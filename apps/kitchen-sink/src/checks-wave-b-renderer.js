// Checks for roadmap wave B items B1 (Node built-ins in windows created with
// nodeIntegration or sandbox: false) and B5 (@electron/remote). Same shape
// as checks.js and, like it, runs unchanged on Electron and on Tauri.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isElectron = Boolean(process.versions.electron)

/** @electron/remote/main: tauri-electron's shim on Tauri; the npm package on Electron (install it to run these there). */
const loadRemoteMain = () => import('@electron/remote/main').then((m) => m.default ?? m)
const dirname = import.meta.dirname

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Opens `page` in a hidden window with `webPreferences`, runs `fn`, always closes it. */
async function withWindow(page, webPreferences, fn) {
  const win = new BrowserWindow({ show: false, width: 360, height: 240, webPreferences })
  try {
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out loading the window')), 10000)
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    win.loadFile(path.join(dirname, '..', page))
    await loaded
    return await fn(win)
  } finally {
    win.destroy()
  }
}

/** A script for executeJavaScript that reports what threw instead of rejecting. */
const attempt = (code) => `(() => { try { return ${code} } catch (error) { return 'threw: ' + error.message } })()`

export const waveBRendererChecks = [
  // --- B1: Node built-ins in renderer windows ------------------------------------------------------
  { id: 'nodeIntegration window: require(fs / os / child_process), Buffer', run: () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-wave-b-'))
    const file = path.join(dir, 'from-main.txt')
    fs.writeFileSync(file, 'written by main')
    return withWindow('child.html', { nodeIntegration: true, contextIsolation: false }, async (win) => {
      const read = await win.webContents.executeJavaScript(attempt(`require('fs').readFileSync(${JSON.stringify(file)}, 'utf8')`))
      assert(read === 'written by main', `fs.readFileSync: ${read}`)
      const host = await win.webContents.executeJavaScript(attempt(`require('node:os').hostname()`))
      assert(host === os.hostname(), `os.hostname: ${host}`)
      const echoed = await win.webContents.executeJavaScript(attempt(`require('child_process').execFileSync('node', ['-e', 'process.stdout.write("hi")']).toString()`))
      assert(echoed === 'hi' || /ENOENT|not found/i.test(echoed), `child_process: ${echoed}`)
      const buffer = await win.webContents.executeJavaScript(attempt(`Buffer.from('hey').toString('base64') + ' ' + typeof setImmediate`))
      assert(buffer === 'aGV5 function', `Buffer / setImmediate: ${buffer}`)
      const written = await win.webContents.executeJavaScript(attempt(`(require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'from-renderer.txt'))}, 'hello'), 'ok')`))
      assert(written === 'ok' && fs.readFileSync(path.join(dir, 'from-renderer.txt'), 'utf8') === 'hello', `fs.writeFileSync: ${written}`)
      return 'ok'
    }).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
  } },
  { id: 'nodeIntegration window: fs.promises', run: () => withWindow('child.html', { nodeIntegration: true, contextIsolation: false }, async (win) => {
    const value = await win.webContents.executeJavaScript(`require('fs').promises.stat(${JSON.stringify(os.tmpdir())}).then((s) => s.isDirectory())`)
    assert(value === true, `stat: ${value}`)
    return 'ok'
  }) },
  { id: 'sandboxed window: no Node built-ins', run: () => withWindow('child.html', { sandbox: true }, async (win) => {
    const read = await win.webContents.executeJavaScript(attempt(`require('fs').readFileSync('/')`))
    assert(String(read).startsWith('threw'), `fs in a sandboxed window: ${read}`)
    if (isElectron) return 'ok'
    // The Rust side refuses too, whatever the page does: the synchronous
    // bridge, and granting itself Node through set_window_config.
    const bridge = await win.webContents.executeJavaScript(`(() => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', window.__TAURI_INTERNALS__.convertFileSrc('node/os/hostname', 'tauri-electron'), false)
      xhr.send()
      return xhr.status
    })()`)
    assert(bridge === 403, `bridge status ${bridge}`)
    const grant = await win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke('plugin:electron|set_window_config', { label: 'electron-main', config: { node: true } }).then(() => 'granted', (e) => 'refused: ' + e)`,
    )
    assert(grant.startsWith('refused'), grant)
    return 'ok'
  }) },

  // --- B5: @electron/remote ---------------------------------------------------------------------------
  { id: '@electron/remote: windows, app, globals, callbacks, promises, Menu', run: async () => {
    const remoteMain = await loadRemoteMain()
    if (!remoteMain.isInitialized()) remoteMain.initialize()
    globalThis.kitchenRemote = {
      answer: 42,
      emitOn: (win, value) => win.emit('kitchen-remote', {}, value),
      later: (value) => new Promise((resolve) => setTimeout(() => resolve(value), 10)),
      same: (a, b) => a === b,
      fail: () => {
        throw new Error('remote boom')
      },
    }
    const win = new BrowserWindow({ show: false, width: 360, height: 240, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    remoteMain.enable(win.webContents)
    try {
      const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
      win.loadFile(path.join(dirname, '..', 'remote.html'))
      await loaded
      const expected = { windowId: win.id, appName: app.getName(), joined: path.join('a', 'b'), platform: process.platform }
      return await win.webContents.executeJavaScript(`remoteChecks(${JSON.stringify(expected)})`)
    } finally {
      win.destroy()
      delete globalThis.kitchenRemote
    }
  } },
  { id: '@electron/remote: refused until enable(webContents)', run: async () => {
    const remoteMain = await loadRemoteMain()
    if (!remoteMain.isInitialized()) remoteMain.initialize()
    return withWindow('remote.html', { nodeIntegration: true, contextIsolation: false }, async (win) => {
      const result = await win.webContents.executeJavaScript(attempt(`require('@electron/remote').getCurrentWindow().id`))
      assert(/disabled for this WebContents/.test(result), result)
      return 'ok'
    })
  } },
]
