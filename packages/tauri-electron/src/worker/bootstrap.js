/**
 * The first code of a `worker_threads` worker (a dedicated Web Worker). It
 * has no imports on purpose: everything else in the worker bundle loads
 * lazily, after the window's 'init' message arrived, because Node code reads
 * `workerData` & co. the moment it runs.
 *
 * Here: wait for 'init' (keeping messages that arrive before the runtime
 * listens), make the worker look like its window to Tauri's JavaScript
 * (`window.__TAURI_INTERNALS__`: commands relayed through the window that
 * created the worker, Channels included; the bridge URL; the OS plugin's
 * constants), and track what keeps the worker busy (timers, relayed calls,
 * fetch, …) for its natural exit. Then src/worker/runtime.js takes over.
 */
const ENVELOPE = '__te'

export function start(loadRuntime) {
  if (typeof WorkerGlobalScope === 'undefined' || !(self instanceof WorkerGlobalScope)) return
  const scope = self
  const queue = []
  let handler = null
  let context = null
  let activity = 0
  const watchers = new Set()
  const timeouts = new Set()
  const intervals = new Set()
  let pending = 0
  const calls = new Map()
  let nextCall = 1
  const callbacks = new Map()

  const native = {
    setTimeout: scope.setTimeout.bind(scope),
    clearTimeout: scope.clearTimeout.bind(scope),
    setInterval: scope.setInterval.bind(scope),
    clearInterval: scope.clearInterval.bind(scope),
  }

  function changed() {
    activity++
    for (const fn of watchers) fn()
  }

  function post(message, transfer) {
    activity++
    scope.postMessage(message, transfer ?? [])
  }

  // --- what keeps the worker busy --------------------------------------------------------------
  scope.setTimeout = function setTimeout(callback, delay, ...args) {
    const id = native.setTimeout((...values) => {
      timeouts.delete(id)
      try {
        if (typeof callback === 'function') callback(...values)
        else (0, eval)(String(callback))
      } finally {
        changed()
      }
    }, delay, ...args)
    timeouts.add(id)
    changed()
    return id
  }
  scope.clearTimeout = function clearTimeout(id) {
    native.clearTimeout(id)
    if (timeouts.delete(id)) changed()
  }
  scope.setInterval = function setInterval(callback, delay, ...args) {
    const id = native.setInterval((...values) => {
      activity++
      if (typeof callback === 'function') callback(...values)
      else (0, eval)(String(callback))
    }, delay, ...args)
    intervals.add(id)
    changed()
    return id
  }
  scope.clearInterval = function clearInterval(id) {
    native.clearInterval(id)
    if (intervals.delete(id)) changed()
  }

  /** Count a promise as pending work until it settles. */
  function track(promise) {
    pending++
    changed()
    const done = () => {
      pending--
      changed()
    }
    promise.then(done, done)
    return promise
  }
  const trackMethods = (target, names) => {
    for (const name of names) {
      const original = target?.[name]
      if (typeof original !== 'function') continue
      target[name] = function tracked(...args) {
        const result = original.apply(this, args)
        return result && typeof result.then === 'function' ? track(result) : result
      }
    }
  }
  trackMethods(scope, ['fetch', 'createImageBitmap'])
  trackMethods(scope.Response?.prototype, ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'])
  trackMethods(scope.Blob?.prototype, ['arrayBuffer', 'bytes', 'text'])
  trackMethods(scope.SubtleCrypto?.prototype, ['decrypt', 'deriveBits', 'deriveKey', 'digest', 'encrypt', 'exportKey', 'generateKey', 'importKey', 'sign', 'unwrapKey', 'verify', 'wrapKey'])
  trackMethods(scope.WebAssembly, ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming'])
  const xhrSend = scope.XMLHttpRequest?.prototype.send
  const xhrOpen = scope.XMLHttpRequest?.prototype.open
  if (xhrSend && xhrOpen) {
    const sync = new WeakSet()
    scope.XMLHttpRequest.prototype.open = function open(method, url, async = true, ...rest) {
      if (async === false) sync.add(this)
      else sync.delete(this)
      return xhrOpen.call(this, method, url, async, ...rest)
    }
    scope.XMLHttpRequest.prototype.send = function send(body) {
      if (!sync.has(this)) track(new Promise((resolve) => this.addEventListener('loadend', resolve, { once: true })))
      return xhrSend.call(this, body)
    }
  }
  if (typeof scope.WebSocket === 'function') {
    const NativeWebSocket = scope.WebSocket
    scope.WebSocket = class WebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args)
        track(new Promise((resolve) => this.addEventListener('close', resolve, { once: true })))
      }
    }
  }

  // --- Tauri's window internals, relayed through the window ---------------------------------------
  function forIpc(args) {
    if (args instanceof ArrayBuffer || ArrayBuffer.isView(args)) return args
    // As Tauri sends them: JSON, with Channels (toJSON) and IPC-serializable objects resolved.
    const text = JSON.stringify(args ?? {}, (key, value) =>
      value && typeof value === 'object' && typeof value.__TAURI_TO_IPC_KEY__ === 'function' ? value.__TAURI_TO_IPC_KEY__() : value,
    )
    return text === undefined ? {} : JSON.parse(text)
  }

  function ipcOptions(options) {
    if (!options) return undefined
    const headers = options.headers
    if (headers && typeof headers.entries === 'function' && !Array.isArray(headers)) return { ...options, headers: [...headers.entries()] }
    return { ...options }
  }

  function installTauri(tauri) {
    if (typeof scope.window === 'undefined') scope.window = scope
    if (!tauri) return
    const randomId = () => scope.crypto.getRandomValues(new Uint32Array(1))[0]
    scope.__TAURI_INTERNALS__ = {
      metadata: tauri.metadata ?? {},
      plugins: tauri.plugins ?? {},
      invoke(cmd, args = {}, options) {
        return new Promise((resolve, reject) => {
          const id = nextCall++
          calls.set(id, { resolve, reject })
          pending++
          try {
            post({ [ENVELOPE]: 'invoke', id, cmd, args: forIpc(args), options: ipcOptions(options) })
          } catch (error) {
            calls.delete(id)
            pending--
            reject(error)
          }
          changed()
        })
      },
      transformCallback(callback, once = false) {
        const id = randomId()
        callbacks.set(id, { callback, once })
        changed()
        return id
      },
      unregisterCallback(id) {
        if (!callbacks.delete(id)) return
        post({ [ENVELOPE]: 'uncb', id })
        changed()
      },
      runCallback(id, data) {
        const entry = callbacks.get(id)
        if (!entry) return
        if (entry.once) callbacks.delete(id)
        entry.callback(data)
      },
      convertFileSrc(filePath, protocol = 'asset') {
        if (!tauri.fileSrc) throw new Error('convertFileSrc is not available in this worker')
        return tauri.fileSrc.replace('tauriproto', protocol).replace('tauripath', encodeURIComponent(filePath))
      },
    }
    if (tauri.os) scope.__TAURI_OS_PLUGIN_INTERNALS__ = tauri.os
  }

  function settle({ id, ok, value, error }) {
    const call = calls.get(id)
    if (!call) return
    calls.delete(id)
    pending--
    if (ok) call.resolve(value)
    else call.reject(error)
    changed()
  }

  function begin(data, event) {
    installTauri(data.tauri)
    globalThis.__TAURI_ELECTRON_APP__ = data.app ?? null
    context = {
      init: data,
      ports: event.ports,
      native,
      post,
      /** Messages for the runtime (user messages): those that came early, then the rest. */
      listen(fn) {
        handler = fn
        for (const early of queue.splice(0)) fn(early)
      },
      /** Timers, relayed calls and Channels, tracked promises. */
      busy: () => timeouts.size + intervals.size + pending + callbacks.size,
      activity: () => activity,
      onChange(fn) {
        watchers.add(fn)
      },
    }
    globalThis.__TAURI_ELECTRON_WORKER__ = context
    post({ [ENVELOPE]: 'online' })
    Promise.resolve()
      .then(() => loadRuntime(data))
      .catch((error) => {
        post({ [ENVELOPE]: 'error', error: { name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack } })
        post({ [ENVELOPE]: 'exit', code: 1 })
        scope.close()
      })
  }

  scope.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object' || !(ENVELOPE in data)) return
    activity++
    switch (data[ENVELOPE]) {
      case 'init':
        if (!context) begin(data, event)
        return
      case 'res':
        settle(data)
        return
      case 'cb': {
        const entry = callbacks.get(data.id)
        if (!entry) return
        if (entry.once) callbacks.delete(data.id)
        entry.callback(data.raw)
        return
      }
      default:
        if (handler) handler(event)
        else queue.push(event)
    }
  })
}
