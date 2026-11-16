/**
 * session.webRequest, applied wherever tauri-electron sees the request.
 *
 * - `net.fetch`, `net.request` and `session.fetch` (plugin-http): every
 *   event. onBeforeRequest cancels or redirects, onBeforeSendHeaders
 *   rewrites the headers sent, onHeadersReceived rewrites the response's
 *   headers and status line (or cancels), redirects are followed here so
 *   that onBeforeRedirect fires and each hop goes through onBeforeRequest
 *   again, onCompleted fires when the body has been read.
 * - Custom schemes served by `protocol.handle()`: every event, around the
 *   handler. A redirect is served in place (the page keeps the URL it
 *   asked for); a cancelled request gets an empty 403 response.
 * - http(s) requests of BrowserWindow pages, through tauri-plugin-electron:
 *   on Windows (WebView2 `WebResourceRequested`) onBeforeRequest,
 *   onBeforeSendHeaders and onSendHeaders apply, and onResponseStarted /
 *   onCompleted are reported; on Linux (WebKitGTK) only the events that
 *   report (onSendHeaders, onBeforeRedirect, onResponseStarted, onCompleted,
 *   onErrorOccurred): WebKitGTK cannot change a page's requests from the UI
 *   process. macOS (WKWebView) reports nothing. A listener that could change
 *   a request is never called where its answer would be ignored.
 *
 * Like Electron, each event has at most one listener per session; filters
 * use Chrome's match patterns (`<all_urls>`, `*://*.example.com/*`), with
 * `excludeUrls` and `types`.
 */
import { report, warnOnce } from '../internal/runtime.js'
import { native, hasNativePlugin } from '../internal/native.js'
import { Buffer } from '../node/buffer.js'
import { platform } from '../process.js'
import { fetchDirect, setRequestHook, VIA_SESSION, VIA_PARTITION } from './net.js'

export const WEB_REQUEST_EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred',
]

/** Events whose listener answers through a callback. */
const BLOCKING = new Set(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived'])

const RESOURCE_TYPES = new Set(['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other'])
const MAX_REDIRECTS = 20

let resolveContents = () => null
let defaultSessionRef = null
let fromPartitionRef = null
let allWindows = () => []

/** session.js hands over what this module cannot import without a cycle. */
export function configureWebRequest({ defaultSession, webContentsFromLabel, fromPartition, windows }) {
  if (defaultSession) defaultSessionRef = defaultSession
  if (webContentsFromLabel) resolveContents = webContentsFromLabel
  if (fromPartition) fromPartitionRef = fromPartition
  if (windows) allWindows = windows
}

// --- match patterns -------------------------------------------------------------------------------

/**
 * A Chrome match pattern (`<scheme>://<host><path>`, `<all_urls>`), compiled.
 * Invalid patterns throw a TypeError like Electron's.
 */
export function parseMatchPattern(pattern) {
  pattern = String(pattern)
  if (pattern === '<all_urls>') return { pattern, test: () => true }
  const fail = (reason) => new TypeError(`Invalid url pattern ${pattern}: ${reason}`)
  const separator = pattern.indexOf('://')
  if (separator <= 0) throw fail('Missing scheme separator.')
  const scheme = pattern.slice(0, separator).toLowerCase()
  if (scheme !== '*' && !/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw fail('Invalid scheme.')
  const rest = pattern.slice(separator + 3)
  const slash = rest.indexOf('/')
  if (slash < 0) throw fail('Empty path.')
  let host = rest.slice(0, slash).toLowerCase()
  const path = rest.slice(slash)
  let port = '*'
  const portMatch = /^(.*?):(\*|\d+)$/.exec(host)
  if (portMatch && !host.endsWith(']')) [, host, port] = portMatch
  if (host === '' && scheme !== 'file' && scheme !== '*') throw fail('Empty host.')
  if (host.includes('*') && host !== '*' && !(host.startsWith('*.') && !host.slice(2).includes('*'))) throw fail('Invalid host wildcard.')
  const pathRegex = new RegExp(`^${path.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return {
    pattern,
    test(url) {
      const urlScheme = url.protocol.slice(0, -1).toLowerCase()
      if (scheme === '*' ? !['http', 'https', 'ws', 'wss'].includes(urlScheme) : scheme !== urlScheme) return false
      const urlHost = url.hostname.toLowerCase()
      if (host !== '*' && scheme !== 'file') {
        if (host.startsWith('*.')) {
          const base = host.slice(2)
          if (urlHost !== base && !urlHost.endsWith(`.${base}`)) return false
        } else if (urlHost !== host) {
          return false
        }
      }
      if (port !== '*') {
        const defaults = { http: '80', https: '443', ws: '80', wss: '443' }
        if ((url.port || defaults[urlScheme] || '') !== port) return false
      }
      return pathRegex.test(`${url.pathname}${url.search}`)
    },
  }
}

/** Electron's WebRequestFilter, compiled (null: everything). */
export function compileFilter(filter) {
  if (filter === null || filter === undefined) return null
  if (typeof filter !== 'object') throw new TypeError('webRequest: the filter must be an object')
  const urls = [...(filter.urls ?? [])].map(parseMatchPattern)
  const excludeUrls = [...(filter.excludeUrls ?? [])].map(parseMatchPattern)
  const types = filter.types === undefined ? null : [...filter.types].map(String)
  for (const type of types ?? []) {
    if (!RESOURCE_TYPES.has(type)) throw new TypeError(`Invalid type ${type}`)
  }
  return { urls, excludeUrls, types }
}

/** Whether a request (`url`, `resourceType`) passes a compiled filter. */
export function filterMatches(compiled, url, resourceType = 'other') {
  if (!compiled) return true
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (compiled.types && compiled.types.length && !compiled.types.includes(resourceType)) return false
  if (compiled.urls.length && !compiled.urls.some((p) => p.test(parsed))) return false
  return !compiled.excludeUrls.some((p) => p.test(parsed))
}

// --- the per-session object ----------------------------------------------------------------------------

/** What the listeners of a session apply to, said once per event and platform. */
function warnCoverage(name) {
  if (name === 'onHeadersReceived' && platform === 'win32') {
    warnOnce('webRequest.onHeadersReceived.win32', 'session.webRequest.onHeadersReceived(): applies to net.fetch / net.request and protocol.handle() schemes; WebView2 cannot change the response headers of http(s) page requests.')
  } else if (BLOCKING.has(name) && platform !== 'win32') {
    warnOnce(`webRequest.${name}`, `session.webRequest.${name}(): applies to net.fetch / net.request and protocol.handle() schemes; http(s) requests of pages cannot be changed on ${platform === 'darwin' ? 'macOS (WKWebView)' : 'Linux (WebKitGTK)'}.`)
  } else if (!BLOCKING.has(name) && platform === 'darwin') {
    warnOnce(`webRequest.${name}`, `session.webRequest.${name}(): reported for net.fetch / net.request and protocol.handle() schemes; WKWebView does not report the http(s) requests of pages.`)
  }
}

export class WebRequest {
  constructor(session) {
    Object.defineProperty(this, '_session', { value: session ?? null })
    this._listeners = {}
    this._filters = {}
    for (const name of WEB_REQUEST_EVENTS) {
      this[name] = (filterOrListener, maybeListener) => this._set(name, filterOrListener, maybeListener)
    }
  }

  _set(name, filterOrListener, maybeListener) {
    let filter = null
    let listener = filterOrListener
    if (maybeListener !== undefined || (filterOrListener !== null && typeof filterOrListener === 'object')) {
      filter = filterOrListener
      listener = maybeListener
    }
    if (listener !== null && listener !== undefined && typeof listener !== 'function') throw new TypeError(`webRequest.${name}: the listener must be a function`)
    const compiled = compileFilter(filter)
    this._listeners[name] = listener ?? null
    this._filters[name] = compiled
    if (listener) warnCoverage(name)
    if (this._session) syncWebRequest(this._session)
  }

  /** The events that have a listener. */
  _events() {
    return WEB_REQUEST_EVENTS.filter((name) => typeof this._listeners[name] === 'function')
  }

  _wants(name, details) {
    return typeof this._listeners[name] === 'function' && filterMatches(this._filters[name], details.url, details.resourceType)
  }

  /** A blocking event: the listener's answer (`{}` without one). */
  _ask(name, details) {
    if (!this._wants(name, details)) return Promise.resolve({})
    const listener = this._listeners[name]
    return new Promise((resolve) => {
      let answered = false
      const callback = (response) => {
        if (answered) return
        answered = true
        resolve(response && typeof response === 'object' ? response : {})
      }
      try {
        listener(details, callback)
      } catch (error) {
        report(`session.webRequest.${name} listener`)(error)
        callback({})
      }
    })
  }

  /** An event that only reports. */
  _tell(name, details) {
    if (!this._wants(name, details)) return
    try {
      this._listeners[name](details)
    } catch (error) {
      report(`session.webRequest.${name} listener`)(error)
    }
  }
}

/** Tell tauri-plugin-electron which events this session's windows listen to. */
export function syncWebRequest(session, windows = allWindows()) {
  if (!hasNativePlugin()) return
  const labels = windows.filter((win) => !win.isDestroyed() && win._label && win.webContents.session === session).map((win) => win._label)
  if (!labels.length) return
  native('web_request_listeners', { labels, events: session.webRequest._events() }).catch(report('session.webRequest'))
}

// --- details --------------------------------------------------------------------------------------------

let nextRequestId = 1

/** `user-agent` → `User-Agent` (Chromium hands headers over in this case). */
export function canonicalHeaderName(name) {
  name = String(name)
  if (name !== name.toLowerCase()) return name
  return name.replace(/(^|-)([a-z])/g, (_, dash, letter) => `${dash}${letter.toUpperCase()}`)
}

/** Request headers as Electron passes them: `{ Name: 'value' }`. */
export function requestHeaderObject(headers) {
  const out = {}
  for (const [name, value] of headerEntries(headers)) out[canonicalHeaderName(name)] = String(value)
  return out
}

/** Response headers as Electron passes them: `{ name: ['value', ...] }`. */
export function responseHeaderObject(headers) {
  const out = {}
  for (const [name, value] of headerEntries(headers)) {
    const key = Object.keys(out).find((k) => k.toLowerCase() === String(name).toLowerCase()) ?? String(name)
    out[key] = [...(out[key] ?? []), String(value)]
  }
  return out
}

function headerEntries(headers) {
  if (!headers) return []
  if (Array.isArray(headers)) return headers
  if (typeof headers.entries === 'function' && typeof headers.get === 'function') {
    // Headers joins set-cookie; keep each one.
    const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
    return [...headers.entries()].flatMap(([name, value]) => (name === 'set-cookie' && cookies.length ? cookies.map((c) => [name, c]) : [[name, value]]))
  }
  return Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((v) => [name, v]) : [[name, value]]))
}

/** `{ Name: value | [values] }` (a listener's answer) → `[[name, value], ...]`. */
export function headerPairs(object) {
  return headerEntries(object ?? {}).map(([name, value]) => [String(name), String(value)])
}

const REASONS = { 200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' }

export function statusLineOf(status, statusText) {
  return `HTTP/1.1 ${status} ${statusText || REASONS[status] || ''}`.trimEnd()
}

/** `HTTP/1.1 200 OK` → { status, statusText } (null when it does not parse). */
export function parseStatusLine(line) {
  const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/i.exec(String(line ?? '').trim())
  return match ? { status: Number(match[1]), statusText: match[2] ?? '' } : null
}

/** Guess Electron's resourceType from Sec-Fetch-Dest, Accept and the extension. */
export function guessResourceType(url, headers = {}) {
  const get = (name) => headerEntries(headers).find(([key]) => String(key).toLowerCase() === name)?.[1] ?? ''
  const dest = String(get('sec-fetch-dest')).toLowerCase()
  const byDest = { document: 'mainFrame', iframe: 'subFrame', frame: 'subFrame', style: 'stylesheet', script: 'script', worker: 'script', sharedworker: 'script', serviceworker: 'script', image: 'image', font: 'font', object: 'object', embed: 'object', audio: 'media', video: 'media', track: 'media', report: 'cspReport', empty: 'xhr' }
  if (byDest[dest]) return byDest[dest]
  const accept = String(get('accept')).toLowerCase()
  if (accept.startsWith('text/html')) return 'mainFrame'
  if (accept.startsWith('text/css')) return 'stylesheet'
  if (accept.startsWith('image/')) return 'image'
  let path = ''
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {}
  const ext = path.slice(path.lastIndexOf('.') + 1)
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'script'
  if (ext === 'css') return 'stylesheet'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp'].includes(ext)) return 'image'
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font'
  if (['mp3', 'mp4', 'webm', 'ogg', 'wav', 'm4a', 'flac', 'mov'].includes(ext)) return 'media'
  if (['html', 'htm'].includes(ext)) return 'mainFrame'
  return 'other'
}

function baseDetails(id, url, method, resourceType, referrer, webContents, uploadData) {
  const details = { id, url, method, resourceType, referrer: referrer ?? '', timestamp: Date.now() }
  if (webContents) {
    details.webContentsId = webContents.id
    details.webContents = webContents
    details.frame = resourceType === 'mainFrame' ? webContents.mainFrame ?? null : null
  }
  if (uploadData) details.uploadData = uploadData
  return details
}

function netError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/** An error from plugin-http / the bridge → Chromium's error name. */
export function netErrorName(error) {
  const message = String(error?.message ?? error ?? '')
  if (/^net::ERR_/.test(message)) return message.split(/\s/)[0]
  if (/cancel|abort/i.test(message) || error?.name === 'AbortError') return 'net::ERR_ABORTED'
  if (/certificate|UnknownIssuer|invalid peer cert|tls|ssl/i.test(message)) return 'net::ERR_CERT_AUTHORITY_INVALID'
  if (/dns|resolve|lookup|no such host|name or service/i.test(message)) return 'net::ERR_NAME_NOT_RESOLVED'
  if (/refused/i.test(message)) return 'net::ERR_CONNECTION_REFUSED'
  if (/timed? ?out/i.test(message)) return 'net::ERR_TIMED_OUT'
  if (/reset/i.test(message)) return 'net::ERR_CONNECTION_RESET'
  if (/not allowed|scope/i.test(message)) return 'net::ERR_ACCESS_DENIED'
  return 'net::ERR_FAILED'
}

// --- the request stage (onBeforeRequest → onBeforeSendHeaders → onSendHeaders) -------------------------

/**
 * Run the request side of a request: onBeforeRequest (with redirects, each
 * going through onBeforeRequest again), onBeforeSendHeaders, onSendHeaders.
 * Resolves `{ cancel: true }` or `{ url, headers, redirected }`.
 */
async function requestStage(webRequest, start, headers, makeDetails) {
  let url = start
  let redirected = false
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) return { cancel: true, error: 'net::ERR_TOO_MANY_REDIRECTS' }
    const details = makeDetails(url)
    const before = await webRequest._ask('onBeforeRequest', details)
    if (before.cancel) return { cancel: true, details }
    if (before.redirectURL && String(before.redirectURL) !== url) {
      const redirectURL = String(before.redirectURL)
      webRequest._tell('onBeforeRedirect', {
        ...details,
        redirectURL,
        statusCode: 307,
        statusLine: 'HTTP/1.1 307 Internal Redirect',
        fromCache: false,
        responseHeaders: { Location: [redirectURL], 'Non-Authoritative-Reason': ['WebRequest API'] },
      })
      url = redirectURL
      redirected = true
      continue
    }
    const sendDetails = { ...details, requestHeaders: requestHeaderObject(headers) }
    const send = await webRequest._ask('onBeforeSendHeaders', sendDetails)
    if (send.cancel) return { cancel: true, details }
    if (send.requestHeaders && typeof send.requestHeaders === 'object') headers = headerPairs(send.requestHeaders)
    webRequest._tell('onSendHeaders', { ...details, requestHeaders: requestHeaderObject(headers) })
    return { url, headers, redirected, details }
  }
}

/** onHeadersReceived's answer applied to `{ status, statusText, headers }`. */
function applyHeadersReceived(answer, response) {
  let { status, statusText, headers } = response
  let changed = false
  if (answer.responseHeaders && typeof answer.responseHeaders === 'object') {
    headers = headerPairs(answer.responseHeaders)
    changed = true
  }
  const line = answer.statusLine ? parseStatusLine(answer.statusLine) : null
  if (line) {
    status = line.status
    statusText = line.statusText
    changed = true
  }
  return { status, statusText, headers, changed }
}

/** A Response with other status / headers (keeping set-cookie, url, redirected). */
function rebuildResponse(original, { status, statusText, headers, body, url, redirected }) {
  const nullBody = [101, 103, 204, 205, 304].includes(status)
  const response = new Response(nullBody ? null : body, { status: status < 200 || status > 599 ? 200 : status, statusText })
  const define = (target) => {
    if (status < 200 || status > 599) Object.defineProperty(target, 'status', { value: status })
    Object.defineProperty(target, 'url', { value: url ?? original?.url ?? '' })
    Object.defineProperty(target, 'redirected', { value: Boolean(redirected) })
    Object.defineProperty(target, 'headers', { value: new Headers(headers) })
    return target
  }
  const clone = response.clone.bind(response)
  Object.defineProperty(response, 'clone', { value: () => define(clone()) })
  return define(response)
}

/** Calls `done` / `failed` when the body has been read (or failed). */
function watchBody(body, done, failed) {
  if (!body) {
    done()
    return null
  }
  const reader = body.getReader()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done: finished, value } = await reader.read()
        if (finished) {
          controller.close()
          done()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        controller.error(error)
        failed(error)
      }
    },
    cancel(reason) {
      failed(new Error('net::ERR_ABORTED'))
      return reader.cancel(reason)
    },
  })
}

// --- net.fetch / net.request / session.fetch ------------------------------------------------------------

async function uploadDataOf(input, init) {
  const body = init?.body ?? null
  if (body === null || body === undefined) {
    if (input instanceof Request && input.body) {
      const bytes = new Uint8Array(await input.clone().arrayBuffer())
      return bytes
    }
    return null
  }
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  return undefined // a stream or FormData: sent as is, not reported
}

function sessionFor(init) {
  if (init?.[VIA_SESSION]) return init[VIA_SESSION]
  if (init?.[VIA_PARTITION] !== undefined && fromPartitionRef) return fromPartitionRef(init[VIA_PARTITION])
  return defaultSessionRef
}

/**
 * netFetch with the session's webRequest listeners applied (installed in
 * net.js). Without listeners, the request goes straight to plugin-http.
 */
export async function fetchWithWebRequest(input, init, direct = fetchDirect) {
  const session = sessionFor(init)
  if (init && (VIA_SESSION in init || VIA_PARTITION in init)) {
    init = { ...init }
    delete init[VIA_SESSION]
    delete init[VIA_PARTITION]
  }
  const webRequest = session?.webRequest
  const startUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? String(input)
  if (!webRequest?._events().length || !/^(https?|file):/i.test(startUrl)) return direct(input, init)

  const request = input instanceof Request ? input : null
  let method = String(init?.method ?? request?.method ?? 'GET').toUpperCase()
  let headers = headerPairs([...headerEntries(request?.headers), ...headerEntries(init?.headers)])
  let bytes = await uploadDataOf(input, init)
  const id = nextRequestId++
  const referrer = headers.find(([name]) => name.toLowerCase() === 'referer')?.[1] ?? ''
  const redirectMode = init?.redirect ?? request?.redirect ?? 'follow'
  // Redirects are followed here (so each hop is seen) unless the body cannot be sent twice.
  const followHere = init?.maxRedirections === undefined && bytes !== undefined
  let url = startUrl
  let redirected = false
  let hops = 0
  const makeDetails = (current) => baseDetails(id, current, method, 'other', referrer, null, bytes ? [{ bytes: Buffer.from(bytes) }] : undefined)

  for (;;) {
    const stage = await requestStage(webRequest, url, headers, makeDetails)
    if (stage.cancel) {
      const error = stage.error ?? 'net::ERR_BLOCKED_BY_CLIENT'
      webRequest._tell('onErrorOccurred', { ...(stage.details ?? makeDetails(url)), fromCache: false, error })
      throw netError(error)
    }
    redirected ||= stage.redirected
    url = stage.url
    headers = stage.headers
    const details = stage.details
    const requestInit = { ...init, method, headers, signal: init?.signal ?? request?.signal }
    if (bytes !== undefined) requestInit.body = bytes && method !== 'GET' && method !== 'HEAD' ? bytes : undefined
    if (followHere) requestInit.maxRedirections = 0
    delete requestInit.redirect
    let response
    try {
      response = await direct(url, requestInit)
    } catch (error) {
      webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: netErrorName(error) })
      throw error
    }
    const statusLine = statusLineOf(response.status, response.statusText)
    const received = await webRequest._ask('onHeadersReceived', { ...details, statusLine, statusCode: response.status, responseHeaders: responseHeaderObject(response.headers) })
    if (received.cancel) {
      response.body?.cancel().catch(() => {})
      webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: 'net::ERR_BLOCKED_BY_CLIENT' })
      throw netError('net::ERR_BLOCKED_BY_CLIENT')
    }
    const applied = applyHeadersReceived(received, { status: response.status, statusText: response.statusText, headers: headerEntries(response.headers) })
    const finalLine = statusLineOf(applied.status, applied.statusText)
    const responseHeaders = responseHeaderObject(applied.headers)
    const location = applied.headers.find(([name]) => name.toLowerCase() === 'location')?.[1]

    if (followHere && [301, 302, 303, 307, 308].includes(applied.status) && location) {
      if (redirectMode === 'error') {
        response.body?.cancel().catch(() => {})
        webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: 'net::ERR_FAILED' })
        throw new TypeError('fetch failed: redirect mode is "error"')
      }
      if (redirectMode !== 'manual') {
        const redirectURL = new URL(location, url).href
        response.body?.cancel().catch(() => {})
        webRequest._tell('onBeforeRedirect', { ...details, redirectURL, statusCode: applied.status, statusLine: finalLine, fromCache: false, responseHeaders })
        if (++hops > MAX_REDIRECTS) {
          webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: 'net::ERR_TOO_MANY_REDIRECTS' })
          throw netError('net::ERR_TOO_MANY_REDIRECTS')
        }
        // Like fetch: 303 (and 301 / 302 after a POST) continue as GET without a body.
        if (applied.status === 303 ? method !== 'HEAD' : [301, 302].includes(applied.status) && method === 'POST') {
          method = 'GET'
          bytes = null
          headers = headers.filter(([name]) => !/^content-(type|length)$/i.test(name))
        }
        url = redirectURL
        redirected = true
        continue
      }
    }

    const done = { ...details, responseHeaders, fromCache: false, statusCode: applied.status, statusLine: finalLine }
    webRequest._tell('onResponseStarted', done)
    const watch = webRequest._wants('onCompleted', details) || webRequest._wants('onErrorOccurred', details)
    if (!applied.changed && !watch && !redirected) return response
    const body = watch
      ? watchBody(response.body, () => webRequest._tell('onCompleted', { ...done, error: 'net::OK' }), (error) => webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: netErrorName(error) }))
      : response.body
    return rebuildResponse(response, { status: applied.status, statusText: applied.statusText, headers: applied.headers, body, url: response.url || url, redirected })
  }
}

setRequestHook(fetchWithWebRequest)

// --- protocol.handle() schemes ------------------------------------------------------------------------

/**
 * A custom-scheme request from a page (`label`), with the listeners of that
 * page's session applied around `serve(request)` (the scheme's handler).
 * `serveOther(url)` answers a redirect to a URL another scheme serves.
 */
export async function protocolWithWebRequest(request, label, serve, serveOther) {
  const webContents = label ? resolveContents(label) ?? null : null
  const session = webContents?.session ?? defaultSessionRef
  const webRequest = session?.webRequest
  if (!webRequest?._events().length) return serve(request)
  const id = nextRequestId++
  const method = request.method
  const original = [...request.headers.entries()]
  const resourceType = guessResourceType(request.url, original)
  const referrer = request.headers.get('referer') ?? ''
  let bytes = null
  if (method !== 'GET' && method !== 'HEAD') bytes = new Uint8Array(await request.clone().arrayBuffer())
  const makeDetails = (url) => baseDetails(id, url, method, resourceType, referrer, webContents, bytes?.length ? [{ bytes: Buffer.from(bytes) }] : undefined)
  const stage = await requestStage(webRequest, request.url, original, makeDetails)
  if (stage.cancel) {
    webRequest._tell('onErrorOccurred', { ...(stage.details ?? makeDetails(request.url)), fromCache: false, error: stage.error ?? 'net::ERR_BLOCKED_BY_CLIENT' })
    return new Response(null, { status: 403, statusText: 'Blocked by session.webRequest' })
  }
  const details = stage.details
  const forwarded = new Request(stage.url, { method, headers: stage.headers, body: bytes?.length ? bytes : undefined })
  let response
  try {
    response = stage.url === request.url || sameScheme(stage.url, request.url) ? await serve(forwarded) : await serveOther(forwarded)
  } catch (error) {
    webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: netErrorName(error) })
    throw error
  }
  const received = await webRequest._ask('onHeadersReceived', { ...details, statusLine: statusLineOf(response.status, response.statusText), statusCode: response.status, responseHeaders: responseHeaderObject(response.headers) })
  if (received.cancel) {
    webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: 'net::ERR_BLOCKED_BY_CLIENT' })
    return new Response(null, { status: 403, statusText: 'Blocked by session.webRequest' })
  }
  const applied = applyHeadersReceived(received, { status: response.status, statusText: response.statusText, headers: headerEntries(response.headers) })
  const done = { ...details, responseHeaders: responseHeaderObject(applied.headers), fromCache: false, statusCode: applied.status, statusLine: statusLineOf(applied.status, applied.statusText) }
  webRequest._tell('onResponseStarted', done)
  // The bytes reach the page once protocol.js has read the body.
  const body = watchBody(response.body, () => webRequest._tell('onCompleted', { ...done, error: 'net::OK' }), (error) => webRequest._tell('onErrorOccurred', { ...details, fromCache: false, error: netErrorName(error) }))
  return rebuildResponse(response, { status: applied.status, statusText: applied.statusText, headers: applied.headers, body, url: request.url })
}

function sameScheme(a, b) {
  return /^[a-z][a-z0-9+.-]*:/i.exec(a)?.[0]?.toLowerCase() === /^[a-z][a-z0-9+.-]*:/i.exec(b)?.[0]?.toLowerCase()
}

// --- page requests reported by tauri-plugin-electron ---------------------------------------------------

const PAGE_EVENTS = new Set(['onSendHeaders', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'])

/** Linux / Windows error codes → Chromium's error names. */
export function pageErrorName({ domain = '', code = 0, message = '' } = {}) {
  if (domain === 'WebKitNetworkError') {
    return { 302: 'net::ERR_ABORTED', 300: 'net::ERR_UNKNOWN_URL_SCHEME', 301: 'net::ERR_FAILED', 303: 'net::ERR_FILE_NOT_FOUND', 399: 'net::ERR_FAILED' }[code] ?? 'net::ERR_FAILED'
  }
  if (domain === 'WebKitPolicyError') return 'net::ERR_BLOCKED_BY_CLIENT'
  if (domain === 'g-resolver-error-quark') return 'net::ERR_NAME_NOT_RESOLVED'
  if (domain === 'g-tls-error-quark') return 'net::ERR_SSL_PROTOCOL_ERROR'
  if (domain === 'g-io-error-quark') {
    // GIOErrorEnum values.
    return { 19: 'net::ERR_ABORTED', 24: 'net::ERR_TIMED_OUT', 28: 'net::ERR_NAME_NOT_RESOLVED', 37: 'net::ERR_ADDRESS_UNREACHABLE', 38: 'net::ERR_ADDRESS_UNREACHABLE', 39: 'net::ERR_CONNECTION_REFUSED', 40: 'net::ERR_PROXY_CONNECTION_FAILED', 44: 'net::ERR_CONNECTION_RESET', 45: 'net::ERR_CONNECTION_CLOSED' }[code] ?? 'net::ERR_FAILED'
  }
  if (/^net::ERR_/.test(message)) return message
  return netErrorName({ message })
}

/**
 * `tauri-electron:web-request` from tauri-plugin-electron: a page's request.
 * `reply` (Windows) waits for the request stage's answer; other events only
 * report.
 */
export async function onPageRequest(payload) {
  const { reply = 0, label, event } = payload
  const webContents = resolveContents(label) ?? null
  const session = webContents?.session ?? defaultSessionRef
  const webRequest = session?.webRequest
  const respond = (answer) => (reply ? native('web_request_respond', { reply, ...answer }).catch(report('session.webRequest')) : undefined)
  if (!webRequest) return respond({})
  const headers = payload.requestHeaders ?? []
  const resourceType = payload.resourceType ?? guessResourceType(payload.url, headers)
  const makeDetails = (url) => baseDetails(payload.request ?? 0, url, payload.method ?? 'GET', resourceType, payload.referrer ?? '', webContents, undefined)
  if (event === 'request') {
    try {
      const stage = await requestStage(webRequest, payload.url, headers, makeDetails)
      if (stage.cancel) return respond({ cancel: true })
      const changed = JSON.stringify(stage.headers) !== JSON.stringify(headerPairs(headers))
      // Tauri passes `redirect_url` as `redirectUrl`.
      return respond({ redirectUrl: stage.url !== payload.url ? stage.url : null, requestHeaders: changed ? stage.headers : null })
    } catch (error) {
      report('session.webRequest')(error)
      return respond({})
    }
  }
  if (!PAGE_EVENTS.has(event)) return undefined
  const details = makeDetails(payload.url)
  if (event === 'onSendHeaders') return webRequest._tell(event, { ...details, requestHeaders: requestHeaderObject(headers) })
  if (event === 'onErrorOccurred') return webRequest._tell(event, { ...details, fromCache: false, error: pageErrorName(payload.error) })
  const response = {
    statusCode: payload.statusCode ?? 0,
    statusLine: statusLineOf(payload.statusCode ?? 0, payload.statusText),
    responseHeaders: responseHeaderObject(payload.responseHeaders ?? []),
    fromCache: Boolean(payload.fromCache),
  }
  if (event === 'onBeforeRedirect') return webRequest._tell(event, { ...details, ...response, redirectURL: payload.redirectURL })
  if (event === 'onCompleted') return webRequest._tell(event, { ...details, ...response, error: 'net::OK' })
  return webRequest._tell(event, { ...details, ...response })
}
