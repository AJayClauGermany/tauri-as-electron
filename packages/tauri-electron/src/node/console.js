/**
 * Node's `console` module: the global console, plus the `Console` class
 * (`new Console(stdout, [stderr])`), which writes formatted lines to any
 * writable stream (an fs-backed one, a `stream.Writable`, `{ write() }`).
 */
import { format, formatWithOptions, inspect } from './util.js'

export class Console {
  constructor(stdout, stderr, ignoreErrors = true) {
    let options = stdout
    if (!stdout || typeof stdout.write === 'function') options = { stdout, stderr, ignoreErrors }
    if (!options.stdout || typeof options.stdout.write !== 'function') {
      const error = new TypeError('The "stdout" argument must be an instance of Stream')
      error.code = 'ERR_CONSOLE_WRITABLE_STREAM'
      throw error
    }
    this._stdout = options.stdout
    this._stderr = options.stderr ?? options.stdout
    this._ignoreErrors = options.ignoreErrors !== false
    this._inspectOptions = options.inspectOptions ?? {}
    this._groupIndentation = options.groupIndentation ?? 2
    this._indent = ''
    this._counts = new Map()
    this._timers = new Map()
    // Methods work detached (`const { log } = console`), as Node's do.
    for (const name of Object.getOwnPropertyNames(Console.prototype)) {
      if (name !== 'constructor' && !name.startsWith('_') && typeof this[name] === 'function') this[name] = this[name].bind(this)
    }
  }

  _write(stream, args) {
    const text = formatWithOptions(this._inspectOptions, ...args)
    const indented = this._indent ? text.split('\n').map((line) => this._indent + line).join('\n') : text
    try {
      stream.write(`${indented}\n`)
    } catch (error) {
      if (!this._ignoreErrors) throw error
    }
  }

  log(...args) {
    this._write(this._stdout, args)
  }

  info(...args) {
    this._write(this._stdout, args)
  }

  debug(...args) {
    this._write(this._stdout, args)
  }

  warn(...args) {
    this._write(this._stderr, args)
  }

  error(...args) {
    this._write(this._stderr, args)
  }

  dir(value, options) {
    this._write(this._stdout, [inspect(value, { ...this._inspectOptions, ...options })])
  }

  dirxml(...args) {
    this.log(...args)
  }

  trace(...args) {
    const stack = new Error().stack?.split('\n').slice(2).join('\n') ?? ''
    this._write(this._stderr, [`Trace${args.length ? `: ${format(...args)}` : ''}\n${stack}`])
  }

  assert(value, ...args) {
    if (!value) this.warn(...(args.length ? [`Assertion failed: ${format(...args)}`] : ['Assertion failed']))
  }

  count(label = 'default') {
    const count = (this._counts.get(label) ?? 0) + 1
    this._counts.set(label, count)
    this.log(`${label}: ${count}`)
  }

  countReset(label = 'default') {
    this._counts.delete(label)
  }

  group(...args) {
    if (args.length) this.log(...args)
    this._indent += ' '.repeat(this._groupIndentation)
  }

  groupCollapsed(...args) {
    this.group(...args)
  }

  groupEnd() {
    this._indent = this._indent.slice(this._groupIndentation)
  }

  time(label = 'default') {
    this._timers.set(label, performance.now())
  }

  timeLog(label = 'default', ...args) {
    const start = this._timers.get(label)
    if (start === undefined) return this.warn(`Warning: No such label '${label}' for console.timeLog()`)
    this.log(`${label}: ${(performance.now() - start).toFixed(3)}ms`, ...args)
  }

  timeEnd(label = 'default') {
    this.timeLog(label)
    this._timers.delete(label)
  }

  table(data) {
    this.log(data)
  }
}

const console = globalThis.console
// Node's global console carries the class.
if (console && !('Console' in console)) Object.defineProperty(console, 'Console', { value: Console, configurable: true, writable: true })

export default console
