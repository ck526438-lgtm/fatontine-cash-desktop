'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');

const scrypt = promisify(crypto.scrypt);

const APP_ID = 'ci.fatontine.cash.desktop';
const APP_VERSION = require('./package.json').version;
const DATA_DIR_NAME = 'FATONTINE_CASH';
const DB_FILENAME = 'fatontine-database.json';
const BACKUP_DIR_NAME = 'sauvegardes';
const BACKUP_PREFIX = 'sauvegarde-';
const MAX_BACKUP_FILES = 30;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_RESTORE_BYTES = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 6;

const INDEX_PATH = path.join(__dirname, 'src', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).toString();

app.setAppUserModelId(APP_ID);

// Les données vivent dans %APPDATA%/FATONTINE_CASH (jamais supprimées par une mise à jour)
const DATA_DIR = path.join(app.getPath('appData'), DATA_DIR_NAME);
app.setPath('userData', DATA_DIR);

const DB_PATH = path.join(DATA_DIR, DB_FILENAME);
const BACKUP_DIR = path.join(DATA_DIR, BACKUP_DIR_NAME);

let mainWindow = null;
let writeQueue = Promise.resolve();
let allowClose = false;
let closeFlushing = false;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');

function dateStamp(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function timeStamp(date = new Date()) {
    return `${dateStamp(date)}_${pad2(date.getHours())}h${pad2(date.getMinutes())}`;
}

function formatFCFA(amount) {
    const value = Number.isFinite(Number(amount)) ? Math.round(Number(amount)) : 0;
    return `${new Intl.NumberFormat('fr-FR').format(value)} FCFA`;
}

function safeFileStem(value) {
    return String(value)
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '_')
        .slice(0, 120) || 'document';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateState(state) {
    if (!isPlainObject(state)) return 'Données invalides.';
    const collectionFields = ['groups', 'members', 'inscriptions', 'cotisations', 'beneficiaries', 'auditLogs'];
    for (const field of collectionFields) {
        if (!Array.isArray(state[field])) {
            return `Champ « ${field} » invalide.`;
        }
    }
    return null;
}

function isTrustedSender(event) {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    return frameUrl === INDEX_URL;
}

async function ensureDataDir() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Base de données locale (écriture atomique + copies automatiques)
// ---------------------------------------------------------------------------
function queueWrite(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
}

async function writeDatabase(state) {
    const payload = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_BYTES) {
        throw new Error('La base de données dépasse la taille maximale autorisée.');
    }
    const tmpPath = `${DB_PATH}.${process.pid}.tmp`;
    const handle = await fsp.open(tmpPath, 'w');
    try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    await fsp.rename(tmpPath, DB_PATH);
    await writeDailyBackup(payload).catch((error) => console.error('Copie automatique impossible :', error));
    return { savedAt: new Date().toISOString(), path: DB_PATH, sizeBytes: Buffer.byteLength(payload, 'utf8') };
}

async function writeDailyBackup(payload) {
    await ensureDataDir();
    const file = path.join(BACKUP_DIR, `${BACKUP_PREFIX}${dateStamp()}.json`);
    try {
        await fsp.access(file);
        return;
    } catch {
        await fsp.writeFile(file, payload, 'utf8');
        await pruneBackups();
    }
}

async function pruneBackups() {
    let files;
    try {
        files = (await fsp.readdir(BACKUP_DIR))
            .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.json'))
            .sort();
    } catch {
        return;
    }
    const excess = files.length - MAX_BACKUP_FILES;
    for (const name of files.slice(0, Math.max(0, excess))) {
        await fsp.rm(path.join(BACKUP_DIR, name), { force: true }).catch(() => {});
    }
}

async function snapshotBeforeRestore() {
    try {
        await fsp.access(DB_PATH);
    } catch {
        return;
    }
    const target = path.join(BACKUP_DIR, `${BACKUP_PREFIX}avant-restauration-${timeStamp().replace('_', 'T')}.json`);
    await fsp.copyFile(DB_PATH, target).catch(() => {});
    await pruneBackups();
}

// ---------------------------------------------------------------------------
// Chiffrement des sauvegardes (AES-256-GCM + scrypt, portable d'un PC à l'autre)
// ---------------------------------------------------------------------------
async function encryptBackup(state, password) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = await scrypt(password, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        format: 'fatontine-cash-backup',
        version: 1,
        encrypted: true,
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        kdf: { name: 'scrypt', salt: salt.toString('base64') },
        cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') },
        data: ciphertext.toString('base64')
    };
}

async function decryptBackupContent(rawContent, password) {
    let parsed;
    try {
        parsed = JSON.parse(rawContent);
    } catch {
        throw new Error('Ce fichier de sauvegarde est illisible.');
    }

    if (parsed && parsed.format === 'fatontine-cash-backup') {
        if (!parsed.encrypted) throw new Error('Fichier de sauvegarde corrompu.');
        if (!password) throw new Error('Ce fichier est chiffré : saisissez son mot de passe.');
        const salt = Buffer.from(parsed.kdf?.salt || '', 'base64');
        const iv = Buffer.from(parsed.cipher?.iv || '', 'base64');
        const authTag = Buffer.from(parsed.cipher?.authTag || '', 'base64');
        if (!salt.length || !iv.length || !authTag.length) throw new Error('Fichier de sauvegarde corrompu.');
        const key = await scrypt(password, salt, 32);
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data || '', 'base64')), decipher.final()]);
            return JSON.parse(plaintext.toString('utf8'));
        } catch {
            throw new Error('Mot de passe incorrect ou fichier de sauvegarde corrompu.');
        }
    }

    const problem = validateState(parsed);
    if (problem) throw new Error("Ce fichier n'est pas une sauvegarde FATONTINE CASH.");
    return parsed;
}

// ---------------------------------------------------------------------------
// Reçu PDF autonome (aucun réseau requis)
// ---------------------------------------------------------------------------
function buildReceiptHtml(receipt) {
    const r = isPlainObject(receipt) ? receipt : {};
    const fields = {
        receiptNo: String(r.receiptNo || 'REC-0000').slice(0, 40),
        member: String(r.member || '-').slice(0, 120),
        phone: String(r.phone || '-').slice(0, 40),
        group: String(r.group || '-').slice(0, 120),
        formula: String(r.formula || '-').slice(0, 120),
        date: String(r.date || '-').slice(0, 40),
        method: String(r.method || '-').slice(0, 80),
        opRef: String(r.opRef || '-').slice(0, 40),
        amount: formatFCFA(r.amount),
        generatedAt: new Date().toLocaleString('fr-FR')
    };
    const rows = [
        ['Membre', fields.member],
        ['Téléphone', fields.phone],
        ['Groupe', fields.group],
        ['Formule', fields.formula],
        ['Date de versement', fields.date],
        ['Mode / Réf. Wave', fields.method],
        ['Réf. opération', fields.opRef]
    ].map(([label, value]) => `<tr><td class="key">${escapeHtml(label)}</td><td class="value">${escapeHtml(value)}</td></tr>`).join('');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Reçu ${escapeHtml(fields.receiptNo)}</title>
<style>
    @page { size: A5; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #ffffff; color: #0A192F; font-family: "Segoe UI", Arial, sans-serif; }
    .page { width: 148mm; padding: 10mm 11mm; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.5pt solid #0A192F; padding-bottom: 4mm; }
    .brand { display: flex; gap: 3mm; align-items: center; }
    .logo { width: 13mm; height: 13mm; border-radius: 4mm; background: linear-gradient(135deg, #F6E094, #B08D22); color: #0A192F; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11pt; }
    .brand h1 { margin: 0; font-size: 13pt; letter-spacing: .5pt; }
    .brand h1 span { color: #B08D22; }
    .tagline { font-size: 7.5pt; color: #64748B; margin-top: 1mm; }
    .id { text-align: right; }
    .badge { display: inline-block; background: #0A192F; color: #F6E094; border: 1pt solid #D4AF37; border-radius: 2mm; font-size: 7pt; font-weight: 700; letter-spacing: 1pt; text-transform: uppercase; padding: 1.4mm 3mm; }
    .receipt-no { font-family: Consolas, monospace; font-size: 9pt; font-weight: 700; margin-top: 2mm; }
    .amount { margin: 7mm 0 5mm; padding: 6mm 4mm; text-align: center; background: #F8FAFC; border: 1pt solid #E2E8F0; border-radius: 4mm; }
    .amount .label { font-size: 7.5pt; letter-spacing: 1.2pt; text-transform: uppercase; color: #64748B; font-weight: 700; }
    .amount .value { font-size: 22pt; font-weight: 800; margin-top: 1.5mm; }
    .status { display: inline-block; margin-top: 2mm; padding: 1.2mm 3mm; border-radius: 999px; background: #DCFCE7; color: #166534; font-size: 7.5pt; font-weight: 700; }
    table.details { width: 100%; border-collapse: collapse; font-size: 9pt; border-top: 1pt dashed #CBD5E1; border-bottom: 1pt dashed #CBD5E1; }
    table.details td { padding: 2mm 0; vertical-align: top; }
    table.details td.key { color: #64748B; width: 38%; }
    table.details td.value { text-align: right; font-weight: 600; }
    .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 8mm; font-size: 8pt; color: #64748B; }
    .footer strong { color: #0A192F; }
    .stamp { width: 26mm; height: 26mm; border: 1.4pt solid #D4AF37; border-radius: 50%; color: #B08D22; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 6.5pt; font-weight: 800; letter-spacing: .6pt; transform: rotate(-12deg); }
    .legal { margin-top: 5mm; text-align: center; font-size: 6.5pt; color: #94A3B8; }
</style>
</head>
<body>
    <div class="page">
        <div class="top">
            <div class="brand">
                <div class="logo">FC</div>
                <div>
                    <h1>FATONTINE <span>CASH</span></h1>
                    <div class="tagline">La tontine, en toute simplicité.</div>
                </div>
            </div>
            <div class="id">
                <span class="badge">Reçu Officiel</span>
                <div class="receipt-no">${escapeHtml(fields.receiptNo)}</div>
            </div>
        </div>

        <div class="amount">
            <div class="label">Montant cotisé encaissé</div>
            <div class="value">${escapeHtml(fields.amount)}</div>
            <div class="status">Paiement validé par Fatima</div>
        </div>

        <table class="details">${rows}</table>

        <div class="footer">
            <div>
                <strong>Administratrice : Fatima</strong><br>
                Côte d'Ivoire • Devise : FCFA<br>
                Édité le ${escapeHtml(fields.generatedAt)}
            </div>
            <div class="stamp"><span>CERTIFIÉ</span><span>PAYÉ</span></div>
        </div>

        <div class="legal">Document généré par l'application FATONTINE CASH — données conservées localement sur le PC de l'administratrice.</div>
    </div>
</body>
</html>`;
}

async function renderReceiptPdf(receipt) {
    const html = buildReceiptHtml(receipt);
    const tmpFile = path.join(app.getPath('temp'), `fatontine-recu-${crypto.randomBytes(6).toString('hex')}.html`);
    await fsp.writeFile(tmpFile, html, 'utf8');

    const printWindow = new BrowserWindow({
        show: false,
        width: 600,
        height: 800,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            javascript: false
        }
    });
    try {
        await printWindow.loadFile(tmpFile);
        return await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A5' });
    } finally {
        printWindow.destroy();
        await fsp.rm(tmpFile, { force: true }).catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Fenêtre principale
// ---------------------------------------------------------------------------
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1080,
        minHeight: 700,
        show: false,
        backgroundColor: '#071326',
        title: 'FATONTINE CASH',
        icon: path.join(__dirname, 'build', 'icon.png'),
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0A192F',
            symbolColor: '#ECCB60',
            height: 36
        },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            devTools: !app.isPackaged
        }
    });

    Menu.setApplicationMenu(null);
    mainWindow.loadFile(INDEX_PATH);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url !== INDEX_URL) event.preventDefault();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openExternalUrl(url);
        return { action: 'deny' };
    });

    mainWindow.on('close', (event) => {
        if (allowClose || closeFlushing) return;
        event.preventDefault();
        closeFlushing = true;
        Promise.race([writeQueue, new Promise((resolve) => setTimeout(resolve, 2500))])
            .finally(() => {
                allowClose = true;
                if (mainWindow) mainWindow.close();
            });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function openExternalUrl(url) {
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            shell.openExternal(parsed.toString());
        }
    } catch {
        console.warn('URL externe refusée :', url);
    }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function handle(channel, handler) {
    ipcMain.handle(channel, async (event, payload) => {
        if (!isTrustedSender(event)) {
            return { ok: false, error: 'Origine non autorisée.' };
        }
        try {
            return await handler(payload);
        } catch (error) {
            console.error(`[${channel}]`, error);
            return { ok: false, error: (error && error.message) || 'Erreur inattendue.' };
        }
    });
}

function registerIpc() {
    handle('state:save', async (state) => {
        const problem = validateState(state);
        if (problem) return { ok: false, error: problem };
        return queueWrite(async () => ({ ok: true, ...(await writeDatabase(state)) }));
    });

    handle('state:load', async () => {
        try {
            const stats = await fsp.stat(DB_PATH);
            if (stats.size > MAX_STATE_BYTES) return { ok: false, error: 'Base de données trop volumineuse.' };
            const raw = await fsp.readFile(DB_PATH, 'utf8');
            const state = JSON.parse(raw);
            return { ok: true, state, savedAt: stats.mtime.toISOString(), path: DB_PATH };
        } catch (error) {
            if (error && error.code === 'ENOENT') return { ok: true, state: null, path: DB_PATH };
            console.error('[state:load]', error);
            return { ok: false, error: 'Lecture de la base locale impossible.' };
        }
    });

    handle('storage:info', async () => {
        let dbStat = null;
        try {
            dbStat = await fsp.stat(DB_PATH);
        } catch {}
        let backupCount = 0;
        try {
            backupCount = (await fsp.readdir(BACKUP_DIR)).filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.json')).length;
        } catch {}
        return {
            ok: true,
            version: APP_VERSION,
            isPackaged: app.isPackaged,
            dataDir: DATA_DIR,
            dbPath: DB_PATH,
            exists: !!dbStat,
            sizeBytes: dbStat ? dbStat.size : 0,
            lastModified: dbStat ? dbStat.mtime.toISOString() : null,
            backupCount
        };
    });

    handle('storage:open-folder', async () => {
        await ensureDataDir();
        const error = await shell.openPath(DATA_DIR);
        return error ? { ok: false, error } : { ok: true };
    });

    handle('backup:export', async (payload) => {
        const state = payload && payload.state;
        const password = payload && typeof payload.password === 'string' ? payload.password : '';
        const problem = validateState(state);
        if (problem) return { ok: false, error: problem };
        if (password.length < MIN_PASSWORD_LENGTH) {
            return { ok: false, error: `Mot de passe trop court (${MIN_PASSWORD_LENGTH} caractères minimum).` };
        }

        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Exporter une sauvegarde chiffrée',
            defaultPath: path.join(app.getPath('documents'), `FATONTINE_CASH_sauvegarde_${timeStamp()}.fatbackup`),
            filters: [{ name: 'Sauvegarde FATONTINE CASH', extensions: ['fatbackup'] }]
        });
        if (result.canceled || !result.filePath) return { ok: true, canceled: true };

        const container = await encryptBackup(state, password);
        await fsp.writeFile(result.filePath, JSON.stringify(container), 'utf8');
        return { ok: true, filePath: result.filePath };
    });

    handle('backup:pick', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Choisir un fichier de sauvegarde',
            properties: ['openFile'],
            filters: [
                { name: 'Sauvegarde FATONTINE CASH', extensions: ['fatbackup', 'json'] },
                { name: 'Tous les fichiers', extensions: ['*'] }
            ]
        });
        if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };

        const filePath = result.filePaths[0];
        const stats = await fsp.stat(filePath);
        if (stats.size > MAX_RESTORE_BYTES) return { ok: false, error: 'Fichier de sauvegarde trop volumineux.' };
        const raw = await fsp.readFile(filePath, 'utf8');

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return { ok: false, error: 'Ce fichier de sauvegarde est illisible.' };
        }
        const isWrapper = parsed && parsed.format === 'fatontine-cash-backup';
        if (!isWrapper && validateState(parsed)) {
            return { ok: false, error: "Ce fichier n'est pas une sauvegarde FATONTINE CASH." };
        }
        if (isWrapper && !parsed.encrypted) {
            return { ok: false, error: 'Fichier de sauvegarde corrompu.' };
        }
        return {
            ok: true,
            canceled: false,
            filePath,
            encrypted: !!isWrapper,
            exportedAt: (isWrapper && parsed.exportedAt) || null
        };
    });

    handle('backup:restore', async (payload) => {
        const filePath = payload && typeof payload.filePath === 'string' ? payload.filePath : '';
        const password = payload && typeof payload.password === 'string' ? payload.password : '';
        if (!filePath || !path.isAbsolute(filePath)) return { ok: false, error: 'Fichier de sauvegarde invalide.' };

        const stats = await fsp.stat(filePath);
        if (stats.size > MAX_RESTORE_BYTES) return { ok: false, error: 'Fichier de sauvegarde trop volumineux.' };
        const raw = await fsp.readFile(filePath, 'utf8');
        const state = await decryptBackupContent(raw, password);

        const problem = validateState(state);
        if (problem) return { ok: false, error: problem };

        await snapshotBeforeRestore();
        await queueWrite(async () => writeDatabase(state));
        return { ok: true, state };
    });

    handle('pdf:receipt', async (receipt) => {
        const receiptNo = safeFileStem((receipt && receipt.receiptNo) || 'recu');
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Enregistrer le reçu en PDF',
            defaultPath: path.join(app.getPath('documents'), `Recu_${receiptNo}.pdf`),
            filters: [{ name: 'Document PDF', extensions: ['pdf'] }]
        });
        if (result.canceled || !result.filePath) return { ok: true, canceled: true };

        const pdf = await renderReceiptPdf(receipt);
        await fsp.writeFile(result.filePath, pdf);
        return { ok: true, filePath: result.filePath };
    });

    handle('file:save-text', async (payload) => {
        const defaultName = safeFileStem((payload && payload.defaultName) || 'FATONTINE_CASH_export.csv');
        const content = (payload && typeof payload.content === 'string') ? payload.content : '';
        const filters = Array.isArray(payload && payload.filters) ? payload.filters : [{ name: 'Fichier CSV', extensions: ['csv'] }];

        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Exporter le fichier',
            defaultPath: path.join(app.getPath('documents'), defaultName),
            filters
        });
        if (result.canceled || !result.filePath) return { ok: true, canceled: true };

        await fsp.writeFile(result.filePath, content, 'utf8');
        return { ok: true, filePath: result.filePath };
    });

    handle('shell:whatsapp', async (payload) => {
        const phone = String((payload && payload.phone) || '').replace(/\D/g, '');
        const text = String((payload && payload.text) || '').slice(0, 3500);
        const url = phone.length >= 8
            ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
            : `https://wa.me/?text=${encodeURIComponent(text)}`;
        await shell.openExternal(url);
        return { ok: true };
    });

    handle('shell:show-in-folder', async (filePath) => {
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
            return { ok: false, error: 'Chemin invalide.' };
        }
        shell.showItemInFolder(filePath);
        return { ok: true };
    });

    handle('shell:open-external', async (url) => {
        openExternalUrl(url);
        return { ok: true };
    });
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });

    app.on('web-contents-created', (_event, contents) => {
        contents.on('will-attach-webview', (event) => event.preventDefault());
    });

    app.whenReady().then(async () => {
        await ensureDataDir();

        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        session.defaultSession.setPermissionCheckHandler(() => false);

        registerIpc();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });

        console.log(`FATONTINE CASH ${APP_VERSION} — données : ${DATA_DIR}`);
    });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
