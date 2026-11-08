/**
 * safeStorage. Electron encrypts with a key kept in the OS keychain
 * (Keychain, DPAPI, libsecret/kwallet). No official Tauri plugin exposes the
 * OS keychain, so encryption is reported as unavailable - exactly what
 * Electron does on a Linux system without a secret store. Apps already
 * handle that case (VS Code falls back, others warn the user).
 */
import { warnOnce } from '../internal/runtime.js'

const ENCRYPT_ERROR = 'Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.'
const DECRYPT_ERROR = 'Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.'

export const safeStorage = {
  isEncryptionAvailable() {
    return false
  },

  isAsyncEncryptionAvailable() {
    return Promise.resolve(false)
  },

  getSelectedStorageBackend() {
    return 'unknown'
  },

  setUsePlainTextEncryption() {
    warnOnce('safeStorage.setUsePlainTextEncryption', 'safeStorage.setUsePlainTextEncryption() is ignored: tauri-electron has no safeStorage backend.')
  },

  encryptString() {
    throw new Error(ENCRYPT_ERROR)
  },

  decryptString() {
    throw new Error(DECRYPT_ERROR)
  },

  encryptStringAsync() {
    return Promise.reject(new Error(ENCRYPT_ERROR))
  },

  decryptStringAsync() {
    return Promise.reject(new Error(DECRYPT_ERROR))
  },
}
