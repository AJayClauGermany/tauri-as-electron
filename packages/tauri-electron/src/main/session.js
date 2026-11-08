/**
 * session: a partial Electron Session per partition.
 *
 * Tauri's webview options cover the storage side of a partition (an
 * incognito webview for in-memory partitions, a separate data store for
 * `persist:` partitions on macOS) and `clearAllBrowsingData()`. Request
 * interception (webRequest), cookies and downloads have no JavaScript API in
 * Tauri: listeners are stored but never called, cookie access rejects.
 */
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError, report, warnOnce } from '../internal/runtime.js'
import { platform } from '../process.js'
import { netFetch } from './net.js'
import { protocol } from './protocol.js'
import { BrowserWindow } from './browser-window.js'

const WEB_REQUEST_EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred',
]

class WebRequest {
  constructor() {
    this._listeners = {}
    for (const name of WEB_REQUEST_EVENTS) {
      this[name] = (filterOrListener, maybeListener) => {
        const listener = maybeListener === undefined ? filterOrListener : maybeListener
        if (listener) warnOnce(`webRequest.${name}`, `session.webRequest.${name}() listeners are stored but never called: Tauri cannot intercept webview requests from JavaScript.`)
        this._listeners[name] = listener ?? null
      }
    }
  }
}

class Cookies extends EventEmitter {
  get() {
    return Promise.reject(new NotImplementedError('session.cookies.get'))
  }

  set() {
    return Promise.reject(new NotImplementedError('session.cookies.set'))
  }

  remove() {
    return Promise.reject(new NotImplementedError('session.cookies.remove'))
  }

  flushStore() {
    return Promise.resolve()
  }
}

/** 16 deterministic bytes (UUID v4 layout) for WKWebsiteDataStore(forIdentifier:). */
export function dataStoreIdentifier(name) {
  const bytes = new Array(16)
  // Four independent FNV-1a passes, 4 bytes each.
  for (let pass = 0; pass < 4; pass++) {
    let hash = 0x811c9dc5 ^ (pass * 0x9e3779b9)
    for (const char of `tauri-electron:${name}`) {
      hash ^= char.codePointAt(0)
      hash = Math.imul(hash, 0x01000193)
    }
    for (let i = 0; i < 4; i++) bytes[pass * 4 + i] = (hash >>> (i * 8)) & 0xff
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes
}

/**
 * Tauri WebviewWindow options for an Electron partition.
 * - '' (default session): nothing.
 * - 'name' (in-memory): `incognito`.
 * - 'persist:name': a separate data store on macOS (>= 14). Elsewhere Tauri
 *   only allows per-window data directories from JavaScript, which would not
 *   be shared between windows, so the default store is used.
 */
export function partitionWebviewOptions(partition, onPlatform = platform) {
  if (!partition) return {}
  if (!partition.startsWith('persist:')) return { incognito: true }
  if (onPlatform === 'darwin') return { dataStoreIdentifier: dataStoreIdentifier(partition.slice('persist:'.length)) }
  warnOnce('persist-partition', `Partition '${partition}' shares the default data store: Tauri only sets per-window data directories from JavaScript on ${onPlatform}.`)
  return {}
}

export class Session extends EventEmitter {
  constructor(partition = '', options = {}) {
    super()
    this._partition = partition
    this._options = { ...options }
    this._userAgent = undefined
    this._acceptLanguages = undefined
    this._spellCheckerLanguages = [typeof navigator !== 'undefined' ? navigator.language : 'en-US']
    this._spellCheckerEnabled = true
    this._dictionary = new Set()
    this._preloads = []
    this._handlers = {}
    this._downloadPath = ''
    this.webRequest = new WebRequest()
    this.cookies = new Cookies()
    this.protocol = protocol
    this.serviceWorkers = new EventEmitter()
    this.extensions = {
      loadExtension: () => Promise.reject(new NotImplementedError('session.extensions.loadExtension')),
      removeExtension() {},
      getExtension: () => null,
      getAllExtensions: () => [],
    }
    this.netLog = { startLogging: () => Promise.reject(new NotImplementedError('session.netLog')), stopLogging: () => Promise.resolve(), currentlyLogging: false }
    this.availableSpellCheckerLanguages = typeof navigator !== 'undefined' ? [...(navigator.languages ?? [navigator.language])] : ['en-US']
  }

  /** Tauri WebviewWindow options for windows using this session. */
  _tauriWebviewOptions() {
    const options = partitionWebviewOptions(this._partition)
    if (this._userAgent) options.userAgent = this._userAgent
    return options
  }

  isPersistent() {
    return this._partition === '' || this._partition.startsWith('persist:')
  }

  get storagePath() {
    return this.isPersistent() ? (this._options.path ?? null) : null
  }

  getStoragePath() {
    return this.storagePath
  }

  // --- user agent ---------------------------------------------------------------
  getUserAgent() {
    return this._userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  }

  /** Applies to windows created afterwards (Tauri sets it at creation). */
  setUserAgent(userAgent, acceptLanguages) {
    this._userAgent = String(userAgent)
    this._acceptLanguages = acceptLanguages
  }

  // --- handlers (stored; Tauri has no hook to call them) ----------------------------
  setPermissionRequestHandler(handler) { this._handlers.permissionRequest = handler }
  setPermissionCheckHandler(handler) { this._handlers.permissionCheck = handler }
  setDisplayMediaRequestHandler(handler) { this._handlers.displayMedia = handler }
  setDevicePermissionHandler(handler) { this._handlers.devicePermission = handler }
  setCertificateVerifyProc(proc) { this._handlers.certificateVerify = proc }
  setBluetoothPairingHandler(handler) { this._handlers.bluetoothPairing = handler }
  setUSBProtectedClassesHandler(handler) { this._handlers.usbProtectedClasses = handler }

  // --- spell checker (cached; the OS webview owns spell checking) --------------------
  setSpellCheckerLanguages(languages) { this._spellCheckerLanguages = [...languages] }
  getSpellCheckerLanguages() { return [...this._spellCheckerLanguages] }
  setSpellCheckerEnabled(enabled) { this._spellCheckerEnabled = Boolean(enabled) }
  isSpellCheckerEnabled() { return this._spellCheckerEnabled }
  get spellCheckerEnabled() { return this._spellCheckerEnabled }
  set spellCheckerEnabled(value) { this.setSpellCheckerEnabled(value) }
  setSpellCheckerDictionaryDownloadURL() {}
  addWordToSpellCheckerDictionary(word) { this._dictionary.add(String(word)); return true }
  removeWordFromSpellCheckerDictionary(word) { this._dictionary.delete(String(word)); return true }
  listWordsInSpellCheckerDictionary() { return Promise.resolve([...this._dictionary]) }

  // --- network ---------------------------------------------------------------------
  resolveProxy() { return Promise.resolve('DIRECT') }
  setProxy() { return Promise.resolve() }
  forceReloadProxyConfig() { return Promise.resolve() }
  closeAllConnections() { return Promise.resolve() }
  clearHostResolverCache() { return Promise.resolve() }
  clearAuthCache() { return Promise.resolve() }
  clearCache() { return Promise.resolve() }
  getCacheSize() { return Promise.resolve(0) }
  preconnect() {}
  setSSLConfig() {}
  enableNetworkEmulation() {}
  disableNetworkEmulation() {}
  fetch(input, init) { return netFetch(input, init) }

  /**
   * Tauri clears everything a webview stored (cookies, storage, cache) - the
   * `options` filter of Electron's clearStorageData() is not honoured.
   */
  async clearStorageData() {
    const windows = BrowserWindow.getAllWindows().filter((win) => (win.webContents.session ?? defaultSession) === this)
    await Promise.all(windows.map(async (win) => {
      const native = await win._nativeReady.promise
      await native.clearAllBrowsingData()
    })).catch(report('session.clearStorageData'))
  }

  clearData() { return this.clearStorageData() }
  flushStorageData() {}

  // --- downloads -------------------------------------------------------------------
  downloadURL() { throw new NotImplementedError('session.downloadURL') }
  createInterruptedDownload() { throw new NotImplementedError('session.createInterruptedDownload') }
  setDownloadPath(path) { this._downloadPath = path }

  // --- preloads (tauri-electron injects preloads at build time) -------------------
  getPreloads() { return [...this._preloads] }
  setPreloads(preloads) {
    warnOnce('session.setPreloads', 'session preloads are not injected: tauri-electron injects preloads at build time (Vite plugin `preload` option).')
    this._preloads = [...preloads]
  }
  registerPreloadScript(script) {
    const id = script.id ?? `preload-${this._preloads.length + 1}`
    this._preloads.push({ ...script, id })
    return id
  }
  unregisterPreloadScript(id) { this._preloads = this._preloads.filter((p) => p.id !== id) }
  getPreloadScripts() { return this._preloads.filter((p) => typeof p === 'object') }

  setCodeCachePath() {}
  clearCodeCaches() { return Promise.resolve() }
  getBlobData() { return Promise.reject(new NotImplementedError('session.getBlobData')) }
  loadExtension() { return Promise.reject(new NotImplementedError('session.loadExtension')) }
  getAllExtensions() { return [] }
  getExtension() { return null }
  removeExtension() {}
}

const partitions = new Map()
export const defaultSession = new Session('')
partitions.set('', defaultSession)

export const session = {
  get defaultSession() {
    return defaultSession
  },

  fromPartition(partition = '', options = {}) {
    partition = String(partition)
    if (!partitions.has(partition)) partitions.set(partition, new Session(partition, options))
    return partitions.get(partition)
  },

  fromPath(path, options = {}) {
    const key = `path:${path}`
    if (!partitions.has(key)) partitions.set(key, new Session(`persist:${path}`, { ...options, path }))
    return partitions.get(key)
  },
}
