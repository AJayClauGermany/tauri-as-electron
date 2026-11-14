/**
 * Minimal Node-style EventEmitter. Electron's main-process objects
 * (app, BrowserWindow, ipcMain, ...) are all EventEmitters, so user code
 * relies on on/once/off/emit semantics.
 *
 * A function rather than a class so that it can also be called the way
 * pre-class Node code does (`EventEmitter.call(this)` with
 * `util.inherits`, as readable-stream and many npm packages do). Classes
 * still extend it as usual.
 */
export function EventEmitter() {
  if (!(this instanceof EventEmitter)) throw new TypeError("Class constructor EventEmitter cannot be invoked without 'new'")
  if (!Object.prototype.hasOwnProperty.call(this, '_events') || !(this._events instanceof Map)) {
    Object.defineProperty(this, '_events', { value: new Map(), writable: true, configurable: true })
  }
}

EventEmitter.prototype._list = function _list(name) {
  let list = this._events.get(name)
  if (!list) this._events.set(name, (list = []))
  return list
}

/** Node's 'newListener' event, plus a hook subclasses use to learn what is listened to. */
EventEmitter.prototype._added = function _added(name, listener) {
  if (name !== 'newListener' && this._events.has('newListener')) this.emit('newListener', name, listener)
  this._newListener?.(name)
}

EventEmitter.prototype.on = function on(name, listener) {
  this._added(name, listener)
  this._list(name).push({ listener, once: false })
  return this
}

// One function under both names, as in Node: subclasses (readable-stream)
// override one name with a wrapper that calls the base under the other.
EventEmitter.prototype.addListener = EventEmitter.prototype.on

EventEmitter.prototype.prependListener = function prependListener(name, listener) {
  this._added(name, listener)
  this._list(name).unshift({ listener, once: false })
  return this
}

EventEmitter.prototype.once = function once(name, listener) {
  this._added(name, listener)
  this._list(name).push({ listener, once: true })
  return this
}

EventEmitter.prototype.prependOnceListener = function prependOnceListener(name, listener) {
  this._added(name, listener)
  this._list(name).unshift({ listener, once: true })
  return this
}

EventEmitter.prototype.off = function off(name, listener) {
  const list = this._events.get(name)
  if (!list) return this
  const index = list.findIndex((entry) => entry.listener === listener)
  if (index !== -1) list.splice(index, 1)
  if (list.length === 0) this._events.delete(name)
  return this
}

EventEmitter.prototype.removeListener = EventEmitter.prototype.off

EventEmitter.prototype.removeAllListeners = function removeAllListeners(name) {
  if (name === undefined) this._events.clear()
  else this._events.delete(name)
  return this
}

EventEmitter.prototype.emit = function emit(name, ...args) {
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

EventEmitter.prototype.listenerCount = function listenerCount(name) {
  return this._events.get(name)?.length ?? 0
}

EventEmitter.prototype.listeners = function listeners(name) {
  return (this._events.get(name) ?? []).map((entry) => entry.listener)
}

EventEmitter.prototype.rawListeners = function rawListeners(name) {
  return this.listeners(name)
}

EventEmitter.prototype.eventNames = function eventNames() {
  return [...this._events.keys()]
}

EventEmitter.prototype.setMaxListeners = function setMaxListeners() {
  return this
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return Infinity
}

// Non-enumerable, like class methods (for…in over an emitter lists its data only).
for (const name of Object.getOwnPropertyNames(EventEmitter.prototype)) {
  if (name !== 'constructor') Object.defineProperty(EventEmitter.prototype, name, { enumerable: false })
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
