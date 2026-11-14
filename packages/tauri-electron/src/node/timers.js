/**
 * Node's `timers`. `setTimeout` / `setInterval` return Timeout objects
 * (`ref()`, `unref()`, `hasRef()`, `refresh()`, `close()`) that convert to
 * the webview's numeric timer id, so `clearTimeout` accepts either.
 * `setImmediate` runs after pending I/O callbacks, on a MessageChannel
 * message (faster than `setTimeout(fn, 0)`, which webviews clamp).
 *
 * `unref()` has nothing to unreference here (the main window does not exit
 * when timers are idle), so it is accepted and recorded only.
 */
import timersPromises from './timers-promises.js'

const native = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
}

const idOf = (timer) => (timer && typeof timer === 'object' && typeof timer[Symbol.toPrimitive] === 'function' ? timer[Symbol.toPrimitive]() : timer)

/** Node's Timeout. */
export class Timeout {
  constructor(callback, delay, args, repeat) {
    this._callback = callback
    this._delay = Math.max(1, Number(delay) || 1)
    this._args = args
    this._repeat = repeat
    this._ref = true
    this._destroyed = false
    this._start()
  }

  _start() {
    const run = () => {
      if (!this._repeat) this._destroyed = true
      this._callback(...this._args)
    }
    this._id = this._repeat ? native.setInterval(run, this._delay) : native.setTimeout(run, this._delay)
  }

  ref() {
    this._ref = true
    return this
  }

  unref() {
    this._ref = false
    return this
  }

  hasRef() {
    return this._ref
  }

  /** Restart the timer with its original delay. */
  refresh() {
    if (this._destroyed) return this
    ;(this._repeat ? native.clearInterval : native.clearTimeout)(this._id)
    this._start()
    return this
  }

  close() {
    this._destroyed = true
    ;(this._repeat ? native.clearInterval : native.clearTimeout)(this._id)
    return this
  }

  [Symbol.toPrimitive]() {
    // A number in a webview; under Node (tests) the native id is itself an object.
    return typeof this._id === 'object' ? Number(this._id) : this._id
  }

  [Symbol.dispose ?? Symbol.for('nodejs.dispose')]() {
    this.close()
  }
}

/** Node's Immediate. */
export class Immediate {
  constructor(callback, args) {
    this._onImmediate = callback
    this._args = args
    this._ref = true
    this._cleared = false
  }

  ref() {
    this._ref = true
    return this
  }

  unref() {
    this._ref = false
    return this
  }

  hasRef() {
    return this._ref
  }
}

function checkCallback(callback) {
  if (typeof callback !== 'function') {
    const error = new TypeError(`The "callback" argument must be of type function. Received ${callback === null ? 'null' : typeof callback}`)
    error.code = 'ERR_INVALID_ARG_TYPE'
    throw error
  }
}

export function setTimeout(callback, delay, ...args) {
  checkCallback(callback)
  return new Timeout(callback, delay, args, false)
}

export function setInterval(callback, delay, ...args) {
  checkCallback(callback)
  return new Timeout(callback, delay, args, true)
}

export function clearTimeout(timer) {
  if (timer instanceof Timeout) timer.close()
  else if (timer !== undefined && timer !== null) native.clearTimeout(idOf(timer))
}

export function clearInterval(timer) {
  if (timer instanceof Timeout) timer.close()
  else if (timer !== undefined && timer !== null) native.clearInterval(idOf(timer))
}

// setImmediate: one MessageChannel; immediates queued during a run wait for the next one, as in Node.
const queue = []
let channel = null
function flush() {
  if (!queue.length) return
  const batch = queue.splice(0, queue.length)
  if (!queue.length) channel?.port1.unref?.()
  for (const immediate of batch) {
    if (!immediate._cleared) immediate._onImmediate(...immediate._args)
  }
}
function schedule() {
  if (typeof MessageChannel === 'undefined') return native.setTimeout(flush, 0)
  if (!channel) {
    channel = new MessageChannel()
    channel.port1.onmessage = flush
  }
  // Node (tests) only: keep the process alive while immediates are pending, not after.
  channel.port1.ref?.()
  channel.port2.postMessage(null)
}

export function setImmediate(callback, ...args) {
  checkCallback(callback)
  const immediate = new Immediate(callback, args)
  if (queue.push(immediate) === 1) schedule()
  return immediate
}

export function clearImmediate(immediate) {
  if (immediate instanceof Immediate) immediate._cleared = true
}


/** Make the main page's globals behave like Node's (Timeout objects, setImmediate). */
export function installTimerGlobals(target = globalThis) {
  Object.assign(target, { setTimeout, setInterval, clearTimeout, clearInterval })
  if (typeof target.setImmediate !== 'function') Object.assign(target, { setImmediate, clearImmediate })
}

export const promises = timersPromises

const timers = {
  setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate, Timeout, Immediate, promises,
}

export default timers
