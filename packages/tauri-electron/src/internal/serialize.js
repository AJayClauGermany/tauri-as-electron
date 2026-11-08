/**
 * Structured-clone-like serialization over JSON.
 *
 * Electron IPC uses the structured clone algorithm, so apps send
 * `Uint8Array`s, `Date`s, `Map`s, `Error`s, `undefined` inside arrays, ...
 * Tauri events carry JSON. `encode` turns a value into JSON-safe data with
 * tagged objects for the types JSON cannot express, `decode` reverses it.
 *
 * Like structured clone: functions and symbols throw "An object could not be
 * cloned.", class instances arrive as plain objects, and Node `Buffer`s
 * arrive as `Uint8Array`s. Unlike it: object identity / cycles are not kept
 * (a cycle throws).
 */
const TAG = '$te'

const TYPED_ARRAYS = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
}

export function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function cloneError() {
  const error = new Error('An object could not be cloned.')
  error.name = 'DataCloneError'
  return error
}

export function encode(value, seen = new Set()) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (Number.isNaN(value)) return { [TAG]: 'num', v: 'NaN' }
      if (value === Infinity) return { [TAG]: 'num', v: 'Infinity' }
      if (value === -Infinity) return { [TAG]: 'num', v: '-Infinity' }
      if (Object.is(value, -0)) return { [TAG]: 'num', v: '-0' }
      return value
    case 'undefined':
      return { [TAG]: 'undef' }
    case 'bigint':
      return { [TAG]: 'bigint', v: value.toString() }
    case 'function':
    case 'symbol':
      throw cloneError()
  }
  if (value === null) return null
  if (seen.has(value)) throw cloneError()
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => encode(item, seen))
    if (value instanceof Date) return { [TAG]: 'date', v: value.getTime() }
    if (value instanceof RegExp) return { [TAG]: 're', s: value.source, f: value.flags }
    if (value instanceof ArrayBuffer) return { [TAG]: 'ab', v: bytesToBase64(new Uint8Array(value)) }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      // Node's Buffer (a Uint8Array subclass) arrives as a Uint8Array, like in Electron.
      const kind = value instanceof DataView ? 'DataView' : Object.keys(TYPED_ARRAYS).find((k) => value instanceof TYPED_ARRAYS[k]) ?? 'Uint8Array'
      return { [TAG]: 'ta', k: kind, v: bytesToBase64(bytes) }
    }
    if (value instanceof Map) return { [TAG]: 'map', v: [...value].map(([k, v]) => [encode(k, seen), encode(v, seen)]) }
    if (value instanceof Set) return { [TAG]: 'set', v: [...value].map((v) => encode(v, seen)) }
    if (value instanceof Error) {
      return { [TAG]: 'err', name: value.name, message: value.message, stack: value.stack, cause: value.cause === undefined ? undefined : encode(value.cause, seen) }
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) throw cloneError()
    const out = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (typeof item === 'function' || typeof item === 'symbol') throw cloneError()
      out[key] = encode(item, seen)
    }
    return TAG in out ? { [TAG]: 'obj', v: out } : out
  } finally {
    seen.delete(value)
  }
}

export function decode(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  const tag = value[TAG]
  if (tag === undefined) {
    const out = {}
    for (const key of Object.keys(value)) out[key] = decode(value[key])
    return out
  }
  switch (tag) {
    case 'undef': return undefined
    case 'num': return Number(value.v)
    case 'bigint': return BigInt(value.v)
    case 'date': return new Date(value.v)
    case 're': return new RegExp(value.s, value.f)
    case 'ab': return base64ToBytes(value.v).buffer
    case 'ta': {
      const bytes = base64ToBytes(value.v)
      if (value.k === 'DataView') return new DataView(bytes.buffer)
      const Ctor = TYPED_ARRAYS[value.k] ?? Uint8Array
      return new Ctor(bytes.buffer, 0, bytes.byteLength / (Ctor.BYTES_PER_ELEMENT ?? 1))
    }
    case 'map': return new Map(value.v.map(([k, v]) => [decode(k), decode(v)]))
    case 'set': return new Set(value.v.map(decode))
    case 'err': {
      const error = new Error(value.message)
      error.name = value.name
      if (value.stack) error.stack = value.stack
      if (value.cause !== undefined) error.cause = decode(value.cause)
      return error
    }
    case 'obj': {
      const out = {}
      for (const key of Object.keys(value.v)) out[key] = decode(value.v[key])
      return out
    }
    default: return value
  }
}

/** Encode a list of IPC arguments. */
export const encodeArgs = (args) => encode(args ?? [])
export const decodeArgs = (args) => (Array.isArray(args) ? decode(args) : [])
