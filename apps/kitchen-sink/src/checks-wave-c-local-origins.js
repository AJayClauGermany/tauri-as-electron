// Checks for roadmap wave C item C6: IPC and preloads for pages of a local
// server, as apps that start one and load it in a window do (SiYuan's
// kernel at http://127.0.0.1:6806). On Tauri the kitchen sink declares
// `http://127.0.0.1:*` a trusted origin with Node (src-tauri/tauri.conf.json,
// plugins.electron.trustedOrigins); any other origin, `localhost` included,
// gets no preload and no IPC there. Electron runs preloads in every page.
// Same shape as checks.js and, like it, runs unchanged on Electron and on Tauri.
import { BrowserWindow, ipcMain } from 'electron'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const isElectron = Boolean(process.versions.electron)
const dirname = import.meta.dirname

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function waitFor(emitter, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeout)
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

/**
 * The server's page reports what it can do to the server itself (a plain
 * fetch, which works with or without IPC): the preload's API, the
 * synchronous bridge and a Tauri command (both refused off the list).
 */
const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Local server page</title></head>
  <body>
    <h1>Served by a local server</h1>
    <script>
      addEventListener('load', async () => {
        const internals = window.__TAURI_INTERNALS__
        const report = { url: location.href, preload: typeof window.kitchen === 'object', bridge: 'none', command: 'none' }
        if (internals) {
          try {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', internals.convertFileSrc('sync-ipc', 'tauri-electron'), false)
            xhr.send(JSON.stringify({ channel: 'kitchen:sync', args: [] }))
            report.bridge = xhr.status
          } catch (error) {
            report.bridge = 'threw'
          }
          report.command = await internals
            .invoke('plugin:event|emit_to', { target: { kind: 'AnyLabel', label: 'electron-main' }, event: 'kitchen-trusted-probe', payload: null })
            .then(() => 'allowed', () => 'refused')
        }
        fetch('/report', { method: 'POST', body: JSON.stringify(report) })
      })
    </script>
  </body>
</html>
`

/** A local HTTP server serving PAGE; `fn({ port, nextReport })`, then closed (also used by checks-wave-c-views.js). */
export async function withLocalServer(fn) {
  const reports = []
  const waiting = []
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const report = JSON.parse(body)
        const waiter = waiting.shift()
        if (waiter) waiter(report)
        else reports.push(report)
        res.end()
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  const nextReport = (timeout = 10000) =>
    reports.length
      ? Promise.resolve(reports.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the page did not report')), timeout)
          waiting.push((report) => {
            clearTimeout(timer)
            resolve(report)
          })
        })
  try {
    return await fn({ port, nextReport })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

/** A hidden window on `url`, with the kitchen sink's preload; `fn(win)`, then destroyed. */
async function withPage(url, webPreferences, fn) {
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 320,
    webPreferences: { preload: path.join(dirname, 'preload.mjs'), sandbox: false, ...webPreferences },
  })
  try {
    const loaded = waitFor(win.webContents, 'did-finish-load')
    win.loadURL(url)
    await loaded
    return await fn(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** A script for executeJavaScript that reports what threw instead of rejecting. */
const attempt = (code) => `(async () => { try { return await ${code} } catch (error) { return 'threw: ' + error.message } })()`

export const waveCLocalOriginsChecks = [
  { id: 'local server page: preload, invoke, sendSync, webContents.send', run: () => withLocalServer(({ port, nextReport }) =>
    withPage(`http://127.0.0.1:${port}/stage/index.html?kernel=1`, {}, async (win) => {
      const report = await nextReport()
      assert(report.preload === true, `the page has the preload: ${JSON.stringify(report)}`)
      if (!isElectron) assert(report.bridge === 200 && report.command === 'allowed', `IPC allowed: ${JSON.stringify(report)}`)
      const origin = await win.webContents.executeJavaScript('location.origin')
      assert(origin === `http://127.0.0.1:${port}`, `origin ${origin}`)
      const echoed = await win.webContents.executeJavaScript(attempt(`window.kitchen.invoke('kitchen:echo', 1, 'two')`))
      assert(JSON.stringify(echoed) === '[1,"two"]', `invoke: ${JSON.stringify(echoed)}`)
      const sync = await win.webContents.executeJavaScript(attempt(`window.kitchen.sendSync('kitchen:sync')`))
      assert(sync === 'sync-ok', `sendSync: ${sync}`)
      await win.webContents.executeJavaScript('window.kitchen.onChildPing((value) => window.kitchen.childPong(value)), true')
      const pong = waitFor(ipcMain, 'kitchen:child-pong')
      win.webContents.send('kitchen:child-ping', { from: 'main', n: 42 })
      const [, value] = await pong
      assert(value?.n === 42, `round trip: ${JSON.stringify(value)}`)
      const type = await win.webContents.executeJavaScript('process.type')
      assert(type === 'renderer', `process.type ${type}`)
      return `ok (port ${port})`
    })) },
  { id: 'local server page: another origin loses IPC, the trusted one gets it back', run: () => withLocalServer(({ port, nextReport }) =>
    withPage(`http://127.0.0.1:${port}/first`, {}, async (win) => {
      await nextReport()
      // `localhost` is a different origin from 127.0.0.1, not on the list.
      const other = `http://localhost:${port}/other`
      await win.webContents.executeJavaScript(`setTimeout(() => { location.href = ${JSON.stringify(other)} }, 0), true`)
      const away = await nextReport()
      assert(away.url === other, `navigated to ${away.url}`)
      if (isElectron) {
        assert(away.preload === true, 'Electron runs the preload in every page')
      } else {
        assert(away.preload === false, `no preload on ${other}: ${JSON.stringify(away)}`)
        assert(away.bridge !== 200, `the bridge refuses ${other}: ${JSON.stringify(away)}`)
        assert(away.command === 'refused', `Tauri commands are refused on ${other}: ${JSON.stringify(away)}`)
      }
      const back = waitFor(win.webContents, 'did-finish-load')
      win.loadURL(`http://127.0.0.1:${port}/back`)
      await back
      const report = await nextReport()
      assert(report.preload === true, `the preload again: ${JSON.stringify(report)}`)
      const echoed = await win.webContents.executeJavaScript(attempt(`window.kitchen.invoke('kitchen:echo', 'back')`))
      assert(JSON.stringify(echoed) === '["back"]', `invoke: ${JSON.stringify(echoed)}`)
      return 'ok'
    })) },
  { id: 'local server page with nodeIntegration: require(os / fs)', run: () => withLocalServer(({ port, nextReport }) =>
    withPage(`http://127.0.0.1:${port}/node`, { nodeIntegration: true, contextIsolation: false }, async (win) => {
      await nextReport()
      const host = await win.webContents.executeJavaScript(attempt(`require('os').hostname()`))
      assert(host === os.hostname(), `os.hostname: ${host}`)
      const exists = await win.webContents.executeJavaScript(attempt(`require('fs').promises.stat(${JSON.stringify(os.tmpdir())}).then((s) => s.isDirectory())`))
      assert(exists === true, `fs.promises.stat: ${exists}`)
      return 'ok'
    })) },
]
