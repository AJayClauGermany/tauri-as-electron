/**
 * Node's `worker_threads` on Web Workers. A worker is a dedicated Web Worker
 * of the window that creates it, running the bundler plugin's worker entry
 * (bundler/worker-entry.js): it receives what Node gives a worker
 * (`workerData`, env, argv, environment data, transferred ports), loads the
 * Node layer, then the worker script, which the bundler plugin bundled
 * (scripts it finds in `new Worker(...)` calls, and those of its `workers`
 * option); `eval: true` code runs as a CommonJS script there.
 *
 * Inside the worker the Node built-ins work as in its window: synchronous
 * calls reach tauri-plugin-electron's bridge directly (Rust checks the
 * window, so a worker gets no more than its window), and Tauri commands
 * (`fs.promises`, `child_process.spawn`, sockets, …) are relayed by this
 * module in the window, including their Channels. Electron's own modules are
 * not available in workers, as in Electron.
 *
 * Differences from Node, documented in API-COVERAGE.md: no SharedArrayBuffer
 * (the webview is not cross-origin isolated), so no `Atomics.wait`;
 * `resourceLimits`, `stdin` and `env: SHARE_ENV` (a copy) are not applied;
 * a worker ends on `process.exit()`, `terminate()`, an uncaught error, or
 * once nothing it tracks is pending (timers, ports with listeners, Tauri
 * calls and Channels, fetch, other workers): asynchronous work it cannot
 * see would be cut short after 100 ms of apparent idleness.
 */
import { EventEmitter } from '../internal/emitter.js'
import { inWorker, NotImplementedError } from '../internal/runtime.js'
import { toProjectPath } from '../internal/app-files.js'
import {
  MessagePort,
  MessageChannel,
  BroadcastChannel,
  createPort,
  incoming,
  outgoing,
  receiveMessageOnPort,
  markAsUntransferable,
  isMarkedAsUntransferable,
  activePortCount,
  onActivePortsChange,
} from '../internal/worker-ports.js'
import { Readable } from './stream.js'

export { MessagePort, MessageChannel, BroadcastChannel, receiveMessageOnPort, markAsUntransferable, isMarkedAsUntransferable }

/** Envelope key of the messages between a window and its workers. */
export const ENVELOPE = '__te'

/** What the worker's bootstrap (src/worker/bootstrap.js) set up, in a worker. */
const context = inWorker ? (globalThis.__TAURI_ELECTRON_WORKER__ ?? null) : null
const init = context?.init ?? null

export const isMainThread = !init
export const isInternalThread = false
export const threadId = init?.threadId ?? 0
export const resourceLimits = init?.resourceLimits ?? {}
export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV')

const environmentData = new Map(init?.environmentData ?? [])

export function setEnvironmentData(key, value) {
  if (value === undefined) environmentData.delete(key)
  else environmentData.set(key, value)
}

export function getEnvironmentData(key) {
  return environmentData.get(key)
}

/** `parentPort`: the worker's side of its channel to the window. */
export const parentPort = init
  ? createPort({
      post: (value, transfer) => context.post({ [ENVELOPE]: 'msg', v: value }, transfer),
      close() {},
      attach() {},
      detach() {},
    })
  : null

export const workerData = init ? incoming(init.workerData, context.ports) : null

if (context) {
  context.listen((event) => {
    const data = event.data
    if (data?.[ENVELOPE] === 'msg') parentPort._receive(data.v, event.ports)
  })
}

export function moveMessagePortToContext() {
  throw new NotImplementedError('worker_threads.moveMessagePortToContext', { reason: 'unsupported', hint: 'vm contexts here are iframes; post the port to code running there instead.' })
}

export function postMessageToThread() {
  return Promise.reject(new NotImplementedError('worker_threads.postMessageToThread', { reason: 'unimplemented', hint: 'Pass a MessagePort to the other thread (transferList) and post on it.' }))
}

// --- Worker (the creating side) ---------------------------------------------------------------

/** Workers this thread created that have not exited, for a worker's natural exit. */
const liveWorkers = new Set()
const workerWatchers = new Set()

function notifyWorkers() {
  for (const fn of workerWatchers) fn()
}

/** Handles that keep this thread alive besides timers and Tauri calls: ports with listeners, workers. */
export function activeHandles() {
  let count = activePortCount()
  for (const worker of liveWorkers) if (worker._refed) count++
  return count
}

export function onActiveHandlesChange(fn) {
  workerWatchers.add(fn)
  const stop = onActivePortsChange(fn)
  return () => {
    workerWatchers.delete(fn)
    stop()
  }
}

let nextThreadId = 1

function newThreadId() {
  // Nested workers number their own workers after the parent's id, so ids stay distinct.
  return threadId ? threadId * 1000 + nextThreadId++ : nextThreadId++
}

function codeError(Base, code, message) {
  const error = new Base(message)
  error.code = code
  return error
}

/** A JSON copy (functions dropped), or undefined. */
function jsonCopy(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/** An Error from the worker's description of it (the same name, message, stack and code). */
function reviveError(data) {
  if (!data || typeof data !== 'object') return new Error(String(data))
  const error = new Error(data.message ?? '')
  for (const [key, value] of Object.entries(data)) {
    if (key === 'message') continue
    try {
      Object.defineProperty(error, key, { value, writable: true, configurable: true, enumerable: key !== 'stack' && key !== 'name' })
    } catch {
      /* read-only */
    }
  }
  return error
}

/** What a Tauri command's rejection becomes on its way to the worker. */
function cloneableReason(reason) {
  if (reason instanceof Error) return { name: reason.name, message: reason.message, stack: reason.stack, code: reason.code }
  try {
    structuredClone(reason)
    return reason
  } catch {
    return String(reason)
  }
}

/** Channel arguments (`__CHANNEL__:<id>` strings, at any depth) mapped through `map`. */
function mapChannels(args, map) {
  if (typeof args === 'string') {
    const match = /^__CHANNEL__:(\d+)$/.exec(args)
    return match ? `__CHANNEL__:${map(Number(match[1]))}` : args
  }
  if (Array.isArray(args)) return args.map((item) => mapChannels(item, map))
  if (args && typeof args === 'object' && Object.getPrototypeOf(args) === Object.prototype) {
    const out = {}
    for (const [key, value] of Object.entries(args)) out[key] = mapChannels(value, map)
    return out
  }
  return args
}

const WORKER_PATH_HINT =
  'The worker script or module filename must be an absolute path or a relative path starting with \'./\' or \'../\'.'

/** `/C:/x` (a file URL's path on Windows) → `C:/x`. */
const dropDriveSlash = (p) => (/^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p)

/**
 * The project path of a worker script (`/src/worker.js`), from what Node
 * accepts: an absolute path or `./` / `../` path (relative to the project
 * here; to the working directory in Node), or a `file:` URL (an `http(s):`
 * / `tauri:` URL of this app's own pages works too).
 */
export function workerScriptPath(filename) {
  let value = filename
  if (value instanceof URL || (value && typeof value === 'object' && typeof value.href === 'string')) value = String(value.href)
  if (typeof value !== 'string') {
    throw codeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "filename" argument must be of type string or an instance of URL.')
  }
  let path
  if (/^file:/i.test(value)) {
    path = dropDriveSlash(decodeURIComponent(new URL(value).pathname))
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) {
    const url = new URL(value)
    const here = typeof location === 'undefined' ? null : location.origin
    if (here === null || url.origin !== here) {
      throw codeError(TypeError, 'ERR_WORKER_PATH', `${WORKER_PATH_HINT} Received "${value}"`)
    }
    path = decodeURIComponent(url.pathname).replace(/^\/@fs(?=\/)/, '')
  } else if (/^data:/i.test(value)) {
    throw new NotImplementedError('new Worker(data: URL)', { reason: 'unimplemented', hint: 'Pass the code with { eval: true } instead.' })
  } else if (value.startsWith('./') || value.startsWith('../') || value.startsWith('.\\') || value.startsWith('..\\')) {
    path = `/${value}`
  } else if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    path = value
  } else {
    throw codeError(TypeError, 'ERR_WORKER_PATH', `${WORKER_PATH_HINT} Received "${value}"`)
  }
  path = path.replace(/\\/g, '/')
  // A real path under the app's folder → its project path.
  path = String(toProjectPath(path)).replace(/\\/g, '/')
  // Normalize `.` and `..` segments.
  const parts = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const absolute = /^[a-zA-Z]:$/.test(parts[0] ?? '') ? parts.join('/') : `/${parts.join('/')}`
  return absolute
}

function registry() {
  return globalThis.__TAURI_ELECTRON_WORKERS__ ?? null
}

/** The worker bundle's URL for nested workers (null: the worker uses its own location). */
function absoluteUrl(url) {
  if (!url) return null
  try {
    return new URL(url, typeof location === 'undefined' ? undefined : location.href).href
  } catch {
    return null
  }
}

function notSetUp() {
  return new NotImplementedError('new Worker()', {
    reason: 'unimplemented',
    hint: "The bundler plugin did not build tauri-electron's worker runtime: it does when the app's sources import worker_threads, or with its `workers` option (true, or the worker scripts).",
  })
}

function notBundled(path) {
  const error = new Error(
    `Cannot find module '${path}': this worker script was not bundled. The bundler plugin bundles the scripts it finds in new Worker(...) calls (path.join(__dirname, '…'), new URL('…', import.meta.url), …); list others in its \`workers\` option.`,
  )
  error.code = 'ERR_MODULE_NOT_FOUND'
  return error
}

/** The fields of a Tauri window's internals a worker needs (JSON copies). */
function tauriContext() {
  const internals = globalThis.__TAURI_INTERNALS__
  if (!internals) return null
  let fileSrc = null
  try {
    fileSrc = internals.convertFileSrc('tauripath', 'tauriproto')
  } catch {
    /* no convertFileSrc */
  }
  return {
    metadata: jsonCopy(internals.metadata) ?? {},
    plugins: jsonCopy(internals.plugins) ?? {},
    fileSrc,
    os: jsonCopy(globalThis.__TAURI_OS_PLUGIN_INTERNALS__) ?? null,
  }
}

function processContext(env) {
  const process = globalThis.process ?? {}
  return {
    env,
    execPath: process.execPath ?? '',
    execArgv: Array.isArray(process.execArgv) ? [...process.execArgv] : [],
    pid: process.pid ?? 0,
    cwd: typeof process.cwd === 'function' ? process.cwd() : '/',
    resourcesPath: process.resourcesPath ?? '',
    versions: jsonCopy(process.versions) ?? {},
    version: process.version ?? '',
  }
}

export class Worker extends EventEmitter {
  /**
   * @param {string|URL} filename The worker script, or its code with `eval: true`.
   * @param {object} [options] `workerData`, `transferList`, `env`, `argv`, `execArgv`, `eval`,
   *   `name`, `stdout`, `stderr`, `resourceLimits` (recorded), `stdin` (not supported).
   */
  constructor(filename, options = {}) {
    super()
    const workers = registry()
    if (!workers?.create) throw notSetUp()
    const isEval = Boolean(options.eval)
    const entry = isEval ? null : workerScriptPath(filename)
    const script = isEval ? null : (workers.aliases?.[entry] ?? entry)
    const env = options.env === undefined || options.env === SHARE_ENV ? { ...(globalThis.process?.env ?? {}) } : Object.fromEntries(Object.entries(options.env ?? {}).map(([k, v]) => [k, String(v)]))
    const argvName = isEval ? '[worker eval]' : typeof filename === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(filename) ? filename : entry

    Object.defineProperties(this, {
      _native: { value: null, writable: true },
      _exited: { value: false, writable: true },
      _exitCode: { value: undefined, writable: true },
      _refed: { value: true, writable: true },
      _callbacks: { value: new Map() },
      _waiting: { value: [] },
      _options: { value: options },
    })
    Object.defineProperty(this, '_threadId', { value: newThreadId(), writable: true })
    this.resourceLimits = { maxYoungGenerationSizeMb: 0, maxOldGenerationSizeMb: 0, codeRangeSizeMb: 0, stackSizeMb: 4, ...(options.resourceLimits ?? {}) }
    this.stdin = null
    this.stdout = new Readable({ read() {} })
    this.stderr = new Readable({ read() {} })
    this.performance = { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) }

    const { value: workerData, transfer } = outgoing(options.workerData, options.transferList)
    if (options.stdin) console.warn('[tauri-electron] worker_threads: the stdin option is not supported; worker.stdin is null.')

    liveWorkers.add(this)
    notifyWorkers()

    if (!isEval && workers.entries && !workers.entries.includes(script)) {
      // As in Node, a missing worker script is an 'error' event, then 'exit'.
      setTimeout(() => this._fail(notBundled(entry)), 0)
      return
    }

    let native
    try {
      native = workers.create({ name: options.name ? String(options.name) : undefined })
    } catch (error) {
      liveWorkers.delete(this)
      notifyWorkers()
      throw error
    }
    this._native = native
    native.addEventListener('message', (event) => this._onMessage(event))
    native.addEventListener('messageerror', () => this.emit('messageerror', codeError(Error, 'ERR_WORKER_MESSAGE_DESERIALIZE', 'Message could not be deserialized')))
    native.addEventListener('error', (event) => {
      // Uncaught errors the worker reports itself arrive as messages; this is a load failure.
      event.preventDefault?.()
      this._fail(event.error ?? new Error(event.message || 'The worker script failed to load'))
    })
    native.postMessage(
      {
        [ENVELOPE]: 'init',
        threadId: this._threadId,
        name: options.name ? String(options.name) : '',
        entry: script,
        eval: isEval ? String(filename) : null,
        argv: [globalThis.process?.execPath ?? '', argvName, ...(options.argv ?? []).map(String)],
        execArgv: options.execArgv ? options.execArgv.map(String) : undefined,
        workerData,
        environmentData: [...environmentData],
        resourceLimits: this.resourceLimits,
        process: processContext(env),
        tauri: tauriContext(),
        app: globalThis.__TAURI_ELECTRON_APP__ ?? null,
        workers: { url: absoluteUrl(workers.url), type: workers.type, entries: workers.entries ?? null, aliases: workers.aliases ?? {}, dev: Boolean(workers.dev) },
      },
      transfer,
    )
  }

  /** The worker's id; -1 once it has exited, as in Node. */
  get threadId() {
    return this._exited ? -1 : this._threadId
  }

  postMessage(value, transferList) {
    if (this._exited || !this._native) return
    const { value: data, transfer } = outgoing(value, transferList)
    this._native.postMessage({ [ENVELOPE]: 'msg', v: data }, transfer)
  }

  _post(message, transfer = []) {
    if (!this._exited && this._native) this._native.postMessage(message, transfer)
  }

  _onMessage(event) {
    const data = event.data
    if (!data || typeof data !== 'object') return
    switch (data[ENVELOPE]) {
      case 'online':
        this.emit('online')
        break
      case 'msg':
        this.emit('message', incoming(data.v, event.ports))
        break
      case 'invoke':
        this._relay(data)
        break
      case 'uncb': {
        const id = this._callbacks.get(data.id)
        this._callbacks.delete(data.id)
        if (id !== undefined) globalThis.__TAURI_INTERNALS__?.unregisterCallback?.(id)
        break
      }
      case 'out':
        this._output(data.fd === 2 ? 'stderr' : 'stdout', data.chunk)
        break
      case 'error':
        this.emit('error', reviveError(data.error))
        break
      case 'exit':
        this._exit(data.code ?? 0)
        break
    }
  }

  /** A Tauri command for the worker, run with this window's permissions. */
  _relay({ id, cmd, args, options }) {
    const internals = globalThis.__TAURI_INTERNALS__
    if (!internals?.invoke) {
      this._post({ [ENVELOPE]: 'res', id, ok: false, error: 'Tauri commands are not available in this window' })
      return
    }
    const mapped = mapChannels(args, (workerId) => {
      let parentId = this._callbacks.get(workerId)
      if (parentId === undefined) {
        parentId = internals.transformCallback((raw) => this._post({ [ENVELOPE]: 'cb', id: workerId, raw }))
        this._callbacks.set(workerId, parentId)
      }
      return parentId
    })
    Promise.resolve()
      .then(() => internals.invoke(cmd, mapped, options))
      .then(
        (value) => this._post({ [ENVELOPE]: 'res', id, ok: true, value }),
        (error) => this._post({ [ENVELOPE]: 'res', id, ok: false, error: cloneableReason(error) }),
      )
      .catch((error) => this._post({ [ENVELOPE]: 'res', id, ok: false, error: cloneableReason(error) }))
  }

  /** The worker's stdout / stderr: the stream when asked for (`stdout: true`), else this thread's console. */
  _output(name, chunk) {
    const stream = this[name]
    // Kept in the stream only when someone reads it, so a chatty worker does not fill memory.
    if (this._options[name] || stream.listenerCount('data') || stream.listenerCount('readable')) stream.push(chunk)
    if (this._options[name]) return
    // Node pipes a worker's output to the parent's process.stdout / stderr.
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    const line = text.endsWith('\n') ? text.slice(0, -1) : text
    if (name === 'stderr') console.error(line)
    else console.log(line)
  }

  _fail(error) {
    if (this._exited) return
    this.emit('error', error)
    this._exit(1)
  }

  _exit(code) {
    if (this._exited) return
    this._exited = true
    this._exitCode = code
    try {
      this._native?.terminate()
    } catch {
      /* already gone */
    }
    for (const parentId of this._callbacks.values()) globalThis.__TAURI_INTERNALS__?.unregisterCallback?.(parentId)
    this._callbacks.clear()
    liveWorkers.delete(this)
    notifyWorkers()
    this.stdout.push(null)
    this.stderr.push(null)
    this.emit('exit', code)
    for (const resolve of this._waiting.splice(0)) resolve(code)
  }

  /** Stop the worker; resolves with its exit code (1, as in Node). */
  terminate(callback) {
    const done = new Promise((resolve) => {
      if (this._exited) resolve(this._exitCode)
      else this._waiting.push(resolve)
    })
    if (!this._exited) {
      try {
        this._native?.terminate()
      } catch {
        /* already gone */
      }
      setTimeout(() => this._exit(1), 0)
    }
    if (typeof callback === 'function') done.then((code) => callback(null, code))
    return done
  }

  ref() {
    this._refed = true
    notifyWorkers()
    return this
  }

  unref() {
    this._refed = false
    notifyWorkers()
    return this
  }

  getHeapSnapshot() {
    return Promise.reject(new NotImplementedError('worker.getHeapSnapshot', { reason: 'unsupported', hint: 'The webview has no heap snapshots; use its devtools.' }))
  }

  getHeapStatistics() {
    return Promise.resolve({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0 })
  }

  [Symbol.asyncDispose ?? Symbol.for('nodejs.asyncDispose')]() {
    return this.terminate()
  }
}

const workerThreads = {
  isMainThread,
  isInternalThread,
  parentPort,
  workerData,
  threadId,
  resourceLimits,
  SHARE_ENV,
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  receiveMessageOnPort,
  markAsUntransferable,
  isMarkedAsUntransferable,
  moveMessagePortToContext,
  postMessageToThread,
  setEnvironmentData,
  getEnvironmentData,
}

export default workerThreads
