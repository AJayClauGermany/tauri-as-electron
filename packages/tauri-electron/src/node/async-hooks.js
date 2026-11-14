/**
 * Node's `async_hooks`, partly. A webview offers no hook into async context,
 * so AsyncLocalStorage keeps its store for the synchronous part of `run()`
 * only: code after an `await` (or in a later callback) sees `undefined`.
 * `createHook` returns a hook that never fires; ids are constants.
 */
export class AsyncLocalStorage {
  constructor() {
    this._enabled = false
    this._store = undefined
  }

  static bind(fn) {
    return fn
  }

  static snapshot() {
    return (fn, ...args) => fn(...args)
  }

  getStore() {
    return this._enabled ? this._store : undefined
  }

  run(store, callback, ...args) {
    const [enabled, previous] = [this._enabled, this._store]
    this._enabled = true
    this._store = store
    try {
      return callback(...args)
    } finally {
      this._enabled = enabled
      this._store = previous
    }
  }

  exit(callback, ...args) {
    const [enabled, previous] = [this._enabled, this._store]
    this._enabled = false
    try {
      return callback(...args)
    } finally {
      this._enabled = enabled
      this._store = previous
    }
  }

  enterWith(store) {
    this._enabled = true
    this._store = store
  }

  disable() {
    this._enabled = false
    this._store = undefined
  }
}

let nextId = 2

export class AsyncResource {
  constructor(type, options = {}) {
    this.type = type
    this._asyncId = nextId++
    this._triggerId = typeof options === 'number' ? options : (options.triggerAsyncId ?? 1)
  }

  static bind(fn, type, thisArg) {
    return new AsyncResource(type ?? fn.name ?? 'bound-anonymous-fn').bind(fn, thisArg)
  }

  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args)
  }

  bind(fn, thisArg) {
    const bound = thisArg === undefined ? fn : fn.bind(thisArg)
    return Object.defineProperty((...args) => this.runInAsyncScope(bound, undefined, ...args), 'asyncResource', { value: this })
  }

  emitDestroy() {
    return this
  }

  asyncId() {
    return this._asyncId
  }

  triggerAsyncId() {
    return this._triggerId
  }
}

export function createHook() {
  return {
    enable() {
      return this
    },
    disable() {
      return this
    },
  }
}

export const executionAsyncId = () => 1
export const triggerAsyncId = () => 0
export const executionAsyncResource = () => ({})
export const asyncWrapProviders = Object.freeze({})

export default { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, triggerAsyncId, executionAsyncResource, asyncWrapProviders }
