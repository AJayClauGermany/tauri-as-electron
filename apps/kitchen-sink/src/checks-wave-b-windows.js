// Checks for roadmap wave B items built on windows created from Rust
// (docs/ROADMAP.md): downloads (B6), permission request handlers (B7) and
// session.setProxy (B13). Same shape as checks.js and, like it, runs
// unchanged on Electron and on Tauri.
import { BrowserWindow, app, session } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

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

const BODY = 'tauri-electron download check\n'.repeat(64)

/** A local HTTP server sending BODY as an attachment; `fn(url)`, then closed. */
async function withServer(fn) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': Buffer.byteLength(BODY),
      'content-disposition': 'attachment; filename="kitchen-download.txt"',
    })
    res.end(BODY)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/file`, hits)
  } finally {
    server.close()
  }
}

/** A hidden window showing child.html. */
async function withWindow(fn, webPreferences = {}) {
  const win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences })
  try {
    const loaded = waitFor(win.webContents, 'did-finish-load')
    win.loadFile(path.join(dirname, '../child.html'))
    await loaded
    return await fn(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** Saves the next download of `ses` in a temporary folder; resolves with { item, state, file }. */
function nextDownload(ses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-wave-b-'))
  return waitFor(ses, 'will-download').then(([, item]) => {
    const file = path.join(dir, item.getFilename())
    item.setSavePath(file)
    return waitFor(item, 'done', 15000).then(([, state]) => ({ item, state, file, dir }))
  })
}

export const waveBWindowChecks = [
  // --- B6: downloads ----------------------------------------------------------------------------------
  { id: 'webContents.downloadURL → will-download / DownloadItem', run: () => withServer((url) => withWindow(async (win) => {
    const download = nextDownload(win.webContents.session)
    win.webContents.downloadURL(url)
    const { item, state, file, dir } = await download
    try {
      assert(state === 'completed', `state ${state}`)
      assert(item.getFilename() === 'kitchen-download.txt', `filename ${item.getFilename()}`)
      assert(item.getURL() === url, 'url')
      assert(item.getTotalBytes() === Buffer.byteLength(BODY), `total ${item.getTotalBytes()}`)
      assert(item.getSavePath() === file, 'save path')
      assert(fs.readFileSync(file, 'utf8') === BODY, 'file content')
      return `${item.getReceivedBytes()} bytes, ${item.getMimeType()}`
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })) },
  { id: 'page download (link) → will-download', run: () => withServer((url) => withWindow(async (win) => {
    const download = nextDownload(win.webContents.session)
    await win.webContents.executeJavaScript(`(() => {
      const a = document.createElement('a')
      a.href = ${JSON.stringify(url)}
      a.download = ''
      document.body.appendChild(a)
      a.click()
      a.remove()
    })()`)
    const { item, state, file, dir } = await download
    try {
      assert(state === 'completed', `state ${state}`)
      assert(fs.readFileSync(file, 'utf8') === BODY, 'file content')
      return `${item.getFilename()}, ${item.getReceivedBytes()} bytes`
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })) },
  { id: 'session.downloadURL + DownloadItem.cancel', run: () => withServer(async (url) => {
    const ses = session.defaultSession
    const [, item] = await (async () => {
      const will = waitFor(ses, 'will-download')
      ses.downloadURL(url)
      return will
    })()
    const done = waitFor(item, 'done')
    item.cancel()
    const [, state] = await done
    assert(state === 'cancelled', `state ${state}`)
    assert(item.getState() === 'cancelled', 'getState')
    return state
  }) },

  // --- B7: permission handlers ---------------------------------------------------------------------------
  { id: 'session.setPermissionRequestHandler (geolocation)', run: async () => {
    // The default session: windows of in-memory partitions (incognito webviews) do not load on WebKitGTK.
    const ses = session.defaultSession
    const asked = []
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      asked.push({ permission, url: details.requestingUrl, sameContents: BrowserWindow.fromWebContents(webContents) !== null })
      callback(false)
    })
    try {
      return await withWindow(async (win) => {
        const answer = await win.webContents.executeJavaScript(`new Promise((resolve) => {
          setTimeout(() => resolve('timeout'), 5000)
          navigator.geolocation.getCurrentPosition(() => resolve('granted'), (error) => resolve(error.code))
        })`)
        if (!asked.length && answer === 'timeout') {
          // No location service (GeoClue on Linux): the webview never asks.
          const error = new Error('the webview asked for no geolocation permission here (no location service)')
          error.name = 'NotImplementedError'
          throw error
        }
        assert(asked.length === 1 && asked[0].permission === 'geolocation', `handler calls ${JSON.stringify(asked)}`)
        assert(asked[0].sameContents, 'webContents of the window')
        assert(answer === 1, `PERMISSION_DENIED expected, got ${answer}`)
        return 'denied by the handler'
      })
    } finally {
      ses.setPermissionRequestHandler(null)
    }
  } },

  // --- B13: setProxy ---------------------------------------------------------------------------------------
  { id: 'session.setProxy / resolveProxy', run: async () => {
    const ses = session.fromPartition('kitchen-proxy')
    await ses.setProxy({ proxyRules: 'http://127.0.0.1:9' })
    const proxied = await ses.resolveProxy('http://example.com/')
    await ses.setProxy({ mode: 'direct' })
    const direct = await ses.resolveProxy('http://example.com/')
    assert(/^PROXY 127\.0\.0\.1:9\b/.test(proxied), `proxied: ${proxied}`)
    assert(direct === 'DIRECT', `direct: ${direct}`)
    return proxied
  } },
  { id: 'app.setProxy', run: async () => {
    await app.setProxy({ proxyRules: 'socks5://127.0.0.1:1080' })
    const value = await app.resolveProxy('https://example.com/')
    await app.setProxy({ mode: 'direct' })
    assert(value.startsWith('SOCKS5 127.0.0.1:1080'), value)
    return value
  } },
]
