/**
 * Node's `crypto`, the part a webview can provide synchronously:
 *
 * - hashes and HMAC (`createHash`, `createHmac`, `hash`), PBKDF2, HKDF and
 *   scrypt, from @noble/hashes (pure JavaScript: Web Crypto is async-only,
 *   and these are synchronous in Node);
 * - random values (`randomBytes`, `randomFill`, `randomInt`, `randomUUID`,
 *   `getRandomValues`) and `webcrypto` / `subtle` from the Web Crypto API;
 * - `timingSafeEqual`, `getHashes`.
 *
 * Ciphers, signatures, key pairs and Diffie-Hellman throw NotImplementedError
 * (reason `unimplemented`): use `crypto.subtle` meanwhile.
 */
import { md5, sha1, ripemd160 } from '@noble/hashes/legacy.js'
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from '@noble/hashes/sha2.js'
import { sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from '@noble/hashes/sha3.js'
import { hmac } from '@noble/hashes/hmac.js'
import { pbkdf2 as noblePbkdf2, pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js'
import { scrypt as nobleScrypt, scryptAsync } from '@noble/hashes/scrypt.js'
import { NotImplementedError } from '../internal/runtime.js'
import { Buffer } from './buffer.js'
import { Transform } from './stream.js'

const ALGORITHMS = {
  md5, sha1, ripemd160, rmd160: ripemd160, sha224, sha256, sha384, sha512,
  'sha512-224': sha512_224, 'sha512-256': sha512_256,
  'sha3-224': sha3_224, 'sha3-256': sha3_256, 'sha3-384': sha3_384, 'sha3-512': sha3_512,
  shake128, shake256,
}

function codedError(Ctor, code, message) {
  const error = new Ctor(message)
  error.code = code
  return error
}

/** The noble hash for a Node algorithm name (`'SHA256'`, `'sha-256'`, `'RSA-SHA256'`). */
function algorithm(name) {
  if (typeof name !== 'string') throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "algorithm" argument must be of type string. Received ${typeof name}`)
  const key = name.toLowerCase().replace(/^rsa-/, '').replace(/^sha-(\d)/, 'sha$1')
  const hash = ALGORITHMS[key]
  if (!hash) throw codedError(Error, 'ERR_OSSL_EVP_UNSUPPORTED', 'Digest method not supported')
  return hash
}

/** string / Buffer / TypedArray / DataView / ArrayBuffer → bytes. */
function bytes(data, encoding, name = 'data') {
  if (typeof data === 'string') return Buffer.from(data, encoding && encoding !== 'buffer' ? encoding : 'utf8')
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${data === null ? 'null' : typeof data}`)
}

function output(digest, encoding) {
  const buffer = Buffer.from(digest.buffer, digest.byteOffset, digest.byteLength)
  return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer
}

const finalized = () => codedError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called')

/** Node's Hash: `update()` / `digest()`, and a Transform stream (write data, read the digest). */
export class Hash extends Transform {
  constructor(name, options = {}) {
    super(options)
    const hash = algorithm(name)
    this._state = hash.create(options.outputLength ? { dkLen: options.outputLength } : undefined)
    this._done = false
  }

  update(data, inputEncoding) {
    if (this._done) throw finalized()
    this._state.update(bytes(data, inputEncoding))
    return this
  }

  digest(encoding) {
    if (this._done) throw finalized()
    this._done = true
    return output(this._state.digest(), encoding)
  }

  copy() {
    if (this._done) throw finalized()
    const copy = Object.create(Hash.prototype)
    Transform.call(copy)
    copy._state = this._state.clone()
    copy._done = false
    return copy
  }

  _transform(chunk, encoding, callback) {
    this._state.update(bytes(chunk, encoding))
    callback()
  }

  _flush(callback) {
    this.push(this.digest())
    callback()
  }
}

/** Node's Hmac. */
export class Hmac extends Transform {
  constructor(name, key, options = {}) {
    super(options)
    if (key && typeof key === 'object' && key.type === 'secret' && typeof key.export === 'function') key = key.export()
    this._state = hmac.create(algorithm(name), bytes(key, options.encoding, 'key'))
    this._done = false
  }

  update(data, inputEncoding) {
    if (this._done) throw finalized()
    this._state.update(bytes(data, inputEncoding))
    return this
  }

  digest(encoding) {
    if (this._done) throw finalized()
    this._done = true
    return output(this._state.digest(), encoding)
  }

  _transform(chunk, encoding, callback) {
    this._state.update(bytes(chunk, encoding))
    callback()
  }

  _flush(callback) {
    this.push(this.digest())
    callback()
  }
}

export const createHash = (name, options) => new Hash(name, options)
export const createHmac = (name, key, options) => new Hmac(name, key, options)

/** Node's one-shot `crypto.hash(algorithm, data, outputEncoding = 'hex')`. */
export function hash(name, data, outputEncoding = 'hex') {
  return output(algorithm(name)(bytes(data)), outputEncoding)
}

export function getHashes() {
  return ['md5', 'ripemd160', 'rmd160', 'sha1', 'sha224', 'sha256', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'shake128', 'shake256']
}

export const getCiphers = () => []
export const getCurves = () => []

// --- random values ---------------------------------------------------------------------------------

export const webcrypto = globalThis.crypto
export const subtle = globalThis.crypto?.subtle

export function getRandomValues(array) {
  return globalThis.crypto.getRandomValues(array)
}

/** Fill a view in chunks: getRandomValues takes at most 65536 bytes at a time. */
function fillRandom(view) {
  for (let offset = 0; offset < view.length; offset += 65536) {
    globalThis.crypto.getRandomValues(view.subarray(offset, Math.min(view.length, offset + 65536)))
  }
  return view
}

function checkSize(size, name = 'size') {
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > 2 ** 31 - 1) {
    throw codedError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be >= 0 && <= 2147483647. Received ${size}`)
  }
}

const later = (fn) => setTimeout(fn, 0)

/** `crypto.randomBytes(size, [callback])`. */
export function randomBytes(size, callback) {
  checkSize(size)
  const buffer = Buffer.alloc(size)
  fillRandom(buffer)
  if (typeof callback === 'function') {
    later(() => callback(null, buffer))
    return undefined
  }
  return buffer
}
export const pseudoRandomBytes = randomBytes
export const prng = randomBytes
export const rng = randomBytes

/** `crypto.randomFillSync(buffer, [offset], [size])`. */
export function randomFillSync(buffer, offset = 0, size) {
  const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const length = size ?? view.length - offset
  checkSize(offset, 'offset')
  checkSize(length)
  fillRandom(view.subarray(offset, offset + length))
  return buffer
}

/** `crypto.randomFill(buffer, [offset], [size], callback)`. */
export function randomFill(buffer, ...rest) {
  const callback = rest.pop()
  if (typeof callback !== 'function') throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function')
  let result
  try {
    result = randomFillSync(buffer, ...rest)
  } catch (error) {
    later(() => callback(error))
    return
  }
  later(() => callback(null, result))
}

/** `crypto.randomInt([min,] max, [callback])`: uniform, without modulo bias. */
export function randomInt(min, max, callback) {
  if (max === undefined || typeof max === 'function') {
    callback = max
    max = min
    min = 0
  }
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min || max - min > 2 ** 48) {
    throw codedError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "max" is out of range. It must be greater than the value of "min" (${min}) and the range must be at most 2**48. Received ${max}`)
  }
  const range = max - min
  const limit = 2 ** 48 - (2 ** 48 % range)
  let value
  do {
    const b = fillRandom(new Uint8Array(6))
    value = b.reduce((acc, byte) => acc * 256 + byte, 0)
  } while (value >= limit)
  const result = min + (value % range)
  if (typeof callback === 'function') {
    later(() => callback(null, result))
    return undefined
  }
  return result
}

/** `crypto.randomUUID()`: a version 4 UUID. */
export function randomUUID() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const b = fillRandom(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `crypto.timingSafeEqual(a, b)`. */
export function timingSafeEqual(a, b) {
  const x = bytes(a, undefined, 'buf1')
  const y = bytes(b, undefined, 'buf2')
  if (x.byteLength !== y.byteLength) throw codedError(RangeError, 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', 'Input buffers must have the same byte length')
  let difference = 0
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i]
  return difference === 0
}

// --- key derivation ------------------------------------------------------------------------------

/** `crypto.pbkdf2Sync(password, salt, iterations, keylen, digest)`. */
export function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  return output(noblePbkdf2(algorithm(digest), bytes(password, undefined, 'password'), bytes(salt, undefined, 'salt'), { c: iterations, dkLen: keylen }))
}

/** `crypto.pbkdf2(password, salt, iterations, keylen, digest, callback)`. */
export function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  if (typeof callback !== 'function') throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function')
  Promise.resolve()
    .then(() => pbkdf2Async(algorithm(digest), bytes(password, undefined, 'password'), bytes(salt, undefined, 'salt'), { c: iterations, dkLen: keylen }))
    .then((key) => later(() => callback(null, output(key))), (error) => later(() => callback(error)))
}

/** `crypto.hkdfSync(digest, ikm, salt, info, keylen)`: an ArrayBuffer, as in Node. */
export function hkdfSync(digest, ikm, salt, info, keylen) {
  const key = nobleHkdf(algorithm(digest), bytes(ikm, undefined, 'ikm'), bytes(salt, undefined, 'salt'), bytes(info, undefined, 'info'), keylen)
  return key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength)
}

export function hkdf(digest, ikm, salt, info, keylen, callback) {
  let result
  try {
    result = hkdfSync(digest, ikm, salt, info, keylen)
  } catch (error) {
    later(() => callback(error))
    return
  }
  later(() => callback(null, result))
}

function scryptOptions(keylen, options = {}) {
  return {
    N: options.N ?? options.cost ?? 16384,
    r: options.r ?? options.blockSize ?? 8,
    p: options.p ?? options.parallelization ?? 1,
    maxmem: options.maxmem ?? 32 * 1024 * 1024,
    dkLen: keylen,
  }
}

/** `crypto.scryptSync(password, salt, keylen, [options])`. */
export function scryptSync(password, salt, keylen, options) {
  return output(nobleScrypt(bytes(password, undefined, 'password'), bytes(salt, undefined, 'salt'), scryptOptions(keylen, options)))
}

/** `crypto.scrypt(password, salt, keylen, [options], callback)`. */
export function scrypt(password, salt, keylen, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  Promise.resolve()
    .then(() => scryptAsync(bytes(password, undefined, 'password'), bytes(salt, undefined, 'salt'), scryptOptions(keylen, options)))
    .then((key) => later(() => callback(null, output(key))), (error) => later(() => callback(error)))
}

// --- not implemented yet ---------------------------------------------------------------------------

function notYet(name) {
  return () => {
    throw new NotImplementedError(`crypto.${name}`, { reason: 'unimplemented', hint: 'Ciphers, signatures and key pairs are not implemented yet: use crypto.subtle (Web Crypto) meanwhile.' })
  }
}

export const createCipheriv = notYet('createCipheriv')
export const createDecipheriv = notYet('createDecipheriv')
export const createSign = notYet('createSign')
export const createVerify = notYet('createVerify')
export const sign = notYet('sign')
export const verify = notYet('verify')
export const generateKeyPair = notYet('generateKeyPair')
export const generateKeyPairSync = notYet('generateKeyPairSync')
export const generateKey = notYet('generateKey')
export const generateKeySync = notYet('generateKeySync')
export const createSecretKey = notYet('createSecretKey')
export const createPublicKey = notYet('createPublicKey')
export const createPrivateKey = notYet('createPrivateKey')
export const publicEncrypt = notYet('publicEncrypt')
export const privateDecrypt = notYet('privateDecrypt')
export const privateEncrypt = notYet('privateEncrypt')
export const publicDecrypt = notYet('publicDecrypt')
export const createECDH = notYet('createECDH')
export const createDiffieHellman = notYet('createDiffieHellman')
export const getDiffieHellman = notYet('getDiffieHellman')
export const diffieHellman = notYet('diffieHellman')

export const constants = Object.freeze({})

const crypto = {
  Hash, Hmac, createHash, createHmac, hash, getHashes, getCiphers, getCurves, webcrypto, subtle, getRandomValues,
  randomBytes, pseudoRandomBytes, prng, rng, randomFillSync, randomFill, randomInt, randomUUID, timingSafeEqual,
  pbkdf2Sync, pbkdf2, hkdfSync, hkdf, scryptSync, scrypt, createCipheriv, createDecipheriv, createSign,
  createVerify, sign, verify, generateKeyPair, generateKeyPairSync, generateKey, generateKeySync, createSecretKey,
  createPublicKey, createPrivateKey, publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt, createECDH,
  createDiffieHellman, getDiffieHellman, diffieHellman, constants,
}

export default crypto
