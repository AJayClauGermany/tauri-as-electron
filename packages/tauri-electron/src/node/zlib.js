/**
 * Node's `zlib` for gzip, zlib (deflate) and raw deflate, from fflate:
 * `*Sync` functions, callback forms, and `createGzip()` & co. as Transform
 * streams. Formats are standard, so data round-trips with real Node and
 * other tools. Errors carry Node's codes (`Z_DATA_ERROR`, `Z_BUF_ERROR`).
 *
 * Not available: Brotli (no browser or fflate implementation) and
 * dictionaries. The callback forms compress on the main thread (deferred to
 * a macrotask), not on a thread pool.
 */
import * as fflate from 'fflate'
import { NotImplementedError } from '../internal/runtime.js'
import { Buffer } from './buffer.js'
import { Transform } from './stream.js'

export const constants = Object.freeze({
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
  Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, ZLIB_VERNUM: 4865,
  DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7,
  Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
})

const looksLikeGzip = (bytes) => bytes?.[0] === 0x1f && bytes?.[1] === 0x8b && bytes?.[2] === 8

/**
 * fflate's error → Node's zlib error. fflate reports truncated gzip data as
 * a bad header; with the gzip magic intact it is a truncation, as Node says.
 */
function zlibError(error, bytes) {
  if (typeof error?.code !== 'number') return error
  const truncated = error.code === 0 || (error.code === 6 && looksLikeGzip(bytes))
  const [message, code, errno] =
    truncated ? ['unexpected end of file', 'Z_BUF_ERROR', -5]
      : error.code === 6 ? ['incorrect header check', 'Z_DATA_ERROR', -3]
        : [error.message, 'Z_DATA_ERROR', -3]
  return Object.assign(new Error(message), { code, errno })
}

function input(data) {
  if (typeof data === 'string') return Buffer.from(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const error = new TypeError('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer.')
  error.code = 'ERR_INVALID_ARG_TYPE'
  throw error
}

function compressOptions(options = {}) {
  const out = {}
  if (options.level !== undefined && options.level !== -1) out.level = options.level
  if (options.memLevel !== undefined) out.mem = options.memLevel
  return out
}

const toBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** Raw deflate, zlib and gzip data alike, as Node's unzip handles gzip and zlib. */
function decompressAny(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return fflate.gunzipSync(bytes)
  return fflate.unzlibSync(bytes)
}

const SYNC = {
  gzip: (bytes, options) => fflate.gzipSync(bytes, compressOptions(options)),
  gunzip: (bytes) => fflate.gunzipSync(bytes),
  deflate: (bytes, options) => fflate.zlibSync(bytes, compressOptions(options)),
  inflate: (bytes) => fflate.unzlibSync(bytes),
  deflateRaw: (bytes, options) => fflate.deflateSync(bytes, compressOptions(options)),
  inflateRaw: (bytes) => fflate.inflateSync(bytes),
  unzip: (bytes) => decompressAny(bytes),
}

function runSync(name, data, options) {
  const bytes = input(data)
  try {
    return toBuffer(SYNC[name](bytes, options))
  } catch (error) {
    throw zlibError(error, bytes)
  }
}

export const gzipSync = (data, options) => runSync('gzip', data, options)
export const gunzipSync = (data, options) => runSync('gunzip', data, options)
export const deflateSync = (data, options) => runSync('deflate', data, options)
export const inflateSync = (data, options) => runSync('inflate', data, options)
export const deflateRawSync = (data, options) => runSync('deflateRaw', data, options)
export const inflateRawSync = (data, options) => runSync('inflateRaw', data, options)
export const unzipSync = (data, options) => runSync('unzip', data, options)

function callbackForm(name) {
  return (data, options, callback) => {
    if (typeof options === 'function') [callback, options] = [options, {}]
    if (typeof callback !== 'function') {
      const error = new TypeError('The "callback" argument must be of type function')
      error.code = 'ERR_INVALID_ARG_TYPE'
      throw error
    }
    setTimeout(() => {
      let result
      try {
        result = runSync(name, data, options)
      } catch (error) {
        return callback(error)
      }
      callback(null, result)
    }, 0)
  }
}

export const gzip = callbackForm('gzip')
export const gunzip = callbackForm('gunzip')
export const deflate = callbackForm('deflate')
export const inflate = callbackForm('inflate')
export const deflateRaw = callbackForm('deflateRaw')
export const inflateRaw = callbackForm('inflateRaw')
export const unzip = callbackForm('unzip')

// util.promisify(zlib.gzip) and friends work through the plain callback signature.

// --- streams -------------------------------------------------------------------------------------

const STREAMS = {
  Gzip: (options, ondata) => new fflate.Gzip(compressOptions(options), ondata),
  Gunzip: (_options, ondata) => new fflate.Gunzip(ondata),
  Deflate: (options, ondata) => new fflate.Zlib(compressOptions(options), ondata),
  Inflate: (_options, ondata) => new fflate.Unzlib(ondata),
  DeflateRaw: (options, ondata) => new fflate.Deflate(compressOptions(options), ondata),
  InflateRaw: (_options, ondata) => new fflate.Inflate(ondata),
  Unzip: (_options, ondata) => new fflate.Decompress(ondata),
}

function streamClass(name) {
  const Stream = class extends Transform {
    constructor(options = {}) {
      super(options)
      this.bytesWritten = 0
      this._engine = STREAMS[name](options, (chunk) => {
        if (chunk.length) this.push(toBuffer(chunk))
      })
    }

    _transform(chunk, encoding, callback) {
      const bytes = input(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk)
      this.bytesWritten += bytes.length
      try {
        this._engine.push(bytes, false)
      } catch (error) {
        return callback(zlibError(error))
      }
      callback()
    }

    _flush(callback) {
      try {
        this._engine.push(new Uint8Array(0), true)
      } catch (error) {
        return callback(zlibError(error))
      }
      callback()
    }

    /** fflate flushes on its own block boundaries; an explicit flush is a no-op. */
    flush(kind, callback) {
      if (typeof kind === 'function') callback = kind
      if (callback) queueMicrotask(callback)
    }

    params(level, strategy, callback) {
      if (callback) queueMicrotask(callback)
    }

    close(callback) {
      if (callback) this.once('close', callback)
      this.destroy()
    }
  }
  Object.defineProperty(Stream, 'name', { value: name })
  return Stream
}

export const Gzip = streamClass('Gzip')
export const Gunzip = streamClass('Gunzip')
export const Deflate = streamClass('Deflate')
export const Inflate = streamClass('Inflate')
export const DeflateRaw = streamClass('DeflateRaw')
export const InflateRaw = streamClass('InflateRaw')
export const Unzip = streamClass('Unzip')

export const createGzip = (options) => new Gzip(options)
export const createGunzip = (options) => new Gunzip(options)
export const createDeflate = (options) => new Deflate(options)
export const createInflate = (options) => new Inflate(options)
export const createDeflateRaw = (options) => new DeflateRaw(options)
export const createInflateRaw = (options) => new InflateRaw(options)
export const createUnzip = (options) => new Unzip(options)

// --- crc32 and Brotli ------------------------------------------------------------------------------

let crcTable = null

/** Node's `zlib.crc32(data, [value])`. */
export function crc32(data, value = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  const bytes = input(data)
  let crc = (value ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function brotli(name) {
  return () => {
    throw new NotImplementedError(`zlib.${name}`, { reason: 'unsupported', hint: 'Brotli has no implementation in the webview or in fflate: use gzip or deflate.' })
  }
}

export const brotliCompress = brotli('brotliCompress')
export const brotliCompressSync = brotli('brotliCompressSync')
export const brotliDecompress = brotli('brotliDecompress')
export const brotliDecompressSync = brotli('brotliDecompressSync')
export const createBrotliCompress = brotli('createBrotliCompress')
export const createBrotliDecompress = brotli('createBrotliDecompress')

const zlib = {
  constants, gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync, unzipSync,
  gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip, Gzip, Gunzip, Deflate, Inflate, DeflateRaw,
  InflateRaw, Unzip, createGzip, createGunzip, createDeflate, createInflate, createDeflateRaw, createInflateRaw,
  createUnzip, crc32, brotliCompress, brotliCompressSync, brotliDecompress, brotliDecompressSync,
  createBrotliCompress, createBrotliDecompress,
}

export default zlib
