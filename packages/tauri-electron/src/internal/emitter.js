/**
 * Minimal Node-style EventEmitter. Electron's main-process objects
 * (app, BrowserWindow, ipcMain, ...) are all EventEmitters, so user code
 * relies on on/once/off/emit semantics.
 */
export class EventEmitter {
  constructor() {
    Object.defineProperty(this, '_events', { value: new Map(), writable: true })
  }

  _list(name) {
    let list = this._events.get(name)
    if (!list) this._events.set(name, (list = []))
    return list
  }

  on(name, listener) {
    this._list(name).push({ listener, once: false })
    return this
  }

  addListener(name, listener) {
    return this.on(name, listener)
  }

  prependListener(name, listener) {
    this._list(name).unshift({ listener, once: false })
    return this
  }

  once(name, listener) {
    this._list(name).push({ listener, once: true })
    return this
  }

  prependOnceListener(name, listener) {
    this._list(name).unshift({ listener, once: true })
    return this
  }

  off(name, listener) {
    const list = this._events.get(name)
    if (!list) return this
    const index = list.findIndex((entry) => entry.listener === listener)
    if (index !== -1) list.splice(index, 1)
    if (list.length === 0) this._events.delete(name)
    return this
  }

  removeListener(name, listener) {
    return this.off(name, listener)
  }

  removeAllListeners(name) {
    if (name === undefined) this._events.clear()
    else this._events.delete(name)
    return this
  }

  emit(name, ...args) {
    const list = this._events.get(name)
    if (!list || list.length === 0) {
      if (name === 'error') throw args[0] instanceof Error ? args[0] : new Error(String(args[0]))
      return false
    }
    for (const entry of [...list]) {
      if (entry.once) this.off(name, entry.listener)
      entry.listener.apply(this, args)
    }
    return true
  }

  listenerCount(name) {
    return this._events.get(name)?.length ?? 0
  }

  listeners(name) {
    return (this._events.get(name) ?? []).map((entry) => entry.listener)
  }

  rawListeners(name) {
    return this.listeners(name)
  }

  eventNames() {
    return [...this._events.keys()]
  }

  setMaxListeners() {
    return this
  }

  getMaxListeners() {
    return Infinity
  }
}

/** An Electron-style event object whose default action can be prevented. */
export function createEvent(extra = {}) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    ...extra,
  }
  return event
}
