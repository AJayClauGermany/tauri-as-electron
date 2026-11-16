/**
 * What `child_process.fork` and `utilityProcess.fork` share.
 *
 * The child is a real Node.js (tauri-plugin-electron's `node-child-process`
 * feature finds it: the `execPath` option, a sidecar the app bundles, `node`
 * on PATH in development). The module it runs must be a file on disk for
 * that Node: the bundler plugins find fork entry points in the app's source
 * (`utilityProcess.fork(path.join(__dirname, 'worker.js'))` & co., and the
 * `fork` option), bundle each one for Node and describe them in
 * `__TAURI_ELECTRON_APP__.fork`:
 *
 *   { dir, bootstrap: 'bootstrap.cjs', entries: { '/src/worker.js': 'src/worker.cjs' } }
 *
 * `dir` is absolute in development; in a build it is null and the files are
 * in `<resources>/fork` (staged in `src-tauri/electron-resources/fork`).
 * Other paths run as they are (app-relative ones mapped onto the app root).
 *
 * The IPC channel carries one JSON text per line both ways (Node's `json`
 * serialization); Rust forwards lines, so messages stay in order.
 */
import processShim from '../process.js'
import { fileURLToPath } from '../url.js'
import { appRoot, resolveAppPath, toProjectPath } from './app-files.js'

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/

function config() {
  return globalThis.__TAURI_ELECTRON_APP__?.fork ?? null
}

function joinNative(base, rest) {
  const sep = /^[a-zA-Z]:[\\/]|^\\\\/.test(base) ? '\\' : '/'
  const tail = String(rest).replace(/^[\\/]+/, '')
  return base.replace(/[\\/]+$/, '') + sep + (sep === '\\' ? tail.replace(/\//g, '\\') : tail)
}

function resourcesPath() {
  return processShim.resourcesPath || globalThis.process?.resourcesPath || ''
}

/** Where the bundled fork files are, or null when the app has none. */
export function forkDir() {
  const cfg = config()
  if (!cfg) return null
  if (cfg.dir) return cfg.dir
  const resources = resourcesPath()
  return resources ? joinNative(resources, 'fork') : null
}

/** The child bootstrap (`process.parentPort`, `require('electron')`), when the app ships it. */
export function bootstrapFile() {
  const cfg = config()
  const dir = forkDir()
  return cfg?.bootstrap && dir ? joinNative(dir, cfg.bootstrap) : null
}

/** A `modulePath` argument (string or file URL) as a path string. */
export function modulePathString(modulePath) {
  if (modulePath instanceof URL) return fileURLToPath(modulePath)
  const text = String(modulePath)
  return text.startsWith('file:') ? fileURLToPath(text) : text
}

/**
 * The file the child runs for `modulePath`: the bundled entry when the
 * bundler built one for it, otherwise the path itself (app-relative paths
 * such as `/src/worker.js` mapped onto the app root).
 */
export function resolveModule(modulePath) {
  const requested = modulePathString(modulePath)
  const cfg = config()
  const dir = forkDir()
  if (cfg?.entries && dir) {
    const key = toProjectPath(requested)
    const bare = key.replace(SOURCE_EXTENSION, '')
    const entry = cfg.entries[key] ?? Object.entries(cfg.entries).find(([name]) => name.replace(SOURCE_EXTENSION, '') === bare)?.[1]
    if (entry) return { file: joinNative(dir, entry), bundled: true, requested }
  }
  return { file: resolveAppPath(requested).path, bundled: false, requested }
}

/**
 * The child's environment: `env` (default: this process's) plus where the
 * app's files are, which bundled entries use for `__dirname`.
 */
export function childEnv(env) {
  const base = env ?? processShim.env ?? globalThis.process?.env ?? {}
  const out = Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
  const root = appRoot()
  if (root && out.TAURI_ELECTRON_APP_ROOT === undefined) out.TAURI_ELECTRON_APP_ROOT = root
  return out
}

/** Node's arguments: options, the bootstrap, the module and its arguments. */
export function nodeArgs(file, args = [], execArgv = []) {
  const bootstrap = bootstrapFile()
  return [...execArgv.map(String), ...(bootstrap ? ['--require', bootstrap] : []), file, ...args.map(String)]
}

/** Whether `execPath` names this app's own executable (Electron's `process.execPath`). */
export function isOwnExecutable(execPath) {
  const own = processShim.execPath || globalThis.process?.execPath
  return Boolean(execPath) && Boolean(own) && String(execPath) === own
}

/**
 * Writes lines to a child's IPC channel in order: one `child_send` at a
 * time, with the lines queued meanwhile sent together.
 */
export class LineQueue {
  /** @param {(data: string) => Promise<boolean>} send */
  constructor(send) {
    this.send = send
    this.pending = []
    this.busy = false
  }

  /** Queue `line` (ending in '\n'); `callback(error)` once written. `line` null: run `action` in order instead. */
  push(line, callback, action) {
    this.pending.push({ line, callback, action })
    if (!this.busy) this.flush()
  }

  async flush() {
    this.busy = true
    while (this.pending.length) {
      const next = this.pending[0]
      if (next.action) {
        this.pending.shift()
        try {
          await next.action()
        } catch {
          /* reported by the action */
        }
        next.callback?.(null)
        continue
      }
      const batch = []
      while (this.pending.length && !this.pending[0].action) batch.push(this.pending.shift())
      let error = null
      try {
        const sent = await this.send(batch.map((item) => item.line).join(''))
        if (sent === false) error = channelClosed()
      } catch (failure) {
        error = failure
      }
      for (const item of batch) item.callback?.(error)
    }
    this.busy = false
  }
}

export function channelClosed() {
  const error = new Error('Channel closed')
  error.code = 'ERR_IPC_CHANNEL_CLOSED'
  return error
}

/** Parse one line from the channel; malformed lines are dropped (Node would throw in the child). */
export function parseLine(line) {
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch {
    return { ok: false }
  }
}

/**
 * A JSON line for `message`, as Node's `json` serialization writes it.
 * `undefined` cannot be sent (Node: ERR_MISSING_ARGS).
 */
export function jsonLine(message) {
  if (message === undefined) {
    const error = new TypeError('The "message" argument must be specified')
    error.code = 'ERR_MISSING_ARGS'
    throw error
  }
  return JSON.stringify(message) + '\n'
}
