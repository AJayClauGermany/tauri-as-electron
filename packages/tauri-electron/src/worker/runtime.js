/**
 * The Node side of a `worker_threads` worker, loaded by the bootstrap
 * (./bootstrap.js) once the window's 'init' message arrived: the Node layer
 * and `require()`, a worker's `process` (its env and argv, `process.exit()`
 * ending the worker, stdout / stderr and console output sent to the window,
 * 'exit' / 'beforeExit' / 'uncaughtException'), uncaught errors reported as
 * the Worker's 'error' event, then the worker script (`loadEntry`, from the
 * bundler plugin) or the `eval: true` code. The worker ends by itself once
 * nothing it tracks is pending (see ../node/worker-threads.js).
 */
import { installNodeLayer } from '../node/install.js'
import { installRequire, requireShim } from '../require.js'
import processShim, { applyProcessInfo } from '../process.js'
import { EventEmitter } from '../internal/emitter.js'
import { format, inspect } from '../node/util.js'
import { Writable } from '../node/stream.js'
import { ENVELOPE, activeHandles, onActiveHandlesChange, parentPort } from '../node/worker-threads.js'

/** How long a worker must look idle before it ends by itself. */
export const IDLE_GRACE_MS = 100

/** Thrown by process.exit() to stop the code that called it; never reported. */
class WorkerExit extends Error {}

export function run(loadEntry) {
  const context = globalThis.__TAURI_ELECTRON_WORKER__
  const { init } = context
  let exiting = false
  let loaded = false
  const events = new EventEmitter()

  // --- process ----------------------------------------------------------------------------------
  const info = init.process ?? {}
  applyProcessInfo({ argv: init.argv, env: info.env, execPath: info.execPath, pid: info.pid, cwd: info.cwd, resourcesPath: info.resourcesPath }, { type: 'worker' })
  // Replaced, not merged: env and argv are the worker's own.
  processShim.env = { ...(info.env ?? {}) }
  processShim.argv = [...(init.argv ?? [])]
  processShim.execArgv = [...(init.execArgv ?? info.execArgv ?? [])]
  if (info.versions) processShim.versions = { ...processShim.versions, ...info.versions }
  if (info.version) processShim.version = info.version
  processShim.exitCode = undefined
  for (const name of ['on', 'once', 'off', 'addListener', 'removeListener', 'prependListener', 'removeAllListeners', 'listenerCount', 'listeners']) {
    processShim[name] = (...args) => {
      const result = events[name](...args)
      return result === events ? processShim : result
    }
  }
  processShim.emit = (...args) => events.emit(...args)
  processShim.exit = (code) => {
    finish(code ?? processShim.exitCode ?? 0)
    throw new WorkerExit('process.exit()')
  }
  processShim.abort = () => processShim.exit(134)
  processShim.reallyExit = processShim.exit
  const output = (fd) =>
    Object.assign(
      new Writable({
        write(chunk, encoding, callback) {
          context.post({ [ENVELOPE]: 'out', fd, chunk: typeof chunk === 'string' ? chunk : new Uint8Array(chunk) })
          callback()
        },
        decodeStrings: false,
      }),
      { fd, isTTY: false, columns: 80, rows: 24 },
    )
  processShim.stdout = output(1)
  processShim.stderr = output(2)

  // --- console: to the window, like a Node worker's output going to the parent's stdout ------------
  const print = (fd) => (...args) => context.post({ [ENVELOPE]: 'out', fd, chunk: `${format(...args)}\n` })
  for (const name of ['log', 'info', 'debug']) console[name] = print(1)
  for (const name of ['warn', 'error', 'trace']) console[name] = print(2)
  console.dir = (value, options) => print(1)(inspect(value, options))

  // --- uncaught errors: the Worker's 'error' event, then exit 1 ----------------------------------------
  const describe = (error) => {
    if (error && typeof error === 'object') {
      const data = { name: error.name ?? 'Error', message: String(error.message ?? ''), stack: error.stack }
      for (const key of Object.keys(error)) {
        try {
          data[key] = structuredClone(error[key])
        } catch {
          /* not cloneable: left out */
        }
      }
      return data
    }
    return { name: 'Error', message: String(error) }
  }
  function uncaught(error, origin) {
    if (error instanceof WorkerExit || exiting) return
    if (events.listenerCount('uncaughtException')) {
      events.emit('uncaughtException', error, origin)
      return
    }
    if (origin === 'unhandledRejection' && events.listenerCount('unhandledRejection')) {
      events.emit('unhandledRejection', error)
      return
    }
    context.post({ [ENVELOPE]: 'error', error: describe(error) })
    finish(1)
  }
  self.addEventListener('error', (event) => {
    event.preventDefault()
    uncaught(event.error ?? new Error(event.message), 'uncaughtException')
  })
  self.addEventListener('unhandledrejection', (event) => {
    event.preventDefault()
    uncaught(event.reason, 'unhandledRejection')
  })

  function finish(code) {
    if (exiting) return
    exiting = true
    processShim.exitCode = code
    try {
      events.emit('exit', code)
    } catch {
      /* an exit listener threw: still exit */
    }
    context.post({ [ENVELOPE]: 'exit', code })
    self.close()
  }

  // --- natural exit: nothing pending for a while ---------------------------------------------------
  let idleTimer = null
  const busy = () => context.busy() + activeHandles()
  function checkIdle() {
    if (!loaded || exiting) return
    if (idleTimer !== null) context.native.clearTimeout(idleTimer)
    idleTimer = null
    if (busy()) return
    const stamp = context.activity()
    idleTimer = context.native.setTimeout(() => {
      idleTimer = null
      if (exiting || busy() || context.activity() !== stamp) return
      events.emit('beforeExit', processShim.exitCode ?? 0)
      if (busy() || context.activity() !== stamp) return
      finish(processShim.exitCode ?? 0)
    }, IDLE_GRACE_MS)
  }
  context.onChange(checkIdle)
  onActiveHandlesChange(checkIdle)

  // --- the Node layer and the script ----------------------------------------------------------------
  installNodeLayer({ timers: true })
  installRequire()
  // Workers this worker starts run the same worker bundle as itself.
  const workers = init.workers ?? {}
  const url = workers.url ?? self.location.href
  globalThis.__TAURI_ELECTRON_WORKERS__ = {
    ...workers,
    url,
    create: (options) => new Worker(url, { ...options, type: workers.type === 'module' ? 'module' : 'classic' }),
  }
  void parentPort

  const started = Promise.resolve().then(() => {
    if (init.eval !== null && init.eval !== undefined) return runEval(String(init.eval))
    const loading = loadEntry(init.entry)
    if (!loading) {
      const error = new Error(`Cannot find module '${init.entry}': this worker script was not bundled (see the bundler plugin's \`workers\` option).`)
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    }
    return loading
  })
  return started.then(
    () => {
      loaded = true
      checkIdle()
    },
    (error) => uncaught(error, 'uncaughtException'),
  )
}

/** `eval: true` code: a CommonJS script, as in Node (`require`, `module`, `__filename` '[worker eval]'). */
function runEval(code) {
  const module = { exports: {}, id: '[worker eval]', filename: '[worker eval]', loaded: false, children: [], paths: [] }
  // eslint-disable-next-line no-new-func
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', `${code}\n//# sourceURL=[worker eval]`)
  fn.call(module.exports, module.exports, requireShim, module, '[worker eval]', '.')
  module.loaded = true
}
