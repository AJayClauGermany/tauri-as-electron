/**
 * `node-pty` on tauri-plugin-electron's `pty` feature (portable-pty: a Unix
 * pseudo-terminal, ConPTY on Windows). The bundler plugins alias `node-pty`
 * here.
 *
 * `spawn(file, args, { name, cols, rows, cwd, env, encoding,
 * handleFlowControl })` returns an `IPty`: `pid` (known at once: the
 * terminal is created over the synchronous bridge), `cols`, `rows`,
 * `process` (the foreground program), `onData` / `onExit` and the
 * `'data'` / `'exit'` events, `write`, `resize`, `kill(signal)`, `pause` /
 * `resume`, `clear`, `destroy`. Output streams over a Tauri Channel and is
 * decoded as a stream (`encoding: null` gives Buffers); `'exit'` follows the
 * last output. Writes, resizes and signals keep their order and never block
 * the page.
 *
 * Differences: `uid` / `gid` and `open()` are not supported; a program that
 * cannot be started makes `spawn` throw (node-pty on Unix starts a child
 * that prints the error and exits with code 1).
 */
import { Channel } from '@tauri-apps/api/core'
import { Buffer } from '../node/buffer.js'
import processShim from '../process.js'
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError, report } from '../internal/runtime.js'
import { native } from '../internal/native.js'
import { signalNumber } from '../internal/signals.js'
import { callSync, callAsync, disposable } from './common.js'

const PKG = 'node-pty'
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_NAME = 'xterm'
const FLOW_CONTROL_PAUSE = '\x13'
const FLOW_CONTROL_RESUME = '\x11'

const isWindows = () => processShim.platform === 'win32'

function toError(body) {
  return new Error(body?.message ?? String(body))
}

/** What node-pty removes from the app's own environment before a terminal gets it. */
function sanitizeEnv(env) {
  for (const key of ['TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'TERMCAP', 'COLUMNS', 'LINES']) delete env[key]
}

function checkSize(cols, rows) {
  if (cols <= 0 || rows <= 0 || Number.isNaN(cols) || Number.isNaN(rows) || cols === Infinity || rows === Infinity) {
    throw new Error('resizing must be done using positive cols and rows')
  }
}

function streamDecoder(encoding) {
  if (!encoding) return null
  try {
    const decoder = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding)
    return { decode: (bytes) => decoder.decode(bytes, { stream: true }), end: () => decoder.decode() }
  } catch {
    // An encoding TextDecoder lacks (ascii, base64, hex, ...): Buffer's, chunk by chunk.
    return { decode: (bytes) => Buffer.from(bytes).toString(encoding), end: () => '' }
  }
}

export class Terminal extends EventEmitter {
  constructor(file, args, options) {
    super()
    if (typeof file !== 'string' || !file) throw new TypeError('file must be a string')
    options = { ...(options ?? {}) }
    if (args === undefined || args === null) args = []
    else if (typeof args === 'string') args = [args]
    if (options.uid !== undefined || options.gid !== undefined) {
      throw new NotImplementedError('pty.spawn({ uid, gid })', { reason: 'unimplemented', hint: 'Terminals run as the app\'s user.' })
    }
    const cols = options.cols ?? DEFAULT_COLS
    const rows = options.rows ?? DEFAULT_ROWS
    checkSize(cols, rows)
    const env = { ...(options.env ?? processShim.env) }
    if (!options.env || options.env === processShim.env) sanitizeEnv(env)
    const name = options.name || env.TERM || DEFAULT_NAME
    if (!isWindows()) env.TERM = name
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null) delete env[key]
      else env[key] = String(value)
    }
    const cwd = options.cwd ?? processShim.cwd()

    const { id, pid } = callSync({
      api: 'pty.spawn',
      pkg: PKG,
      module: 'pty',
      op: 'spawn',
      request: { file, args: args.map(String), cwd, env, cols: Math.floor(cols), rows: Math.floor(rows) },
      toError,
    })
    this._id = id
    this._file = file
    this._name = name
    this._exit = null
    this._queue = []
    this._writing = false
    this._decoder = streamDecoder(options.encoding === undefined ? 'utf8' : options.encoding)
    this._flowControlPause = options.flowControlPause || FLOW_CONTROL_PAUSE
    this._flowControlResume = options.flowControlResume || FLOW_CONTROL_RESUME
    this.pid = pid ?? 0
    this.cols = cols
    this.rows = rows
    this.handleFlowControl = Boolean(options.handleFlowControl)

    const channel = new Channel()
    channel.onmessage = (event) => this._event(event)
    native('pty_attach', { id, onEvent: channel }).catch(report('node-pty output'))
  }

  _event(event) {
    if (event.type === 'data') {
      const bytes = Buffer.from(event.data, 'base64')
      const data = this._decoder ? this._decoder.decode(bytes) : bytes
      if (data.length) this.emit('data', data)
    } else if (event.type === 'exit') {
      const rest = this._decoder?.end()
      if (rest) this.emit('data', rest)
      this._exit = { exitCode: event.exitCode, signal: event.signal }
      this.emit('exit', event.exitCode, event.signal)
    }
  }

  /**
   * Writes, resizes, signals and flow control reach the terminal one at a
   * time and in the order they were made (node-pty's resize and kill are
   * synchronous, so `resize(); write('stty size')` sees the new size);
   * consecutive writes go in one piece.
   */
  _control(op, args) {
    const last = this._queue.at(-1)
    if (op === 'write' && last?.op === 'write') last.chunks.push(args)
    else this._queue.push(op === 'write' ? { op, chunks: [args] } : { op, args })
    if (!this._writing) this._flush()
  }

  _flush() {
    const next = this._queue.shift()
    if (!next) {
      this._writing = false
      return
    }
    this._writing = true
    const args = next.op === 'write' ? { data: Buffer.concat(next.chunks).toString('base64') } : next.args
    callAsync({ api: `pty.${next.op}`, pkg: PKG, command: 'pty_control', args: { id: this._id, op: next.op, args }, toError })
      .catch(report(`node-pty ${next.op}`))
      .finally(() => this._flush())
  }

  /** `onData(listener)`: an IDisposable subscription. */
  get onData() {
    return (listener) => {
      this.on('data', listener)
      return disposable(() => this.removeListener('data', listener))
    }
  }

  /** `onExit(listener)`: `listener({ exitCode, signal })`. */
  get onExit() {
    return (listener) => {
      const wrapped = (exitCode, signal) => listener({ exitCode, signal })
      this.on('exit', wrapped)
      return disposable(() => this.removeListener('exit', wrapped))
    }
  }

  /** The program in the terminal's foreground (the spawned file once it exited). */
  get process() {
    if (this._exit || isWindows()) return this._file
    try {
      return callSync({ api: 'pty.process', pkg: PKG, module: 'pty', op: 'process', request: { id: this._id }, toError }) ?? this._file
    } catch {
      return this._file
    }
  }

  write(data) {
    if (this.handleFlowControl) {
      if (data === this._flowControlPause) return this.pause()
      if (data === this._flowControlResume) return this.resume()
    }
    this._control('write', typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
  }

  resize(cols, rows) {
    checkSize(cols, rows)
    this.cols = cols
    this.rows = rows
    this._control('resize', { cols: Math.floor(cols), rows: Math.floor(rows) })
  }

  /** `kill(signal = 'SIGHUP')`; Windows terminates the process and takes no signal. */
  kill(signal) {
    if (isWindows()) {
      if (signal) throw new Error('Signals not supported on windows.')
      this._control('kill', { signal: 9 })
      return
    }
    this._control('kill', { signal: signalNumber(signal, 'SIGHUP') })
  }

  pause() {
    this._control('pause')
  }

  resume() {
    this._control('resume')
  }

  /** Windows' ConPTY buffer reset; nothing to do elsewhere. */
  clear() {
    this._control('clear')
  }

  destroy() {
    if (!this._exit) this.kill()
  }
}

/** `pty.spawn(file, args, options)`. */
export function spawn(file, args, options) {
  return new Terminal(file, args, options)
}

/** Deprecated aliases of `spawn`. */
export const fork = spawn
export const createTerminal = spawn

/** `pty.open()`: a terminal without a process (Unix). */
export function open() {
  throw new NotImplementedError('pty.open', { reason: 'unimplemented', hint: 'Spawn the program with pty.spawn instead.' })
}

const nodePty = { spawn, fork, createTerminal, open, Terminal }
export default nodePty
