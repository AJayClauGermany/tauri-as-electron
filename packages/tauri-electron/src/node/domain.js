/**
 * Node's deprecated `domain`, minimally: `run`, `bind` and `intercept` route
 * synchronous exceptions and callback errors to the domain's 'error' event.
 * Errors thrown later in asynchronous code are not caught (that needs Node's
 * async hooks).
 */
import { EventEmitter } from '../internal/emitter.js'

export let active = null

export class Domain extends EventEmitter {
  constructor() {
    super()
    this.members = []
  }

  _handle(error) {
    if (error && typeof error === 'object') error.domain = this
    this.emit('error', error)
  }

  run(fn, ...args) {
    const previous = active
    active = this
    try {
      return fn.apply(this, args)
    } catch (error) {
      this._handle(error)
    } finally {
      active = previous
    }
  }

  add(emitter) {
    this.members.push(emitter)
    emitter.on?.('error', (error) => this._handle(error))
  }

  remove(emitter) {
    this.members = this.members.filter((member) => member !== emitter)
  }

  bind(fn) {
    const domain = this
    return function bound(...args) {
      return domain.run(() => fn.apply(this, args))
    }
  }

  intercept(fn) {
    const domain = this
    return function intercepted(error, ...args) {
      if (error) return domain._handle(error)
      return domain.run(() => fn.apply(this, args))
    }
  }

  enter() {
    active = this
  }

  exit() {
    if (active === this) active = null
  }

  dispose() {
    this.exit()
    this.removeAllListeners()
  }
}

export function create() {
  return new Domain()
}
export const createDomain = create

export default { create, createDomain, Domain, get active() { return active } }
