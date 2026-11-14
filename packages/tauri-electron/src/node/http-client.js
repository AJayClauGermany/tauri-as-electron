/**
 * The client side of Node's `http` and `https`, on tauri-plugin-http (the
 * same transport as Electron's `net` here, Rust's reqwest: no CORS).
 *
 * `request()` / `get()` return a ClientRequest; the `'response'` is an
 * IncomingMessage, a Readable stream (`on('data')`, `setEncoding`, `pipe`,
 * async iteration). Like Node, redirects are not followed. The request body
 * is buffered and sent on `end()`. Servers (`createServer`) are not
 * implemented: they need sockets in Rust (layer 4 of the plan).
 */
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError } from '../internal/runtime.js'
import { toNodeHeaders } from '../main/net.js'
import { Buffer } from './buffer.js'
import { Readable } from './stream.js'

export const METHODS = [
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE',
  'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH',
  'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK',
  'UNLOCK', 'UNSUBSCRIBE',
]

export const STATUS_CODES = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints', 200: 'OK', 201: 'Created',
  202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used', 300: 'Multiple Choices', 301: 'Moved Permanently',
  302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed',
  418: "I'm a Teapot", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency',
  425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded', 510: 'Not Extended', 511: 'Network Authentication Required',
}

/** Connection pooling is reqwest's; Agent is accepted and ignored. */
export class Agent extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = { ...options }
    this.keepAlive = Boolean(options.keepAlive)
    this.maxSockets = options.maxSockets ?? Infinity
    this.maxFreeSockets = options.maxFreeSockets ?? 256
    this.maxTotalSockets = options.maxTotalSockets ?? Infinity
    this.sockets = {}
    this.freeSockets = {}
    this.requests = {}
  }

  destroy() {}
}

/** Node's IncomingMessage (client side): a Readable of the response body. */
export class IncomingMessage extends Readable {
  constructor(response) {
    super({ read() {} })
    const { headers, rawHeaders } = toNodeHeaders(response.headers)
    this.statusCode = response.status
    this.statusMessage = response.statusText || STATUS_CODES[response.status] || ''
    this.headers = headers
    this.rawHeaders = rawHeaders
    this.trailers = {}
    this.rawTrailers = []
    this.httpVersion = '1.1'
    this.httpVersionMajor = 1
    this.httpVersionMinor = 1
    this.complete = false
    this.aborted = false
    this.url = ''
    this.method = null
    this.socket = null
  }

  setTimeout(ms, callback) {
    if (callback) this.once('timeout', callback)
    return this
  }
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * reqwest's error text → the `code` Node would give, where the text says.
 * plugin-http often reports only "error sending request for url (…)",
 * without the OS cause; that becomes ECONNRESET.
 */
function networkError(error, url) {
  const message = String(error?.message ?? error)
  const host = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  })()
  if (/refused/i.test(message)) return Object.assign(codedError(`connect ECONNREFUSED ${host}`, 'ECONNREFUSED'), { syscall: 'connect', cause: error })
  if (/dns|resolve|lookup|name or service not known|nodename nor servname/i.test(message)) {
    return Object.assign(codedError(`getaddrinfo ENOTFOUND ${host}`, 'ENOTFOUND'), { syscall: 'getaddrinfo', hostname: host, cause: error })
  }
  if (/timed? ?out/i.test(message)) return Object.assign(codedError(message, 'ETIMEDOUT'), { cause: error })
  if (/certificate|tls|ssl/i.test(message)) return Object.assign(codedError(message, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'), { cause: error })
  return Object.assign(codedError(message, 'ECONNRESET'), { cause: error })
}

/** `(url | options, [options], [callback])` → URL, options, callback. */
function requestArguments(defaultProtocol, input, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  let base = {}
  if (typeof input === 'string' || input instanceof URL) {
    const url = new URL(String(input))
    base = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port,
      path: `${url.pathname}${url.search}`,
      auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
    }
  } else if (input && typeof input === 'object') {
    options = { ...input, ...options }
  }
  const merged = { ...base, ...options }
  const protocol = merged.protocol ?? defaultProtocol
  if (protocol !== defaultProtocol) {
    const error = new TypeError(`Protocol "${protocol}" not supported. Expected "${defaultProtocol}"`)
    error.code = 'ERR_INVALID_PROTOCOL'
    throw error
  }
  const hostname = merged.hostname ?? (merged.host ? String(merged.host).replace(/:\d+$/, '') : 'localhost')
  const port = merged.port ?? (merged.host && /:\d+$/.test(merged.host) ? merged.host.split(':').pop() : '')
  const host = hostname.includes(':') ? `[${hostname}]` : hostname
  const url = `${protocol}//${host}${port ? `:${port}` : ''}${merged.path ?? '/'}`
  return { url, options: merged, callback }
}

/** Node's ClientRequest: headers, a buffered body, `'response'` / `'error'` / `'close'`. */
export class ClientRequest extends EventEmitter {
  constructor(defaultProtocol, input, options, callback) {
    super()
    const parsed = requestArguments(defaultProtocol, input, options, callback)
    const opts = parsed.options
    this.url = parsed.url
    this.method = String(opts.method ?? 'GET').toUpperCase()
    this.path = opts.path ?? '/'
    this.host = opts.hostname ?? opts.host ?? 'localhost'
    this.protocol = opts.protocol ?? defaultProtocol
    this.agent = opts.agent
    this.headersSent = false
    this.finished = false
    this.writableEnded = false
    this.writableFinished = false
    this.destroyed = false
    this.aborted = false
    this.reusedSocket = false
    this.maxHeadersCount = null
    this.socket = null
    this._headers = new Map()
    for (const [name, value] of Object.entries(opts.headers ?? {})) this.setHeader(name, value)
    if (opts.auth && !this._headers.has('authorization')) {
      this.setHeader('Authorization', `Basic ${Buffer.from(opts.auth).toString('base64')}`)
    }
    this._chunks = []
    this._controller = new AbortController()
    this._timeout = null
    if (opts.timeout) this.setTimeout(opts.timeout)
    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(() => this.destroy(abortError()))
      else opts.signal.addEventListener('abort', () => this.destroy(abortError()), { once: true })
    }
    if (parsed.callback) this.once('response', parsed.callback)
  }

  setHeader(name, value) {
    if (this.headersSent) throw codedError('Cannot set headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT')
    this._headers.set(String(name).toLowerCase(), [String(name), value])
    return this
  }

  getHeader(name) {
    return this._headers.get(String(name).toLowerCase())?.[1]
  }

  getHeaders() {
    return Object.fromEntries([...this._headers].map(([key, [, value]]) => [key, value]))
  }

  getHeaderNames() {
    return [...this._headers.keys()]
  }

  getRawHeaderNames() {
    return [...this._headers.values()].map(([name]) => name)
  }

  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase())
  }

  removeHeader(name) {
    if (this.headersSent) throw codedError('Cannot remove headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT')
    this._headers.delete(String(name).toLowerCase())
  }

  flushHeaders() {}

  setNoDelay() {}

  setSocketKeepAlive() {}

  setTimeout(ms, callback) {
    if (callback) this.once('timeout', callback)
    clearTimeout(this._timeout)
    if (ms > 0) this._timeout = setTimeout(() => this.emit('timeout'), ms)
    return this
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') [callback, encoding] = [encoding, undefined]
    if (this.writableEnded) {
      const error = codedError('write after end', 'ERR_STREAM_WRITE_AFTER_END')
      queueMicrotask(() => (callback ? callback(error) : this.emit('error', error)))
      return false
    }
    this._chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding ?? 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    if (callback) queueMicrotask(callback)
    return true
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') [callback, chunk] = [chunk, undefined]
    else if (typeof encoding === 'function') [callback, encoding] = [encoding, undefined]
    if (this.writableEnded) return this
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding)
    this.writableEnded = true
    this.finished = true
    if (callback) this.once('finish', callback)
    this._send()
    return this
  }

  abort() {
    if (this.aborted) return
    this.aborted = true
    queueMicrotask(() => this.emit('abort'))
    this.destroy()
  }

  destroy(error) {
    if (this.destroyed) return this
    this.destroyed = true
    clearTimeout(this._timeout)
    this._controller.abort()
    this._response?.destroy(error)
    queueMicrotask(() => {
      if (error) this.emit('error', error)
      this.emit('close')
    })
    return this
  }

  async _send() {
    this.headersSent = true
    const headers = []
    for (const [, [name, value]] of this._headers) {
      for (const item of Array.isArray(value) ? value : [value]) headers.push([name, String(item)])
    }
    const body = this._chunks.length ? Buffer.concat(this._chunks) : undefined
    let response
    try {
      response = await httpFetch(this.url, {
        method: this.method,
        headers,
        body: body && this.method !== 'GET' && this.method !== 'HEAD' ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : undefined,
        maxRedirections: 0, // Node's http does not follow redirects
        signal: this._controller.signal,
      })
    } catch (error) {
      if (this.destroyed) return
      this.destroyed = true
      clearTimeout(this._timeout)
      this.emit('error', networkError(error, this.url))
      this.emit('close')
      return
    }
    if (this.destroyed) return
    this.writableFinished = true
    this.emit('finish')
    const message = new IncomingMessage(response)
    message.req = this
    this._response = message
    if (this.listenerCount('response') > 0) this.emit('response', message)
    else message.resume() // Node discards an unread response
    try {
      if (response.body?.getReader) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done || this.destroyed) break
          message.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
        }
      } else {
        const all = new Uint8Array(await response.arrayBuffer())
        if (all.length) message.push(Buffer.from(all.buffer))
      }
    } catch (error) {
      if (!this.destroyed) message.destroy(networkError(error, this.url))
      return
    }
    if (this.destroyed) return
    message.complete = true
    message.push(null)
    clearTimeout(this._timeout)
    message.once('end', () => this.emit('close'))
  }
}

function abortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function serverNotImplemented(name) {
  return () => {
    throw new NotImplementedError(name, { reason: 'unimplemented', hint: 'HTTP servers need sockets in Rust, not implemented yet. Use protocol.handle() for app-internal endpoints.' })
  }
}

export function validateHeaderName(name) {
  if (typeof name !== 'string' || !/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(name)) {
    const error = new TypeError(`Header name must be a valid HTTP token ["${name}"]`)
    error.code = 'ERR_INVALID_HTTP_TOKEN'
    throw error
  }
}

export function validateHeaderValue(name, value) {
  if (value === undefined) {
    const error = new TypeError(`Invalid value "${value}" for header "${name}"`)
    error.code = 'ERR_HTTP_INVALID_HEADER_VALUE'
    throw error
  }
  if (/[^\t\x20-\x7e\x80-\xff]/.test(String(value))) {
    const error = new TypeError(`Invalid character in header content ["${name}"]`)
    error.code = 'ERR_INVALID_CHAR'
    throw error
  }
}

/** The `http` (or `https`) module object for one protocol. */
export function createHttpModule(protocol) {
  const globalAgent = new Agent()
  const request = (input, options, callback) => new ClientRequest(protocol, input, options, callback)
  const get = (input, options, callback) => {
    const req = request(input, options, callback)
    req.end()
    return req
  }
  return {
    METHODS,
    STATUS_CODES,
    Agent,
    globalAgent,
    ClientRequest,
    IncomingMessage,
    request,
    get,
    validateHeaderName,
    validateHeaderValue,
    maxHeaderSize: 16384,
    createServer: serverNotImplemented(`${protocol.slice(0, -1)}.createServer`),
    Server: serverNotImplemented(`${protocol.slice(0, -1)}.Server`),
    ServerResponse: serverNotImplemented(`${protocol.slice(0, -1)}.ServerResponse`),
    OutgoingMessage: serverNotImplemented(`${protocol.slice(0, -1)}.OutgoingMessage`),
    setMaxIdleHTTPParsers() {},
  }
}
