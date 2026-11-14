// Electron main process, CommonJS style, as webpack Electron projects write it.
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('fs')
const net = require('net')
import { readFileSync } from 'node:fs'

export const seen = {
  page: MAIN_WINDOW_WEBPACK_ENTRY,
  preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
  html: path.join(__dirname, 'index.html'),
  file: __filename,
  fsType: typeof fs.readFileSync,
  namedType: typeof readFileSync,
  stubType: typeof net.connect,
}

app.whenReady().then(() => new BrowserWindow().loadURL(MAIN_WINDOW_WEBPACK_ENTRY))
