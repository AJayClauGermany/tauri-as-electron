/**
 * safeStorage, backed by tauri-plugin-electron (Cargo feature
 * `safe-storage`, on by default): AES-256-GCM in Rust with a random key kept
 * in the operating system's keychain (macOS Keychain, Windows Credential
 * Manager, the Secret Service on Linux).
 *
 * `encryptString` / `decryptString` are synchronous, as in Electron, over the
 * synchronous bridge; the `*Async` variants use commands. Main process only.
 * Without a keychain (a Linux session with no Secret Service) encryption is
 * unavailable and `getSelectedStorageBackend()` is `'basic_text'`, as in
 * Electron; `setUsePlainTextEncryption(true)` then encrypts with a key fixed
 * in tauri-plugin-electron. Ciphertext is not compatible with Electron's:
 * data encrypted by the Electron build of an app cannot be decrypted here.
 *
 * Outside Tauri, or with the feature off, encryption is reported as
 * unavailable.
 */
import { native, syncRequestBytes } from '../internal/native.js'
import { inTauri, isMainProcess, warnOnce } from '../internal/runtime.js'
import { platform } from '../process.js'

const ENCRYPT_ERROR = 'Error while encrypting the text provided to safeStorage.encryptString.'
const DECRYPT_ERROR = 'Error while decrypting the ciphertext provided to safeStorage.decryptString.'
const NOT_AVAILABLE = { encrypt: 'Encryption is not available.', decrypt: 'Decryption is not available.' }

const utf8 = new TextDecoder()
const encoder = new TextEncoder()

const toBuffer = (bytes) => (globalThis.Buffer ? globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes)

function bytesOf(value, api) {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError(`Expected the first argument of ${api}() to be a buffer`)
}

function base64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const usable = () => inTauri && isMainProcess

/** A bridge call: `{ ok, bytes }`, or `{ ok: false, unavailable, message }`. */
function bridge(op, { query, body } = {}) {
  if (!usable()) return { ok: false, unavailable: true }
  let response
  try {
    response = syncRequestBytes(`safe-storage/${op}`, { query, body })
  } catch {
    return { ok: false, unavailable: true } // no tauri-plugin-electron
  }
  if (response.status === 200) return { ok: true, bytes: response.bytes }
  // 404: a plugin that predates safeStorage; 501: the feature is off.
  return { ok: false, unavailable: response.status === 404 || response.status === 501, message: utf8.decode(response.bytes) }
}

let keychainReady = false

function status() {
  // Once the keychain has answered with a key, that does not change.
  if (keychainReady) return { available: true, backend: platform === 'linux' ? 'gnome_libsecret' : 'unknown' }
  const answer = bridge('status')
  if (!answer.ok) return { available: false, backend: 'unknown' }
  const value = JSON.parse(utf8.decode(answer.bytes))
  keychainReady = Boolean(value.available && !value.error)
  return value
}

function failure(prefix, kind, answer) {
  return new Error(`${prefix} ${answer.unavailable || !answer.message ? NOT_AVAILABLE[kind] : answer.message}`)
}

export const safeStorage = {
  isEncryptionAvailable() {
    return Boolean(status().available)
  },

  async isAsyncEncryptionAvailable() {
    if (!usable()) return false
    try {
      return Boolean((await native('safe_storage_status')).available)
    } catch {
      return false
    }
  },

  /** Linux only, like Electron: `gnome_libsecret` with a Secret Service, else `basic_text`. */
  getSelectedStorageBackend() {
    return platform === 'linux' ? status().backend : 'unknown'
  },

  /** Linux only: without a keychain, encrypt with a fixed key instead of failing. */
  setUsePlainTextEncryption(usePlainText) {
    if (platform !== 'linux') return
    const answer = bridge('plain-text', { query: `on=${Boolean(usePlainText)}` })
    if (!answer.ok && !answer.unavailable) warnOnce('safeStorage.setUsePlainTextEncryption', `safeStorage.setUsePlainTextEncryption() failed: ${answer.message}`)
  },

  encryptString(plainText) {
    if (typeof plainText !== 'string') throw new TypeError('Expected the first argument of encryptString() to be a string')
    const answer = bridge('encrypt', { body: encoder.encode(plainText) })
    if (!answer.ok) throw failure(ENCRYPT_ERROR, 'encrypt', answer)
    return toBuffer(answer.bytes)
  },

  decryptString(encrypted) {
    const answer = bridge('decrypt', { body: bytesOf(encrypted, 'decryptString') })
    if (!answer.ok) throw failure(DECRYPT_ERROR, 'decrypt', answer)
    return utf8.decode(answer.bytes)
  },

  async encryptStringAsync(plainText) {
    if (typeof plainText !== 'string') throw new TypeError('Expected the first argument of encryptStringAsync() to be a string')
    if (!usable()) throw failure(ENCRYPT_ERROR, 'encrypt', { unavailable: true })
    let result
    try {
      result = await native('safe_storage_encrypt', { text: plainText })
    } catch (error) {
      throw failure(ENCRYPT_ERROR, 'encrypt', { message: String(error?.message ?? error) })
    }
    return toBuffer(result instanceof ArrayBuffer ? new Uint8Array(result) : Uint8Array.from(result))
  },

  /** Resolves with `{ shouldReEncrypt, result }`, as in Electron. */
  async decryptStringAsync(encrypted) {
    const bytes = bytesOf(encrypted, 'decryptStringAsync')
    if (!usable()) throw failure(DECRYPT_ERROR, 'decrypt', { unavailable: true })
    try {
      return { shouldReEncrypt: false, result: await native('safe_storage_decrypt', { data: base64(bytes) }) }
    } catch (error) {
      throw failure(DECRYPT_ERROR, 'decrypt', { message: String(error?.message ?? error) })
    }
  },
}
