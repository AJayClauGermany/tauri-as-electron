/**
 * Node's `net`, backed by tauri-plugin-electron (Cargo feature `node-net`):
 * TCP sockets and servers, and IPC (Unix domain sockets, Windows named
 * pipes) through `path`.
 *
 * `Socket` is a Duplex stream: writes resolve when Rust has flushed them to
 * the kernel (back-pressure), and reading pauses in Rust when the stream's
 * buffer is full. `Server` accepts connections in Rust and hands each one
 * over as a Socket. Errors are Node's (`connect ECONNREFUSED 127.0.0.1:9`,
 * `code`, `errno`, `syscall`, `address`, `port`).
 */
import { Channel } from '@tauri-apps/api/core'
import { EventEmitter } from '../internal/emitter.js'
import { native, hasFeature, featureError } from '../internal/native.js'
import { inTauri, explainError, NotImplementedError } from '../internal/runtime.js'
import { nodeFailure, noTauri } from '../internal/node-bridge.js'
import { Buffer } from './buffer.js'
import { Duplex } from './stream.js'

const FEATURE = 'node-net'

// --- errors ---------------------------------------------------------------------------------------

const DESCRIPTIONS = {
  EADDRINUSE: 'address already in use',
  EADDRNOTAVAIL: 'address not available',
  EACCES: 'permission denied',
  EAFNOSUPPORT: 'address family not supported',
}

/** A Node-shaped Error from what Rust reports for a socket call. */
export function socketError(body, api = 'net') {
  if (!body || typeof body !== 'object' || !body.code) return explainError(api, body)
  if (body.code === 'ERR_FEATURE_DISABLED' || body.code === 'ERR_ACCESS_DENIED') {
    return nodeFailure({ api, module: 'net', feature: body.feature ?? FEATURE, status: 400, body })
  }
  const { code, errno, syscall, address, port, hostname } = body
  let message
  if (code.startsWith('ERR_')) message = body.message ?? code
  else if (syscall === 'getaddrinfo') message = `getaddrinfo ${code} ${hostname}`
  else if (syscall === 'listen' && DESCRIPTIONS[code]) message = `listen ${code}: ${DESCRIPTIONS[code]} ${address ?? ''}${port !== undefined && port !== null ? `:${port}` : ''}`
  else if (syscall) message = `${syscall} ${code}${address ? ` ${address}${port !== undefined && port !== null ? `:${port}` : ''}` : ''}`
  else message = body.message ?? code
  const error = new Error(message)
  if (code.startsWith('ERR_') && !body.syscall) error.name = 'Error'
  if (code === 'ENOTFOUND' && syscall === 'getaddrinfo') error.errno = -3008
  else if (code === 'EAI_AGAIN') error.errno = -3001
  else if (errno !== undefined && errno !== null) error.errno = errno
  error.code = code
  if (syscall) error.syscall = syscall
  if (hostname) error.hostname = hostname
  if (address !== undefined && address !== null) error.address = address
  if (port !== undefined && port !== null) error.port = port
  return error
}

/** Throws NotImplementedError (feature off, no Tauri) before any call is made. */
export function checkNet(api, feature = FEATURE) {
  if (!inTauri) throw noTauri(api, 'net', feature)
  if (!hasFeature(feature)) throw featureError(api, feature)
}

// --- addresses ----------------------------------------------------------------------------------

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

export function isIPv4(input) {
  return IPV4.test(String(input))
}

export function isIPv6(input) {
  const text = String(input)
  if (!text.includes(':') || /[^0-9a-fA-F:.%]/.test(text.split('%')[0])) return false
  try {
    new URL(`http://[${text.split('%')[0]}]/`)
    return true
  } catch {
    return false
  }
}

export function isIP(input) {
  return isIPv4(input) ? 4 : isIPv6(input) ? 6 : 0
}

let autoSelectFamily = false
let autoSelectFamilyAttemptTimeout = 250
export const getDefaultAutoSelectFamily = () => autoSelectFamily
export const setDefaultAutoSelectFamily = (value) => (autoSelectFamily = Boolean(value))
export const getDefaultAutoSelectFamilyAttemptTimeout = () => autoSelectFamilyAttemptTimeout
export const setDefaultAutoSelectFamilyAttemptTimeout = (value) => (autoSelectFamilyAttemptTimeout = Math.max(10, Number(value) || 250))

export class SocketAddress {
  constructor({ address = '127.0.0.1', port = 0, family = isIPv6(address) ? 'ipv6' : 'ipv4', flowlabel = 0 } = {}) {
    Object.assign(this, { address, port, family, flowlabel })
  }
}

// --- Socket ---------------------------------------------------------------------------------------

/** `(port, host, cb)`, `(path, cb)`, `(options, cb)` → options and callback, as Node normalizes them. */
export function normalizeConnectArgs(args) {
  const list = [...args]
  const callback = typeof list.at(-1) === 'function' ? list.pop() : undefined
  let options
  if (list[0] !== null && typeof list[0] === 'object') options = { ...list[0] }
  else if (typeof list[0] === 'string' && !/^\d+$/.test(list[0])) options = { path: list[0] }
  else options = { port: list[0], host: list[1] }
  return [options, callback]
}

const base64 = (chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64')

/** Node's net.Socket. */
export class Socket extends Duplex {
  constructor(options = {}) {
    super({
      allowHalfOpen: Boolean(options.allowHalfOpen),
      emitClose: false,
      autoDestroy: true,
      decodeStrings: true,
      readableHighWaterMark: options.readableHighWaterMark,
      writableHighWaterMark: options.writableHighWaterMark,
    })
    this._id = null
    this._channel = null
    this._pausedInRust = false
    this._rustPaused = false
    this._pauseSending = false
    this._ready = null
    this._timeoutMs = 0
    this._timer = null
    this._bytesWritten = 0
    this.bytesRead = 0
    this.connecting = false
    this.remoteAddress = undefined
    this.remotePort = undefined
    this.remoteFamily = undefined
    this.localAddress = undefined
    this.localPort = undefined
    this.localFamily = undefined
    this._noDelay = Boolean(options.noDelay)
    this._keepAlive = Boolean(options.keepAlive)
    this._keepAliveInitialDelay = options.keepAliveInitialDelay ?? 0
    this.on('end', () => this._touch())
  }

  get bytesWritten() {
    return this._bytesWritten
  }

  get pending() {
    return this._id === null
  }

  get readyState() {
    if (this.connecting) return 'opening'
    if (this.readable && this.writable) return 'open'
    if (this.readable) return 'readOnly'
    if (this.writable) return 'writeOnly'
    return 'closed'
  }

  /** Bind an id Rust created (a connected or accepted socket) and its addresses. */
  _attach(id, info = {}) {
    this._id = id
    this.connecting = false
    for (const key of ['remoteAddress', 'remotePort', 'remoteFamily', 'localAddress', 'localPort', 'localFamily']) {
      if (info[key] !== undefined && info[key] !== null) this[key] = info[key]
    }
    if (info.path) this._path = info.path
    this._resolveReady?.()
  }

  /** Events from Rust: data, end, error. */
  _onEvent(event) {
    if (event.type === 'data') {
      const chunk = Buffer.from(event.data, 'base64')
      this.bytesRead += chunk.length
      this._touch()
      if (!this.push(chunk)) this._pauseInRust(true)
    } else if (event.type === 'end') {
      // As Node: 'end' follows EOF even when nobody reads an empty socket.
      this.push(null)
      this.read(0)
    } else if (event.type === 'error') {
      this.destroy(socketError(event.error, 'net.Socket'))
    }
  }

  connect(...args) {
    const [options, callback] = normalizeConnectArgs(args)
    return this._connect(options, callback)
  }

  _connect(options, callback, tls) {
    checkNet(tls ? 'tls.connect' : 'net.connect', tls ? 'node-tls' : FEATURE)
    if (options.path === undefined) {
      const port = Number(options.port)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        const error = new RangeError(`Port should be >= 0 and < 65536. Received ${typeof options.port === 'string' ? `type string ('${options.port}')` : options.port}.`)
        error.code = 'ERR_SOCKET_BAD_PORT'
        throw error
      }
      options.port = port
    }
    if (callback) this.once(tls ? 'secureConnect' : 'connect', callback)
    this.connecting = true
    this._ready = new Promise((resolve) => (this._resolveReady = resolve))
    const channel = new Channel()
    channel.onmessage = (event) => this._onEvent(event)
    this._channel = channel
    if (options.timeout) this.setTimeout(options.timeout)
    const request = {
      host: options.host ?? (options.path === undefined ? 'localhost' : undefined),
      port: options.port,
      path: options.path,
      family: options.family || undefined,
      localAddress: options.localAddress,
      localPort: options.localPort,
      noDelay: options.noDelay ?? this._noDelay,
      keepAlive: options.keepAlive ?? this._keepAlive,
      keepAliveInitialDelay: options.keepAliveInitialDelay ?? this._keepAliveInitialDelay,
      tls,
    }
    native('net_connect', { options: request, onEvent: channel }).then(
      (info) => {
        if (this.destroyed) {
          native('net_destroy', { id: info.id }).catch(() => {})
          return
        }
        this._attach(info.id, info)
        this._onConnected?.(info)
        this.emit('connect')
        this.emit('ready')
        this._touch()
      },
      (error) => {
        this.connecting = false
        this._resolveReady?.()
        const failure = socketError(error, tls ? 'tls.connect' : 'net.connect')
        this.destroy(this._connectError ? this._connectError(failure) : failure)
      },
    )
    return this
  }

  _write(chunk, encoding, callback) {
    const send = () => {
      if (this._id === null) return callback(Object.assign(new Error('This socket is closed'), { code: 'ERR_SOCKET_CLOSED' }))
      native('net_write', { id: this._id, data: base64(chunk) }).then(
        () => {
          this._bytesWritten += chunk.length
          this._touch()
          callback()
        },
        (error) => callback(socketError(error, 'net.Socket.write')),
      )
    }
    if (this.connecting && this._ready) this._ready.then(send)
    else send()
  }

  _final(callback) {
    const end = () => (this._id === null ? callback() : native('net_end', { id: this._id }).then(() => callback(), () => callback()))
    if (this.connecting && this._ready) this._ready.then(end)
    else end()
  }

  _read() {
    this._pauseInRust(false)
  }

  /**
   * Stop / restart reading in Rust. Commands can be handled out of order, so
   * one call is in flight at a time and it always sends the latest state.
   */
  _pauseInRust(paused) {
    this._pausedInRust = paused
    if (this._pauseSending || this._id === null) return
    this._pauseSending = true
    const send = () => {
      if (this._id === null || this._rustPaused === this._pausedInRust) {
        this._pauseSending = false
        return
      }
      const wanted = this._pausedInRust
      native('net_pause', { id: this._id, paused: wanted })
        .catch(() => {})
        .then(() => {
          this._rustPaused = wanted
          send()
        })
    }
    send()
  }

  _destroy(error, callback) {
    clearTimeout(this._timer)
    this.connecting = false
    if (this._id !== null) native('net_destroy', { id: this._id }).catch(() => {})
    this._onDestroyed?.()
    callback(error)
    queueMicrotask(() => this.emit('close', Boolean(error)))
  }

  /** `setTimeout(ms, [callback])`: emits 'timeout' after `ms` without activity. */
  setTimeout(ms, callback) {
    this._timeoutMs = Number(ms) || 0
    if (callback) {
      if (this._timeoutMs) this.once('timeout', callback)
      else this.removeListener('timeout', callback)
    }
    this._touch()
    return this
  }

  get timeout() {
    return this._timeoutMs || undefined
  }

  _touch() {
    clearTimeout(this._timer)
    if (this._timeoutMs > 0 && !this.destroyed) this._timer = setTimeout(() => this.emit('timeout'), this._timeoutMs)
  }

  setNoDelay(noDelay = true) {
    this._noDelay = Boolean(noDelay)
    if (this._id !== null) native('net_set_option', { id: this._id, name: 'noDelay', value: this._noDelay }).catch(() => {})
    return this
  }

  setKeepAlive(enable = false, initialDelay = 0) {
    this._keepAlive = Boolean(enable)
    this._keepAliveInitialDelay = initialDelay
    if (this._id !== null) native('net_set_option', { id: this._id, name: 'keepAlive', value: { enable: this._keepAlive, initialDelay } }).catch(() => {})
    return this
  }

  address() {
    if (this._path) return this._path
    if (this.localAddress === undefined) return {}
    return { address: this.localAddress, family: this.localFamily, port: this.localPort }
  }

  resetAndDestroy() {
    return this.destroy()
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}

export const Stream = Socket

// --- Server ---------------------------------------------------------------------------------------

/** `(port, host, backlog, cb)`, `(path, cb)`, `(options, cb)` → options and callback. */
function normalizeListenArgs(args) {
  const list = [...args]
  const callback = typeof list.at(-1) === 'function' ? list.pop() : undefined
  let options
  if (list[0] !== null && typeof list[0] === 'object' && !Array.isArray(list[0])) options = { ...list[0] }
  else if (typeof list[0] === 'string' && !/^\d+$/.test(list[0])) options = { path: list[0], backlog: list[1] }
  else options = { port: list[0] === undefined ? 0 : Number(list[0]), host: typeof list[1] === 'string' ? list[1] : undefined, backlog: typeof list[1] === 'number' ? list[1] : list[2] }
  return [options, callback]
}

/** Node's net.Server. */
export class Server extends EventEmitter {
  constructor(options, connectionListener) {
    super()
    if (typeof options === 'function') [connectionListener, options] = [options, {}]
    this._options = options ?? {}
    this._id = null
    this._address = null
    this._sockets = new Map()
    this.listening = false
    this.maxConnections = undefined
    if (connectionListener) this.on(this._connectionEvent ?? 'connection', connectionListener)
  }

  /** The `tls` options sent to Rust (tls.Server). */
  _tlsOptions() {
    return undefined
  }

  /** The socket an accepted connection becomes (tls.Server makes TLSSockets). */
  _createSocket() {
    return new Socket({ allowHalfOpen: this._options.allowHalfOpen, noDelay: this._options.noDelay, keepAlive: this._options.keepAlive })
  }

  listen(...args) {
    const [options, callback] = normalizeListenArgs(args)
    checkNet('net.Server.listen', this._tlsOptions() ? 'node-tls' : FEATURE)
    if (this.listening || this._listenPending) {
      const error = new Error('Listen method has been called more than once without closing.')
      error.code = 'ERR_SERVER_ALREADY_LISTEN'
      throw error
    }
    if (callback) this.once('listening', callback)
    const channel = new Channel()
    channel.onmessage = (event) => this._onEvent(event)
    const request = { host: options.host, port: options.port, path: options.path, backlog: options.backlog, ipv6Only: Boolean(options.ipv6Only), tls: this._tlsOptions() }
    this._listenPending = true
    native('net_listen', { options: request, onEvent: channel }).then(
      (info) => {
        this._listenPending = false
        // close() came before Rust answered: stop the listener it just opened.
        if (this._closeWhenListening) {
          this._closeWhenListening = false
          native('net_destroy', { id: info.id }).catch(() => {})
          queueMicrotask(() => this.emit('close'))
          return
        }
        this._id = info.id
        this._address = info.path ?? { address: info.address, family: info.family, port: info.port }
        this.listening = true
        this.emit('listening')
      },
      (error) => {
        this._listenPending = false
        if (this._closeWhenListening) {
          this._closeWhenListening = false
          queueMicrotask(() => this.emit('close'))
          return
        }
        this.emit('error', socketError(error, 'net.Server.listen'))
      },
    )
    return this
  }

  _onEvent(event) {
    if (event.type === 'connection') {
      const socket = this._createSocket()
      socket._attach(event.socket, event)
      socket._server = this
      socket.server = this
      this._sockets.set(event.socket, socket)
      socket._onDestroyed = () => {
        this._sockets.delete(event.socket)
        this._maybeClosed()
      }
      if (this.maxConnections !== undefined && this._sockets.size > this.maxConnections) {
        socket.destroy()
        this.emit('drop', { localAddress: socket.localAddress, localPort: socket.localPort, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, remoteFamily: socket.remoteFamily })
        return
      }
      this._onConnection(socket, event)
    } else if (event.type === 'tlsClientError') {
      this.emit('tlsClientError', Object.assign(new Error(event.error?.message ?? 'TLS handshake failed'), { code: event.error?.code ?? 'ECONNRESET' }), null)
    } else if (event.socket !== undefined) {
      this._sockets.get(event.socket)?._onEvent(event)
    } else if (event.type === 'error') {
      this.emit('error', socketError(event.error, 'net.Server'))
    }
  }

  _onConnection(socket) {
    this.emit('connection', socket)
  }

  address() {
    return this._address
  }

  /** Stops accepting; 'close' follows once every connection has closed. */
  close(callback) {
    if (this._listenPending) {
      this._closeWhenListening = true
      if (callback) this.once('close', callback)
      return this
    }
    if (callback) {
      if (!this.listening) {
        const error = new Error('Server is not running.')
        error.code = 'ERR_SERVER_NOT_RUNNING'
        queueMicrotask(() => callback(error))
      } else {
        this.once('close', callback)
      }
    }
    const wasListening = this.listening
    if (this._id !== null) {
      // 'close' waits until the listener is closed in Rust, so the port
      // refuses connections by then, as in Node.
      this._listenerClosing = true
      native('net_destroy', { id: this._id })
        .catch(() => {})
        .then(() => {
          this._listenerClosing = false
          this._maybeClosed()
        })
    }
    this.listening = false
    this._id = null
    this._closing = wasListening
    this._maybeClosed()
    return this
  }

  _maybeClosed() {
    if (this._closing && !this._listenerClosing && this._sockets.size === 0) {
      this._closing = false
      queueMicrotask(() => this.emit('close'))
    }
  }

  getConnections(callback) {
    queueMicrotask(() => callback(null, this._sockets.size))
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  [Symbol.asyncDispose ?? Symbol.for('nodejs.asyncDispose')]() {
    return new Promise((resolve) => this.close(() => resolve()))
  }
}

export function createServer(options, connectionListener) {
  return new Server(options, connectionListener)
}

export function connect(...args) {
  const [options, callback] = normalizeConnectArgs(args)
  const socket = new Socket(options)
  if (options.timeout) socket.setTimeout(options.timeout)
  return socket._connect(options, callback)
}
export const createConnection = connect

export class BlockList {
  constructor() {
    throw new NotImplementedError('net.BlockList', { reason: 'unimplemented', hint: 'BlockList is not implemented yet.' })
  }
}

const net = {
  Socket, Stream, Server, SocketAddress, BlockList, createServer, connect, createConnection, isIP, isIPv4, isIPv6,
  getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
}

export default net
