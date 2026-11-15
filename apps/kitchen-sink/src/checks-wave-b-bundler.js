// Checks for roadmap wave B (docs/ROADMAP.md): electron-updater (B2), custom
// schemes collected by the bundler (B10), titleBarOverlay window controls
// (B8) and message boxes beyond the native dialog (B12). Same shape as
// checks.js and, like it, runs unchanged on Electron and on Tauri.
import { BrowserWindow, dialog, protocol } from 'electron'
import path from 'node:path'

const isElectron = Boolean(process.versions.electron)
const dirname = import.meta.dirname

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withWindow(options, fn) {
  const win = new BrowserWindow({ show: false, width: 640, height: 360, ...options })
  try {
    const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    win.loadFile(path.join(dirname, '../child.html'))
    await loaded
    return await fn(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export const waveBBundlerChecks = [
  // --- B2: electron-updater ------------------------------------------------------------------------
  { id: "electron-updater's autoUpdater (aliased)", run: async () => {
    // The kitchen sink does not depend on electron-updater; on Tauri the bundler aliases it.
    if (isElectron) return 'electron-updater is not installed in the kitchen sink'
    const { autoUpdater, AppUpdater, CancellationToken } = await import('electron-updater')
    assert(autoUpdater instanceof AppUpdater, 'autoUpdater is an AppUpdater')
    assert(autoUpdater.autoDownload === true && autoUpdater.autoInstallOnAppQuit === true, 'defaults')
    assert(typeof new CancellationToken().cancel === 'function', 'CancellationToken')
    assert(autoUpdater.currentVersion.version === (await import('electron')).app.getVersion(), 'currentVersion')
    const events = []
    autoUpdater.on('checking-for-update', () => events.push('checking'))
    autoUpdater.on('error', () => events.push('error'))
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.logger = null
    // The kitchen sink builds without the `updater` feature: the check fails and says why.
    const error = await autoUpdater.checkForUpdates().then(() => null, (e) => e)
    assert(error && /updater/.test(error.message), `feature error, got ${error?.message}`)
    assert(events.join() === 'checking,error', events.join())
    return error.reason ?? error.message
  } },

  // --- B10: schemes from the bundler -----------------------------------------------------------------
  { id: 'custom scheme from src/main.js registered without .protocol() in Rust', run: async () => {
    if (!(await protocol.isProtocolHandled('kitchen'))) {
      protocol.handle('kitchen', (request) => new Response(`<title>kitchen</title>hello from ${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html' } }))
    }
    // A renderer page fetches kitchen://: only works if the scheme was registered at build time.
    return withWindow({}, async (win) => {
      const url = process.platform === 'win32' && !isElectron ? 'http://kitchen.localhost/scheme-check' : 'kitchen://localhost/scheme-check'
      const text = await win.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then((r) => r.text())`)
      assert(text.includes('hello from /scheme-check'), text)
      return 'kitchen:// answered'
    })
  } },

  // --- B8: titleBarOverlay -------------------------------------------------------------------------
  { id: 'titleBarOverlay window controls + windowControlsOverlay', run: () => {
    if (process.platform === 'darwin') return 'macOS keeps its traffic lights'
    return withWindow({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#203040', symbolColor: '#ffffff', height: 40 } }, async (win) => {
      const read = () => win.webContents.executeJavaScript(`({
        controls: Boolean(document.querySelector('[data-tauri-electron="window-controls"]')),
        visible: Boolean(navigator.windowControlsOverlay?.visible),
        height: navigator.windowControlsOverlay?.getTitlebarAreaRect().height ?? 0,
        css: getComputedStyle(document.documentElement).getPropertyValue('--titlebar-area-height').trim(),
      })`)
      const before = await read()
      if (isElectron) return `windowControlsOverlay visible=${before.visible}`
      assert(before.controls, 'buttons drawn')
      assert(before.visible && before.height === 40, `rect height ${before.height}`)
      assert(before.css === '40px', `css ${before.css}`)
      win.setTitleBarOverlay({ height: 48 })
      await sleep(300)
      const after = await read()
      assert(after.height === 48 && after.css === '48px', `after setTitleBarOverlay ${JSON.stringify(after)}`)
      return 'controls drawn, setTitleBarOverlay applied'
    })
  } },

  // --- B12: message boxes beyond the native dialog -----------------------------------------------
  { id: 'dialog.showMessageBox with 4 buttons + checkbox (dismissed by signal)', run: async () => {
    const controller = new AbortController()
    const pending = dialog.showMessageBox({
      message: 'Kitchen sink',
      detail: 'Closes itself.',
      buttons: ['One', 'Two', 'Three', 'Cancel'],
      checkboxLabel: 'Remember',
      checkboxChecked: true,
      signal: controller.signal,
    })
    await sleep(800)
    if (!isElectron) {
      const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow')
      const labels = (await getAllWebviewWindows()).map((w) => w.label)
      assert(labels.some((l) => l.startsWith('electron-message-box-')), `message-box window open: ${labels}`)
    }
    controller.abort()
    const result = await pending
    assert(result.response === 3, `cancelId (the Cancel button), got ${result.response}`)
    assert(result.checkboxChecked === true, 'checkbox state kept')
    return `response ${result.response}, checkboxChecked ${result.checkboxChecked}`
  } },
]
