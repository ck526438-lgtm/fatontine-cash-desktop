'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('fatontine', {
    isDesktop: true,
    platform: process.platform,
    saveState: (state) => invoke('state:save', state),
    loadState: () => invoke('state:load'),
    getStorageInfo: () => invoke('storage:info'),
    openDataFolder: () => invoke('storage:open-folder'),
    exportBackup: (payload) => invoke('backup:export', payload),
    pickBackup: () => invoke('backup:pick'),
    restoreBackup: (payload) => invoke('backup:restore', payload),
    exportReceiptPdf: (payload) => invoke('pdf:receipt', payload),
    saveTextFile: (payload) => invoke('file:save-text', payload),
    openWhatsApp: (payload) => invoke('shell:whatsapp', payload),
    showInFolder: (filePath) => invoke('shell:show-in-folder', filePath),
    openExternal: (url) => invoke('shell:open-external', url)
});
