/**
 * Node's `MessagePort` / `MessageChannel` / `BroadcastChannel` (from
 * `worker_threads`) over the webview's own. Node's ports are event
 * emitters: `port.on('message', (value) => …)` receives the value itself,
 * messages wait in the port until a 'message' listener is attached,
 * `close()` closes both ends and emits 'close' on both, and
 * `receiveMessageOnPort()` takes a waiting message synchronously.
 *
 * A port wraps a transport: a DOM `MessagePort`, or (for `parentPort` and a
 * `Worker`) the worker's own message channel. Ports sent in a message must
 * be listed in its transfer list, as in Node; they travel as DOM ports and
 * are wrapped again on arrival.
 */
import { EventEmitter } from './emitter.js'

/** Sent before a port closes, so the other end emits 'close' too (filtered out on arrival). */
const CLOSE = '__tauriElectronPortClose'

const wrappers = new WeakMap() // DOM MessagePort → MessagePort
const untransferable = new WeakSet()

/** Ports that keep a worker alive (a 'message' listener, ref'd, open), for its natural exit. */
const active = new Set()
const watchers = new Set()

/** `fn()` runs whenever the set of active ports changes. */
export function onActivePortsChange(fn) {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

export function activePortCount() {
  return active.size
}

function dataCloneError(message) {
  let error
  try {
    error = new DOMException(message, 'DataCloneError')
  } catch {
    error = new Error(message)
    error.name = 'DataCloneError'
  }
  return error
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A copy of `value` with every object `swap` maps replaced, copying only the
 * containers (arrays, plain objects, Maps, Sets) on the way to a replaced
 * object; everything else is passed by reference (structured clone copies it).
 */
function replaceDeep(value, swap, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value
  const swapped = swap(value)
  if (swapped !== undefined) return swapped
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const out = []
    seen.set(value, out)
    let changed = false
    for (const item of value) {
      const next = replaceDeep(item, swap, seen)
      changed ||= next !== item
      out.push(next)
    }
    if (!changed) seen.set(value, value)
    return changed ? out : value
  }
  if (value instanceof Map) {
    const out = new Map()
    seen.set(value, out)
    let changed = false
    for (const [k, v] of value) {
      const nk = replaceDeep(k, swap, seen)
      const nv = replaceDeep(v, swap, seen)
      changed ||= nk !== k || nv !== v
      out.set(nk, nv)
    }
    if (!changed) seen.set(value, value)
    return changed ? out : value
  }
  if (value instanceof Set) {
    const out = new Set()
    seen.set(value, out)
    let changed = false
    for (const v of value) {
      const nv = replaceDeep(v, swap, seen)
      changed ||= nv !== v
      out.add(nv)
    }
    if (!changed) seen.set(value, value)
    return changed ? out : value
  }
  if (!isPlainObject(value)) return value
  const out = {}
  seen.set(value, out)
  let changed = false
  for (const key of Object.keys(value)) {
    const next = replaceDeep(value[key], swap, seen)
    changed ||= next !== value[key]
    out[key] = next
  }
  if (!changed) seen.set(value, value)
  return changed ? out : value
}

function transferListOf(options) {
  if (options === undefined || options === null) return []
  if (Array.isArray(options)) return options
  if (typeof options === 'object' && Array.isArray(options.transfer)) return options.transfer
  if (typeof options === 'object' && options.transfer === undefined) return []
  throw new TypeError('The "transferList" argument must be an array')
}

/**
 * What to hand the DOM's postMessage for a Node `postMessage(value, transferList)`:
 * Node ports become DOM ports (in the value and the transfer list) and are
 * detached here, like in Node. `self` is the sending port, which cannot be
 * transferred through itself.
 */
export function outgoing(value, options, self) {
  const list = transferListOf(options)
  if (!list.length) return { value, transfer: [] }
  const map = new Map()
  const transfer = []
  for (const item of list) {
    if (item === self && self) throw dataCloneError('Transfer list contains source port')
    if (item && typeof item === 'object' && untransferable.has(item)) throw dataCloneError('An ArrayBuffer is marked as untransferable')
    if (item instanceof MessagePort) {
      const native = item._native
      if (!native) throw dataCloneError('MessagePort in transfer list is already detached')
      map.set(item, native)
      transfer.push(native)
    } else {
      transfer.push(item)
    }
  }
  const swapped = map.size ? replaceDeep(value, (v) => map.get(v)) : value
  for (const port of map.keys()) port._detach()
  return { value: swapped, transfer }
}

/** The value of an arriving message, its DOM ports wrapped as Node ports. */
export function incoming(value, ports) {
  if (!ports || !ports.length) return value
  const set = new Set(ports)
  return replaceDeep(value, (v) => (set.has(v) ? wrapPort(v) : undefined))
}

/** The Node port for a DOM port (one wrapper per DOM port). */
export function wrapPort(native) {
  return wrappers.get(native) ?? makePort(native)
}

function nativeTransport(native) {
  return {
    native,
    post: (value, transfer) => native.postMessage(value, transfer),
    close: () => native.close(),
    attach(port) {
      native.onmessage = (event) => port._receive(event.data, event.ports)
      native.onmessageerror = (event) => port._messageError(event)
    },
    detach() {
      native.onmessage = null
      native.onmessageerror = null
    },
  }
}

function messageEvent(type, init) {
  try {
    return new MessageEvent(type, init)
  } catch {
    return { type, ...init }
  }
}

const NOT_CONSTRUCTIBLE = Symbol('MessagePort')

export class MessagePort extends EventEmitter {
  /** Not for user code (`new MessagePort()` throws, as in Node): ports come from a MessageChannel. */
  constructor(transport, key) {
    if (key !== NOT_CONSTRUCTIBLE || !transport || typeof transport !== 'object') throw new TypeError('Illegal constructor')
    super()
    Object.defineProperties(this, {
      _transport: { value: transport, writable: true },
      _queue: { value: [], writable: true },
      _closed: { value: false, writable: true },
      _refed: { value: true, writable: true },
      _flushing: { value: false, writable: true },
      _domListeners: { value: new Map() },
      _onmessage: { value: null, writable: true },
      _onmessageerror: { value: null, writable: true },
    })
    transport.attach(this)
  }

  /** The DOM port behind this one (undefined for parentPort / once transferred). */
  get _native() {
    return this._transport?.native
  }

  postMessage(value, transferList) {
    if (this._closed || !this._transport) return
    const { value: data, transfer } = outgoing(value, transferList, this)
    this._transport.post(data, transfer)
  }

  /** Messages arriving from the other end. */
  _receive(data, ports) {
    if (this._closed) return
    if (data && typeof data === 'object' && data[CLOSE] === true) {
      this._shutdown()
      return
    }
    this._queue.push({ data, ports })
    this._flush()
  }

  _messageError(event) {
    const error = dataCloneError('Message could not be deserialized')
    if (this.listenerCount('messageerror')) this.emit('messageerror', error)
    void event
  }

  _flush() {
    if (this._flushing || !this.listenerCount('message') || !this._queue.length) return
    this._flushing = true
    // Asynchronous, like a MessagePort event, even for messages queued before the listener.
    queueMicrotask(() => {
      this._flushing = false
      while (this._queue.length && this.listenerCount('message') && !this._closed) {
        const { data, ports } = this._queue.shift()
        this.emit('message', incoming(data, ports))
      }
    })
  }

  _newListener(name) {
    // Called before the listener is stored: look once it is.
    if (name === 'message') {
      queueMicrotask(() => {
        this._flush()
        this._updateActive()
      })
    }
  }

  off(name, listener) {
    super.off(name, listener)
    if (name === 'message') this._updateActive()
    return this
  }

  removeListener(name, listener) {
    return this.off(name, listener)
  }

  removeAllListeners(name) {
    super.removeAllListeners(name)
    this._updateActive()
    return this
  }

  _updateActive() {
    const was = active.has(this)
    const is = !this._closed && this._refed && this.listenerCount('message') > 0
    if (was === is) return
    if (is) active.add(this)
    else active.delete(this)
    for (const fn of watchers) fn()
  }

  /** Messages are delivered once a 'message' listener exists; start() is accepted for the DOM API's sake. */
  start() {
    this._flush()
  }

  close() {
    if (this._closed) return
    // A DOM port's other end closes too (parentPort has no other end to tell).
    if (this._native) {
      try {
        this._transport.post({ [CLOSE]: true }, [])
      } catch {
        /* the other end is gone */
      }
    }
    this._shutdown()
  }

  _shutdown() {
    if (this._closed) return
    this._closed = true
    this._queue.length = 0
    try {
      this._transport?.detach()
      this._transport?.close()
    } catch {
      /* already closed */
    }
    this._updateActive()
    queueMicrotask(() => this.emit('close'))
  }

  /** Transferred elsewhere: this side no longer sends or receives. */
  _detach() {
    this._transport?.detach()
    if (this._native) wrappers.delete(this._native)
    this._transport = null
    this._closed = true
    this._updateActive()
  }

  ref() {
    this._refed = true
    this._updateActive()
    return this
  }

  unref() {
    this._refed = false
    this._updateActive()
    return this
  }

  hasRef() {
    return this._refed && !this._closed
  }

  // EventTarget side of Node's MessagePort: listeners get a MessageEvent.
  addEventListener(type, listener) {
    if (typeof listener !== 'function' && typeof listener?.handleEvent !== 'function') return
    const key = `${type}`
    let byListener = this._domListeners.get(key)
    if (!byListener) this._domListeners.set(key, (byListener = new Map()))
    if (byListener.has(listener)) return
    const call = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener)
    const wrapped = (value) => call.call(this, type === 'message' ? messageEvent('message', { data: value }) : messageEvent(type, { data: value }))
    byListener.set(listener, wrapped)
    this.on(type, wrapped)
  }

  removeEventListener(type, listener) {
    const wrapped = this._domListeners.get(`${type}`)?.get(listener)
    if (!wrapped) return
    this._domListeners.get(`${type}`).delete(listener)
    this.off(type, wrapped)
  }

  dispatchEvent(event) {
    this.emit(event.type, event.data)
    return true
  }

  get onmessage() {
    return this._onmessage
  }

  set onmessage(handler) {
    if (this._onmessage) this.removeEventListener('message', this._onmessage)
    this._onmessage = typeof handler === 'function' ? handler : null
    if (this._onmessage) this.addEventListener('message', this._onmessage)
  }

  get onmessageerror() {
    return this._onmessageerror
  }

  set onmessageerror(handler) {
    if (this._onmessageerror) this.removeEventListener('messageerror', this._onmessageerror)
    this._onmessageerror = typeof handler === 'function' ? handler : null
    if (this._onmessageerror) this.addEventListener('messageerror', this._onmessageerror)
  }

  get [Symbol.toStringTag]() {
    return 'MessagePort'
  }
}

/** A port over a custom transport (parentPort, a Worker's channel). */
export function createPort(transport) {
  return new MessagePort(transport, NOT_CONSTRUCTIBLE)
}

function makePort(native) {
  const port = new MessagePort(nativeTransport(native), NOT_CONSTRUCTIBLE)
  wrappers.set(native, port)
  return port
}

export class MessageChannel {
  constructor() {
    const channel = new globalThis.MessageChannel()
    this.port1 = makePort(channel.port1)
    this.port2 = makePort(channel.port2)
  }
}

/**
 * `receiveMessageOnPort(port)`: the oldest message waiting in `port` as
 * `{ message }`, or undefined. Only messages that have already arrived (a
 * task after they were posted) can be taken: the webview has no
 * synchronous receive.
 */
export function receiveMessageOnPort(port) {
  if (!(port instanceof MessagePort)) {
    const error = new TypeError('The "port" argument must be a MessagePort instance')
    error.code = 'ERR_INVALID_ARG_TYPE'
    throw error
  }
  if (!port._queue.length) return undefined
  const { data, ports } = port._queue.shift()
  return { message: incoming(data, ports) }
}

export function markAsUntransferable(object) {
  if (object && (typeof object === 'object' || typeof object === 'function')) untransferable.add(object)
}

export function isMarkedAsUntransferable(object) {
  return Boolean(object && untransferable.has(object))
}

/** Node's BroadcastChannel is the web one plus ref() / unref(). */
const NativeBroadcastChannel = globalThis.BroadcastChannel

export const BroadcastChannel = NativeBroadcastChannel
  ? class BroadcastChannel extends NativeBroadcastChannel {
      ref() {
        return this
      }

      unref() {
        return this
      }
    }
  : class BroadcastChannel {
      constructor() {
        throw new TypeError('BroadcastChannel is not available in this webview')
      }
    }
