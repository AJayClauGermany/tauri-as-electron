/**
 * `fs.watch`, `fs.promises.watch`, `fs.watchFile` and `fs.unwatchFile`.
 *
 * - `fs.watch` creates the watcher synchronously over the bridge
 *   (`node/fs/watch`, the notify crate in tauri-plugin-electron), so a missing
 *   path throws as in Node and nothing that happens after `fs.watch()`
 *   returns is missed; its events then arrive over a Channel (`fs_watch`).
 *   As in Node, events are `'rename'` (an entry appeared or disappeared) or
 *   `'change'` (content or metadata), with the name relative to the watched
 *   folder, or the file's own name.
 * - `fs.watchFile` polls with `fs.promises.stat`, like Node's stat watcher.
 *
 * There is no event loop to keep alive in a webview: `ref()` / `unref()`
 * and `persistent` are accepted and do nothing.
 *
 * Created by ./fs.js with the helpers it shares (`createWatchApi`), which
 * keeps this module free of an import cycle.
 */
import { Channel } from '@tauri-apps/api/core'
import { Buffer } from './buffer.js'
import { native } from '../internal/native.js'
import { EventEmitter } from '../internal/emitter.js'
import { report } from '../internal/runtime.js'

function abortError(reason) {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  if (reason !== undefined) error.cause = reason
  return error
}

/** The fields whose change makes `fs.watchFile` call its listeners (libuv's list). */
const POLLED = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs']

/**
 * @param {object} fs helpers from ./fs.js: `target` (path argument → real path),
 *   `callSync`, `nodeError`, `stat` (fs.promises.stat), `makeStats`,
 *   `invalidArgType`, `getOptions`, `checkEncoding`.
 */
export function createWatchApi(fs) {
  const filenameIn = (encoding) => (name) => {
    if (name == null) return name
    if (encoding === 'buffer') return Buffer.from(name)
    if (!encoding || encoding === 'utf8' || encoding === 'utf-8') return name
    return Buffer.from(name).toString(encoding)
  }

  class FSWatcher extends EventEmitter {
    constructor() {
      super()
      this._id = null
      this._closed = false
    }

    _start(path, { recursive, encoding }) {
      const { id } = fs.callSync('fs.watch', 'watch', { path, recursive: Boolean(recursive) })
      this._id = id
      const toName = filenameIn(encoding)
      const channel = new Channel()
      channel.onmessage = (message) => {
        if (this._closed) return
        if (message.type === 'error') {
          this.emit('error', fs.nodeError(message.error))
          this.close()
          return
        }
        this.emit('change', message.type, toName(message.filename))
      }
      native('fs_watch', { id, onEvent: channel }).catch((error) => {
        if (this._closed) return
        this.emit('error', error instanceof Error ? error : new Error(String(error?.message ?? error)))
        this.close()
      })
    }

    close() {
      if (this._closed) return
      this._closed = true
      if (this._id !== null) native('fs_unwatch', { id: this._id }).catch(report('fs.watch close'))
      queueMicrotask(() => this.emit('close'))
    }

    ref() {
      return this
    }

    unref() {
      return this
    }
  }

  /** `fs.watch(filename[, options][, listener])`. */
  function watch(filename, options, listener) {
    if (typeof options === 'function') {
      listener = options
      options = undefined
    }
    const opts = fs.getOptions(options, { encoding: 'utf8', recursive: false, persistent: true })
    fs.checkEncoding(opts.encoding)
    if (opts.signal !== undefined && (opts.signal === null || typeof opts.signal.aborted !== 'boolean')) {
      throw fs.invalidArgType('options.signal', 'an instance of AbortSignal', opts.signal)
    }
    const path = fs.target(filename, { name: 'filename', syscall: 'watch' })
    const watcher = new FSWatcher()
    watcher._start(path, opts)
    if (typeof listener === 'function') watcher.on('change', listener)
    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(() => watcher.close())
      else opts.signal.addEventListener('abort', () => watcher.close(), { once: true })
    }
    return watcher
  }

  /** `fs.promises.watch(filename[, options])`: an async iterator of `{ eventType, filename }`. */
  async function* watchAsync(filename, options) {
    const opts = fs.getOptions(options, {})
    const { signal } = opts
    if (signal?.aborted) throw abortError(signal.reason)
    const watcher = watch(filename, { ...opts, signal: undefined })
    const queue = []
    let failure = null
    let wake = null
    const notify = () => {
      wake?.()
      wake = null
    }
    watcher.on('change', (eventType, name) => {
      queue.push({ eventType, filename: name })
      notify()
    })
    watcher.on('error', (error) => {
      failure = error
      notify()
    })
    const onAbort = () => {
      failure = abortError(signal.reason)
      notify()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift()
          continue
        }
        if (failure) throw failure
        await new Promise((resolve) => (wake = resolve))
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      watcher.close()
    }
  }

  // --- fs.watchFile -------------------------------------------------------------------------------

  class StatWatcher extends EventEmitter {
    constructor(path, { interval, bigint }) {
      super()
      this._path = path
      this._interval = interval
      this._bigint = bigint
      this._timer = null
      this._stopped = false
      this._prev = null
      this._status = null
      this._poll(true)
    }

    async _poll(first) {
      let current
      let status = 'ok'
      try {
        current = await fs.stat(this._path, { bigint: this._bigint })
      } catch (error) {
        status = error?.code ?? 'error'
        current = fs.makeStats({}, this._bigint)
      }
      if (this._stopped) return
      const prev = this._prev ?? fs.makeStats({}, this._bigint)
      const changed = first
        ? status !== 'ok' // like libuv: a missing file is reported once, with zeroed stats
        : status !== this._status || (status === 'ok' && POLLED.some((key) => current[key] !== prev[key]))
      this._prev = current
      this._status = status
      if (changed) this.emit('change', current, prev)
      this._timer = setTimeout(() => this._poll(false), this._interval)
    }

    stop() {
      if (this._stopped) return
      this._stopped = true
      clearTimeout(this._timer)
      queueMicrotask(() => this.emit('stop'))
    }

    ref() {
      return this
    }

    unref() {
      return this
    }
  }

  const statWatchers = new Map()

  /** `fs.watchFile(filename[, options], listener)`. */
  function watchFile(filename, options, listener) {
    if (typeof options === 'function') {
      listener = options
      options = undefined
    }
    if (typeof listener !== 'function') throw fs.invalidArgType('listener', 'of type function', listener)
    const opts = { interval: 5007, persistent: true, bigint: false, ...(options ?? {}) }
    const path = fs.target(filename, { name: 'filename' })
    let watcher = statWatchers.get(path)
    if (!watcher) {
      watcher = new StatWatcher(path, { interval: Number(opts.interval) || 5007, bigint: Boolean(opts.bigint) })
      statWatchers.set(path, watcher)
    }
    watcher.on('change', listener)
    return watcher
  }

  /** `fs.unwatchFile(filename[, listener])`: one listener, or all of them. */
  function unwatchFile(filename, listener) {
    const path = fs.target(filename, { name: 'filename' })
    const watcher = statWatchers.get(path)
    if (!watcher) return
    if (typeof listener === 'function') watcher.removeListener('change', listener)
    else watcher.removeAllListeners('change')
    if (watcher.listenerCount('change') === 0) {
      watcher.stop()
      statWatchers.delete(path)
    }
  }

  return { FSWatcher, StatWatcher, watch, watchAsync, watchFile, unwatchFile }
}
