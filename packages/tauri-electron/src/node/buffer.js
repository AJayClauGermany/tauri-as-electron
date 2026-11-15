/**
 * Node's `buffer` module, from the `buffer` npm package (the implementation
 * browserify and webpack 4 used): `Buffer` is a Uint8Array subclass, so it
 * crosses IPC as bytes like in Electron.
 *
 * Imported as `buffer/index.js` so that the bundler aliases for the bare
 * `buffer` specifier (which point here) do not apply to it.
 */
import bufferPackage from 'buffer/index.js'

export const { Buffer, SlowBuffer, INSPECT_MAX_BYTES } = bufferPackage
export const kMaxLength = bufferPackage.kMaxLength
export const kStringMaxLength = 2 ** 29 - 24
export const constants = Object.freeze({ MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength })

// Web platform classes Node also exports from `buffer`.
export const Blob = globalThis.Blob
export const File = globalThis.File
export const atob = (...args) => globalThis.atob(...args)
export const btoa = (...args) => globalThis.btoa(...args)

const bytesOf = (input) => {
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  throw new TypeError('The "input" argument must be an instance of ArrayBuffer, Buffer, TypedArray or DataView.')
}

export function isUtf8(input) {
  const bytes = bytesOf(input)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

export function isAscii(input) {
  return bytesOf(input).every((byte) => byte < 0x80)
}

export function transcode(source, fromEncoding, toEncoding) {
  return Buffer.from(Buffer.from(source).toString(fromEncoding), toEncoding)
}

const buffer = {
  Buffer,
  SlowBuffer,
  INSPECT_MAX_BYTES,
  kMaxLength,
  kStringMaxLength,
  constants,
  Blob,
  File,
  atob,
  btoa,
  isUtf8,
  isAscii,
  transcode,
}

export default buffer
