'use strict';
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function appUrl() {
  const configPath = path.join(__dirname, 'app-config.json');
  if (!fs.existsSync(configPath)) throw new Error('Missing app-config.json; build with FILMWORK_APP_URL set to the public HTTPS site URL.');
  const value = JSON.parse(fs.readFileSync(configPath, 'utf8')).url;
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Filmwork requires HTTPS.');
  return url;
}

function createWindow() {
  const start = appUrl();
  const win = new BrowserWindow({ width: 1280, height: 850, minWidth: 360, minHeight: 600, backgroundColor: '#08080d', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, target) => {
    try { const next = new URL(target); if (next.origin !== start.origin) { event.preventDefault(); if (next.protocol === 'https:') shell.openExternal(target); } }
    catch { event.preventDefault(); }
  });
  win.loadURL(start.toString());
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
