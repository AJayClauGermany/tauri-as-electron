/**
 * `node:events` for Electron code: `const { EventEmitter } = require('events')`
 * is common in main-process code. The EventEmitter tauri-electron's own
 * objects (app, BrowserWindow, ipcMain, …) are built on.
 */
import { EventEmitter } from './internal/emitter.js'

/** Node's `events.once(emitter, name)`: resolves with the event arguments. */
export function once(emitter, name) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      emitter.off?.(name, onEvent)
      reject(error)
    }
    const onEvent = (...args) => {
      if (name !== 'error') emitter.off?.('error', onError)
      resolve(args)
    }
    emitter.once(name, onEvent)
    if (name !== 'error') emitter.once?.('error', onError)
  })
}

/** Node's `events.on(emitter, name)`: an async iterator over the event's arguments. */
export function on(emitter, name, { signal } = {}) {
  const queue = []
  const waiting = []
  let failure = null
  let done = false
  const push = (item) => (waiting.length ? waiting.shift().resolve(item) : queue.push(item))
  const onEvent = (...args) => push({ value: args, done: false })
  const onError = (error) => {
    failure = error
    if (waiting.length) waiting.shift().reject(error)
  }
  const stop = () => {
    done = true
    emitter.off(name, onEvent)
    if (name !== 'error') emitter.off('error', onError)
    while (waiting.length) waiting.shift().resolve({ value: undefined, done: true })
  }
  emitter.on(name, onEvent)
  if (name !== 'error') emitter.on('error', onError)
  signal?.addEventListener('abort', () => onError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true })
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (failure) {
        const error = failure
        failure = null
        stop()
        return Promise.reject(error)
      }
      if (done) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
    },
    return() {
      stop()
      return Promise.resolve({ value: undefined, done: true })
    },
    throw(error) {
      stop()
      return Promise.reject(error)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

export const captureRejectionSymbol = Symbol.for('nodejs.rejection')
export const errorMonitor = Symbol('events.errorMonitor')
export const defaultMaxListeners = 10

export function listenerCount(emitter, name) {
  return emitter.listenerCount(name)
}

export function getEventListeners(emitter, name) {
  if (typeof emitter.listeners === 'function') return emitter.listeners(name)
  return [] // EventTarget listeners cannot be listed
}

export function setMaxListeners() {}

/** Node's `events.addAbortListener(signal, listener)`: returns a disposable. */
export function addAbortListener(signal, listener) {
  if (signal.aborted) queueMicrotask(() => listener())
  else signal.addEventListener('abort', listener, { once: true })
  return { [Symbol.dispose ?? Symbol.for('nodejs.dispose')]: () => signal.removeEventListener('abort', listener) }
}

Object.assign(EventEmitter, {
  EventEmitter,
  once,
  on,
  captureRejectionSymbol,
  errorMonitor,
  defaultMaxListeners,
  listenerCount,
  getEventListeners,
  setMaxListeners,
  addAbortListener,
  captureRejections: false,
  init() {
    EventEmitter.call(this)
  },
})

export { EventEmitter }
export default EventEmitter
