/**
 * Loaded first (`node --require bootstrap.cjs`) in the Node.js children of
 * `utilityProcess.fork` and `child_process.fork`; the bundler plugins build
 * it to `bootstrap.cjs` next to the fork entries.
 *
 * - `require('electron')` returns the child's `electron` (./electron.js).
 * - `TAURI_ELECTRON_IPC=utility:fd:<n>` (or `utility:tcp:<port>:<token>`):
 *   `process.parentPort` for a utility process, on the IPC channel
 *   tauri-plugin-electron opened (see ../main/utility-process.js for the
 *   line protocol), with `MessagePortMain`s for transferred ports. The
 *   process exits when the main process goes away, as Electron's utility
 *   processes do.
 * - `TAURI_ELECTRON_IPC=node:tcp:<port>:<token>` (Windows): `process.send`,
 *   `process.on('message')`, `process.disconnect()` and `process.connected`
 *   over loopback, as Node's own channel would provide them. On Unix, Node's
 *   channel (`NODE_CHANNEL_FD`) is used and this part does not run.
 *
 * Both variables are removed from `process.env`, so that grandchildren do
 * not pick them up.
 */
import { EventEmitter } from 'node:events'
import Module from 'node:module'
import net from 'node:net'
import { encode, decode } from '../internal/serialize.js'
import electron from './electron.js'

const INSTALLED = Symbol.for('tauri-electron.fork-bootstrap')

function hookElectron() {
  const load = Module._load
  Module._load = function loadWithElectron(request, ...rest) {
    if (request === 'electron' || request === 'electron/main' || request === 'electron/utility' || request === 'electron/common') return electron
    return load.call(this, request, ...rest)
  }
}

/** The socket of the channel, unreferenced until something listens. */
function connect(transport, rest) {
  let socket
  if (transport === 'fd') {
    socket = new net.Socket({ fd: Number(rest[0]), readable: true, writable: true })
  } else if (transport === 'tcp') {
    const [port, token] = rest
    socket = net.connect({ host: '127.0.0.1', port: Number(port) })
    socket.setNoDelay(true)
    // Queued writes keep their order: the token goes first.
    socket.write(`${token}\n`)
  } else {
    return null
  }
  socket.setEncoding('utf8')
  socket.unref()
  return socket
}

/** Call `onLine` for every complete line; `onEnd` once the channel closes. */
function readLines(socket, onLine, onEnd) {
  let pending = ''
  socket.on('data', (chunk) => {
    pending += chunk
    let index
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index)
      pending = pending.slice(index + 1)
      if (!line) continue
      let value
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      onLine(value)
    }
  })
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    onEnd()
  }
  socket.on('end', end)
  socket.on('close', end)
  socket.on('error', end)
}

/** References the socket (keeps the process alive) while anything needs it. */
function holder(socket) {
  const holds = new Set()
  return {
    hold(key, on) {
      if (on) holds.add(key)
      else holds.delete(key)
      if (holds.size) socket.ref()
      else socket.unref()
    },
  }
}

function cloneError(message) {
  const error = new Error(message)
  error.name = 'DataCloneError'
  return error
}

// --- utility process: process.parentPort ---------------------------------------------------

function installParentPort(socket) {
  const send = (message) => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
  }
  const { hold } = holder(socket)
  const ports = new Map()

  /** Electron's MessagePortMain, for a port the main process transferred here. */
  class MessagePortMain extends EventEmitter {
    constructor(id) {
      super()
      this._id = id
      this._queue = []
      this._started = false
      this._closed = false
      ports.set(id, this)
    }

    postMessage(message, transfer) {
      if (transfer?.length) throw cloneError('tauri-electron cannot transfer MessagePorts through a MessagePort')
      if (this._closed) return
      send({ t: 'pm', p: this._id, d: encode(message) })
    }

    start() {
      if (this._started || this._closed) return
      this._started = true
      hold(this, true)
      const queue = this._queue.splice(0)
      setImmediate(() => {
        for (const data of queue) this._emitMessage(data)
      })
    }

    close() {
      if (this._closed) return
      send({ t: 'pc', p: this._id })
      this._shut()
    }

    _deliver(data) {
      if (this._closed) return
      if (this._started) this._emitMessage(data)
      else this._queue.push(data)
    }

    _emitMessage(data) {
      if (!this._closed) this.emit('message', { data: decode(data), ports: [] })
    }

    _shut() {
      if (this._closed) return
      this._closed = true
      ports.delete(this._id)
      hold(this, false)
      this.emit('close')
    }
  }

  /** Electron's ParentPort: started by its first 'message' listener. */
  class ParentPort extends EventEmitter {
    constructor() {
      super()
      this._queue = []
      this._started = false
      this.on('newListener', (name) => {
        if (name === 'message' && this.listenerCount('message') === 0) this.start()
      })
      this.on('removeListener', (name) => {
        if (name === 'message' && this.listenerCount('message') === 0) this.pause()
      })
    }

    start() {
      if (this._started) return
      this._started = true
      hold(this, true)
      // After the listener being added is in place.
      setImmediate(() => {
        while (this._started && this._queue.length) this.emit('message', this._queue.shift())
      })
    }

    pause() {
      this._started = false
      hold(this, false)
    }

    postMessage(message) {
      send({ t: 'm', d: encode(message) })
    }

    _deliver(event) {
      if (this._started && !this._queue.length) this.emit('message', event)
      else this._queue.push(event)
    }
  }

  const parentPort = new ParentPort()
  Object.defineProperty(process, 'parentPort', { value: parentPort, enumerable: true, configurable: false, writable: false })
  readLines(
    socket,
    (message) => {
      if (message.t === 'm') {
        const transferred = (message.p ?? []).map((id) => new MessagePortMain(id))
        parentPort._deliver({ data: decode(message.d), ports: transferred })
      } else if (message.t === 'pm') {
        ports.get(message.p)?._deliver(message.d)
      } else if (message.t === 'pc') {
        ports.get(message.p)?._shut()
      }
    },
    // The main process is gone (or killed us off): like Electron, end too.
    () => process.exit(0),
  )
}

// --- forked child over loopback (Windows): Node's process.send ------------------------------

function installProcessChannel(socket) {
  const { hold } = holder(socket)
  let connected = true
  process.connected = true
  process.channel = {
    ref: () => hold('channel', true),
    unref: () => hold('channel', false),
  }
  process.send = function send(message, handle, options, callback) {
    if (typeof handle === 'function') callback = handle
    else if (typeof options === 'function') callback = options
    if (message === undefined) {
      const error = new TypeError('The "message" argument must be specified')
      error.code = 'ERR_MISSING_ARGS'
      throw error
    }
    if (!connected) {
      const error = new Error('Channel closed')
      error.code = 'ERR_IPC_CHANNEL_CLOSED'
      if (typeof callback === 'function') process.nextTick(callback, error)
      else process.nextTick(() => process.emit('error', error))
      return false
    }
    return socket.write(`${JSON.stringify(message)}\n`, (error) => {
      if (typeof callback === 'function') callback(error ?? null)
    })
  }
  process.disconnect = function disconnect() {
    if (!connected) {
      const error = new Error('IPC channel is already disconnected')
      error.code = 'ERR_IPC_DISCONNECTED'
      process.emit('error', error)
      return
    }
    socket.end()
  }
  // Like Node: 'message' and 'disconnect' listeners keep the channel referenced.
  let listeners = 0
  const counts = (name) => name === 'message' || name === 'disconnect'
  process.on('newListener', (name) => {
    if (counts(name)) hold('listeners', ++listeners > 0)
  })
  process.on('removeListener', (name) => {
    if (counts(name)) hold('listeners', --listeners > 0)
  })
  readLines(
    socket,
    (message) => {
      if (message && typeof message === 'object' && typeof message.cmd === 'string' && message.cmd.startsWith('NODE_')) process.emit('internalMessage', message)
      else process.emit('message', message, undefined)
    },
    () => {
      connected = false
      process.connected = false
      process.channel = undefined
      hold('listeners', false)
      process.emit('disconnect')
    },
  )
}

function install() {
  if (globalThis[INSTALLED]) return
  globalThis[INSTALLED] = true
  const spec = process.env.TAURI_ELECTRON_IPC
  const serviceName = process.env.TAURI_ELECTRON_SERVICE_NAME
  delete process.env.TAURI_ELECTRON_IPC
  delete process.env.TAURI_ELECTRON_SERVICE_NAME
  hookElectron()
  if (!spec) return
  const [kind, transport, ...rest] = spec.split(':')
  const socket = connect(transport, rest)
  if (!socket) return
  if (kind === 'utility') {
    process.type = 'utility'
    if (serviceName) process.title = serviceName
    installParentPort(socket)
  } else if (kind === 'node') {
    installProcessChannel(socket)
  }
}

install()
