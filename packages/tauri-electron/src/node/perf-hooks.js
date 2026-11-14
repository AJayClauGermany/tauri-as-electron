/**
 * Node's `perf_hooks`: the webview's `performance` with Node's additions
 * (`timerify`, `eventLoopUtilization`), PerformanceObserver, and histograms
 * (`monitorEventLoopDelay` samples timer lateness).
 */
const native = globalThis.performance

export const performance = {
  get timeOrigin() {
    return native.timeOrigin
  },
  now: () => native.now(),
  mark: (...args) => native.mark(...args),
  measure: (...args) => native.measure(...args),
  clearMarks: (...args) => native.clearMarks(...args),
  clearMeasures: (...args) => native.clearMeasures(...args),
  clearResourceTimings: (...args) => native.clearResourceTimings?.(...args),
  getEntries: () => native.getEntries(),
  getEntriesByName: (...args) => native.getEntriesByName(...args),
  getEntriesByType: (...args) => native.getEntriesByType(...args),
  toJSON: () => native.toJSON(),
  nodeTiming: { name: 'node', entryType: 'node', startTime: 0, duration: native.now() },
  /** Idle time is not observable from a webview: utilization is reported as 0. */
  eventLoopUtilization(previous) {
    const active = 0
    const idle = native.now()
    const now = { idle, active, utilization: 0 }
    if (!previous) return now
    return { idle: now.idle - previous.idle, active: 0, utilization: 0 }
  },
  /** Wraps `fn` so each call is recorded as a 'function' performance entry (a measure here). */
  timerify(fn) {
    const name = fn.name || 'anonymous'
    function timerified(...args) {
      const start = native.now()
      const result = new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args)
      try {
        native.measure(`timerify:${name}`, { start, end: native.now() })
      } catch {
        /* old engines without measure options */
      }
      return result
    }
    return timerified
  },
}

export const PerformanceObserver = globalThis.PerformanceObserver
export const PerformanceEntry = globalThis.PerformanceEntry
export const PerformanceMark = globalThis.PerformanceMark
export const PerformanceMeasure = globalThis.PerformanceMeasure
export const PerformanceObserverEntryList = globalThis.PerformanceObserverEntryList
export const PerformanceResourceTiming = globalThis.PerformanceResourceTiming

/** Node's RecordableHistogram (values in nanoseconds for event-loop delay). */
class Histogram {
  constructor() {
    this.reset()
  }

  reset() {
    this._values = []
    this.exceeds = 0
  }

  record(value) {
    this._values.push(Number(value))
  }

  recordDelta() {
    const now = native.now() * 1e6
    if (this._last !== undefined) this.record(now - this._last)
    this._last = now
  }

  get count() {
    return this._values.length
  }

  get min() {
    return this._values.length ? Math.min(...this._values) : 9223372036854776000
  }

  get max() {
    return this._values.length ? Math.max(...this._values) : 0
  }

  get mean() {
    return this._values.length ? this._values.reduce((a, b) => a + b, 0) / this._values.length : NaN
  }

  get stddev() {
    if (!this._values.length) return NaN
    const mean = this.mean
    return Math.sqrt(this._values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / this._values.length)
  }

  percentile(p) {
    if (!this._values.length) return 0
    const sorted = [...this._values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
  }

  get percentiles() {
    return new Map([0, 50, 75, 90, 99, 100].map((p) => [p, this.percentile(p)]))
  }
}

export function createHistogram() {
  return new Histogram()
}

/** Samples how late a `resolution` ms timer fires, like Node's event-loop delay monitor. */
export function monitorEventLoopDelay({ resolution = 10 } = {}) {
  const histogram = new Histogram()
  let timer = null
  let expected = 0
  histogram.enable = () => {
    if (timer) return false
    expected = native.now() + resolution
    timer = setInterval(() => {
      const now = native.now()
      histogram.record(Math.max(1, (now - expected) * 1e6))
      expected = now + resolution
    }, resolution)
    return true
  }
  histogram.disable = () => {
    if (!timer) return false
    clearInterval(timer)
    timer = null
    return true
  }
  return histogram
}

export const constants = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16, NODE_PERFORMANCE_GC_FLAGS_NO: 0, NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
})

export default {
  performance, PerformanceObserver, PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceObserverEntryList,
  PerformanceResourceTiming, createHistogram, monitorEventLoopDelay, constants,
}
