/**
 * Node's `querystring`: `parse` / `stringify` with Node's rules (`+` is a
 * space, repeated keys become arrays, a null-prototype result, `maxKeys`).
 */
import { Buffer } from './buffer.js'

/** Like decodeURIComponent, but leaves malformed escapes as they are (as Node does). */
export function unescape(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    const bytes = []
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
        i += 2
      } else if (code < 0x80) {
        bytes.push(code)
      } else {
        bytes.push(...Buffer.from(text[i]))
      }
    }
    return Buffer.from(bytes).toString()
  }
}

export function unescapeBuffer(text) {
  return Buffer.from(unescape(text))
}

export function escape(text) {
  return encodeURIComponent(typeof text === 'string' ? text : String(text))
}

function primitive(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return ''
}

/** `querystring.parse(str, [sep], [eq], [{ maxKeys, decodeURIComponent }])`. */
export function parse(text, sep = '&', eq = '=', options = {}) {
  const result = Object.create(null)
  if (typeof text !== 'string' || text.length === 0) return result
  const decode = options.decodeURIComponent ?? unescape
  const maxKeys = options.maxKeys ?? 1000
  let pairs = text.split(sep || '&')
  if (maxKeys > 0) pairs = pairs.slice(0, maxKeys)
  for (const pair of pairs) {
    if (!pair) continue
    const index = pair.indexOf(eq || '=')
    const rawKey = index >= 0 ? pair.slice(0, index) : pair
    const rawValue = index >= 0 ? pair.slice(index + (eq || '=').length) : ''
    const key = decode(rawKey.replace(/\+/g, ' '))
    const value = decode(rawValue.replace(/\+/g, ' '))
    if (!(key in result)) result[key] = value
    else if (Array.isArray(result[key])) result[key].push(value)
    else result[key] = [result[key], value]
  }
  return result
}

/** `querystring.stringify(obj, [sep], [eq], [{ encodeURIComponent }])`. */
export function stringify(object, sep = '&', eq = '=', options = {}) {
  if (object === null || typeof object !== 'object') return ''
  const encode = options.encodeURIComponent ?? escape
  const parts = []
  for (const key of Object.keys(object)) {
    const value = object[key]
    const name = encode(primitive(key)) + (eq || '=')
    if (Array.isArray(value)) for (const item of value) parts.push(name + encode(primitive(item)))
    else parts.push(name + encode(primitive(value)))
  }
  return parts.join(sep || '&')
}

export const decode = parse
export const encode = stringify

export default { parse, stringify, escape, unescape, unescapeBuffer, decode, encode }
