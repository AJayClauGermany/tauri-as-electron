/**
 * The server side of Node's `http` and `https`: an HTTP/1.1 server written
 * on node-net's sockets (and node-tls's for https), so that the parts of
 * Node's API that expose the connection work: `'connection'`, `'upgrade'`
 * (WebSocket servers), `'connect'`, `req.socket`.
 *
 * Supported: keep-alive (with `keepAliveTimeout`), pipelined requests
 * (answered in order), `Content-Length` and chunked bodies both ways,
 * `Expect: 100-continue` / 'checkContinue', HEAD, 204 / 304, `'clientError'`
 * (400 / 431 answers), `closeAllConnections()` / `closeIdleConnections()`.
 * Not supported: HTTP/2, `maxHeaderSize` beyond 16 KiB.
 */
import { Buffer } from './buffer.js'
import { Writable } from './stream.js'
import { Server as NetServer } from './net.js'
import { TLSServer } from './tls.js'
import { IncomingMessage, STATUS_CODES, validateHeaderName, validateHeaderValue } from './http-client.js'

const MAX_HEADER_SIZE = 16 * 1024
const CRLF = '\r\n'
const NO_BODY_STATUS = new Set([204, 304])

/** Node's IncomingMessage for a request the server received. */
class ServerRequest extends IncomingMessage {
  constructor(socket) {
    super(null)
    this.socket = socket
    this.connection = socket
  }
}

/** Header lines → Node's `headers` (lower-case, repeated values joined) and `rawHeaders`. */
const SINGLE = new Set(['age', 'authorization', 'content-length', 'content-type', 'etag', 'expires', 'from', 'host', 'if-modified-since', 'if-unmodified-since', 'last-modified', 'location', 'max-forwards', 'proxy-authorization', 'referer', 'retry-after', 'server', 'user-agent'])

function headersFrom(lines) {
  const headers = {}
  const rawHeaders = []
  for (const line of lines) {
    const index = line.indexOf(':')
    if (index <= 0) throw new Error('bad header')
    const name = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    rawHeaders.push(name, value)
    const key = name.toLowerCase()
    if (key === 'set-cookie') headers[key] = [...(headers[key] ?? []), value]
    else if (!(key in headers)) headers[key] = value
    else if (!SINGLE.has(key)) headers[key] = `${headers[key]}${key === 'cookie' ? '; ' : ', '}${value}`
  }
  return { headers, rawHeaders }
}

/** Node's ServerResponse: a Writable that sends the head with the first bytes. */
export class ServerResponse extends Writable {
  constructor(req, options = {}) {
    super({ decodeStrings: true, emitClose: false })
    this.req = req
    this.socket = null
    this.connection = null
    this.statusCode = 200
    this.statusMessage = undefined
    this.sendDate = true
    this.headersSent = false
    this.chunkedEncoding = false
    this.shouldKeepAlive = options.keepAlive ?? true
    this.useChunkedEncodingByDefault = true
    this.finished = false
    this._headers = new Map()
    this._head = ''
    this._chunked = false
    this._noBody = req.method === 'HEAD'
    this._written = false
    this._trailers = null
    this._keepAliveTimeout = options.keepAliveTimeout ?? 5000
    this.once('finish', () => {
      this.finished = true
    })
  }

  _assignSocket(socket) {
    this.socket = socket
    this.connection = socket
  }

  setHeader(name, value) {
    if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
    validateHeaderName(name)
    validateHeaderValue(name, value)
    this._headers.set(String(name).toLowerCase(), [String(name), value])
    return this
  }

  appendHeader(name, value) {
    const existing = this.getHeader(name)
    if (existing === undefined) return this.setHeader(name, value)
    return this.setHeader(name, [existing, value].flat())
  }

  getHeader(name) {
    return this._headers.get(String(name).toLowerCase())?.[1]
  }

  getHeaders() {
    const out = Object.create(null)
    for (const [key, [, value]] of this._headers) out[key] = value
    return out
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
    if (this.headersSent) throw Object.assign(new Error('Cannot remove headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
    this._headers.delete(String(name).toLowerCase())
  }

  /** `writeHead(status, [statusMessage], [headers])`. */
  writeHead(statusCode, statusMessage, headers) {
    if (this.headersSent) throw Object.assign(new Error('Cannot write headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
    if (typeof statusMessage !== 'string') [headers, statusMessage] = [statusMessage, undefined]
    const code = Number(statusCode)
    if (!Number.isInteger(code) || code < 100 || code > 999) {
      throw Object.assign(new RangeError(`Invalid status code: ${statusCode}`), { code: 'ERR_HTTP_INVALID_STATUS_CODE' })
    }
    this.statusCode = code
    if (statusMessage !== undefined) this.statusMessage = statusMessage
    if (Array.isArray(headers)) {
      for (let i = 0; i + 1 < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1])
    } else if (headers) {
      for (const [name, value] of Object.entries(headers)) if (value !== undefined) this.setHeader(name, value)
    }
    this._buildHead()
    return this
  }

  _buildHead(contentLength) {
    if (this._head) return
    const status = this.statusCode
    const noBody = this._noBody || NO_BODY_STATUS.has(status) || (status >= 100 && status < 200)
    const message = this.statusMessage ?? STATUS_CODES[status] ?? 'unknown'
    const lines = [`HTTP/1.1 ${status} ${message}`]
    const has = (name) => this._headers.has(name)
    if (this.sendDate && !has('date')) lines.push(`Date: ${new Date().toUTCString()}`)
    const http10 = this.req.httpVersion === '1.0'
    if (!has('connection')) {
      lines.push(this.shouldKeepAlive ? 'Connection: keep-alive' : 'Connection: close')
      if (this.shouldKeepAlive && !http10 && this._keepAliveTimeout) lines.push(`Keep-Alive: timeout=${Math.floor(this._keepAliveTimeout / 1000)}`)
    } else if (/close/i.test(String(this.getHeader('connection')))) {
      this.shouldKeepAlive = false
    }
    if (contentLength !== undefined && !has('content-length') && !has('transfer-encoding') && !NO_BODY_STATUS.has(status)) {
      this._headers.set('content-length', ['Content-Length', contentLength])
    }
    if (!has('content-length') && !has('transfer-encoding') && !noBody) {
      if (http10 || !this.useChunkedEncodingByDefault) this.shouldKeepAlive = false
      else {
        lines.push('Transfer-Encoding: chunked')
        this._chunked = true
      }
    } else if (/chunked/i.test(String(this.getHeader('transfer-encoding') ?? ''))) {
      this._chunked = true
    }
    this.chunkedEncoding = this._chunked
    for (const [, [name, value]] of this._headers) {
      for (const item of [value].flat()) lines.push(`${name}: ${item}`)
    }
    this._head = lines.join(CRLF) + CRLF + CRLF
    this._noBody = noBody
  }

  _send(data, callback) {
    if (!this.socket || this.socket.destroyed) return callback()
    let out = data
    if (!this.headersSent) {
      this.headersSent = true
      out = Buffer.concat([Buffer.from(this._head, 'latin1'), data])
    }
    if (out.length === 0) return callback()
    this.socket.write(out, () => callback())
  }

  _write(chunk, encoding, callback) {
    this._written = true
    this._buildHead()
    if (this._noBody) return this._send(Buffer.alloc(0), callback)
    const data = this._chunked ? Buffer.concat([Buffer.from(`${chunk.length.toString(16)}${CRLF}`), chunk, Buffer.from(CRLF)]) : chunk
    this._send(data, callback)
  }

  _final(callback) {
    this._buildHead(0)
    let tail = Buffer.alloc(0)
    if (this._chunked && !this._noBody) {
      const trailers = this._trailers ? Object.entries(this._trailers).map(([k, v]) => `${k}: ${v}${CRLF}`).join('') : ''
      tail = Buffer.from(`0${CRLF}${trailers}${CRLF}`)
    }
    this._send(tail, callback)
  }

  /** `end()` with the whole body sets Content-Length, as Node does. */
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') [callback, chunk] = [chunk, undefined]
    else if (typeof encoding === 'function') [callback, encoding] = [encoding, undefined]
    if (!this.headersSent && !this._head && !this._written) {
      const length = chunk === undefined || chunk === null ? 0 : typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength
      this._buildHead(length)
    }
    return super.end(chunk, encoding, callback)
  }

  flushHeaders() {
    this._buildHead()
    if (!this.headersSent) this._send(Buffer.alloc(0), () => {})
  }

  writeContinue(callback) {
    this.socket?.write(`HTTP/1.1 100 Continue${CRLF}${CRLF}`, callback)
  }

  writeProcessing(callback) {
    this.socket?.write(`HTTP/1.1 102 Processing${CRLF}${CRLF}`, callback)
  }

  writeEarlyHints(hints, callback) {
    const lines = Object.entries(hints).flatMap(([k, v]) => [v].flat().map((item) => `${k}: ${item}`))
    this.socket?.write(`HTTP/1.1 103 Early Hints${CRLF}${lines.join(CRLF)}${CRLF}${CRLF}`, callback)
  }

  addTrailers(trailers) {
    this._trailers = { ...this._trailers, ...trailers }
  }

  setTimeout(ms, callback) {
    this.socket?.setTimeout(ms, callback)
    return this
  }
}

export const OutgoingMessage = ServerResponse

/**
 * One connection: parse requests from `socket`, hand each to `server`,
 * answer them in order.
 */
function serve(server, socket) {
  let buffer = Buffer.alloc(0)
  let request = null // the request whose body is being read
  let body = null // { mode: 'length' | 'chunked', remaining, ... }
  let responding = 0 // responses still running
  let parsing = true
  let idleTimer = null
  let ended = false // the client sent FIN
  const pending = [] // ServerResponses waiting for their turn

  server._connections.add(socket)
  socket.once('close', () => {
    server._connections.delete(socket)
    clearTimeout(idleTimer)
    if (request && !request.complete) {
      request.aborted = true
      request.emit('aborted')
      request.destroy()
    }
    for (const res of pending.splice(0)) if (!res.writableFinished) res.emit('close')
  })
  socket.on('error', (error) => {
    if (server.listenerCount('clientError') > 0) server.emit('clientError', error, socket)
  })
  const onEnd = () => {
    ended = true
    if (!responding) socket.end()
  }
  socket.on('end', onEnd)

  const idle = () => {
    clearTimeout(idleTimer)
    socket._httpIdle = true
    if (server.keepAliveTimeout > 0) idleTimer = setTimeout(() => socket.destroy(), server.keepAliveTimeout)
  }
  const busy = () => {
    clearTimeout(idleTimer)
    socket._httpIdle = false
  }
  idle()

  const clientError = (status, reason) => {
    const error = Object.assign(new Error(reason), { code: status === 431 ? 'HPE_HEADER_OVERFLOW' : 'HPE_INVALID_HEADER_TOKEN', bytesParsed: 0, rawPacket: buffer })
    parsing = false
    if (server.listenerCount('clientError') > 0) server.emit('clientError', error, socket)
    else if (socket.writable) socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}${CRLF}Connection: close${CRLF}${CRLF}`)
    else socket.destroy()
  }

  const startNext = () => {
    const next = pending[0]
    if (!next || next.socket) return
    next._assignSocket(socket)
    next.emit('_ready')
  }

  const onRequestDone = (res) => {
    pending.shift()
    responding--
    // A body the handler did not read is discarded, as Node's req._dump().
    if (!res.req.complete) res.req.resume()
    if (!res.shouldKeepAlive || server._closingAll) {
      socket.end()
      return
    }
    if (pending.length) return startNext()
    // Requests that arrived meanwhile (pipelined) are still in the buffer.
    parse()
    if (responding) return
    // The client half-closed and every request is answered.
    if (ended) socket.end()
    else idle()
  }

  const beginRequest = (req) => {
    busy()
    const keepAlive = req.httpVersion === '1.1' ? !/\bclose\b/i.test(req.headers.connection ?? '') : /keep-alive/i.test(req.headers.connection ?? '')
    const res = new ServerResponse(req, { keepAlive: keepAlive && !server._closingAll, keepAliveTimeout: server.keepAliveTimeout })
    responding++
    pending.push(res)
    // Writes wait until the earlier responses on this connection are done.
    const write = res._send.bind(res)
    res._send = (data, callback) => (res.socket ? write(data, callback) : res.once('_ready', () => write(data, callback)))
    res.once('finish', () => {
      onRequestDone(res)
      queueMicrotask(() => res.emit('close'))
    })
    startNext()
    return res
  }

  const finishBody = () => {
    request.complete = true
    request.push(null)
    request = null
    body = null
  }

  /** Feed body bytes from `buffer` into the current request. Returns false when more input is needed. */
  const readBody = () => {
    while (body) {
      if (body.mode === 'length') {
        if (body.remaining === 0) return finishBody(), true
        if (!buffer.length) return false
        const take = Math.min(body.remaining, buffer.length)
        request.push(buffer.subarray(0, take))
        buffer = buffer.subarray(take)
        body.remaining -= take
        continue
      }
      // chunked
      if (body.remaining > 0) {
        if (!buffer.length) return false
        const take = Math.min(body.remaining, buffer.length)
        request.push(buffer.subarray(0, take))
        buffer = buffer.subarray(take)
        body.remaining -= take
        if (body.remaining === 0) body.needCRLF = true
        continue
      }
      if (body.needCRLF) {
        if (buffer.length < 2) return false
        buffer = buffer.subarray(2)
        body.needCRLF = false
      }
      const end = buffer.indexOf(CRLF)
      if (end === -1) return false
      if (body.trailers) {
        if (end === 0) {
          buffer = buffer.subarray(2)
          return finishBody(), true
        }
        const line = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 2)
        const index = line.indexOf(':')
        if (index > 0) {
          request.trailers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
          request.rawTrailers.push(line.slice(0, index).trim(), line.slice(index + 1).trim())
        }
        continue
      }
      const size = parseInt(buffer.subarray(0, end).toString('latin1').split(';')[0], 16)
      buffer = buffer.subarray(end + 2)
      if (!Number.isFinite(size) || size < 0) return clientError(400, 'Parse Error: Invalid character in chunk size'), false
      if (size === 0) body.trailers = true
      else body.remaining = size
    }
    return true
  }

  const parse = () => {
    while (parsing && !socket.destroyed) {
      if (body) {
        if (!readBody()) return
        continue
      }
      // One request at a time: the next waits for the current response.
      if (responding > 0) return
      const end = buffer.indexOf(CRLF + CRLF)
      if (end === -1) {
        if (buffer.length > MAX_HEADER_SIZE) clientError(431, 'Header overflow')
        return
      }
      const head = buffer.subarray(0, end).toString('latin1')
      buffer = buffer.subarray(end + 4)
      const [requestLine, ...headerLines] = head.split(CRLF)
      const match = /^([A-Z-]+) (\S+) HTTP\/(\d)\.(\d)$/.exec(requestLine)
      if (!match) return clientError(400, 'Parse Error: Invalid method encountered')
      let parsed
      try {
        parsed = headersFrom(headerLines)
      } catch {
        return clientError(400, 'Parse Error: Invalid header value char')
      }
      const req = new ServerRequest(socket)
      req.method = match[1]
      req.url = match[2]
      req.httpVersionMajor = Number(match[3])
      req.httpVersionMinor = Number(match[4])
      req.httpVersion = `${match[3]}.${match[4]}`
      req.headers = parsed.headers
      req.rawHeaders = parsed.rawHeaders
      req.trailers = {}
      req.rawTrailers = []
      req._read = () => socket.resume()

      const upgrade = /\bupgrade\b/i.test(req.headers.connection ?? '') && req.headers.upgrade
      if (req.method === 'CONNECT' || upgrade) {
        const event = req.method === 'CONNECT' ? 'connect' : 'upgrade'
        if (server.listenerCount(event) > 0) {
          parsing = false
          socket.removeListener('data', onData)
          socket.removeListener('end', onEnd)
          busy()
          server._connections.delete(socket)
          req.complete = true
          req.push(null)
          server.emit(event, req, socket, buffer)
          return
        }
        if (req.method === 'CONNECT') return socket.destroy()
      }

      const te = String(req.headers['transfer-encoding'] ?? '')
      const length = req.headers['content-length']
      if (/\bchunked\b/i.test(te)) body = { mode: 'chunked', remaining: 0 }
      else if (length !== undefined) {
        const n = Number(length)
        if (!Number.isInteger(n) || n < 0) return clientError(400, 'Parse Error: Invalid Content-Length')
        body = { mode: 'length', remaining: n }
      } else body = { mode: 'length', remaining: 0 }
      request = req

      const res = beginRequest(req)
      if (/100-continue/i.test(req.headers.expect ?? '')) {
        if (server.listenerCount('checkContinue') > 0) server.emit('checkContinue', req, res)
        else {
          res.writeContinue()
          server.emit('request', req, res)
        }
      } else {
        server.emit('request', req, res)
      }
    }
  }

  const onData = (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    parse()
    // Back-pressure: stop reading while a request body is not being consumed.
    if (request && request.readableLength > request.readableHighWaterMark) socket.pause()
  }
  socket.on('data', onData)
}

/** The http.Server parts shared by http and https. */
function httpServerMixin(Base) {
  return class extends Base {
    constructor(options, requestListener) {
      if (typeof options === 'function') [requestListener, options] = [options, {}]
      super({ allowHalfOpen: true, ...options })
      this.timeout = 0
      this.keepAliveTimeout = options?.keepAliveTimeout ?? 5000
      this.headersTimeout = options?.headersTimeout ?? 60000
      this.requestTimeout = options?.requestTimeout ?? 300000
      this.maxHeadersCount = null
      this.maxRequestsPerSocket = 0
      this._connections = new Set()
      if (requestListener) this.on('request', requestListener)
    }

    _onConnection(socket) {
      super._onConnection(socket)
      if (this.timeout) socket.setTimeout(this.timeout, () => (this.listenerCount('timeout') ? this.emit('timeout', socket) : socket.destroy()))
      serve(this, socket)
    }

    setTimeout(ms, callback) {
      this.timeout = ms
      if (callback) this.on('timeout', callback)
      return this
    }

    closeAllConnections() {
      for (const socket of this._connections) socket.destroy()
    }

    closeIdleConnections() {
      for (const socket of this._connections) if (socket._httpIdle) socket.destroy()
    }

    /** Like Node 19+: stop accepting and close idle keep-alive connections. */
    close(callback) {
      super.close(callback)
      this._closingAll = true
      this.closeIdleConnections()
      return this
    }
  }
}

/** Node's http.Server. */
export class Server extends httpServerMixin(NetServer) {}

/** Node's https.Server (needs tauri-plugin-electron's `node-tls`). */
export class HttpsServer extends httpServerMixin(TLSServer) {}

export function createServer(options, requestListener) {
  return new Server(options, requestListener)
}

export function createHttpsServer(options, requestListener) {
  return new HttpsServer(options, requestListener)
}

export { ServerRequest }
