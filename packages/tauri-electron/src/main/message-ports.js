/**
 * MessageChannelMain / MessagePortMain, and MessagePort transfer between the
 * main process and renderers.
 *
 * Ports created in the main process are plain objects entangled in memory.
 * When a port is transferred to a renderer (webContents.postMessage) or
 * received from one (ipcRenderer.postMessage), its messages are relayed over
 * the IPC bridge; the renderer side uses a real DOM MessageChannel, so page
 * code gets genuine `MessagePort`s, like in Electron. Port ids are global:
 * `main:<n>` for ports created here, `<label>:<n>` for renderer ports.
 * A utility process is a destination too (`registerPortSink`): its port
 * messages travel over its IPC channel instead of a Tauri event.
 *
 * Not supported: transferring ports inside messages sent *over* a port.
 */
import { emitTo } from '@tauri-apps/api/event'
import { EventEmitter } from '../internal/emitter.js'
import { TO_RENDERER, report } from '../internal/runtime.js'
import { encode, decode } from '../internal/serialize.js'

const ports = new Map()
let nextPortId = 1
/** Destinations other than windows (utility processes), by label. */
const sinks = new Map()

function post(label, message) {
  const sink = sinks.get(label)
  if (sink) return sink(message)
  return emitTo(label, TO_RENDERER, { ...message, to: label }).catch(report('MessagePort relay'))
}

/**
 * Deliver what is posted to `label` (`{ type: 'port-message' | 'port-close', port, data }`)
 * with `send` instead of a Tauri event; `send` null removes the destination.
 * The destination reports back through `onRendererPortMessage`.
 */
export function registerPortSink(label, send) {
  if (send) sinks.set(label, send)
  else sinks.delete(label)
}

function cloneError(message) {
  const error = new Error(message)
  error.name = 'DataCloneError'
  return error
}

export class MessagePortMain extends EventEmitter {
  constructor() {
    super()
    this._queue = []
    this._started = false
    this._closed = false
    this._entangled = null // the other end, when both ends live in the main process
    this._remote = null // { label, id }: the other end lives in a renderer
    this._transferred = null // { label, id, pending }: this port now lives in a renderer (pending: not sent there yet)
  }

  postMessage(message, transfer) {
    if (transfer?.length) throw cloneError('tauri-electron cannot transfer MessagePorts through a MessagePort')
    this._sendOut(encode(message))
  }

  /** Send already-encoded data out of this port to the other end. */
  _sendOut(data) {
    if (this._closed) return
    if (this._entangled) {
      const peer = this._entangled
      setTimeout(() => peer._deliver(data), 0)
    } else if (this._remote) {
      post(this._remote.label, { type: 'port-message', port: this._remote.id, data })
    }
  }

  /** A message arriving at this port. */
  _deliver(data) {
    if (this._closed) return
    if (this._transferred) {
      if (this._transferred.pending) this._queue.push(data)
      else post(this._transferred.label, { type: 'port-message', port: this._transferred.id, data })
    } else if (!this._started) {
      this._queue.push(data)
    } else {
      this.emit('message', { data: decode(data), ports: [] })
    }
  }

  start() {
    if (this._started) return
    this._started = true
    const queue = this._queue.splice(0)
    setTimeout(() => {
      for (const data of queue) this.emit('message', { data: decode(data), ports: [] })
    }, 0)
  }

  close() {
    if (this._closed) return
    this._closed = true
    if (this._entangled) this._entangled._onPeerClosed()
    if (this._remote) post(this._remote.label, { type: 'port-close', port: this._remote.id })
    this._closeTransferred()
    this._forget()
    this.emit('close')
  }

  _onPeerClosed() {
    if (this._closed) return
    this._closed = true
    this._closeTransferred()
    this._forget()
    this.emit('close')
  }

  /** Tell the port's new home it closed (after the transfer, if that is still pending). */
  _closeTransferred() {
    if (!this._transferred) return
    if (this._transferred.pending) this._transferred.closeOnFlush = true
    else post(this._transferred.label, { type: 'port-close', port: this._transferred.id })
  }

  _forget() {
    if (this._remote) ports.delete(this._remote.id)
    if (this._transferred) ports.delete(this._transferred.id)
  }

  /**
   * Hand this port to a renderer (or a utility process); returns the id the
   * destination will use. `deferQueue`: the caller sends the message that
   * creates the port first, then calls `_flushTransferred()` (a utility
   * process drops messages for ports it does not have yet).
   */
  _transferTo(label, { deferQueue = false } = {}) {
    if (this._closed || this._transferred) throw cloneError('Port at index 0 is already neutered or closed')
    this._reserved = false
    const id = `main:${nextPortId++}`
    // Pending until _flushTransferred(): messages (and a close) arriving
    // meanwhile wait, since the destination does not have the port yet.
    this._transferred = { label, id, pending: true }
    ports.set(id, this)
    if (!deferQueue) this._flushTransferred()
    return id
  }

  /** The port has reached its new home: send what waited for it. */
  _flushTransferred() {
    const transferred = this._transferred
    if (!transferred?.pending) return
    transferred.pending = false
    for (const data of this._queue.splice(0)) post(transferred.label, { type: 'port-message', port: transferred.id, data })
    if (transferred.closeOnFlush) post(transferred.label, { type: 'port-close', port: transferred.id })
  }

  /** A port that lives in a renderer, received through ipcRenderer.postMessage. */
  static _fromRenderer(label, id) {
    const port = new MessagePortMain()
    port._remote = { label, id }
    ports.set(id, port)
    return port
  }
}

export class MessageChannelMain {
  constructor() {
    this.port1 = new MessagePortMain()
    this.port2 = new MessagePortMain()
    this.port1._entangled = this.port2
    this.port2._entangled = this.port1
  }
}

/** Relay a port message/close coming from a renderer. */
export function onRendererPortMessage(message) {
  const port = ports.get(message.port)
  if (!port) return
  const fromTransferredEnd = port._transferred?.id === message.port
  if (message.type === 'port-close') {
    if (fromTransferredEnd) {
      // The renderer closed the end we gave it: like closing this port.
      port._transferred = null
      ports.delete(message.port)
      port.close()
    } else {
      port._onPeerClosed()
    }
    return
  }
  if (fromTransferredEnd) port._sendOut(message.data)
  else port._deliver(message.data)
}

/**
 * Throw if a transfer list cannot be transferred, before any port is: so a
 * bad entry leaves the others usable.
 */
export function checkTransferList(transfer, { reserved = false } = {}) {
  for (const [index, port] of transfer.entries()) {
    if (!(port instanceof MessagePortMain)) throw cloneError('Only MessagePortMain objects can be transferred')
    // `reserved`: ports reserved for this very message (reservePorts) are fine.
    if (port._closed || port._transferred || (port._reserved && !reserved) || transfer.indexOf(port) !== index) {
      throw cloneError(`Port at index ${index} is already neutered or closed`)
    }
  }
}

/**
 * Ports in a webContents.postMessage() transfer list → ids for the renderer.
 * `deferQueue`: the caller sends the message carrying them, then calls each
 * port's `_flushTransferred()` (what reached them meanwhile goes after it).
 */
export function transferPorts(transfer, label, { deferQueue = false } = {}) {
  if (!transfer?.length) return undefined
  checkTransferList(transfer, { reserved: true })
  return transfer.map((port) => port._transferTo(label, { deferQueue }))
}

/** Hold ports for a message that waits for its page: they cannot be transferred elsewhere meanwhile. */
export function reservePorts(transfer) {
  checkTransferList(transfer)
  for (const port of transfer) port._reserved = true
}
