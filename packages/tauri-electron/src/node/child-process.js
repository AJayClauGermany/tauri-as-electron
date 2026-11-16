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
 * - `fork` runs a module in a real Node.js (see ../internal/fork.js for how
 *   it is found and how the module gets onto disk) with Node's own IPC
 *   channel: `send()`, `'message'`, `disconnect()`, `connected`. So does
 *   `spawn` with an `'ipc'` entry in `stdio`, and `spawn(process.execPath, …)`
 *   with `ELECTRON_RUN_AS_NODE` set (Electron's way of running Node).
 *
 * Shells are chosen as Node does: `/bin/sh -c` on Unix, `cmd.exe /d /s /c`
 * on Windows. Not supported: sending handles (sockets, servers) over the
 * IPC channel, `serialization: 'advanced'`, and streams or file descriptors
 * other than 0–2 (and `'ipc'`) as `stdio`.
 */
import { Channel } from '@tauri-apps/api/core'
import { EventEmitter } from '../internal/emitter.js'
import { native, hasFeature, featureError } from '../internal/native.js'
import { nodeCallSync, noTauri, parseJson, nodeFailure } from '../internal/node-bridge.js'
import { inTauri, explainError, NotImplementedError } from '../internal/runtime.js'
import { LineQueue, bootstrapFile, channelClosed, childEnv, isOwnExecutable, jsonLine, nodeArgs, parseLine, resolveModule } from '../internal/fork.js'
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
      reason: 'unimplemented',
      hint: entry === 'ipc' ? "Put 'ipc' after the three standard streams (descriptor 3 or higher)." : "Use 'pipe', 'inherit' or 'ignore', and pipe the child's streams yourself.",
    })
  })
}

function nodeError(message, code, Type = Error) {
  const error = new Type(message)
  error.code = code
  return error
}

/** The `'ipc'` entry of `stdio` (descriptor 3 or higher), as Rust's `ipc` option. */
function ipcOption(stdio, api, sync, serialization) {
  const index = Array.isArray(stdio) ? stdio.indexOf('ipc') : -1
  if (index === -1) return null
  if (sync) throw nodeError('Forked processes must not have an IPC pipe', 'ERR_IPC_SYNC_FORK')
  if (stdio.indexOf('ipc', index + 1) !== -1) throw nodeError('Child process can have only one IPC pipe', 'ERR_IPC_ONE_PIPE')
  if (serialization !== undefined && serialization !== 'json') {
    throw new NotImplementedError(`${api} with serialization '${serialization}'`, { reason: 'unimplemented', hint: "Only 'json' serialization is supported: the parent side runs in a webview, which has no V8 serializer." })
  }
  // An index below 3 is refused by normalizeStdio, with an explanation.
  return { kind: 'node', fd: index, tcp: isWindows }
}

/** What Rust's `SpawnOptions` takes, from Node's spawn arguments. */
function spawnOptions(file, args, options, api, { sync = false } = {}) {
  const ipc = ipcOption(options.stdio, api, sync, options.serialization)
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
    ipc,
    node: false,
  }
}

function spawnError({ code, errno, syscall, path, message }, spawnargs) {
  const explained = code === 'ENOENT' && (message?.startsWith('cwd') || message?.startsWith('no Node.js'))
  const error = new Error(`${syscall} ${code}${explained ? ` (${message})` : ''}`)
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

  ref() {}

  unref() {}

  get [Symbol.toStringTag]() {
    return 'ChildProcess'
  }
}

/**
 * The IPC channel of a child started with one: Node's `send()` /
 * `'message'` / `disconnect()` for `kind: 'node'`; `utilityProcess` reads
 * the raw lines (`onLine`) itself.
 */
function attachChannel(child, kind) {
  const queue = new LineQueue((data) => child._ready.then(() => native('child_send', { id: child._id, data })))
  const ipc = {
    kind,
    ended: false,
    onLine: null,
    onEnd: null,
    write: (line, callback) => queue.push(line, callback),
    close: () => queue.push(null, null, () => child._ready.then(() => native('child_disconnect', { id: child._id }))),
  }
  child._ipc = ipc
  if (kind !== 'node') return ipc
  child.connected = true
  child.channel = { ref() {}, unref() {}, hasRef: () => true }
  child.send = function send(message, handle, options, callback) {
    if (typeof handle === 'function') {
      callback = handle
      handle = undefined
    } else if (typeof options === 'function') {
      callback = options
    }
    const line = jsonLine(message)
    if (handle !== undefined && handle !== null) {
      throw new NotImplementedError('subprocess.send with a handle', { reason: 'unsupported', hint: 'Sockets and servers cannot be passed to the child: the parent side runs in a webview.' })
    }
    if (!this.connected) {
      const error = channelClosed()
      if (typeof callback === 'function') setTimeout(() => callback(error), 0)
      else setTimeout(() => this.emit('error', error), 0)
      return false
    }
    ipc.write(line, (error) => {
      if (typeof callback === 'function') callback(error)
      // A child that failed to start has reported that already ('error').
      else if (error && this.pid !== undefined && error.code !== 'ERR_IPC_CHANNEL_CLOSED') this.emit('error', explainError('subprocess.send', error))
    })
    return true
  }
  child.disconnect = function disconnect() {
    if (!this.connected) {
      this.emit('error', nodeError('IPC channel is already disconnected', 'ERR_IPC_DISCONNECTED'))
      return
    }
    this.connected = false
    ipc.close()
  }
  ipc.onLine = (line) => {
    const parsed = parseLine(line)
    if (!parsed.ok) return
    const message = parsed.value
    // Node keeps its own messages (NODE_HANDLE & co.) apart.
    if (message && typeof message === 'object' && typeof message.cmd === 'string' && message.cmd.startsWith('NODE_')) child.emit('internalMessage', message)
    else child.emit('message', message, undefined)
  }
  ipc.onEnd = () => {
    child.connected = false
    child.channel = null
    child.emit('disconnect')
  }
  return ipc
}

/**
 * Start a child: `spawn` and friends, and with `extra.node` the Node.js
 * runtime (`file` is the `execPath` option or empty) and with `extra.ipc`
 * the IPC channel of `fork` / `utilityProcess`.
 */
function start(api, file, args, options, extra = {}) {
  checkAvailable(api)
  const request = spawnOptions(file, args, options, api)
  if (extra.ipc) request.ipc = { tcp: isWindows, ...request.ipc, ...extra.ipc }
  if (extra.node) request.node = true
  if (request.ipc?.tcp) {
    // Windows: the child connects back over loopback; tauri-electron's
    // bootstrap does that for any Node.js child, through NODE_OPTIONS.
    const bootstrap = bootstrapFile()
    if (!bootstrap) {
      throw new NotImplementedError(`${api} on Windows`, {
        reason: 'unimplemented',
        hint: "The child's IPC channel is set up by tauri-electron's fork bootstrap, which the bundler plugins build only when they find a fork entry point (or the `fork` option lists one).",
      })
    }
    const env = request.env ?? Object.fromEntries(Object.entries(globalThis.process?.env ?? {}).map(([k, v]) => [k, String(v)]))
    const quoted = `"${bootstrap.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    request.env = { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, `--require ${quoted}`].filter(Boolean).join(' ') }
  }
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
  // Like Node, 'close' also waits for the IPC channel.
  const ipc = request.ipc ? attachChannel(child, request.ipc.kind) : null
  if (ipc) pending.add('ipc')
  const endIpc = () => {
    if (!ipc || ipc.ended) return
    ipc.ended = true
    ipc.onEnd?.()
    pending.delete('ipc')
    maybeClose()
  }
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
    } else if (event.type === 'ipc') {
      for (const line of event.lines ?? []) ipc?.onLine?.(line)
    } else if (event.type === 'ipc-end') {
      endIpc()
    }
  }

  native('child_spawn', { options: request, onEvent: events }).then(
    ({ id, pid, file: spawned }) => {
      child._id = id
      child.pid = pid
      if (request.node && spawned) {
        child.spawnfile = spawned
        child.spawnargs = [spawned, ...request.args]
      }
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
      if (ipc) {
        ipc.ended = true
        child.connected = false
      }
      child.emit('error', failure)
      child.emit('close', typeof failure.errno === 'number' ? failure.errno : -1, null)
    },
  )
  child._ready.catch(() => {})
  return child
}

// Node.js options that take the next argument as their value (unless written
// `--opt=value`). Short ones are in NODE_SHORT_VALUE_OPTIONS.
const NODE_VALUE_OPTIONS = new Set([
  '--allow-fs-read', '--allow-fs-write', '--conditions', '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name',
  '--debug-port', '--diagnostic-dir', '--disable-warning', '--dns-result-order', '--env-file', '--env-file-if-exists',
  '--experimental-config-file', '--experimental-default-type', '--experimental-loader', '--experimental-policy',
  '--experimental-sea-config', '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name',
  '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--icu-data-dir', '--import', '--input-type',
  '--inspect-port', '--inspect-publish-uid', '--loader', '--localstorage-file', '--max-http-header-size',
  '--network-family-autoselection-attempt-timeout', '--openssl-config', '--policy-integrity', '--redirect-warnings',
  '--report-dir', '--report-directory', '--report-filename', '--report-signal', '--require', '--secure-heap',
  '--secure-heap-min', '--security-revert', '--snapshot-blob', '--test-concurrency', '--test-coverage-branches', '--test-coverage-exclude',
  '--test-coverage-functions', '--test-coverage-include', '--test-coverage-lines', '--test-global-setup', '--test-isolation',
  '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-shard', '--test-skip-pattern',
  '--test-timeout', '--title', '--tls-cipher-list', '--tls-keylog', '--trace-event-categories',
  '--trace-event-file-pattern', '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--watch-kill-signal',
  '--watch-path',
  // V8 options Node passes on, which also take a separate value.
  '--max-old-space-size', '--max-semi-space-size', '--stack-size', '--stack-trace-limit',
])
const NODE_SHORT_VALUE_OPTIONS = new Set(['r', 'C'])
// Options after which there is no script file: code, stdin, a package.json script.
const NODE_NO_SCRIPT_OPTIONS = /^--(eval|print|run)(=|$)/

/**
 * Index of the script in a Node.js command line, or -1 when there is none
 * (`-e` / `-p` code, `--run`, `-` for stdin, options only).
 */
export function nodeScriptIndex(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i])
    if (arg === '--') return i + 1 < args.length ? i + 1 : -1
    if (arg === '-') return -1
    if (!arg.startsWith('-')) return i
    if (NODE_NO_SCRIPT_OPTIONS.test(arg)) return -1
    if (/^-[a-zA-Z]+$/.test(arg)) {
      // Short options, possibly grouped (`-pe`): code instead of a script, or a value next.
      if (/[ep]/.test(arg)) return -1
      if (NODE_SHORT_VALUE_OPTIONS.has(arg.at(-1))) i++
      continue
    }
    if (NODE_VALUE_OPTIONS.has(arg)) i++
  }
  return -1
}

/** `child_process.spawn(command, [args], [options])`. */
export function spawn(command, ...rest) {
  const { file, args, options } = splitArguments(command, rest)
  // Electron runs itself as Node with ELECTRON_RUN_AS_NODE: run the Node.js runtime instead.
  const env = options.env ?? globalThis.process?.env ?? {}
  if (isOwnExecutable(file) && env.ELECTRON_RUN_AS_NODE && !options.shell) {
    const script = nodeScriptIndex(args)
    const nodeArgs = script === -1 ? args : args.map((arg, i) => (i === script ? resolveModule(arg).file : arg))
    return start('child_process.spawn', '', nodeArgs, { ...options, env: childEnv(env) }, { node: true })
  }
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

/**
 * For `utilityProcess.fork`: the Node.js runtime with `args`, and a channel
 * of `kind` whose raw lines the caller reads (`child._ipc.onLine`).
 */
export function startNodeChild(api, args, options, kind) {
  return start(api, '', args, { ...options, stdio: [...options.stdio.slice(0, 3), 'ipc'], shell: false }, { node: true, ipc: { kind } })
}

/** Node's stdio for fork: `silent` pipes, otherwise inherits; always with 'ipc'. */
function forkStdio(options) {
  const stdio = options.stdio ?? (options.silent ? 'pipe' : 'inherit')
  if (typeof stdio === 'string') return [stdio, stdio, stdio, 'ipc']
  if (!Array.isArray(stdio) || !stdio.includes('ipc')) {
    throw nodeError('Forked processes must have an IPC channel, missing value \'ipc\' in options.stdio', 'ERR_CHILD_PROCESS_IPC_REQUIRED')
  }
  return stdio
}

/**
 * `child_process.fork(modulePath, [args], [options])`: `modulePath` in a
 * Node.js child with an IPC channel (`send()`, `'message'`). The runtime is
 * `options.execPath`, the app's bundled Node.js sidecar or, in development,
 * `node` on PATH.
 */
export function fork(modulePath, ...rest) {
  if (typeof modulePath !== 'string' && !(modulePath instanceof URL)) throw invalidArgType('modulePath', 'of type string or an instance of URL', modulePath)
  let args = []
  let options = {}
  if (Array.isArray(rest[0])) args = rest.shift()
  else if (rest[0] === null || rest[0] === undefined) rest.shift()
  if (rest[0] && typeof rest[0] === 'object') options = rest[0]
  else if (rest[0] !== undefined && rest[0] !== null) throw invalidArgType('options', 'of type object', rest[0])
  checkAvailable('child_process.fork')
  const { file } = resolveModule(modulePath)
  const execPath = options.execPath && !isOwnExecutable(options.execPath) ? String(options.execPath) : ''
  const execArgv = options.execArgv ?? globalThis.process?.execArgv ?? []
  const forkOptions = { ...options, stdio: forkStdio(options), env: childEnv(options.env), shell: false }
  return start('child_process.fork', execPath, nodeArgs(file, args.map(String), execArgv), forkOptions, { node: true })
}

const childProcess = { ChildProcess, spawn, spawnSync, exec, execSync, execFile, execFileSync, fork }

export default childProcess
