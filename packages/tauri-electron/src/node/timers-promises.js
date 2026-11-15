/**
 * Node's `timers/promises`: promise and async-iterator timers with
 * AbortSignal support, and `scheduler.wait` / `scheduler.yield`.
 */
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis)

function abortError(signal) {
  const error = new Error('The operation was aborted', { cause: signal?.reason })
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function later(schedule, cancel, value, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cancel(handle)
      reject(abortError(signal))
    }
    const handle = schedule(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function setTimeout(delay = 1, value, options) {
  return later((fn) => nativeSetTimeout(fn, delay), nativeClearTimeout, value, options)
}

export function setImmediate(value, options) {
  return later(
    (fn) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        fn()
      }
      channel.port2.postMessage(null)
      return channel
    },
    (channel) => channel.port1.close(),
    value,
    options,
  )
}

/** An async iterator that yields `value` every `delay` ms until the loop stops or the signal aborts. */
export async function* setInterval(delay = 1, value, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal)
  let pending = 0
  let wake = null
  let aborted = false
  const id = globalThis.setInterval(() => {
    pending++
    wake?.()
  }, delay)
  const onAbort = () => {
    aborted = true
    wake?.()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      if (!pending && !aborted) await new Promise((resolve) => (wake = resolve))
      wake = null
      if (aborted) throw abortError(signal)
      pending--
      yield value
    }
  } finally {
    globalThis.clearInterval(id)
    signal?.removeEventListener('abort', onAbort)
  }
}

export const scheduler = {
  wait: (delay, options) => setTimeout(delay, undefined, options),
  yield: () => setImmediate(),
}

export default { setTimeout, setImmediate, setInterval, scheduler }
