/**
 * What `better-sqlite3` and `sqlite3` share: the database operations of
 * tauri-plugin-electron's `sqlite` feature (`node/sqlite/<op>` on the
 * synchronous bridge, the `sqlite` command for the asynchronous API), and
 * how values cross (see sqlite.rs): numbers are REALs, `{ $i }` INTEGERs,
 * `{ $b }` BLOBs (base64), `{ $f }` the REALs JSON cannot carry.
 */
import { Buffer } from '../node/buffer.js'
import processShim from '../process.js'
import { callSync, callAsync, rawAnswer } from './common.js'

export const BIND_TYPES = 'SQLite3 can only bind numbers, strings, bigints, buffers, and null'

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/**
 * A JavaScript value in the wire form. `strict`: better-sqlite3's rules
 * (numbers are REALs; booleans, dates and objects are refused); otherwise
 * node-sqlite3's (integers are INTEGERs, booleans 1 / 0, dates their time,
 * other objects their string).
 */
export function encodeValue(value, { strict = true, message = BIND_TYPES } = {}) {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
      if (!strict && Number.isSafeInteger(value)) return { $i: String(value) }
      return Number.isFinite(value) ? value : { $f: String(value) }
    case 'bigint':
      if (value < INT64_MIN || value > INT64_MAX) {
        throw new RangeError('The bound BigInt is too large to be represented as a 64-bit signed integer')
      }
      return { $i: value.toString() }
    case 'boolean':
      if (!strict) return { $i: value ? '1' : '0' }
      break
    default:
      break
  }
  if (ArrayBuffer.isView(value)) return { $b: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (!strict) {
    if (value instanceof ArrayBuffer) return { $b: Buffer.from(value).toString('base64') }
    if (value instanceof Date) return value.getTime()
    return String(value)
  }
  throw new TypeError(message)
}

/** A wire value in JavaScript: INTEGERs as BigInts when `safe`, BLOBs as Buffers. */
export function decodeValue(value, safe = false) {
  if (value === null || typeof value !== 'object') return value
  if ('$i' in value) return safe ? BigInt(value.$i) : Number(value.$i)
  if ('$b' in value) return Buffer.from(value.$b, 'base64')
  if ('$f' in value) return Number(value.$f)
  return value
}

/** Where a database file is: relative paths are relative to `process.cwd()`, as in Node. */
export function resolveFilename(filename) {
  if (filename === '' || filename === ':memory:' || filename.startsWith('file:')) return filename
  if (filename.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filename) || filename.startsWith('\\\\')) return filename
  const cwd = processShim.cwd()
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${filename}`
}

/** A blocking database operation (better-sqlite3). */
export function sqliteSync(api, pkg, op, request, toError, binary = false) {
  return callSync({ api, pkg, module: 'sqlite', op, request, binary, toError })
}

/** The same operation off the main thread (sqlite3, backups). */
export async function sqliteAsync(api, pkg, op, request, toError, binary = false) {
  const answer = await callAsync({ api, pkg, command: 'sqlite', args: { request: { ...request, op } }, toError })
  return rawAnswer(answer, binary)
}
