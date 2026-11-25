'use strict';

/**
 * Génère l'icône FATONTINE CASH (bleu nuit & or) sans dépendance externe :
 *  - build/icon.png  (512x512, icône de fenêtre en développement)
 *  - build/icon.ico  (16 à 256 px, installateur et exécutable Windows)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');

// ---------------------------------------------------------------------------
// Encodeur PNG minimal (RGBA 8 bits)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// ---------------------------------------------------------------------------
// Rendu vectoriel (SDF + anticrénelage analytique)
// ---------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
    const qx = Math.abs(px - cx) - (hw - r);
    const qy = Math.abs(py - cy) - (hh - r);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    const inside = Math.min(Math.max(qx, qy), 0);
    return outside + inside - r;
}

function coverage(sdPixels) {
    return clamp01(0.5 - sdPixels);
}

function composite(dst, r, g, b, a, index) {
    if (a <= 0) return;
    const dr = dst[index], dg = dst[index + 1], db = dst[index + 2], da = dst[index + 3] / 255;
    const outA = a + da * (1 - a);
    if (outA <= 0) return;
    dst[index] = Math.round((r * a + dr * da * (1 - a)) / outA);
    dst[index + 1] = Math.round((g * a + dg * da * (1 - a)) / outA);
    dst[index + 2] = Math.round((b * a + db * da * (1 - a)) / outA);
    dst[index + 3] = Math.round(outA * 255);
}

function interpolateColor(stops, t) {
    if (t <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const [t0, c0] = stops[i - 1];
            const [t1, c1] = stops[i];
            const k = (t - t0) / (t1 - t0 || 1);
            return [mix(c0[0], c1[0], k), mix(c0[1], c1[1], k), mix(c0[2], c1[2], k)];
        }
    }
    return stops[stops.length - 1][1];
}

const BG_STOPS = [
    [0, [6, 18, 37]],
    [0.55, [12, 33, 66]],
    [1, [30, 58, 110]]
];
const GOLD_STOPS = [
    [0, [251, 240, 201]],
    [0.5, [236, 203, 96]],
    [1, [176, 141, 34]]
];

function renderIcon(size) {
    const rgba = Buffer.alloc(size * size * 4, 0);
    const ringHalf = Math.max(0.015, 0.55 / size);
    const rimHalf = Math.max(0.006, 0.45 / size);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const index = (y * size + x) * 4;
            const u = (x + 0.5) / size;
            const v = (y + 0.5) / size;

            // 1. Tuile arrondie bleu nuit
            const tile = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225) * size;
            const tileAlpha = coverage(tile);
            if (tileAlpha <= 0) continue;
            const bg = interpolateColor(BG_STOPS, clamp01(u * 0.55 + v * 0.45));
            composite(rgba, bg[0], bg[1], bg[2], tileAlpha, index);

            // 2. Liseré doré
            const rim = (Math.abs(sdRoundRect(u, v, 0.5, 0.5, 0.5 - 0.035, 0.5 - 0.035, 0.195)) - rimHalf) * size;
            const rimAlpha = coverage(rim) * 0.75;
            if (rimAlpha > 0) composite(rgba, 236, 203, 96, rimAlpha, index);

            // 3. Cercle doré
            const ringDist = Math.abs(Math.hypot(u - 0.5, v - 0.47) - 0.285) - ringHalf;
            const ringAlpha = coverage(ringDist * size) * 0.95;
            if (ringAlpha > 0) {
                const gold = interpolateColor(GOLD_STOPS, clamp01(v));
                composite(rgba, gold[0], gold[1], gold[2], ringAlpha, index);
            }

            // 4. Monogramme « F » (ombre puis or)
            const bars = [
                [0.415, 0.470, 0.037, 0.155, 0.018],
                [0.530, 0.345, 0.115, 0.037, 0.018],
                [0.505, 0.470, 0.090, 0.033, 0.014]
            ];
            const barDistance = (ox, oy) => {
                let d = Infinity;
                for (const [cx, cy, hw, hh, r] of bars) {
                    d = Math.min(d, sdRoundRect(u + ox, v + oy, cx, cy, hw, hh, r));
                }
                return d;
            };

            const shadowAlpha = coverage(barDistance(-0.006, -0.008) * size) * 0.35;
            if (shadowAlpha > 0) composite(rgba, 4, 11, 22, shadowAlpha, index);

            const fAlpha = coverage(barDistance(0, 0) * size);
            if (fAlpha > 0) {
                const gold = interpolateColor(GOLD_STOPS, clamp01(v));
                composite(rgba, gold[0], gold[1], gold[2], fAlpha, index);
            }
        }
    }
    return rgba;
}

// ---------------------------------------------------------------------------
// Encodeur ICO (entrées PNG, supporté par Windows Vista+)
// ---------------------------------------------------------------------------
function encodeIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);

    const entries = Buffer.alloc(16 * images.length);
    let offset = header.length + entries.length;

    images.forEach((image, i) => {
        const entry = i * 16;
        entries.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
        entries.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
        entries.writeUInt8(0, entry + 2);
        entries.writeUInt8(0, entry + 3);
        entries.writeUInt16LE(1, entry + 4);
        entries.writeUInt16LE(32, entry + 6);
        entries.writeUInt32LE(image.buffer.length, entry + 8);
        entries.writeUInt32LE(offset, entry + 12);
        offset += image.buffer.length;
    });

    return Buffer.concat([header, entries, ...images.map((image) => image.buffer)]);
}

// ---------------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });

const master = encodePng(512, 512, renderIcon(512));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), master);

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoImages = icoSizes.map((size) => ({ size, buffer: encodePng(size, size, renderIcon(size)) }));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(icoImages));

console.log(`Icônes générées dans ${OUT_DIR} : icon.png (512), icon.ico (${icoSizes.join(', ')} px)`);
