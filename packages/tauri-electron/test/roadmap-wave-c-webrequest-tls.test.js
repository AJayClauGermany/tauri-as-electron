import { beforeEach, describe, expect, it, vi } from 'vitest'

// Roadmap wave C: session.webRequest applied (C7) and TLS / auth events
// (C10), with plugin-http and tauri-plugin-electron replaced by scripted fakes.
const state = vi.hoisted(() => ({ commands: [], onCommand: null, plugin: true, responses: [] }))

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async (input, init) => {
    const next = state.responses.shift()
    if (!next) return new Response('default', { status: 200 })
    return typeof next === 'function' ? next(input, init) : next
  }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn(async () => null), message: vi.fn() }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    constructor(label, options) {
      this.label = label
      this.options = options
      this.listeners = {}
    }
    once(event, handler) { (this.listeners[event] ??= []).push(handler) }
    emit(event, payload) { for (const handler of this.listeners[event] ?? []) handler({ event, payload }) }
  },
}))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    hasNativePlugin: () => state.plugin,
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand?.(command, args)
    },
  }
})

const { parseMatchPattern, compileFilter, filterMatches, configureWebRequest, onPageRequest, guessResourceType, canonicalHeaderName, pageErrorName } = await import('../src/main/web-request.js')
const { certificateFromPem } = await import('../src/main/certificate.js')
const { onCertificateError, onLogin, onSelectClientCertificate, configureTlsAuth, certificateErrorOf } = await import('../src/main/tls-auth.js')
const { session } = await import('../src/main/session.js')
const { net, parseAuthenticate } = await import('../src/main/net.js')
const { protocol, onRequest } = await import('../src/main/protocol.js')
const { EventEmitter } = await import('../src/internal/emitter.js')
const { CA, CERT } = await import('../../../apps/kitchen-sink/src/fixtures/tls-test-cert.js')
const httpFetch = (await import('@tauri-apps/plugin-http')).fetch

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const ses = session.defaultSession

function clearListeners(target = ses) {
  for (const name of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) target.webRequest[name](null)
}

/** A webContents-like emitter for a window label. */
function fakeContents(id = 7, session = ses) {
  const contents = new EventEmitter()
  Object.assign(contents, { id, session, mainFrame: { url: 'x' }, _win: { _loadWaiters: [] } })
  return contents
}

beforeEach(() => {
  state.commands = []
  state.onCommand = null
  state.plugin = true
  state.responses = []
  httpFetch.mockClear()
  clearListeners()
  ses.setCertificateVerifyProc(null)
})

describe('match patterns and filters', () => {
  it('matches like Chrome match patterns', () => {
    const url = (u) => new URL(u)
    expect(parseMatchPattern('<all_urls>').test(url('app://x/y'))).toBe(true)
    const any = parseMatchPattern('*://*.example.com/*')
    expect(any.test(url('https://example.com/a'))).toBe(true)
    expect(any.test(url('http://www.example.com:8080/a?b'))).toBe(true)
    expect(any.test(url('https://example.org/'))).toBe(false)
    expect(any.test(url('ftp://example.com/'))).toBe(false)
    const path = parseMatchPattern('https://api.test/v1/*')
    expect(path.test(url('https://api.test/v1/users?id=2'))).toBe(true)
    expect(path.test(url('https://api.test/v2/users'))).toBe(false)
    expect(parseMatchPattern('http://localhost:3000/*').test(url('http://localhost:3001/'))).toBe(false)
    expect(parseMatchPattern('http://localhost/*').test(url('http://localhost:3001/'))).toBe(true)
    expect(parseMatchPattern('app://*/*').test(url('app://bundle/index.html'))).toBe(true)
    expect(parseMatchPattern('file:///*').test(url('file:///etc/hosts'))).toBe(true)
  })

  it('rejects invalid patterns with a TypeError, as Electron does', () => {
    expect(() => parseMatchPattern('example.com')).toThrow(TypeError)
    expect(() => parseMatchPattern('https://example.com')).toThrow(/Empty path/)
    expect(() => parseMatchPattern('https://a*.com/')).toThrow(/wildcard/)
    expect(() => ses.webRequest.onBeforeRequest({ urls: ['nope'] }, () => {})).toThrow(TypeError)
    expect(() => compileFilter({ urls: [], types: ['bogus'] })).toThrow(/Invalid type/)
  })

  it('applies urls, excludeUrls and types', () => {
    const filter = compileFilter({ urls: ['*://*.test/*'], excludeUrls: ['*://private.test/*'], types: ['xhr', 'script'] })
    expect(filterMatches(filter, 'https://a.test/x', 'xhr')).toBe(true)
    expect(filterMatches(filter, 'https://private.test/x', 'xhr')).toBe(false)
    expect(filterMatches(filter, 'https://a.test/x', 'image')).toBe(false)
    expect(filterMatches(compileFilter({ urls: [] }), 'https://any.where/', 'other')).toBe(true)
    expect(filterMatches(null, 'whatever', 'other')).toBe(true)
  })

  it('guesses resource types and canonical header names', () => {
    expect(guessResourceType('app://x/main.js')).toBe('script')
    expect(guessResourceType('app://x/', [['Sec-Fetch-Dest', 'iframe']])).toBe('subFrame')
    expect(guessResourceType('app://x/page', { Accept: 'text/html,*/*' })).toBe('mainFrame')
    expect(guessResourceType('app://x/data')).toBe('other')
    expect(canonicalHeaderName('user-agent')).toBe('User-Agent')
    expect(canonicalHeaderName('X-Custom')).toBe('X-Custom')
  })
})

describe('webRequest listeners', () => {
  it('keeps one listener per event, removes it with null and tells Rust which events windows need', () => {
    configureWebRequest({ windows: () => [{ isDestroyed: () => false, _label: 'w1', webContents: { session: ses } }] })
    const first = vi.fn()
    ses.webRequest.onCompleted(first)
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({}))
    expect(ses.webRequest._events()).toEqual(['onBeforeRequest', 'onCompleted'])
    expect(state.commands.at(-1)).toEqual({ command: 'web_request_listeners', args: { labels: ['w1'], events: ['onBeforeRequest', 'onCompleted'] } })
    ses.webRequest.onBeforeRequest(null)
    expect(ses.webRequest._events()).toEqual(['onCompleted'])
    configureWebRequest({ windows: () => [] })
  })
})

describe('net.fetch with webRequest', () => {
  it('goes straight to plugin-http without listeners', async () => {
    state.responses.push(new Response('plain'))
    const response = await net.fetch('https://x.test/a', { headers: { a: '1' } })
    expect(await response.text()).toBe('plain')
    expect(httpFetch).toHaveBeenCalledTimes(1)
    expect(httpFetch.mock.calls[0][0]).toBe('https://x.test/a')
    expect(httpFetch.mock.calls[0][1].maxRedirections).toBeUndefined()
  })

  it('cancels in onBeforeRequest with net::ERR_BLOCKED_BY_CLIENT and reports onErrorOccurred', async () => {
    const errors = []
    ses.webRequest.onBeforeRequest({ urls: ['https://blocked.test/*'] }, (details, callback) => callback({ cancel: true }))
    ses.webRequest.onErrorOccurred((details) => errors.push([details.url, details.error]))
    await expect(net.fetch('https://blocked.test/x')).rejects.toThrow('net::ERR_BLOCKED_BY_CLIENT')
    expect(httpFetch).not.toHaveBeenCalled()
    expect(errors).toEqual([['https://blocked.test/x', 'net::ERR_BLOCKED_BY_CLIENT']])
    // Other URLs pass the filter untouched.
    state.responses.push(new Response('ok'))
    expect(await (await net.fetch('https://open.test/')).text()).toBe('ok')
  })

  it('redirects in onBeforeRequest, then asks again for the new URL', async () => {
    const seen = []
    ses.webRequest.onBeforeRequest((details, callback) => {
      seen.push(details.url)
      callback(details.url.includes('old') ? { redirectURL: 'https://new.test/b' } : {})
    })
    const redirects = []
    ses.webRequest.onBeforeRedirect((details) => redirects.push([details.url, details.redirectURL, details.statusCode]))
    state.responses.push(new Response('new'))
    const response = await net.fetch('https://old.test/a')
    expect(await response.text()).toBe('new')
    expect(seen).toEqual(['https://old.test/a', 'https://new.test/b'])
    expect(redirects).toEqual([['https://old.test/a', 'https://new.test/b', 307]])
    expect(httpFetch.mock.calls[0][0]).toBe('https://new.test/b')
    expect(response.redirected).toBe(true)
  })

  it('rewrites request headers in onBeforeSendHeaders; onSendHeaders sees them', async () => {
    let sent
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      expect(details.requestHeaders['User-Agent']).toBe('original')
      expect(details.method).toBe('POST')
      expect(new TextDecoder().decode(details.uploadData[0].bytes)).toBe('body')
      const requestHeaders = { ...details.requestHeaders, 'User-Agent': 'Rewritten/1.0', Referer: 'https://www.youtube.com/' }
      delete requestHeaders['X-Drop']
      callback({ requestHeaders })
    })
    ses.webRequest.onSendHeaders((details) => (sent = details.requestHeaders))
    state.responses.push(new Response('ok'))
    await net.fetch('https://x.test/', { method: 'POST', body: 'body', headers: { 'user-agent': 'original', 'X-Drop': '1' } })
    const headers = new Map(httpFetch.mock.calls[0][1].headers.map(([k, v]) => [k.toLowerCase(), v]))
    expect(headers.get('user-agent')).toBe('Rewritten/1.0')
    expect(headers.get('referer')).toBe('https://www.youtube.com/')
    expect(headers.has('x-drop')).toBe(false)
    expect(sent['User-Agent']).toBe('Rewritten/1.0')
    expect(new TextDecoder().decode(httpFetch.mock.calls[0][1].body)).toBe('body')
  })

  it('rewrites response headers and the status line in onHeadersReceived', async () => {
    ses.webRequest.onHeadersReceived((details, callback) => {
      expect(details.statusLine).toBe('HTTP/1.1 403 Forbidden')
      expect(details.responseHeaders['x-old']).toEqual(['1'])
      callback({
        responseHeaders: { ...details.responseHeaders, 'Access-Control-Allow-Origin': ['*'], 'Content-Security-Policy': ["default-src 'self'"] },
        statusLine: 'HTTP/1.1 200 OK',
      })
    })
    state.responses.push(new Response('body', { status: 403, statusText: 'Forbidden', headers: { 'x-old': '1' } }))
    const response = await net.fetch('https://x.test/')
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(response.headers.get('x-old')).toBe('1')
    expect(await response.text()).toBe('body')
  })

  it('follows redirects itself so that onBeforeRedirect fires, and reports onCompleted after the body', async () => {
    const events = []
    ses.webRequest.onBeforeRedirect((d) => events.push(['redirect', d.url, d.redirectURL, d.statusCode]))
    ses.webRequest.onResponseStarted((d) => events.push(['started', d.url, d.statusCode]))
    ses.webRequest.onCompleted((d) => events.push(['completed', d.url, d.statusCode, d.error]))
    state.responses.push(new Response(null, { status: 302, headers: { location: '/final' } }))
    state.responses.push(new Response('done'))
    const response = await net.fetch('https://x.test/start')
    expect(httpFetch.mock.calls.map((c) => [c[0], c[1].maxRedirections])).toEqual([['https://x.test/start', 0], ['https://x.test/final', 0]])
    expect(events).toEqual([
      ['redirect', 'https://x.test/start', 'https://x.test/final', 302],
      ['started', 'https://x.test/final', 200],
    ])
    expect(await response.text()).toBe('done')
    expect(events.at(-1)).toEqual(['completed', 'https://x.test/final', 200, 'net::OK'])
    expect(response.redirected).toBe(true)
  })

  it("applies a session's own listeners to session.fetch and net.request({ session })", async () => {
    const other = session.fromPartition('wave-c-other')
    const own = vi.fn((details, callback) => callback({ cancel: true }))
    other.webRequest.onBeforeRequest(own)
    await expect(other.fetch('https://x.test/')).rejects.toThrow('net::ERR_BLOCKED_BY_CLIENT')
    const errored = new Promise((resolve) => net.request({ url: 'https://x.test/r', session: other }).on('error', resolve).end())
    expect((await errored).message).toBe('net::ERR_BLOCKED_BY_CLIENT')
    // The default session has no listener: its requests pass.
    state.responses.push(new Response('fine'))
    expect(await (await net.fetch('https://x.test/')).text()).toBe('fine')
    expect(own).toHaveBeenCalledTimes(2)
    clearListeners(other)
  })
})

describe("ClientRequest 'login'", () => {
  it('parses challenges', () => {
    expect(parseAuthenticate('Basic realm="Kitchen \\"sink\\""')).toEqual({ scheme: 'basic', realm: 'Kitchen "sink"' })
    expect(parseAuthenticate('Digest realm=x, nonce="y"')).toEqual({ scheme: 'digest', realm: 'x' })
    expect(parseAuthenticate(null)).toBeNull()
  })

  it('retries with Basic credentials from the listener', async () => {
    state.responses.push(new Response('no', { status: 401, headers: { 'www-authenticate': 'Basic realm="sink"' } }))
    state.responses.push((input, init) => new Response(`auth ${new Headers(init.headers).get('authorization')}`))
    const request = net.request('http://x.test:8080/secret')
    const logins = []
    request.on('login', (authInfo, callback) => {
      logins.push(authInfo)
      callback('user', 'pass')
    })
    const body = new Promise((resolve) => request.on('response', (message) => {
      let text = ''
      message.on('data', (chunk) => (text += new TextDecoder().decode(chunk)))
      message.on('end', () => resolve([message.statusCode, text]))
    }))
    request.end()
    expect(await body).toEqual([200, `auth Basic ${btoa('user:pass')}`])
    expect(logins).toEqual([{ isProxy: false, scheme: 'basic', host: 'x.test', port: 8080, realm: 'sink' }])
  })
})

describe('protocol.handle with webRequest', () => {
  const handled = []
  beforeEach(() => {
    handled.length = 0
    protocol.unhandle('wavec')
    protocol.handle('wavec', (request) => {
      handled.push([request.url, request.headers.get('x-added')])
      return new Response(`served ${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html' } })
    })
  })
  const contents = fakeContents(11)
  const payload = (path, extra = {}) => ({ scheme: 'wavec', from: 'w-proto', url: `wavec://app${path}`, method: 'GET', headers: [['accept', 'text/html']], ...extra })
  const decode = (response) => new TextDecoder().decode(Uint8Array.from(atob(response.body), (c) => c.charCodeAt(0)))

  it('passes the page’s requests through its session’s listeners', async () => {
    configureWebRequest({ webContentsFromLabel: (label) => (label === 'w-proto' ? contents : null) })
    const seen = []
    ses.webRequest.onBeforeSendHeaders({ urls: ['wavec://*/*'] }, (details, callback) => {
      seen.push([details.url, details.resourceType, details.webContentsId, details.webContents === contents])
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Added': 'yes' } })
    })
    ses.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'none'"] } }))
    const completed = vi.fn()
    ses.webRequest.onCompleted(completed)
    const response = await onRequest(payload('/index.html'))
    expect(decode(response)).toBe('served /index.html')
    expect(response.headers).toContainEqual(['content-security-policy', "default-src 'none'"])
    expect(handled).toEqual([['wavec://app/index.html', 'yes']])
    expect(seen).toEqual([['wavec://app/index.html', 'mainFrame', 11, true]])
    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed.mock.calls[0][0].statusCode).toBe(200)
  })

  it('answers a cancelled request with 403 and serves a redirect in place', async () => {
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.endsWith('/blocked.js')) return callback({ cancel: true })
      if (details.url.endsWith('/old.html')) return callback({ redirectURL: 'wavec://app/new.html' })
      callback({})
    })
    expect((await onRequest(payload('/blocked.js'))).status).toBe(403)
    const moved = await onRequest(payload('/old.html'))
    expect(decode(moved)).toBe('served /new.html')
    expect(handled.map(([url]) => url)).toEqual(['wavec://app/new.html'])
  })
})

describe('page requests from tauri-plugin-electron', () => {
  const contents = fakeContents(21)
  beforeEach(() => configureWebRequest({ webContentsFromLabel: (label) => (label === 'w-page' ? contents : null) }))

  it('answers a held request (Windows) with cancel, redirect or headers', async () => {
    ses.webRequest.onBeforeRequest({ urls: ['*://ads.test/*'] }, (details, callback) => callback({ cancel: true }))
    ses.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: { ...details.requestHeaders, Origin: 'https://www.youtube.com' } }))
    await onPageRequest({ reply: 1, label: 'w-page', event: 'request', request: 5, url: 'https://ads.test/a.js', method: 'GET', resourceType: 'script', requestHeaders: [] })
    await onPageRequest({ reply: 2, label: 'w-page', event: 'request', request: 6, url: 'https://video.test/v', method: 'GET', resourceType: 'xhr', requestHeaders: [['Accept', '*/*']] })
    expect(state.commands).toEqual([
      { command: 'web_request_respond', args: { reply: 1, cancel: true } },
      { command: 'web_request_respond', args: { reply: 2, redirectUrl: null, requestHeaders: [['Accept', '*/*'], ['Origin', 'https://www.youtube.com']] } },
    ])
  })

  it('answers a redirect under the argument name the Rust command reads', async () => {
    ses.webRequest.onBeforeRequest({ urls: ['*://old.test/*'] }, (details, callback) => callback({ redirectURL: 'https://new.test/x' }))
    await onPageRequest({ reply: 3, label: 'w-page', event: 'request', request: 7, url: 'https://old.test/x', method: 'GET', resourceType: 'mainFrame', requestHeaders: [] })
    expect(state.commands).toEqual([{ command: 'web_request_respond', args: { reply: 3, redirectUrl: 'https://new.test/x', requestHeaders: null } }])
  })

  it('reports what WebKitGTK / WebView2 saw to the listeners', async () => {
    const seen = []
    ses.webRequest.onCompleted((d) => seen.push(['completed', d.id, d.url, d.statusCode, d.responseHeaders, d.webContents === contents, d.resourceType]))
    ses.webRequest.onErrorOccurred((d) => seen.push(['error', d.error]))
    ses.webRequest.onBeforeRedirect((d) => seen.push(['redirect', d.url, d.redirectURL]))
    await onPageRequest({ reply: 0, label: 'w-page', event: 'onBeforeRedirect', request: 9, url: 'https://a.test/', redirectURL: 'https://b.test/', statusCode: 301 })
    await onPageRequest({ reply: 0, label: 'w-page', event: 'onCompleted', request: 9, url: 'https://b.test/', resourceType: 'mainFrame', statusCode: 200, responseHeaders: [['Content-Type', 'text/html']] })
    await onPageRequest({ reply: 0, label: 'w-page', event: 'onErrorOccurred', request: 10, url: 'https://c.test/', error: { domain: 'g-resolver-error-quark', code: 0 } })
    expect(seen).toEqual([
      ['redirect', 'https://a.test/', 'https://b.test/'],
      ['completed', 9, 'https://b.test/', 200, { 'Content-Type': ['text/html'] }, true, 'mainFrame'],
      ['error', 'net::ERR_NAME_NOT_RESOLVED'],
    ])
    expect(state.commands).toEqual([])
    expect(pageErrorName({ domain: 'WebKitNetworkError', code: 302 })).toBe('net::ERR_ABORTED')
  })
})

describe('certificates', () => {
  it('reads Electron’s Certificate fields from PEM', () => {
    const certificate = certificateFromPem([CERT, CA])
    expect(certificate.subjectName).toBe('localhost')
    expect(certificate.issuerName).toBe('tauri-electron kitchen-sink test CA')
    expect(certificate.serialNumber).toBe('03CBBD0174CFDAAAC7FF555C83B60A885655AAC9')
    expect(certificate.validStart).toBe(Date.UTC(2025, 0, 1) / 1000)
    expect(certificate.validExpiry).toBe(Date.UTC(2125, 0, 1) / 1000)
    expect(certificate.fingerprint).toBe('sha256/U+wNhBz0hkDSfrXqo3k/tAeYiks0vAecez9qr2eYrTs=')
    expect(certificate.data).toMatch(/^-----BEGIN CERTIFICATE-----\n/)
    expect(certificate.issuerCert.subjectName).toBe('tauri-electron kitchen-sink test CA')
    expect(certificate.issuerCert.issuerCert).toBeUndefined()
  })

  it('maps platform certificate problems to Chromium errors', () => {
    expect(certificateErrorOf(['unknown-ca', 'bad-identity'])).toEqual({ name: 'net::ERR_CERT_AUTHORITY_INVALID', code: -202 })
    expect(certificateErrorOf(['expired'])).toEqual({ name: 'net::ERR_CERT_DATE_INVALID', code: -201 })
    expect(certificateErrorOf([])).toEqual({ name: 'net::ERR_CERT_INVALID', code: -207 })
  })
})

describe("'certificate-error' and setCertificateVerifyProc", () => {
  const app = new EventEmitter()
  let contents
  beforeEach(() => {
    contents = fakeContents(31)
    configureTlsAuth({ webContentsFromLabel: (label) => (label === 'w-tls' ? contents : null) })
    app.removeAllListeners?.('certificate-error')
  })
  const payload = { id: 4, label: 'w-tls', url: 'https://localhost:8443/', errors: ['unknown-ca'], certificate: [CERT, CA], isMainFrame: true }
  const answers = () => state.commands.filter((c) => c.command === 'tls_auth_respond').map((c) => c.args)

  it('rejects by default: did-fail-load and loadURL() rejects', async () => {
    const failed = vi.fn()
    contents.on('did-fail-load', failed)
    const waiter = { resolve: vi.fn(), reject: vi.fn() }
    contents._win._loadWaiters.push(waiter)
    await onCertificateError(payload, app)
    expect(answers()).toEqual([{ id: 4, answer: { trusted: false } }])
    expect(failed.mock.calls[0].slice(1, 5)).toEqual([-202, 'ERR_CERT_AUTHORITY_INVALID', 'https://localhost:8443/', true])
    expect(waiter.reject.mock.calls[0][0].message).toBe("ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://localhost:8443/'")
  })

  it('trusts when a listener prevents the default and calls back with true', async () => {
    const order = []
    contents.on('certificate-error', (event, url, error, certificate) => order.push(['webContents', url, error, certificate.subjectName]))
    app.on('certificate-error', (event, webContents, url, error, certificate, callback, isMainFrame) => {
      order.push(['app', webContents === contents, isMainFrame])
      event.preventDefault()
      setTimeout(() => callback(true), 0)
    })
    await onCertificateError(payload, app)
    await flush()
    expect(order).toEqual([['webContents', 'https://localhost:8443/', 'net::ERR_CERT_AUTHORITY_INVALID', 'localhost'], ['app', true, true]])
    expect(answers()).toEqual([{ id: 4, answer: { trusted: true } }])
  })

  it('asks setCertificateVerifyProc first: 0 trusts, -2 rejects, -3 defers to certificate-error', async () => {
    const requests = []
    ses.setCertificateVerifyProc((request, callback) => {
      requests.push(request)
      callback(request.certificate.fingerprint === 'sha256/U+wNhBz0hkDSfrXqo3k/tAeYiks0vAecez9qr2eYrTs=' ? 0 : -2)
    })
    const listener = vi.fn()
    app.on('certificate-error', listener)
    await onCertificateError(payload, app)
    expect(requests[0]).toMatchObject({ hostname: 'localhost', verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', errorCode: -202 })
    expect(listener).not.toHaveBeenCalled()
    ses.setCertificateVerifyProc((request, callback) => callback(-2))
    await onCertificateError({ ...payload, id: 5 }, app)
    ses.setCertificateVerifyProc((request, callback) => callback(-3))
    await onCertificateError({ ...payload, id: 6 }, app)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(answers()).toEqual([{ id: 4, answer: { trusted: true } }, { id: 5, answer: { trusted: false } }, { id: 6, answer: { trusted: false } }])
    app.removeListener('certificate-error', listener)
  })
})

describe("'login' and 'select-client-certificate'", () => {
  const app = new EventEmitter()
  const contents = fakeContents(41)
  beforeEach(() => configureTlsAuth({ webContentsFromLabel: () => contents }))
  const answers = () => state.commands.filter((c) => c.command === 'tls_auth_respond').map((c) => c.args)

  it('cancels without a listener and answers with the callback’s credentials', () => {
    onLogin({ id: 1, label: 'w', url: 'http://localhost:1/', scheme: 'basic', host: 'localhost', port: 1, realm: 'r', isProxy: false }, app)
    const seen = []
    const onApp = (event, webContents, details, authInfo, callback) => {
      seen.push([webContents === contents, details.url, authInfo])
      event.preventDefault()
      callback('user', 'secret')
    }
    app.on('login', onApp)
    onLogin({ id: 2, label: 'w', url: 'http://localhost:1/', scheme: 'basic', host: 'localhost', port: 1, realm: 'r', isProxy: false }, app)
    app.removeListener('login', onApp)
    expect(seen).toEqual([[true, 'http://localhost:1/', { isProxy: false, scheme: 'basic', host: 'localhost', port: 1, realm: 'r' }]])
    expect(answers()).toEqual([{ id: 1, answer: { cancel: true } }, { id: 2, answer: { username: 'user', password: 'secret' } }])
  })

  it('picks the first client certificate unless a listener chooses', () => {
    onSelectClientCertificate({ id: 3, label: 'w', url: 'https://x.test:443', certificates: [[CERT], [CA]] }, app)
    contents.once('select-client-certificate', (event, url, list, callback) => {
      event.preventDefault()
      callback(list[1])
    })
    onSelectClientCertificate({ id: 4, label: 'w', url: 'https://x.test:443', certificates: [[CERT], [CA]] }, app)
    contents.once('select-client-certificate', (event, url, list, callback) => {
      event.preventDefault()
      callback()
    })
    onSelectClientCertificate({ id: 5, label: 'w', url: 'https://x.test:443', certificates: [[CERT]] }, app)
    expect(answers()).toEqual([{ id: 3, answer: { certificate: 0 } }, { id: 4, answer: { certificate: 1 } }, { id: 5, answer: { certificate: -1 } }])
  })
})
