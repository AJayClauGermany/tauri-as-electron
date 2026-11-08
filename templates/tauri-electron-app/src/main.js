// Electron main-process code. With tauri-electron it runs in a hidden
// Tauri window, but it is written exactly like a regular Electron main.js.
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      // Kept for Electron compatibility. Under Tauri the Vite plugin injects
      // the preload script instead (see vite.config.js).
      preload: path.join(import.meta.dirname, 'preload.js'),
    },
  })

  win.loadFile(path.join(import.meta.dirname, '../index.html'))

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('main:hello', `Hello from the main process at ${new Date().toLocaleTimeString()}`)
  })
}

ipcMain.handle('app:versions', () => ({
  app: app.getVersion(),
  name: app.getName(),
  platform: process.platform,
  arch: process.arch,
  locale: app.getLocale(),
}))

ipcMain.handle('app:ping', (_event, message) => `pong: ${message}`)

ipcMain.on('app:set-title', (event, title) => {
  BrowserWindow.fromWebContents(event.sender)?.setTitle(title)
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
