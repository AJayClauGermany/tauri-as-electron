/**
 * Electron's `utilityProcess`: a module running in a Node.js child process
 * that talks to the main process through `process.parentPort`.
 *
 * The child is a real Node.js started by tauri-plugin-electron (Cargo feature
 * `node-child-process`; see ../internal/fork.js for how the runtime and the
 * module file are found). Its IPC channel carries one JSON text per line:
 *
 *   main → child   { t: 'm', d, p }   a message (structured-clone-like `d`,
 *                                     transferred MessagePortMain ids `p`)
 *                  { t: 'pm', p, d }  a message for a port the child holds
 *                  { t: 'pc', p }     that port's other end closed
 *   child → main   { t: 'm', d }      process.parentPort.postMessage
 *                  { t: 'pm', p, d } / { t: 'pc', p }  the child's ports
 *
 * tauri-electron's bootstrap (bundled next to the fork entries and loaded
 * with `--require`) gives the child `process.parentPort` and
 * `MessagePortMain`s. Ports go main → child (`postMessage(msg, [port])`),
 * as in Electron; their messages are relayed by the main process, so a port
 * whose other end is in a renderer works too.
 *
 * Not supported: the `'error'` event (V8 fatal errors are not reported),
 * `respondToAuthRequestsFromMainProcess`, and, as everywhere in
 * tauri-electron, transferring ports through a port.
 */
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError } from '../internal/runtime.js'
import { encode, decode } from '../internal/serialize.js'
import { signalNumber } from '../internal/signals.js'
import { bootstrapFile, childEnv, nodeArgs, parseLine, resolveModule } from '../internal/fork.js'
import { startNodeChild } from '../node/child-process.js'
import { checkTransferList, onRendererPortMessage, registerPortSink } from './message-ports.js'

const STDIO = new Set(['pipe', 'ignore', 'inherit'])
let nextLabel = 1

/** Electron's `stdio` option: stdout and stderr; stdin is always ignored. */
function utilityStdio(stdio = 'inherit') {
  if (typeof stdio === 'string') {
    if (!STDIO.has(stdio)) throw new Error(`stdio value ${stdio} is not supported.`)
    return ['ignore', stdio, stdio]
  }
  if (Array.isArray(stdio)) {
    const [stdin = 'ignore', stdout = 'inherit', stderr = 'inherit'] = stdio
    if (stdin !== 'ignore') throw new Error('stdin value other than ignore is not supported.')
    for (const value of [stdout, stderr]) if (!STDIO.has(value)) throw new Error(`stdio value ${value} is not supported.`)
    return ['ignore', stdout, stderr]
  }
  throw new TypeError('stdio must be a string or an array')
}

export class UtilityProcess extends EventEmitter {
  constructor(modulePath, args = [], options = {}) {
    super()
    if (typeof modulePath !== 'string' && !(modulePath instanceof URL)) throw new TypeError('The "modulePath" argument must be of type string or an instance of URL')
    if (!Array.isArray(args)) throw new TypeError('The "args" argument must be an array')
    this.pid = undefined
    this.stdout = null
    this.stderr = null
    this._label = `utility:${nextLabel++}`
    this._ports = new Set()
    this._exited = false

    const stdio = utilityStdio(options.stdio)
    const { file } = resolveModule(modulePath)
    if (!bootstrapFile()) {
      throw new NotImplementedError('utilityProcess.fork', {
        reason: 'unimplemented',
        hint: `${String(modulePath)} needs tauri-electron's fork bootstrap (process.parentPort), which the bundler plugins build when they find a utilityProcess.fork() entry point in the app's source; list entries they cannot find with their \`fork\` option.`,
      })
    }
    const env = childEnv(options.env)
    if (options.serviceName) env.TAURI_ELECTRON_SERVICE_NAME = String(options.serviceName)
    const child = startNodeChild('utilityProcess.fork', nodeArgs(file, args, options.execArgv ?? []), { stdio, env, cwd: options.cwd }, 'utility')
    this._child = child
    this.stdout = child.stdout
    this.stderr = child.stderr

    child._ipc.onLine = (line) => this._receive(line)
    registerPortSink(this._label, (message) => {
      if (message.type === 'port-message') this._write({ t: 'pm', p: message.port, d: message.data })
      else if (message.type === 'port-close') this._write({ t: 'pc', p: message.port })
    })

    child.on('spawn', () => {
      this.pid = child.pid
      this.emit('spawn')
    })
    child.on('error', (error) => {
      // A child that could not start (no Node.js runtime, a refused caller).
      if (this.pid !== undefined || this._exited) return
      console.error(`[tauri-electron] utilityProcess.fork(${String(modulePath)}) failed:`, error)
      if (this.listenerCount('error')) this.emit('error', 'FatalError', file, String(error?.message ?? error))
      this._finish(typeof error?.errno === 'number' ? error.errno : 1)
    })
    child.on('exit', (code, signal) => this._finish(code ?? (signal ? signalNumber(signal) : -1)))
  }

  _write(message) {
    if (this._exited) return
    this._child._ipc.write(JSON.stringify(message) + '\n', () => {})
  }

  _receive(line) {
    const parsed = parseLine(line)
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return
    const { t, d, p } = parsed.value
    if (t === 'm') this.emit('message', decode(d))
    else if (t === 'pm' && this._ports.has(p)) onRendererPortMessage({ type: 'port-message', port: p, data: d })
    else if (t === 'pc' && this._ports.has(p)) {
      this._ports.delete(p)
      onRendererPortMessage({ type: 'port-close', port: p })
    }
  }

  _finish(code) {
    if (this._exited) return
    this._exited = true
    this.pid = undefined
    registerPortSink(this._label, null)
    // The ports the child held are gone with it.
    for (const id of this._ports) onRendererPortMessage({ type: 'port-close', port: id })
    this._ports.clear()
    this.emit('exit', code)
  }

  /** Send `message` to `process.parentPort` in the child, transferring `MessagePortMain`s. */
  postMessage(message, transfer = []) {
    if (!Array.isArray(transfer)) throw new TypeError('transfer must be an array of MessagePortMain')
    checkTransferList(transfer)
    const data = encode(message)
    if (this._exited) return
    // The 'm' line creates the ports in the child, so it goes before their queued messages.
    const ids = transfer.map((port) => port._transferTo(this._label, { deferQueue: true }))
    for (const id of ids) this._ports.add(id)
    this._write({ t: 'm', d: data, p: ids })
    for (const port of transfer) port._flushTransferred()
  }

  /** Terminate the child (SIGTERM on POSIX). False when it is not running. */
  kill() {
    if (this._exited) return false
    return this._child.kill('SIGTERM')
  }
}

/** `utilityProcess.fork(modulePath, [args], [options])`. */
function fork(modulePath, args, options) {
  if (args && !Array.isArray(args) && typeof args === 'object') {
    options = args
    args = []
  }
  return new UtilityProcess(modulePath, args ?? [], options ?? {})
}

export const utilityProcess = { fork }
