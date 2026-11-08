// Kitchen sink main process. Plain Electron code: it runs unchanged on
// Electron (`npm run start:electron`) and on Tauri via tauri-electron.
import { app, BrowserWindow, ipcMain, Menu, protocol } from 'electron'
import path from 'node:path'
import { checks, applicationMenu } from './checks.js'

const dirname = import.meta.dirname
// Set by scripts/smoke.mjs: post the results there and quit.
const SMOKE_URL = import.meta.env?.VITE_KITCHEN_SMOKE_URL || process.env.KITCHEN_SMOKE_URL

function format(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// --- check runner -------------------------------------------------------------
ipcMain.handle('kitchen:list', () => checks.map(({ id, manual }) => ({ id, manual: Boolean(manual) })))

ipcMain.handle('kitchen:run', async (_event, id) => {
  const check = checks.find((c) => c.id === id)
  if (!check) throw new Error(`Unknown check: ${id}`)
  progress({ id, status: 'running' })
  let result
  try {
    result = { status: 'pass', detail: format(await check.run()) }
  } catch (error) {
    const unsupported = error?.name === 'NotImplementedError'
    result = { status: unsupported ? 'unsupported' : 'fail', detail: String(error?.message ?? error) }
  }
  progress({ id, ...result })
  return result
})

// Renderer-side checks report their progress here too.
ipcMain.on('kitchen:progress', (_event, entry) => progress(entry))

/** Smoke runs print each check as it starts and ends, so a hang shows where. */
function progress(entry) {
  if (!SMOKE_URL) return
  lastProgress = entry
  fetch(SMOKE_URL.replace(/\/report$/, '/progress'), { method: 'POST', body: JSON.stringify(entry) }).catch(() => {})
}
let lastProgress = null

ipcMain.handle('kitchen:report', async (_event, results) => {
  if (!SMOKE_URL) return false
  await postSmoke({ runtime: process.versions.electron ? 'electron' : 'tauri', results })
  setTimeout(() => app.quit(), 100)
  return true
})

async function postSmoke(body) {
  try {
    await fetch(SMOKE_URL, { method: 'POST', body: JSON.stringify(body) })
  } catch (error) {
    console.error('smoke report failed', error)
  }
}

// Custom schemes must be declared before 'ready' (Electron); see the
// protocol.handle checks. On Tauri, src-tauri/src/lib.rs declares it too.
protocol.registerSchemesAsPrivileged([{ scheme: 'kitchen', privileges: { standard: true, supportFetchAPI: true } }])

// --- IPC endpoints used by the renderer-side checks ---------------------------------
ipcMain.on('kitchen:port', (event) => {
  const [port] = event.ports
  port.on('message', ({ data }) => port.postMessage({ doubled: data * 2 }))
  port.start()
})
ipcMain.handle('kitchen:echo', (_event, ...args) => args)
ipcMain.handle('kitchen:throw', () => {
  throw new Error('boom')
})
ipcMain.on('kitchen:ping', (event, value) => event.reply('kitchen:pong', value))
ipcMain.on('kitchen:sync', (event) => {
  event.returnValue = 'sync-ok'
})
ipcMain.on('kitchen:context-menu', (event, x, y) => {
  const menu = Menu.buildFromTemplate([
    { label: 'Context menu from the main process', enabled: false },
    { type: 'separator' },
    { role: 'copy' },
    { role: 'selectAll' },
    { type: 'separator' },
    { label: 'Reload', click: (_item, win) => win?.webContents.reload() },
  ])
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender), x, y })
})

// --- windows ------------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    title: 'Electron Kitchen Sink',
    webPreferences: { preload: path.join(dirname, 'preload.mjs'), sandbox: false },
  })
  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(dirname, '../index.html'), { query: { from: 'main', smoke: SMOKE_URL ? '1' : '0' } })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(applicationMenu())
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  if (SMOKE_URL) {
    setTimeout(async () => {
      const last = lastProgress ? ` (last: ${lastProgress.status} ${lastProgress.id})` : ''
      await postSmoke({ error: `timed out waiting for the renderer report${last}` })
      app.exit(1)
    }, 120_000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
