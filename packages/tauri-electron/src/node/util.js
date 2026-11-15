/**
 * Node's `util`: `format`, `inspect`, `promisify`, `callbackify`,
 * `inherits`, `deprecate`, `debuglog`, `isDeepStrictEqual`, `types`, the
 * text codecs and the legacy `is*` helpers. Pure JavaScript.
 *
 * `inspect` follows Node's output closely (quoting, `Map(1) { 'a' => 1 }`,
 * class names, `[Circular *1]`, depth, `inspect.custom`), but does not
 * group long arrays into columns.
 */
import types from './util-types.js'

export { types }

const customInspect = Symbol.for('nodejs.util.inspect.custom')
const customPromisify = Symbol.for('nodejs.util.promisify.custom')

// --- inspect --------------------------------------------------------------------------------------

const defaultOptions = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
}

const colors = {
  reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], hidden: [8, 28],
  strikethrough: [9, 29], black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39],
  magenta: [35, 39], cyan: [36, 39], white: [37, 39], gray: [90, 39], grey: [90, 39],
  redBright: [91, 39], greenBright: [92, 39], yellowBright: [93, 39], blueBright: [94, 39],
  magentaBright: [95, 39], cyanBright: [96, 39], whiteBright: [97, 39],
}

const styles = {
  special: 'cyan', number: 'yellow', bigint: 'yellow', boolean: 'yellow', undefined: 'grey', null: 'bold',
  string: 'green', symbol: 'green', date: 'magenta', regexp: 'red', module: 'underline',
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function stylize(ctx, text, style) {
  if (!ctx.colors) return text
  const color = colors[styles[style]]
  return color ? `\u001b[${color[0]}m${text}\u001b[${color[1]}m` : text
}

function quote(text) {
  const escaped = text.replace(/[\\\n\r\t\b\f\v\u0000-\u001f\u007f]/g, (c) => {
    const known = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '\v': '\\v' }
    return known[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`
  })
  if (!escaped.includes("'")) return `'${escaped}'`
  if (!escaped.includes('"')) return `"${escaped}"`
  if (!escaped.includes('`') && !escaped.includes('${')) return `\`${escaped}\``
  return `'${escaped.replace(/'/g, "\\'")}'`
}

function formatPrimitive(ctx, value) {
  switch (typeof value) {
    case 'string': {
      let text = value
      let suffix = ''
      if (text.length > ctx.maxStringLength) {
        suffix = `... ${text.length - ctx.maxStringLength} more character${text.length - ctx.maxStringLength > 1 ? 's' : ''}`
        text = text.slice(0, ctx.maxStringLength)
      }
      return stylize(ctx, quote(text), 'string') + suffix
    }
    case 'number':
      return stylize(ctx, Object.is(value, -0) ? '-0' : String(value), 'number')
    case 'bigint':
      return stylize(ctx, `${value}n`, 'bigint')
    case 'boolean':
      return stylize(ctx, String(value), 'boolean')
    case 'undefined':
      return stylize(ctx, 'undefined', 'undefined')
    case 'symbol':
      return stylize(ctx, value.toString(), 'symbol')
    default:
      return stylize(ctx, 'null', 'null')
  }
}

function constructorName(value) {
  let proto = Object.getPrototypeOf(value)
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'constructor')
    if (descriptor && typeof descriptor.value === 'function' && descriptor.value.name) return descriptor.value.name
    proto = Object.getPrototypeOf(proto)
  }
  return null
}

function formatKey(ctx, key) {
  if (typeof key === 'symbol') return `[${stylize(ctx, key.toString(), 'symbol')}]`
  return IDENTIFIER.test(key) ? key : stylize(ctx, quote(key), 'string')
}

function functionBase(value) {
  const source = Function.prototype.toString.call(value)
  if (source.startsWith('class') && /^class\b/.test(source)) {
    const parent = Object.getPrototypeOf(value)
    return `[class ${value.name || '(anonymous)'}${parent && parent.name ? ` extends ${parent.name}` : ''}]`
  }
  const kind = types.isAsyncFunction(value)
    ? types.isGeneratorFunction(value) ? 'AsyncGeneratorFunction' : 'AsyncFunction'
    : types.isGeneratorFunction(value) ? 'GeneratorFunction' : 'Function'
  return `[${kind}${value.name ? `: ${value.name}` : ' (anonymous)'}]`
}

function ownKeys(ctx, value, skip) {
  const keys = ctx.showHidden ? Object.getOwnPropertyNames(value) : Object.keys(value)
  const symbols = Object.getOwnPropertySymbols(value).filter((s) => ctx.showHidden || Object.prototype.propertyIsEnumerable.call(value, s))
  const all = [...keys.filter((k) => !skip(k)), ...symbols]
  if (ctx.sorted) all.sort(typeof ctx.sorted === 'function' ? ctx.sorted : undefined)
  return all
}

function formatProperty(ctx, value, key, depth) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key) ?? { value: value[key], enumerable: true }
  let shown
  if (descriptor.get || descriptor.set) {
    const label = descriptor.get && descriptor.set ? 'Getter/Setter' : descriptor.get ? 'Getter' : 'Setter'
    if (ctx.getters && descriptor.get) {
      try {
        shown = `[${label}: ${formatValue(ctx, descriptor.get.call(value), depth + 1)}]`
      } catch (error) {
        shown = `[${label}: <Inspection threw (${error.message})>]`
      }
    } else {
      shown = stylize(ctx, `[${label}]`, 'special')
    }
  } else {
    shown = formatValue(ctx, descriptor.value, depth + 1)
  }
  const name = descriptor.enumerable === false ? `[${formatKey(ctx, key)}]` : formatKey(ctx, key)
  return `${name}: ${shown}`
}

const visibleLength = (ctx, text) => (ctx.colors ? stripVTControlCharacters(text).length : text.length)

/** Node's column layout for arrays of more than six short entries. */
function groupArrayElements(ctx, output, value) {
  let totalLength = 0
  let maxLength = 0
  let outputLength = output.length
  if (ctx.maxArrayLength < (value?.length ?? 0) && outputLength > 0 && output[outputLength - 1].startsWith('... ')) outputLength--
  const separatorSpace = 2
  const dataLen = new Array(outputLength)
  for (let i = 0; i < outputLength; i++) {
    const len = visibleLength(ctx, output[i])
    dataLen[i] = len
    totalLength += len + separatorSpace
    if (maxLength < len) maxLength = len
  }
  const actualMax = maxLength + separatorSpace
  if (actualMax * 3 + ctx.indentation.length < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
    const averageBias = Math.sqrt(actualMax - totalLength / output.length)
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1)
    const columns = Math.min(
      Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentation.length) / actualMax),
      ctx.compact * 4,
      15,
    )
    if (columns <= 1) return output
    const maxLineLength = []
    for (let i = 0; i < columns; i++) {
      let lineLength = 0
      for (let j = i; j < output.length; j += columns) if (dataLen[j] > lineLength) lineLength = dataLen[j]
      maxLineLength.push(lineLength + separatorSpace)
    }
    let padStart = true
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
          padStart = false
          break
        }
      }
    }
    const grouped = []
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength)
      let line = ''
      let j = i
      for (; j < max - 1; j++) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j]
        line += padStart ? `${output[j]}, `.padStart(padding, ' ') : `${output[j]}, `.padEnd(padding, ' ')
      }
      if (padStart) line += output[j].padStart(maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace, ' ')
      else line += output[j]
      grouped.push(line)
    }
    if (outputLength < output.length) grouped.push(output[outputLength])
    return grouped
  }
  return output
}

function reduceToSingleLine(ctx, output, base, braces, depth, isArrayLike, value) {
  if (ctx.compact !== true && typeof ctx.compact === 'number' && ctx.compact >= 1) {
    const entries = output.length
    if (isArrayLike && entries > 6) output = groupArrayElements(ctx, output, value)
    // Single line only for objects with fewer than `compact` levels inside them.
    if (ctx.currentDepth - depth < ctx.compact && entries === output.length) {
      const start = output.length + ctx.indentation.length + braces[0].length + base.length + 10
      const totalLength = output.reduce((sum, entry) => sum + visibleLength(ctx, entry), 0) + output.length
      if (totalLength + start <= ctx.breakLength && !base.includes('\n')) {
        const joined = output.join(', ')
        if (!joined.includes('\n')) return `${base ? `${base} ` : ''}${braces[0]} ${joined} ${braces[1]}`
      }
    }
  }
  const indentation = `\n${ctx.indentation}  `
  return `${base ? `${base} ` : ''}${braces[0]}${indentation}${output.join(`,${indentation}`)}\n${ctx.indentation}${braces[1]}`
}

function formatValue(ctx, value, depth) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return formatPrimitive(ctx, value)

  if (ctx.customInspect && typeof value[customInspect] === 'function' && value[customInspect] !== inspect) {
    const result = value[customInspect](ctx.depth === null ? null : ctx.depth - depth, { ...ctx.options, depth: ctx.depth === null ? null : ctx.depth - depth }, inspect)
    if (result !== value) return typeof result === 'string' ? result : formatValue(ctx, result, depth)
  }

  if (ctx.seen.includes(value)) {
    if (!ctx.circular.has(value)) ctx.circular.set(value, ctx.circular.size + 1)
    return stylize(ctx, `[Circular *${ctx.circular.get(value)}]`, 'special')
  }
  return formatRaw(ctx, value, depth)
}

function formatRaw(ctx, value, depth) {
  const name = constructorName(value)
  let base = ''
  let braces = ['{', '}']
  let entries = null // formatted entries before the own properties
  let skip = () => false
  const prefix = (fallback, size) => {
    const label = name ?? `[${fallback}: null prototype]`
    return size === undefined ? label : `${label}(${size})`
  }

  if (Array.isArray(value)) {
    braces = [`${name === 'Array' ? '' : `${prefix('Array', value.length)} `}[`, ']']
    skip = (key) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length
    entries = () => {
      const out = []
      let holes = 0
      const limit = Math.min(value.length, ctx.maxArrayLength)
      for (let i = 0; i < limit; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          holes++
          continue
        }
        if (holes) out.push(stylize(ctx, `<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'))
        holes = 0
        out.push(formatValue(ctx, value[i], depth + 1))
      }
      if (holes) out.push(stylize(ctx, `<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'))
      if (value.length > limit) out.push(`... ${value.length - limit} more item${value.length - limit > 1 ? 's' : ''}`)
      return out
    }
  } else if (types.isSet(value)) {
    braces = [`${prefix('Set', value.size)} {`, '}']
    entries = () => [...value].slice(0, ctx.maxArrayLength).map((v) => formatValue(ctx, v, depth + 1))
  } else if (types.isMap(value)) {
    braces = [`${prefix('Map', value.size)} {`, '}']
    entries = () => [...value].slice(0, ctx.maxArrayLength).map(([k, v]) => `${formatValue(ctx, k, depth + 1)} => ${formatValue(ctx, v, depth + 1)}`)
  } else if (types.isTypedArray(value)) {
    const fallback = Object.prototype.toString.call(value).slice(8, -1)
    braces = [`${prefix(fallback, value.length)} [`, ']']
    skip = (key) => /^(0|[1-9]\d*)$/.test(key)
    entries = () => {
      const limit = Math.min(value.length, ctx.maxArrayLength)
      const out = Array.from(value.subarray(0, limit), (v) => formatPrimitive(ctx, v))
      if (value.length > limit) out.push(`... ${value.length - limit} more item${value.length - limit > 1 ? 's' : ''}`)
      return out
    }
  } else if (types.isArrayBuffer(value) || types.isSharedArrayBuffer(value)) {
    braces = [`${prefix('ArrayBuffer')} {`, '}']
    entries = () => {
      const bytes = [...new Uint8Array(value, 0, Math.min(value.byteLength, 50))].map((b) => b.toString(16).padStart(2, '0'))
      const more = value.byteLength > 50 ? ` ... ${value.byteLength - 50} more byte${value.byteLength - 50 > 1 ? 's' : ''}` : ''
      return [`[Uint8Contents]: <${bytes.join(' ')}${more}>`, `[byteLength]: ${formatPrimitive(ctx, value.byteLength)}`]
    }
  } else if (types.isMapIterator(value) || types.isSetIterator(value)) {
    braces = [`[${Object.prototype.toString.call(value).slice(8, -1)}] {`, '}']
    entries = () => ['<items unknown>']
  } else if (types.isWeakMap(value) || types.isWeakSet(value)) {
    braces = [`${prefix(types.isWeakMap(value) ? 'WeakMap' : 'WeakSet')} {`, '}']
    entries = () => [stylize(ctx, '<items unknown>', 'special')]
  } else if (types.isPromise(value)) {
    braces = [`${prefix('Promise')} {`, '}']
    entries = () => [stylize(ctx, '<unknown>', 'special')] // a webview cannot read a promise's state synchronously
  } else if (typeof value === 'function') {
    base = functionBase(value)
    skip = (key) => ['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)
  } else if (types.isRegExp(value)) {
    base = stylize(ctx, RegExp.prototype.toString.call(value), 'regexp')
    skip = (key) => key === 'lastIndex'
  } else if (types.isDate(value)) {
    base = stylize(ctx, Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(), 'date')
  } else if (types.isNativeError(value)) {
    const stack = typeof value.stack === 'string' && value.stack ? value.stack : `${value.name}: ${value.message}`
    // WebKit stacks lack the "Name: message" header Node prints first.
    const header = `${value.name ?? 'Error'}${value.message ? `: ${value.message}` : ''}`
    base = stack.startsWith(header) ? stack : `${header}\n${stack.split('\n').map((line) => `    at ${line.replace(/^\s*at\s+/, '')}`).join('\n')}`
    if (!value.stack) base = `[${header}]`
    skip = (key) => key === 'stack' || key === 'message'
    if (ctx.indentation) base = base.split('\n').join(`\n${ctx.indentation}`)
  } else if (types.isBoxedPrimitive(value)) {
    const inner = value.valueOf()
    const label = typeof inner === 'bigint' ? 'BigInt' : typeof inner === 'symbol' ? 'Symbol' : (typeof inner)[0].toUpperCase() + (typeof inner).slice(1)
    base = `[${label}: ${formatPrimitive(ctx, inner)}]`
    if (typeof inner === 'string') skip = (key) => /^(0|[1-9]\d*)$/.test(key) || key === 'length'
  } else if (types.isModuleNamespaceObject(value)) {
    braces = ['[Module: null prototype] {', '}']
  } else {
    if (name === null) braces = ['[Object: null prototype] {', '}']
    else if (name !== 'Object') braces = [`${name} {`, '}']
    if (types.isArgumentsObject(value)) braces = ['[Arguments] [', ']']
  }

  // Beyond `depth`, like Node: empty objects still print as `{}` / `[]`.
  const noEntries = entries === null || value.length === 0 || value.size === 0
  if (ctx.depth !== null && depth > ctx.depth && !(noEntries && !base && ownKeys(ctx, value, skip).length === 0)) {
    if (base) return base
    return stylize(ctx, `[${name ?? (Array.isArray(value) ? 'Array' : 'Object')}]`, 'special')
  }

  ctx.seen.push(value)
  const outerDepth = ctx.currentDepth
  ctx.currentDepth = depth
  const saved = ctx.indentation
  ctx.indentation += '  '
  let output
  let entryCount = 0
  try {
    output = entries ? entries() : []
    entryCount = output.length
    for (const key of ownKeys(ctx, value, skip)) output.push(formatProperty(ctx, value, key, depth))
  } finally {
    ctx.indentation = saved
    ctx.seen.pop()
  }

  let result
  if (output.length === 0) {
    ctx.currentDepth = outerDepth // empty objects do not count as a nesting level (Node returns them early)
    if (base) result = base
    else result = braces[0].endsWith('[') ? `${braces[0]}]` : `${braces[0]}}`
  } else {
    const arrayLike = Array.isArray(value) || types.isTypedArray(value) || types.isSet(value) || types.isMap(value)
    const grouped = (Array.isArray(value) || types.isTypedArray(value)) && entryCount === output.length
    result = reduceToSingleLine(ctx, output, base, braces, depth, grouped, arrayLike ? value : undefined)
  }
  if (ctx.circular.has(value)) result = `<ref *${ctx.circular.get(value)}> ${result}`
  return result
}

/** Node's `util.inspect(value, [options])` (the legacy `(value, showHidden, depth, colors)` form too). */
export function inspect(value, options, depth, useColors) {
  let opts = { ...defaultOptions, ...inspect.defaultOptions }
  if (typeof options === 'boolean') {
    opts.showHidden = options
    if (depth !== undefined) opts.depth = depth
    if (useColors !== undefined) opts.colors = useColors
  } else if (options && typeof options === 'object') {
    opts = { ...opts, ...options }
  }
  if (opts.depth === Infinity) opts.depth = null
  const ctx = { ...opts, options: opts, seen: [], circular: new Map(), indentation: '', currentDepth: 0 }
  return formatValue(ctx, value, 0)
}

inspect.custom = customInspect
inspect.defaultOptions = { ...defaultOptions }
inspect.colors = colors
inspect.styles = styles

// --- format ---------------------------------------------------------------------------------------

function hasOwnToString(value) {
  let proto = value
  while (proto && proto !== Object.prototype && proto !== Error.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, 'toString')) return true
    proto = Object.getPrototypeOf(proto)
  }
  return false
}

/** Node's `util.formatWithOptions(inspectOptions, format, ...args)`. */
export function formatWithOptions(inspectOptions, ...args) {
  const first = args[0]
  let index = 1
  let text = ''
  if (typeof first === 'string') {
    if (args.length === 1) return first
    let last = 0
    for (let i = 0; i < first.length - 1; i++) {
      if (first[i] !== '%') continue
      const code = first[i + 1]
      if (code === '%') {
        text += first.slice(last, i) + '%'
        last = i + 2
        i++
        continue
      }
      if (index >= args.length || !'sdifjoOc'.includes(code)) continue
      const arg = args[index]
      let piece
      switch (code) {
        case 's':
          if (typeof arg === 'bigint') piece = `${arg}n`
          else if (typeof arg === 'number' && Object.is(arg, -0)) piece = '-0'
          else if (arg !== null && typeof arg === 'object' && !hasOwnToString(arg)) piece = inspect(arg, { ...inspectOptions, depth: 0, colors: false, compact: 3 })
          else piece = String(arg)
          break
        case 'd':
          piece = typeof arg === 'bigint' ? `${arg}n` : typeof arg === 'symbol' ? 'NaN' : formatPrimitive({}, Number(arg))
          break
        case 'i':
          piece = typeof arg === 'bigint' ? `${arg}n` : typeof arg === 'symbol' ? 'NaN' : String(parseInt(arg))
          break
        case 'f':
          piece = typeof arg === 'symbol' ? 'NaN' : String(parseFloat(arg))
          break
        case 'j':
          try {
            piece = JSON.stringify(arg)
          } catch (error) {
            if (/circular/i.test(error.message)) piece = '[Circular]'
            else throw error
          }
          break
        case 'o':
          piece = inspect(arg, { ...inspectOptions, showHidden: true, showProxy: true, depth: 4 })
          break
        case 'O':
          piece = inspect(arg, inspectOptions)
          break
        case 'c':
          piece = ''
          break
      }
      text += first.slice(last, i) + piece
      last = i + 2
      i++
      index++
    }
    text += first.slice(last)
  } else {
    index = 0
  }
  for (; index < args.length; index++) {
    const value = args[index]
    text += (text || index > 0 ? ' ' : '') + (typeof value === 'string' ? value : inspect(value, inspectOptions))
  }
  return text
}

/** Node's `util.format(format, ...args)`. */
export function format(...args) {
  return formatWithOptions(undefined, ...args)
}

// --- functions ------------------------------------------------------------------------------------

/** Node's `util.promisify`: honours `util.promisify.custom`. */
export function promisify(original) {
  if (typeof original !== 'function') {
    const error = new TypeError(`The "original" argument must be of type function. Received ${original === null ? 'null' : typeof original}`)
    error.code = 'ERR_INVALID_ARG_TYPE'
    throw error
  }
  if (original[customPromisify]) {
    const fn = original[customPromisify]
    return Object.defineProperty(fn, customPromisify, { value: fn, enumerable: false, writable: false, configurable: true })
  }
  function fn(...args) {
    return new Promise((resolve, reject) => {
      original.call(this, ...args, (error, ...values) => (error ? reject(error) : resolve(values[0])))
    })
  }
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original))
  Object.defineProperty(fn, customPromisify, { value: fn, enumerable: false, writable: false, configurable: true })
  return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original))
}
promisify.custom = customPromisify

/** Node's `util.callbackify`: a falsy rejection reason becomes an Error with `.reason`. */
export function callbackify(original) {
  if (typeof original !== 'function') throw new TypeError('The "original" argument must be of type function')
  function callbackified(...args) {
    const callback = args.pop()
    if (typeof callback !== 'function') throw new TypeError('The last argument must be of type function')
    original.apply(this, args).then(
      (value) => queueMicrotask(() => callback(null, value)),
      (reason) => {
        if (!reason) {
          const wrapped = new Error('Promise was rejected with a falsy value')
          wrapped.code = 'ERR_FALSY_VALUE_REJECTION'
          wrapped.reason = reason
          reason = wrapped
        }
        queueMicrotask(() => callback(reason))
      },
    )
  }
  Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original))
  return callbackified
}

/** Node's `util.inherits(ctor, superCtor)`. */
export function inherits(ctor, superCtor) {
  if (typeof ctor !== 'function' || typeof superCtor !== 'function' || superCtor.prototype === undefined) {
    throw new TypeError('The "ctor" and "superCtor" arguments must be functions with a prototype')
  }
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true })
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
}

const warnedCodes = new Set()

/** Node's `util.deprecate(fn, message, code)`: warns once (per code) on first call. */
export function deprecate(fn, message, code) {
  let warned = false
  function deprecated(...args) {
    if (!warned && !(code && warnedCodes.has(code))) {
      warned = true
      if (code) warnedCodes.add(code)
      const process = globalThis.process
      if (!process?.noDeprecation) {
        const text = `${code ? `[${code}] ` : ''}DeprecationWarning: ${message}`
        if (typeof process?.emitWarning === 'function') process.emitWarning(text)
        else console.warn(text)
      }
    }
    return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args)
  }
  Object.setPrototypeOf(deprecated, fn)
  if (fn.prototype) deprecated.prototype = fn.prototype
  return deprecated
}

/** Node's `util.debuglog(section)`: logs when NODE_DEBUG names the section. */
export function debuglog(section, callback) {
  let enabled
  const isEnabled = () => {
    if (enabled === undefined) {
      const names = String(globalThis.process?.env?.NODE_DEBUG ?? '')
      const pattern = names
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((name) => name.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*'))
        .join('|')
      enabled = Boolean(pattern) && new RegExp(`^(${pattern})$`, 'i').test(section)
      callback?.(logger)
    }
    return enabled
  }
  function logger(...args) {
    if (isEnabled()) console.error(`${section.toUpperCase()} ${globalThis.process?.pid ?? 0}: ${format(...args)}`)
  }
  Object.defineProperty(logger, 'enabled', { get: isEnabled, enumerable: true })
  return logger
}
export const debug = debuglog

// --- isDeepStrictEqual ------------------------------------------------------------------------

function deepEqual(a, b, memo) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  const tagA = Object.prototype.toString.call(a)
  if (tagA !== Object.prototype.toString.call(b)) return false
  const seen = memo.get(a)
  if (seen?.has(b)) return true
  if (seen) seen.add(b)
  else memo.set(a, new Set([b]))

  if (types.isDate(a)) {
    if (!Object.is(a.getTime(), b.getTime())) return false
  } else if (types.isRegExp(a)) {
    if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false
  } else if (types.isBoxedPrimitive(a)) {
    if (!Object.is(a.valueOf(), b.valueOf())) return false
  } else if (types.isNativeError(a)) {
    if (a.message !== b.message || a.name !== b.name) return false
  } else if (ArrayBuffer.isView(a)) {
    if (a.byteLength !== b.byteLength) return false
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    if (types.isFloat32Array(a) || types.isFloat64Array(a)) {
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    } else {
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    }
    // Own non-index properties are compared below.
  } else if (types.isAnyArrayBuffer(a)) {
    if (a.byteLength !== b.byteLength) return false
    const x = new Uint8Array(a)
    const y = new Uint8Array(b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  } else if (types.isSet(a)) {
    if (a.size !== b.size) return false
    const rest = []
    for (const value of a) {
      if (value !== null && typeof value === 'object') rest.push(value)
      else if (!b.has(value)) return false
    }
    const candidates = [...b].filter((value) => value !== null && typeof value === 'object')
    for (const value of rest) {
      const index = candidates.findIndex((candidate) => deepEqual(value, candidate, memo))
      if (index === -1) return false
      candidates.splice(index, 1)
    }
  } else if (types.isMap(a)) {
    if (a.size !== b.size) return false
    for (const [key, value] of a) {
      if (key !== null && typeof key === 'object') {
        const match = [...b].find(([other, otherValue]) => deepEqual(key, other, memo) && deepEqual(value, otherValue, memo))
        if (!match) return false
      } else if (!b.has(key) || !deepEqual(value, b.get(key), memo)) {
        return false
      }
    }
  } else if (types.isWeakMap(a) || types.isWeakSet(a) || types.isPromise(a)) {
    return false // identity only, like Node
  }

  const index = (key) => ArrayBuffer.isView(a) && /^(0|[1-9]\d*)$/.test(key)
  const keysA = Object.keys(a).filter((key) => !index(key))
  const keysB = Object.keys(b).filter((key) => !index(key))
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.prototype.propertyIsEnumerable.call(b, key)) return false
    if (!deepEqual(a[key], b[key], memo)) return false
  }
  const symbolsA = Object.getOwnPropertySymbols(a).filter((s) => Object.prototype.propertyIsEnumerable.call(a, s))
  const symbolsB = Object.getOwnPropertySymbols(b).filter((s) => Object.prototype.propertyIsEnumerable.call(b, s))
  if (symbolsA.length !== symbolsB.length) return false
  for (const symbol of symbolsA) if (!deepEqual(a[symbol], b[symbol], memo)) return false
  return true
}

/** Node's `util.isDeepStrictEqual(a, b)` (the comparison of `assert.deepStrictEqual`). */
export function isDeepStrictEqual(a, b) {
  return deepEqual(a, b, new Map())
}

// --- the rest ------------------------------------------------------------------------------------

export const TextEncoder = globalThis.TextEncoder
export const TextDecoder = globalThis.TextDecoder

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g

export function stripVTControlCharacters(text) {
  return String(text).replace(ANSI, '')
}

/** Node's `util.styleText(format, text)`. */
export function styleText(formatNames, text) {
  let result = String(text)
  for (const name of [formatNames].flat()) {
    const color = colors[name]
    if (!color) throw new TypeError(`The argument 'format' must be one of: ${Object.keys(colors).join(', ')}. Received '${name}'`)
    result = `\u001b[${color[0]}m${result}\u001b[${color[1]}m`
  }
  return result
}

export function toUSVString(text) {
  return String(text).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

/** Node's `util.aborted(signal, resource)`: resolves when the signal aborts. */
export function aborted(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

const ERRNO = {
  1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR', 5: 'EIO', 9: 'EBADF', 11: 'EAGAIN', 12: 'ENOMEM', 13: 'EACCES',
  16: 'EBUSY', 17: 'EEXIST', 18: 'EXDEV', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL', 24: 'EMFILE', 28: 'ENOSPC',
  30: 'EROFS', 32: 'EPIPE', 39: 'ENOTEMPTY', 40: 'ELOOP', 110: 'ETIMEDOUT', 111: 'ECONNREFUSED', 104: 'ECONNRESET',
  4058: 'ENOENT', 4092: 'EACCES', 4075: 'EEXIST', 4048: 'EPERM', 4071: 'EINVAL', 4068: 'EISDIR', 4052: 'ENOTDIR', 4051: 'ENOTEMPTY',
}

/** Node's `util.getSystemErrorName(errno)` for the common codes (Linux numbering, and libuv's Windows ones). */
export function getSystemErrorName(errno) {
  if (typeof errno !== 'number' || errno >= 0 || !Number.isInteger(errno)) {
    throw new RangeError(`The value of "err" is out of range. It must be a negative integer. Received ${errno}`)
  }
  return ERRNO[-errno] ?? `Unknown system error ${errno}`
}

// Legacy helpers, deprecated in Node but still common in older packages.
export const isArray = Array.isArray
export const isBoolean = (value) => typeof value === 'boolean'
export const isBuffer = (value) => Boolean(value?.constructor?.isBuffer?.(value))
export const isDate = types.isDate
export const isError = types.isNativeError
export const isFunction = (value) => typeof value === 'function'
export const isNull = (value) => value === null
export const isNullOrUndefined = (value) => value === null || value === undefined
export const isNumber = (value) => typeof value === 'number'
export const isObject = (value) => value !== null && typeof value === 'object'
export const isPrimitive = (value) => value === null || (typeof value !== 'object' && typeof value !== 'function')
export const isRegExp = types.isRegExp
export const isString = (value) => typeof value === 'string'
export const isSymbol = (value) => typeof value === 'symbol'
export const isUndefined = (value) => value === undefined

export function log(...args) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  console.log(`${d.getDate()} ${months[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} - ${format(...args)}`)
}

export function _extend(target, source) {
  if (source === null || typeof source !== 'object') return target
  for (const key of Object.keys(source)) target[key] = source[key]
  return target
}

const util = {
  format, formatWithOptions, inspect, promisify, callbackify, inherits, deprecate, debuglog, debug,
  isDeepStrictEqual, types, TextEncoder, TextDecoder, stripVTControlCharacters, styleText, toUSVString,
  aborted, getSystemErrorName, isArray, isBoolean, isBuffer, isDate, isError, isFunction, isNull,
  isNullOrUndefined, isNumber, isObject, isPrimitive, isRegExp, isString, isSymbol, isUndefined, log, _extend,
}

export default util
