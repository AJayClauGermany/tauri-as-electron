/**
 * Node's `diagnostics_channel`: named publish/subscribe channels and
 * tracing channels (`start`, `end`, `asyncStart`, `asyncEnd`, `error`).
 */
const channels = new Map()

export class Channel {
  constructor(name) {
    this.name = name
    this._subscribers = []
    this._stores = new Map()
  }

  get hasSubscribers() {
    return this._subscribers.length > 0 || this._stores.size > 0
  }

  subscribe(subscription) {
    this._subscribers.push(subscription)
  }

  unsubscribe(subscription) {
    const index = this._subscribers.indexOf(subscription)
    if (index === -1) return false
    this._subscribers.splice(index, 1)
    return true
  }

  /** Subscribers' exceptions do not stop the others; they surface asynchronously, as in Node. */
  publish(message) {
    for (const subscriber of [...this._subscribers]) {
      try {
        subscriber(message, this.name)
      } catch (error) {
        queueMicrotask(() => {
          throw error
        })
      }
    }
  }

  bindStore(store, transform) {
    this._stores.set(store, transform)
  }

  unbindStore(store) {
    return this._stores.delete(store)
  }

  runStores(data, fn, thisArg, ...args) {
    let run = () => {
      this.publish(data)
      return fn.apply(thisArg, args)
    }
    for (const [store, transform] of this._stores) {
      const next = run
      run = () => store.run(transform ? transform(data) : data, next)
    }
    return run()
  }
}

export function channel(name) {
  if (!channels.has(name)) channels.set(name, new Channel(name))
  return channels.get(name)
}

export function hasSubscribers(name) {
  return channels.get(name)?.hasSubscribers ?? false
}

export function subscribe(name, subscription) {
  channel(name).subscribe(subscription)
}

export function unsubscribe(name, subscription) {
  return channel(name).unsubscribe(subscription)
}

const EVENTS = ['start', 'end', 'asyncStart', 'asyncEnd', 'error']

export class TracingChannel {
  constructor(nameOrChannels) {
    for (const event of EVENTS) {
      this[event] = typeof nameOrChannels === 'string' ? channel(`tracing:${nameOrChannels}:${event}`) : nameOrChannels[event]
    }
  }

  get hasSubscribers() {
    return EVENTS.some((event) => this[event].hasSubscribers)
  }

  subscribe(handlers) {
    for (const event of EVENTS) if (handlers[event]) this[event].subscribe(handlers[event])
  }

  unsubscribe(handlers) {
    let done = true
    for (const event of EVENTS) if (handlers[event] && !this[event].unsubscribe(handlers[event])) done = false
    return done
  }

  traceSync(fn, context = {}, thisArg, ...args) {
    return this.start.runStores(context, () => {
      try {
        context.result = fn.apply(thisArg, args)
        return context.result
      } catch (error) {
        context.error = error
        this.error.publish(context)
        throw error
      } finally {
        this.end.publish(context)
      }
    })
  }

  tracePromise(fn, context = {}, thisArg, ...args) {
    return this.start.runStores(context, () => {
      try {
        const promise = Promise.resolve(fn.apply(thisArg, args))
        this.end.publish(context)
        return promise.then(
          (result) => {
            context.result = result
            this.asyncStart.publish(context)
            this.asyncEnd.publish(context)
            return result
          },
          (error) => {
            context.error = error
            this.error.publish(context)
            this.asyncStart.publish(context)
            this.asyncEnd.publish(context)
            throw error
          },
        )
      } catch (error) {
        context.error = error
        this.error.publish(context)
        this.end.publish(context)
        throw error
      }
    })
  }

  traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
    const index = position < 0 ? args.length + position : position
    const callback = args[index]
    args[index] = (error, result) => {
      if (error) {
        context.error = error
        this.error.publish(context)
      } else {
        context.result = result
      }
      this.asyncStart.publish(context)
      try {
        return callback.call(thisArg, error, result)
      } finally {
        this.asyncEnd.publish(context)
      }
    }
    return this.traceSync(fn, context, thisArg, ...args)
  }
}

export function tracingChannel(nameOrChannels) {
  return new TracingChannel(nameOrChannels)
}

export default { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel, Channel }
