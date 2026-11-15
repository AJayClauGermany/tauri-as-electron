// Checks for roadmap wave C items C7 (session.webRequest applied) and C10
// (TLS and authentication events), against local HTTP and HTTPS servers.
// Same shape as checks.js and, like it, runs unchanged on Electron and on
// Tauri.
import { BrowserWindow, app, protocol, session } from 'electron'
import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'
import { CERT, KEY } from './fixtures/tls-test-cert.js'

const isElectron = Boolean(process.versions.electron)

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function unsupported(message) {
  const error = new Error(message)
  error.name = 'NotImplementedError'
  return error
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

/** Resolves once `test()` is true (polling), or rejects after `timeout`. */
async function until(test, what, timeout = 10000) {
  const end = Date.now() + timeout
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** Runs `fn(port, hits)` against a server, then closes it (without waiting on kept-alive connections). */
async function withServer(server, fn) {
  const hits = []
  server.on('request', (req) => hits.push({ url: req.url, headers: req.headers }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    return await fn(server.address().port, hits)
  } finally {
    server.closeAllConnections?.()
    await Promise.race([new Promise((resolve) => server.close(() => resolve())), sleep(1000)])
  }
}

/** A server echoing what it received, with a redirect at /old. */
function echoServer() {
  return http.createServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(302, { location: '/final' })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-server': 'kitchen' })
    res.end(JSON.stringify({ url: req.url, kitchen: req.headers['x-kitchen'] ?? null }))
  })
}

/** A hidden window loading `url`; `fn(win)`, then destroyed. */
async function withWindow(url, fn, options = {}) {
  const win = new BrowserWindow({ show: false, width: 320, height: 240, ...options })
  try {
    return await fn(win, win.loadURL(url).catch((error) => error))
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** A session.webRequest listener set for the duration of `fn`. */
async function withListeners(ses, listeners, fn) {
  for (const [name, args] of Object.entries(listeners)) ses.webRequest[name](...args)
  try {
    return await fn()
  } finally {
    for (const name of Object.keys(listeners)) ses.webRequest[name](null)
  }
}

export const waveCWebRequestTlsChecks = [
  // --- C7: session.webRequest -------------------------------------------------------------------
  { id: 'webRequest.onBeforeSendHeaders / onHeadersReceived (session.fetch)', run: () => withServer(echoServer(), async (port) => {
    const ses = session.fromPartition('kitchen-webrequest')
    const filter = { urls: [`http://127.0.0.1:${port}/*`] }
    return withListeners(ses, {
      onBeforeSendHeaders: [filter, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, 'X-Kitchen': 'rewritten' } })],
      onHeadersReceived: [filter, (details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'X-Added': ['by-listener'] } })],
    }, async () => {
      const response = await ses.fetch(`http://127.0.0.1:${port}/headers`)
      const body = await response.json()
      assert(body.kitchen === 'rewritten', `server saw ${JSON.stringify(body)}`)
      assert(response.headers.get('x-added') === 'by-listener', `x-added ${response.headers.get('x-added')}`)
      assert(response.headers.get('x-server') === 'kitchen', 'server headers kept')
      return 'request and response headers rewritten'
    })
  }) },
  { id: 'webRequest.onBeforeRequest cancel / redirect (session.fetch)', run: () => withServer(echoServer(), async (port, hits) => {
    const ses = session.fromPartition('kitchen-webrequest')
    const base = `http://127.0.0.1:${port}`
    return withListeners(ses, {
      onBeforeRequest: [{ urls: [`${base}/*`] }, (details, callback) => {
        if (details.url.endsWith('/blocked')) return callback({ cancel: true })
        if (details.url.endsWith('/moved')) return callback({ redirectURL: `${base}/target` })
        callback({})
      }],
    }, async () => {
      const blocked = await ses.fetch(`${base}/blocked`).then(() => 'resolved', (error) => String(error?.message ?? error))
      assert(/ERR_BLOCKED_BY_CLIENT/.test(blocked), `blocked: ${blocked}`)
      const moved = await (await ses.fetch(`${base}/moved`)).json()
      assert(moved.url === '/target', `moved to ${moved.url}`)
      assert(!hits.some((hit) => hit.url === '/blocked' || hit.url === '/moved'), `server hits ${hits.map((h) => h.url)}`)
      return 'blocked, then redirected to /target'
    })
  }) },
  { id: 'webRequest.onBeforeRedirect / onCompleted (session.fetch)', run: () => withServer(echoServer(), async (port) => {
    const ses = session.fromPartition('kitchen-webrequest')
    const filter = { urls: [`http://127.0.0.1:${port}/*`] }
    const events = []
    return withListeners(ses, {
      onBeforeRedirect: [filter, (details) => events.push(`redirect ${new URL(details.url).pathname} → ${new URL(details.redirectURL).pathname} (${details.statusCode})`)],
      onCompleted: [filter, (details) => events.push(`completed ${new URL(details.url).pathname} (${details.statusCode})`)],
    }, async () => {
      const response = await ses.fetch(`http://127.0.0.1:${port}/old`)
      const body = await response.json()
      await until(() => events.some((e) => e.startsWith('completed')), 'onCompleted', 5000)
      assert(body.url === '/final', `followed to ${body.url}`)
      assert(events[0] === 'redirect /old → /final (302)', events.join('; '))
      assert(events.includes('completed /final (200)'), events.join('; '))
      return events.join('; ')
    })
  }) },
  { id: 'webRequest around protocol.handle (kitchen://)', run: async () => {
    if (!(await protocol.isProtocolHandled('kitchen'))) {
      protocol.handle('kitchen', (request) => new Response(`<title>kitchen</title>hello from ${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html' } }))
    }
    const ses = session.defaultSession
    const filter = { urls: ['kitchen://*/*'] }
    const completed = []
    return withListeners(ses, {
      onBeforeRequest: [filter, (details, callback) => callback(details.url.endsWith('/webrequest-old') ? { redirectURL: 'kitchen://localhost/webrequest-new' } : {})],
      onCompleted: [filter, (details) => completed.push(details)],
    }, () => withWindow('kitchen://localhost/webrequest-old', async (win) => {
      await until(() => completed.some((d) => d.url.endsWith('/webrequest-new')), 'onCompleted for the redirect target')
      const done = completed.find((d) => d.url.endsWith('/webrequest-new'))
      assert(done.statusCode === 200, `status ${done.statusCode}`)
      assert(done.webContentsId === win.webContents.id, `webContentsId ${done.webContentsId}`)
      return `${done.url} (${done.resourceType})`
    }))
  } },
  { id: "webRequest.onCompleted reports a page's requests", run: async () => {
    if (!isElectron && process.platform === 'darwin') throw unsupported('WKWebView does not report the requests of pages')
    const server = http.createServer((req, res) => {
      const css = req.url === '/style.css'
      res.writeHead(200, { 'content-type': css ? 'text/css' : 'text/html' })
      res.end(css ? 'body { color: green }' : '<!doctype html><title>page</title><link rel="stylesheet" href="/style.css">page')
    })
    return withServer(server, async (port) => {
      const ses = session.defaultSession
      const completed = []
      return withListeners(ses, { onCompleted: [{ urls: [`http://127.0.0.1:${port}/*`] }, (details) => completed.push(details)] }, () => withWindow(`http://127.0.0.1:${port}/page`, async (win) => {
        await until(() => completed.some((d) => d.url.endsWith('/style.css')), 'onCompleted for the stylesheet')
        const page = completed.find((d) => d.url.endsWith('/page'))
        const style = completed.find((d) => d.url.endsWith('/style.css'))
        assert(page && page.statusCode === 200 && page.resourceType === 'mainFrame', `page ${JSON.stringify(page && { statusCode: page.statusCode, resourceType: page.resourceType })}`)
        assert(style.resourceType === 'stylesheet', `style ${style.resourceType}`)
        assert(page.webContentsId === win.webContents.id, 'webContentsId')
        return completed.map((d) => `${new URL(d.url).pathname} ${d.statusCode}`).join(', ')
      }))
    })
  } },
  { id: "webRequest.onBeforeRequest cancels a page's request", run: async () => {
    if (!isElectron && process.platform !== 'win32') throw unsupported(`page requests cannot be cancelled on ${process.platform === 'darwin' ? 'macOS (WKWebView)' : 'Linux (WebKitGTK)'}`)
    const server = http.createServer((req, res) => {
      const css = req.url === '/blocked.css'
      res.writeHead(200, { 'content-type': css ? 'text/css' : 'text/html' })
      res.end(css ? '' : '<!doctype html><link rel="stylesheet" href="/blocked.css">page')
    })
    return withServer(server, async (port, hits) => {
      const ses = session.defaultSession
      const errors = []
      return withListeners(ses, {
        onBeforeRequest: [{ urls: [`http://127.0.0.1:${port}/blocked.css`] }, (details, callback) => callback({ cancel: true })],
        onErrorOccurred: [{ urls: [`http://127.0.0.1:${port}/*`] }, (details) => errors.push(details.error)],
      }, () => withWindow(`http://127.0.0.1:${port}/page`, async () => {
        await until(() => hits.some((h) => h.url === '/page'), 'the page request')
        await sleep(1000)
        assert(!hits.some((h) => h.url === '/blocked.css'), 'the stylesheet reached the server')
        return `blocked ${errors.join(', ') || '(no onErrorOccurred)'}`
      }))
    })
  } },

  // --- C10: certificate errors, setCertificateVerifyProc, login ------------------------------------
  { id: "app 'certificate-error' (untrusted → did-fail-load)", run: async () => {
    if (!isElectron && process.platform === 'darwin') throw unsupported('WKWebView does not report certificate errors through Tauri')
    const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => res.end('secret'))
    server.on('tlsClientError', () => {})
    return withServer(server, async (port, hits) => {
      const seen = []
      const listener = (event, webContents, url, error) => seen.push(error)
      app.on('certificate-error', listener)
      try {
        // 127.0.0.1 here; the trust check below uses localhost (exceptions are per host).
        return await withWindow(`https://127.0.0.1:${port}/`, async (win) => {
          const [, code, description] = await waitFor(win.webContents, 'did-fail-load', 15000)
          assert(seen[0] === 'net::ERR_CERT_AUTHORITY_INVALID', `certificate-error ${seen[0]}`)
          assert(code === -202 && description === 'ERR_CERT_AUTHORITY_INVALID', `did-fail-load ${code} ${description}`)
          assert(hits.length === 0, 'no request reached the server')
          return `${code} ${description}`
        })
      } finally {
        app.removeListener('certificate-error', listener)
      }
    })
  } },
  { id: "setCertificateVerifyProc + 'certificate-error' trusts a self-signed server", run: async () => {
    if (!isElectron && process.platform === 'darwin') throw unsupported('WKWebView does not report certificate errors through Tauri')
    const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>trusted</title>trusted')
    })
    server.on('tlsClientError', () => {})
    return withServer(server, async (port, hits) => {
      const ses = session.defaultSession
      const asked = []
      ses.setCertificateVerifyProc((request, callback) => {
        if (request.hostname === 'localhost') asked.push({ error: request.verificationResult, subject: request.certificate.subjectName })
        callback(-3) // let Chromium's result (and 'certificate-error') decide
      })
      let certificate = null
      const listener = (event, webContents, url, error, cert, callback) => {
        if (!url.startsWith(`https://localhost:${port}`)) return
        certificate = cert
        event.preventDefault()
        callback(true)
      }
      app.on('certificate-error', listener)
      try {
        return await withWindow(`https://localhost:${port}/`, async () => {
          await until(() => hits.length > 0, 'the trusted page request', 15000)
          assert(certificate?.subjectName === 'localhost', `certificate ${certificate?.subjectName}`)
          assert(certificate.issuerName === 'tauri-electron kitchen-sink test CA', `issuer ${certificate.issuerName}`)
          assert(/^sha256\//.test(certificate.fingerprint), `fingerprint ${certificate.fingerprint}`)
          assert(asked.some((a) => a.error === 'net::ERR_CERT_AUTHORITY_INVALID' && a.subject === 'localhost'), `verify proc ${JSON.stringify(asked)}`)
          return `trusted ${certificate.subjectName} (${certificate.fingerprint.slice(0, 20)}…)`
        })
      } finally {
        app.removeListener('certificate-error', listener)
        ses.setCertificateVerifyProc(null)
      }
    })
  } },
  { id: "app 'login' answers HTTP Basic authentication", run: async () => {
    if (!isElectron && process.platform === 'darwin') throw unsupported('WKWebView does not report authentication challenges through Tauri')
    const expected = `Basic ${btoa('kitchen:sink')}`
    const server = http.createServer((req, res) => {
      const welcome = req.headers.authorization === expected
      res.writeHead(welcome ? 200 : 401, welcome ? { 'content-type': 'text/html' } : { 'www-authenticate': 'Basic realm="kitchen"', 'content-type': 'text/plain' })
      res.end(welcome ? 'welcome' : 'who are you?')
    })
    return withServer(server, async (port, hits) => {
      let info = null
      const listener = (event, webContents, details, authInfo, callback) => {
        if (authInfo.port !== port) return
        info = { url: details.url, ...authInfo }
        event.preventDefault()
        callback('kitchen', 'sink')
      }
      app.on('login', listener)
      try {
        return await withWindow(`http://127.0.0.1:${port}/private`, async () => {
          await until(() => hits.some((h) => h.headers.authorization === expected), 'a request with the credentials')
          assert(info && info.scheme === 'basic' && info.realm === 'kitchen' && info.host === '127.0.0.1' && info.isProxy === false, JSON.stringify(info))
          return `${info.scheme} realm="${info.realm}" for ${info.host}:${info.port}`
        })
      } finally {
        app.removeListener('login', listener)
      }
    })
  } },
]
