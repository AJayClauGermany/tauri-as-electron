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
 *
 * Not supported: transferring ports inside messages sent *over* a port.
 */
import { emitTo } from '@tauri-apps/api/event'
import { EventEmitter } from '../internal/emitter.js'
import { TO_RENDERER, report } from '../internal/runtime.js'
import { encode, decode } from '../internal/serialize.js'

const ports = new Map()
let nextPortId = 1

function post(label, message) {
  return emitTo(label, TO_RENDERER, { ...message, to: label }).catch(report('MessagePort relay'))
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
    this._transferred = null // { label, id }: this port now lives in a renderer
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
      post(this._transferred.label, { type: 'port-message', port: this._transferred.id, data })
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
    if (this._transferred) post(this._transferred.label, { type: 'port-close', port: this._transferred.id })
    this._forget()
    this.emit('close')
  }

  _onPeerClosed() {
    if (this._closed) return
    this._closed = true
    if (this._transferred) post(this._transferred.label, { type: 'port-close', port: this._transferred.id })
    this._forget()
    this.emit('close')
  }

  _forget() {
    if (this._remote) ports.delete(this._remote.id)
    if (this._transferred) ports.delete(this._transferred.id)
  }

  /** Hand this port to a renderer; returns the id the renderer will use. */
  _transferTo(label) {
    if (this._closed || this._transferred) throw cloneError('Port at index 0 is already neutered or closed')
    const id = `main:${nextPortId++}`
    this._transferred = { label, id }
    ports.set(id, this)
    const queue = this._queue.splice(0)
    for (const data of queue) post(label, { type: 'port-message', port: id, data })
    return id
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

/** Ports in a webContents.postMessage() transfer list → ids for the renderer. */
export function transferPorts(transfer, label) {
  if (!transfer?.length) return undefined
  return transfer.map((port) => {
    if (!(port instanceof MessagePortMain)) throw cloneError('Only MessagePortMain objects can be transferred')
    return port._transferTo(label)
  })
}
