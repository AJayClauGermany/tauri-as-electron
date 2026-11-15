/**
 * Node's `child_process`, backed by tauri-plugin-electron (Cargo feature
 * `node-child-process`).
 *
 * - `spawnSync`, `execSync`, `execFileSync` block on the synchronous bridge,
 *   as they block in Node (renderer windows keep running).
 * - `spawn`, `exec`, `execFile` return a ChildProcess whose `stdout` /
 *   `stderr` are Readable streams and `stdin` a Writable one; output and the
 *   exit arrive from Rust over a Tauri Channel.
 *
 * Shells are chosen as Node does: `/bin/sh -c` on Unix, `cmd.exe /d /s /c`
 * on Windows. Not supported: `fork()` (it starts another Node.js, and none is
 * shipped), the `'ipc'` stdio channel (`send()`), and streams or file
 * descriptors other than 0–2 as `stdio`.
 */
import { Channel } from '@tauri-apps/api/core'
import { EventEmitter } from '../internal/emitter.js'
import { native, hasFeature, featureError } from '../internal/native.js'
import { nodeCallSync, noTauri, parseJson, nodeFailure } from '../internal/node-bridge.js'
import { inTauri, explainError, NotImplementedError } from '../internal/runtime.js'
import { signalNumber, signalName } from '../internal/signals.js'
import { platform } from '../process.js'
import { fileURLToPath } from '../url.js'
import { Buffer } from './buffer.js'
import { Readable, Writable } from './stream.js'

const FEATURE = 'node-child-process'
const MODULE = 'child_process'
const isWindows = platform === 'win32'
const customPromisify = Symbol.for('nodejs.util.promisify.custom')
const MAX_BUFFER = 1024 * 1024

// --- arguments ---------------------------------------------------------------------------------------

function invalidArgType(name, expected, value) {
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${value === null ? 'null' : typeof value === 'object' ? `an instance of ${value.constructor?.name ?? 'Object'}` : `type ${typeof value} (${String(value)})`}`)
  error.code = 'ERR_INVALID_ARG_TYPE'
  return error
}

/** `(file, [args], [options], [callback])` → its parts, as Node accepts them. */
function splitArguments(file, rest) {
  let args = []
  let options = {}
  let callback
  const list = [...rest]
  if (typeof list.at(-1) === 'function') callback = list.pop()
  if (Array.isArray(list[0])) args = list.shift()
  else if (list[0] === null || list[0] === undefined) list.shift()
  if (list[0] && typeof list[0] === 'object') options = list.shift()
  else if (list[0] !== undefined && list[0] !== null) throw invalidArgType('options', 'of type object', list[0])
  if (typeof file !== 'string' || !file) throw invalidArgType('file', 'of type string', file)
  return { file, args: args.map(String), options, callback }
}

function shellFor(command, shell) {
  if (isWindows) {
    const file = typeof shell === 'string' ? shell : globalThis.process?.env?.ComSpec || 'cmd.exe'
    if (/^(?:.*\\)?cmd(?:\.exe)?$/i.test(file)) return { file, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true }
    return { file, args: ['-c', command], verbatim: false }
  }
  return { file: typeof shell === 'string' ? shell : '/bin/sh', args: ['-c', command], verbatim: false }
}

const STDIO = new Set(['pipe', 'overlapped', 'inherit', 'ignore'])

function normalizeStdio(stdio, api) {
  const list = stdio === undefined || stdio === null ? ['pipe', 'pipe', 'pipe'] : typeof stdio === 'string' ? [stdio, stdio, stdio] : [...stdio]
  while (list.length < 3) list.push('pipe')
  return list.slice(0, 3).map((entry, fd) => {
    if (entry === undefined || entry === null) return 'pipe'
    if (entry === fd || (typeof entry === 'object' && entry?.fd === fd)) return 'inherit' // the app's own stdio
    if (entry === 'overlapped') return 'pipe'
    if (STDIO.has(entry)) return entry
    throw new NotImplementedError(`${api} with stdio ${typeof entry === 'string' ? `'${entry}'` : typeof entry}`, {
      reason: entry === 'ipc' ? 'unsupported' : 'unimplemented',
      hint: entry === 'ipc' ? 'The IPC channel needs a Node.js child; none is shipped.' : "Use 'pipe', 'inherit' or 'ignore', and pipe the child's streams yourself.",
    })
  })
}

/** What Rust's `SpawnOptions` takes, from Node's spawn arguments. */
function spawnOptions(file, args, options, api, { sync = false } = {}) {
  let command = { file, args, verbatim: Boolean(options.windowsVerbatimArguments) }
  if (options.shell) command = shellFor([file, ...args].join(' '), options.shell)
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd
  if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') throw invalidArgType('options.cwd', 'of type string or an instance of URL', cwd)
  let env = null
  if (options.env) env = Object.fromEntries(Object.entries(options.env).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
  return {
    file: command.file,
    args: command.args,
    cwd: cwd ?? null,
    env,
    stdio: normalizeStdio(options.stdio, api),
    timeout: sync && options.timeout > 0 ? Math.floor(options.timeout) : 0,
    maxBuffer: sync ? (options.maxBuffer === Infinity ? null : (options.maxBuffer ?? MAX_BUFFER)) : null,
    killSignal: signalNumber(options.killSignal),
    detached: Boolean(options.detached),
    uid: options.uid ?? null,
    gid: options.gid ?? null,
    windowsHide: Boolean(options.windowsHide),
    windowsVerbatimArguments: command.verbatim,
  }
}

function spawnError({ code, errno, syscall, path, message }, spawnargs) {
  const error = new Error(`${syscall} ${code}${code === 'ENOENT' && message?.startsWith('cwd') ? ` (${message})` : ''}`)
  Object.assign(error, { errno, code, syscall, path, spawnargs })
  return error
}

function decode(buffer, encoding) {
  if (buffer === null) return null
  return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer
}

function checkAvailable(api) {
  if (!inTauri) throw noTauri(api, MODULE, FEATURE)
  if (!hasFeature(FEATURE)) throw featureError(api, FEATURE)
}

// --- spawnSync and friends ----------------------------------------------------------------------------

function runSync(api, file, args, options) {
  const input = options.input
  let body
  if (typeof input === 'string') body = Buffer.from(input, options.encoding && options.encoding !== 'buffer' ? options.encoding : 'utf8')
  else if (ArrayBuffer.isView(input)) body = input
  else if (input !== undefined && input !== null) throw invalidArgType('options.input', 'of type string or an instance of Buffer, TypedArray, or DataView', input)
  const request = spawnOptions(file, args, options, api, { sync: true })
  const frame = nodeCallSync({ api, module: MODULE, feature: FEATURE, op: 'spawnSync', args: request, body: body ?? new Uint8Array(0) })
  const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true)
  const header = parseJson(frame.subarray(4, 4 + length))
  let offset = 4 + length
  const take = (size) => {
    if (size === null || size === undefined) return null
    const bytes = frame.subarray(offset, offset + size)
    offset += size
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  const stdout = decode(take(header.stdout), options.encoding)
  const stderr = decode(take(header.stderr), options.encoding)
  const result = {
    pid: header.pid,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: header.status,
    signal: signalName(header.signal),
  }
  if (header.error) result.error = spawnError(header.error, args)
  return result
}

/** `child_process.spawnSync(command, [args], [options])`. */
export function spawnSync(command, ...rest) {
  const { file, args, options } = splitArguments(command, rest)
  checkAvailable('child_process.spawnSync')
  const result = runSync('child_process.spawnSync', file, args, options)
  return result.error ? { error: result.error, ...result } : result
}

function checkSyncResult(cmd, result) {
  if (result.error) {
    Object.assign(result.error, { status: result.status, signal: result.signal, output: result.output, pid: result.pid, stdout: result.stdout, stderr: result.stderr })
    throw result.error
  }
  if (result.status !== 0) {
    const stderr = result.stderr === null ? '' : String(result.stderr)
    const error = new Error(`Command failed: ${cmd}${stderr ? `\n${stderr}` : ''}`)
    Object.assign(error, { status: result.status, signal: result.signal, output: result.output, pid: result.pid, stdout: result.stdout, stderr: result.stderr })
    throw error
  }
  return result.stdout
}

/** Unlike spawnSync, stderr goes to the app's own stderr unless `stdio` says otherwise. */
const SYNC_STDIO = ['pipe', 'pipe', 'inherit']

/** `child_process.execSync(command, [options])`: stdout, or throws when the command fails. */
export function execSync(command, options = {}) {
  if (typeof command !== 'string') throw invalidArgType('command', 'of type string', command)
  checkAvailable('child_process.execSync')
  const result = runSync('child_process.execSync', command, [], { stdio: SYNC_STDIO, ...options, shell: options.shell || true })
  return checkSyncResult(command, result)
}

/** `child_process.execFileSync(file, [args], [options])`. */
export function execFileSync(file, ...rest) {
  const { args, options } = splitArguments(file, rest)
  checkAvailable('child_process.execFileSync')
  const result = runSync('child_process.execFileSync', file, args, { stdio: SYNC_STDIO, ...options })
  return checkSyncResult([file, ...args].join(' '), result)
}

// --- ChildProcess ------------------------------------------------------------------------------------------

const toBase64 = (chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64')

/** Node's ChildProcess: an EventEmitter with stdio streams, `pid`, `kill()`. */
export class ChildProcess extends EventEmitter {
  constructor() {
    super()
    this.pid = undefined
    this.exitCode = null
    this.signalCode = null
    this.killed = false
    this.connected = false
    this.spawnfile = undefined
    this.spawnargs = []
    this.stdin = null
    this.stdout = null
    this.stderr = null
    this.stdio = [null, null, null]
    this._id = null
  }

  /** Sends `signal` (default SIGTERM). Like Node, true when the signal could be sent. */
  kill(signal = 'SIGTERM') {
    const number = signalNumber(signal)
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.killed = true
    const send = () =>
      native('child_kill', { id: this._id, signal: number }).catch((error) => this.emit('error', explainError('subprocess.kill', error)))
    if (this._id === null) this._ready?.then(send, () => {})
    else send()
    return true
  }

  send() {
    throw new NotImplementedError('subprocess.send', { reason: 'unsupported', hint: 'There is no IPC channel: the child is not a Node.js process.' })
  }

  disconnect() {}

  ref() {}

  unref() {}

  get [Symbol.toStringTag]() {
    return 'ChildProcess'
  }
}

function start(api, file, args, options) {
  checkAvailable(api)
  const request = spawnOptions(file, args, options, api)
  const child = new ChildProcess()
  child.spawnfile = request.file
  child.spawnargs = [request.file, ...request.args]
  const [stdinMode, stdoutMode, stderrMode] = request.stdio

  let resolveReady
  let rejectReady
  child._ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const readable = () => new Readable({ read() {} })
  if (stdoutMode === 'pipe') child.stdout = readable()
  if (stderrMode === 'pipe') child.stderr = readable()
  if (stdinMode === 'pipe') {
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
        // A child that already closed its stdin drops the data (Node would emit EPIPE).
        child._ready
          .then(() => native('child_write', { id: child._id, data: toBase64(bytes) }))
          .then(() => callback(), (error) => callback(explainError('subprocess.stdin.write', error)))
      },
      final(callback) {
        child._ready.then(() => native('child_end', { id: child._id })).then(() => callback(), () => callback())
      },
    })
  }
  child.stdio = [child.stdin, child.stdout, child.stderr]

  const pending = new Set([stdoutMode === 'pipe' ? 1 : null, stderrMode === 'pipe' ? 2 : null].filter(Boolean))
  let exit = null
  const streamFor = (fd) => (fd === 1 ? child.stdout : child.stderr)

  // 'close' after the exit and the end of stdout / stderr; streams that are
  // being read are drained first, so 'close' follows their last 'data'.
  const maybeClose = () => {
    if (!exit || pending.size) return
    const reading = [child.stdout, child.stderr].filter((s) => s && !s.readableEnded && (s.readableFlowing || s.listenerCount('data') > 0 || s.listenerCount('readable') > 0))
    let waiting = reading.length
    const close = () => setTimeout(() => child.emit('close', exit.code, exit.signal), 0)
    if (!waiting) return close()
    for (const stream of reading) {
      stream.once('end', () => {
        if (--waiting === 0) close()
      })
    }
  }

  const events = new Channel()
  events.onmessage = (event) => {
    if (event.type === 'data') {
      streamFor(event.fd)?.push(Buffer.from(event.data, 'base64'))
    } else if (event.type === 'end') {
      streamFor(event.fd)?.push(null)
      pending.delete(event.fd)
      maybeClose()
    } else if (event.type === 'exit') {
      exit = { code: event.code ?? null, signal: signalName(event.signal) }
      child.exitCode = exit.code
      child.signalCode = exit.signal
      child.emit('exit', exit.code, exit.signal)
      maybeClose()
    }
  }

  native('child_spawn', { options: request, onEvent: events }).then(
    ({ id, pid }) => {
      child._id = id
      child.pid = pid
      resolveReady()
      child.emit('spawn')
    },
    (error) => {
      rejectReady(error)
      const failure =
        error && typeof error === 'object' && 'code' in error
          ? error.syscall
            ? spawnError(error, args)
            : nodeFailure({ api, module: MODULE, feature: FEATURE, status: 400, body: error })
          : explainError(api, error)
      child.stdin?.destroy()
      child.stdout?.push(null)
      child.stderr?.push(null)
      child.emit('error', failure)
      child.emit('close', typeof failure.errno === 'number' ? failure.errno : -1, null)
    },
  )
  child._ready.catch(() => {})
  return child
}

/** `child_process.spawn(command, [args], [options])`. */
export function spawn(command, ...rest) {
  const { file, args, options } = splitArguments(command, rest)
  return start('child_process.spawn', file, args, options)
}

/** exec / execFile: buffered output, a callback, and the promisified `{ stdout, stderr }` form. */
function buffered(api, cmd, file, args, options, callback) {
  const opts = { encoding: 'utf8', timeout: 0, maxBuffer: MAX_BUFFER, killSignal: 'SIGTERM', ...options, stdio: 'pipe' }
  const child = start(api, file, args, opts)
  const chunks = { stdout: [], stderr: [] }
  const sizes = { stdout: 0, stderr: 0 }
  let failure = null
  let killedByUs = false
  let timer = null
  const kill = () => {
    killedByUs = true
    child.kill(opts.killSignal)
  }
  for (const name of ['stdout', 'stderr']) {
    child[name].on('data', (chunk) => {
      sizes[name] += chunk.length
      if (opts.maxBuffer !== Infinity && sizes[name] > opts.maxBuffer) {
        const keep = chunk.length - (sizes[name] - opts.maxBuffer)
        if (keep > 0) chunks[name].push(chunk.subarray(0, keep))
        if (!failure) {
          failure = new RangeError(`${name} maxBuffer length exceeded`)
          failure.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          kill()
        }
        return
      }
      chunks[name].push(chunk)
    })
  }
  if (opts.timeout > 0) timer = setTimeout(kill, opts.timeout)
  const output = (name) => {
    const all = Buffer.concat(chunks[name])
    return opts.encoding && opts.encoding !== 'buffer' ? all.toString(opts.encoding) : all
  }
  let done = false
  const finish = (error, code, signal) => {
    if (done) return
    done = true
    clearTimeout(timer)
    const stdout = output('stdout')
    const stderr = output('stderr')
    if (!error && !failure && code === 0 && signal === null) return callback?.(null, stdout, stderr)
    let reported = error ?? failure
    if (!reported) {
      reported = new Error(`Command failed: ${cmd}\n${stderr}`)
      Object.assign(reported, { code, killed: child.killed || killedByUs, signal, cmd })
    } else if (!error) {
      Object.assign(reported, { cmd })
    }
    callback?.(reported, stdout, stderr)
  }
  child.on('error', (error) => finish(error))
  child.on('close', (code, signal) => finish(null, code, signal))
  return child
}

function promisified(run) {
  return (...args) => {
    let child
    const promise = new Promise((resolve, reject) => {
      child = run(...args, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })))
    })
    promise.child = child
    return promise
  }
}

/** `child_process.exec(command, [options], [callback])`: runs `command` in a shell. */
export function exec(command, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  if (typeof command !== 'string') throw invalidArgType('command', 'of type string', command)
  return buffered('child_process.exec', command, command, [], { ...options, shell: options?.shell || true }, callback)
}
exec[customPromisify] = promisified(exec)

/** `child_process.execFile(file, [args], [options], [callback])`. */
export function execFile(file, ...rest) {
  const { args, options, callback } = splitArguments(file, rest)
  return buffered('child_process.execFile', [file, ...args].join(' '), file, args, options, callback)
}
execFile[customPromisify] = promisified(execFile)

/** Not available: it starts another Node.js process. */
export function fork(modulePath) {
  throw new NotImplementedError('child_process.fork', {
    reason: 'unsupported',
    hint: `fork('${modulePath}') starts another Node.js process, and no Node.js is shipped. Run that code in the main process or a Web Worker, or spawn a separate executable.`,
  })
}

const childProcess = { ChildProcess, spawn, spawnSync, exec, execSync, execFile, execFileSync, fork }

export default childProcess
