/**
 * Node's `dgram` (UDP), backed by tauri-plugin-electron (Cargo feature
 * `node-net`): bind, send, receive, broadcast, multicast, and `connect()`
 * (kept in JavaScript: datagrams from other peers are dropped, as the
 * kernel would for a connected socket).
 */
import { Channel } from '@tauri-apps/api/core'
import { EventEmitter } from '../internal/emitter.js'
import { native } from '../internal/native.js'
import { Buffer } from './buffer.js'
import { checkNet, socketError, isIP } from './net.js'

function systemError(code, syscall) {
  const errno = { EBADF: -9, EINVAL: -22 }[code]
  return Object.assign(new Error(`${syscall} ${code}`), { code, errno, syscall })
}

function codedError(code, message, Ctor = Error) {
  return Object.assign(new Ctor(message), { code })
}

/** Node's dgram.Socket. */
export class Socket extends EventEmitter {
  constructor(options, listener) {
    super()
    if (typeof options === 'string') options = { type: options }
    if (!options || (options.type !== 'udp4' && options.type !== 'udp6')) {
      throw codedError('ERR_SOCKET_BAD_TYPE', 'Bad socket type specified. Valid types are: udp4, udp6', TypeError)
    }
    this.type = options.type
    this._options = options
    this._id = null
    this._address = null
    this._binding = null
    this._remote = null
    this._closed = false
    this._sizes = { recv: options.recvBufferSize, send: options.sendBufferSize }
    if (listener) this.on('message', listener)
    if (options.signal) {
      if (options.signal.aborted) queueMicrotask(() => this.close())
      else options.signal.addEventListener('abort', () => this.close(), { once: true })
    }
  }

  /** `bind([port], [address], [cb])` or `bind(options, [cb])`. */
  bind(...args) {
    checkNet('dgram.Socket.bind')
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined
    const options = args[0] !== null && typeof args[0] === 'object' ? args[0] : { port: args[0], address: args[1] }
    if (this._binding) throw codedError('ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound')
    if (callback) this.once('listening', callback)
    this._binding = this._bind(options)
    return this
  }

  _bind(options = {}) {
    const channel = new Channel()
    channel.onmessage = (event) => this._onEvent(event)
    const request = {
      type: this.type,
      address: options.address,
      port: options.port === undefined ? 0 : Number(options.port),
      reuseAddr: Boolean(this._options.reuseAddr),
      ipv6Only: Boolean(this._options.ipv6Only),
      recvBufferSize: this._options.recvBufferSize,
      sendBufferSize: this._options.sendBufferSize,
    }
    return native('udp_bind', { options: request, onEvent: channel }).then(
      (info) => {
        if (this._closed) {
          native('net_destroy', { id: info.id }).catch(() => {})
          return false
        }
        this._id = info.id
        this._address = { address: info.address, family: info.family, port: info.port }
        this.emit('listening')
        return true
      },
      (error) => {
        this._binding = null
        this.emit('error', socketError(error, 'dgram.Socket.bind'))
        return false
      },
    )
  }

  _onEvent(event) {
    if (event.type === 'message') {
      if (this._remote && (event.address !== this._remote.address || event.port !== this._remote.port)) return
      this.emit('message', Buffer.from(event.data, 'base64'), { address: event.address, family: event.family, port: event.port, size: event.size })
    } else if (event.type === 'error') {
      this.emit('error', socketError(event.error, 'dgram.Socket'))
    }
  }

  /** `send(msg, [offset, length], [port, address], [callback])`, overloads resolved as Node does. */
  send(message, offset, length, port, address, callback) {
    checkNet('dgram.Socket.send')
    let data = this._bytes(message)
    if (!this._remote) {
      if (address || (port && typeof port !== 'function')) {
        data = data.subarray(offset, offset + length)
      } else {
        callback = port
        port = offset
        address = length
      }
    } else {
      if (typeof length === 'number') {
        data = data.subarray(offset, offset + length)
        if (typeof port === 'function') {
          callback = port
          port = null
        }
      } else {
        callback = offset
        port = null
        address = undefined
      }
      if (port || (address && typeof address !== 'function')) throw codedError('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected')
      ;({ port, address } = this._remote)
    }
    if (typeof address === 'function') {
      callback = address
      address = undefined
    }
    if (port === undefined || port === null) throw codedError('ERR_SOCKET_BAD_PORT', 'Port should be > 0 and < 65536', RangeError)
    address = address || (this.type === 'udp6' ? '::1' : '127.0.0.1')
    const bound = this._binding ?? (this._binding = this._bind({ port: 0 }))
    bound
      .then((ok) => {
        if (!ok) throw codedError('ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running')
        return native('udp_send', { id: this._id, data: data.toString('base64'), port: Number(port), address })
      })
      .then(
        (bytes) => callback?.(null, bytes),
        (error) => {
          const failure = error instanceof Error ? error : socketError(error, 'dgram.Socket.send')
          if (typeof callback === 'function') callback(failure)
          else this.emit('error', failure)
        },
      )
  }

  _bytes(message) {
    const parts = Array.isArray(message) ? message : [message]
    return Buffer.concat(
      parts.map((part) => {
        if (typeof part === 'string') return Buffer.from(part)
        if (ArrayBuffer.isView(part)) return Buffer.from(part.buffer, part.byteOffset, part.byteLength)
        throw Object.assign(new TypeError('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, or DataView.'), { code: 'ERR_INVALID_ARG_TYPE' })
      }),
    )
  }

  /** `connect(port, [address], [callback])`: later sends go to that peer only. */
  connect(port, address, callback) {
    if (typeof address === 'function') [callback, address] = [address, undefined]
    if (this._remote) throw codedError('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected')
    address = address || (this.type === 'udp6' ? '::1' : '127.0.0.1')
    const bound = this._binding ?? (this._binding = this._bind({ port: 0 }))
    const resolve = isIP(address) ? Promise.resolve(address) : native('dns_lookup', { hostname: address, family: this.type === 'udp6' ? 6 : 4 }).then((list) => list[0].address)
    Promise.all([bound, resolve]).then(
      ([, resolved]) => {
        this._remote = { address: resolved, port: Number(port), family: this.type === 'udp6' ? 'IPv6' : 'IPv4' }
        this.emit('connect')
        callback?.()
      },
      (error) => {
        const failure = error instanceof Error ? error : socketError(error, 'dgram.Socket.connect')
        if (callback) callback(failure)
        else this.emit('error', failure)
      },
    )
  }

  disconnect() {
    if (!this._remote) throw codedError('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected')
    this._remote = null
  }

  remoteAddress() {
    if (!this._remote) throw codedError('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected')
    return { ...this._remote }
  }

  address() {
    if (!this._address) throw systemError('EBADF', 'getsockname')
    return { ...this._address }
  }

  close(callback) {
    if (this._closed) {
      if (callback) queueMicrotask(() => callback(codedError('ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running')))
      return this
    }
    this._closed = true
    if (callback) this.once('close', callback)
    if (this._id !== null) native('net_destroy', { id: this._id }).catch(() => {})
    queueMicrotask(() => this.emit('close'))
    return this
  }

  _option(name, value, syscall) {
    if (this._id === null) throw systemError('EBADF', syscall)
    native('udp_option', { id: this._id, name, value }).catch((error) => this.emit('error', socketError(error, `dgram.Socket.${syscall}`)))
  }

  setBroadcast(flag) {
    this._option('broadcast', Boolean(flag), 'setBroadcast')
  }

  setTTL(ttl) {
    this._option('ttl', ttl, 'setTTL')
    return ttl
  }

  setMulticastTTL(ttl) {
    this._option('multicastTTL', ttl, 'setMulticastTTL')
    return ttl
  }

  setMulticastLoopback(flag) {
    this._option('multicastLoopback', Boolean(flag), 'setMulticastLoopback')
    return flag
  }

  setMulticastInterface(address) {
    this._option('multicastInterface', address, 'setMulticastInterface')
  }

  setRecvBufferSize(size) {
    this._sizes.recv = size
    this._option('recvBufferSize', size, 'setRecvBufferSize')
  }

  setSendBufferSize(size) {
    this._sizes.send = size
    this._option('sendBufferSize', size, 'setSendBufferSize')
  }

  /** The last size set (the kernel may round it); 0 until one is. */
  getRecvBufferSize() {
    if (this._id === null) throw systemError('EBADF', 'getRecvBufferSize')
    return this._sizes.recv ?? 0
  }

  getSendBufferSize() {
    if (this._id === null) throw systemError('EBADF', 'getSendBufferSize')
    return this._sizes.send ?? 0
  }

  addMembership(group, iface) {
    if (this._id === null) throw systemError('EBADF', 'addMembership')
    native('udp_membership', { id: this._id, add: true, group, interface: iface ?? null }).catch((error) => this.emit('error', socketError(error, 'dgram.Socket.addMembership')))
  }

  dropMembership(group, iface) {
    if (this._id === null) throw systemError('EBADF', 'dropMembership')
    native('udp_membership', { id: this._id, add: false, group, interface: iface ?? null }).catch((error) => this.emit('error', socketError(error, 'dgram.Socket.dropMembership')))
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

export function createSocket(options, listener) {
  return new Socket(options, listener)
}

export default { Socket, createSocket }
