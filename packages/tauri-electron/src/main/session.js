/**
 * session: a partial Electron Session per partition.
 *
 * Tauri's webview options cover the storage side of a partition (an
 * incognito webview for in-memory partitions, a separate data store for
 * `persist:` partitions on macOS) and `clearAllBrowsingData()`. Cookies go
 * through tauri-plugin-electron (the webview's cookie store), and so do
 * downloads (./downloads.js) and permission requests (./permissions.js) of
 * windows it creates. `setProxy` applies to windows created afterwards
 * (./proxy.js). `webRequest` listeners apply where tauri-electron sees the
 * request (./web-request.js); `setCertificateVerifyProc` to the webview's
 * certificate errors (./tls-auth.js).
 */
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { NotImplementedError, MAIN_LABEL, report, warnOnce } from '../internal/runtime.js'
import { native, hasNativePlugin } from '../internal/native.js'
import { platform } from '../process.js'
import { netFetch, setDefaultProxy, OWN_PROXY, VIA_SESSION } from './net.js'
import { protocol } from './protocol.js'
import { BrowserWindow, webContentsFromLabel } from './browser-window.js'
import { dialog } from './dialog.js'
import { configureDownloads, downloadURL } from './downloads.js'
import { configurePermissions, syncPermissionHandler } from './permissions.js'
import { parseProxyConfig, describeProxy } from './proxy.js'
import { WebRequest, configureWebRequest } from './web-request.js'
import { configureTlsAuth } from './tls-auth.js'

/** Whether `domain` is `parent` or one of its subdomains (leading dots ignored). */
function withinDomain(domain, parent) {
  domain = String(domain).replace(/^\./, '').toLowerCase()
  parent = String(parent).replace(/^\./, '').toLowerCase()
  return domain === parent || domain.endsWith(`.${parent}`)
}

/** Electron's `cookies.get` filter, after Rust selected by `url`. */
export function filterCookies(cookies, filter = {}) {
  return cookies.filter((cookie) =>
    (filter.name === undefined || cookie.name === filter.name) &&
    (filter.domain === undefined || withinDomain(cookie.domain, filter.domain)) &&
    (filter.path === undefined || cookie.path === filter.path) &&
    (filter.secure === undefined || cookie.secure === filter.secure) &&
    (filter.httpOnly === undefined || cookie.httpOnly === filter.httpOnly) &&
    (filter.session === undefined || cookie.session === filter.session))
}

/** A cookie as Electron returns it: no `expirationDate` on session cookies. */
function toElectronCookie(cookie) {
  const out = { ...cookie }
  if (out.expirationDate === null || out.expirationDate === undefined) delete out.expirationDate
  return out
}

/**
 * session.cookies, on the webview cookie store of a window in the session
 * (the hidden main window for the default session). 'changed' is emitted for
 * changes made through this API only: Tauri reports no others.
 */
/**
 * Session preloads are files loaded at runtime in Electron; tauri-electron's
 * bundler plugins put the known libraries' ones (electron-log, …, listed in
 * `__TAURI_ELECTRON_APP__.sessionPreloads`) in every renderer page instead.
 * Warn about any other.
 */
function warnUnbundledPreload(api, file) {
  const bundled = globalThis.__TAURI_ELECTRON_APP__?.sessionPreloads ?? []
  const normalized = String(file ?? '').replace(/\\/g, '/')
  // `…/electron-log/src/renderer/electron-log-preload.js`, `…/@sentry/electron/preload/index.js`, a listed file
  if (bundled.some((name) => normalized.includes(String(name).replace(/\\/g, '/').replace(/^\.\//, '')))) return
  warnOnce(`${api}:${file}`, `${api}('${file}'): preloads cannot be loaded at runtime. Add it to the bundler plugin's \`sessionPreloads\` (or \`preload\`) option to run it in renderer pages.`)
}

class Cookies extends EventEmitter {
  constructor(session) {
    super()
    this._session = session
  }

  /** A window whose webview uses this session's cookie store. */
  async _label(api) {
    if (!hasNativePlugin()) throw new NotImplementedError(api, { reason: 'plugin', hint: 'Cookies need tauri-plugin-electron.' })
    if (this._session === defaultSession) return MAIN_LABEL
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.session === this._session)
    const missing = () => new Error(`${api}: no window uses partition '${this._session._partition}' yet; its cookie store is reached through one.`)
    if (!win) throw missing()
    // The window may close before its native window exists: do not wait forever.
    await new Promise((resolve, reject) => {
      const onClosed = () => reject(missing())
      win.once('closed', onClosed)
      win._nativeReady.promise.then(() => {
        win.removeListener('closed', onClosed)
        resolve()
      }, reject)
    })
    return win._label
  }

  async get(filter = {}) {
    const label = await this._label('session.cookies.get')
    const cookies = await native('cookies_get', { label, url: filter.url ?? null })
    return filterCookies(cookies, filter).map(toElectronCookie)
  }

  async set(details) {
    if (!details?.url) throw new TypeError('session.cookies.set: details.url is required')
    const label = await this._label('session.cookies.set')
    const cookie = await native('cookies_set', {
      label,
      details: {
        url: String(details.url),
        name: String(details.name ?? ''),
        value: String(details.value ?? ''),
        domain: details.domain,
        path: details.path,
        secure: Boolean(details.secure),
        httpOnly: Boolean(details.httpOnly),
        expirationDate: details.expirationDate,
        sameSite: details.sameSite,
      },
    })
    this.emit('changed', createEvent(), toElectronCookie(cookie), 'explicit', false)
  }

  async remove(url, name) {
    const label = await this._label('session.cookies.remove')
    const removed = await native('cookies_remove', { label, url: String(url), name: String(name) })
    for (const cookie of removed) this.emit('changed', createEvent(), toElectronCookie(cookie), 'explicit', true)
  }

  /** The webview writes its store itself. */
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
    this._proxy = null
    this.webRequest = new WebRequest(this)
    this.cookies = new Cookies(this)
    this.protocol = protocol
    this.serviceWorkers = new EventEmitter()
    this.extensions = {
      loadExtension: () => Promise.reject(new NotImplementedError('session.extensions.loadExtension', { reason: 'unsupported', hint: 'Chrome extensions do not exist in WebKit / WebView2.' })),
      removeExtension() {},
      getExtension: () => null,
      getAllExtensions: () => [],
    }
    this.netLog = { startLogging: () => Promise.reject(new NotImplementedError('session.netLog', { reason: 'unsupported' })), stopLogging: () => Promise.resolve(), currentlyLogging: false }
    this.availableSpellCheckerLanguages = typeof navigator !== 'undefined' ? [...(navigator.languages ?? [navigator.language])] : ['en-US']
  }

  /** Tauri WebviewWindow options for windows using this session. */
  _tauriWebviewOptions() {
    const options = partitionWebviewOptions(this._partition)
    if (this._userAgent) options.userAgent = this._userAgent
    if (this._proxy) options.proxyUrl = this._proxy.url
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
  /** Applied to this session's windows (./permissions.js); without one, everything is granted. */
  setPermissionRequestHandler(handler) {
    this._handlers.permissionRequest = typeof handler === 'function' ? handler : null
    syncPermissionHandler(this, BrowserWindow.getAllWindows())
  }

  /** Stored: Tauri has no hook for permission checks (navigator.permissions.query). */
  setPermissionCheckHandler(handler) { this._handlers.permissionCheck = handler }
  /** Called for a page's getDisplayMedia() (./display-media.js); the webview's picker chooses the source. */
  setDisplayMediaRequestHandler(handler, options) { this._handlers.displayMedia = typeof handler === 'function' ? handler : null; this._handlers.displayMediaOptions = { ...options } }
  setDevicePermissionHandler(handler) { this._handlers.devicePermission = handler }
  /** Asked when a window's webview rejects a certificate, before 'certificate-error' (./tls-auth.js). */
  setCertificateVerifyProc(proc) { this._handlers.certificateVerify = typeof proc === 'function' ? proc : null }
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
  resolveProxy(url) { return Promise.resolve(describeProxy(this._proxy, url)) }

  /** Applies to windows created afterwards (Tauri sets a webview's proxy at creation) and to fetch(). */
  setProxy(config) {
    this._proxy = parseProxyConfig(config)
    this._proxyConfigured = true
    if (this === defaultSession) setDefaultProxy(this._proxy?.url ?? null)
    if (BrowserWindow.getAllWindows().some((win) => win.webContents.session === this)) {
      warnOnce('setProxy-existing', 'session.setProxy() applies to windows created afterwards: Tauri sets a webview\'s proxy when it is created.')
    }
    return Promise.resolve()
  }
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
  // Each session uses its own proxy settings only (the default session's are applied by netFetch).
  fetch(input, init) {
    if (this === defaultSession) return netFetch(input, { ...init, [VIA_SESSION]: this })
    return netFetch(input, { ...init, [OWN_PROXY]: true, [VIA_SESSION]: this, ...(this._proxy && init?.proxy === undefined ? { proxy: { all: this._proxy.url } } : {}) })
  }

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
  /** Emits 'will-download' like a page download (./downloads.js). */
  downloadURL(url, options) {
    const win = this === defaultSession ? null : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.session === this)
    downloadURL(this, win?.webContents ?? null, url, options)
  }
  createInterruptedDownload() { throw new NotImplementedError('session.createInterruptedDownload', { reason: 'unimplemented' }) }
  setDownloadPath(path) { this._downloadPath = path }

  // --- preloads (tauri-electron injects preloads at build time) -------------------
  getPreloads() { return this._preloads.map((p) => (typeof p === 'object' ? p.filePath : p)) }
  setPreloads(preloads) {
    for (const file of preloads) warnUnbundledPreload('session.setPreloads', file)
    this._preloads = [...preloads]
  }
  registerPreloadScript(script) {
    warnUnbundledPreload('session.registerPreloadScript', script?.filePath)
    const id = script.id ?? `preload-${this._preloads.length + 1}`
    this._preloads.push({ ...script, id })
    return id
  }
  unregisterPreloadScript(id) { this._preloads = this._preloads.filter((p) => p.id !== id) }
  getPreloadScripts() { return this._preloads.filter((p) => typeof p === 'object') }

  setCodeCachePath() {}
  clearCodeCaches() { return Promise.resolve() }
  getBlobData() { return Promise.reject(new NotImplementedError('session.getBlobData', { reason: 'unsupported' })) }
  loadExtension() { return Promise.reject(new NotImplementedError('session.loadExtension', { reason: 'unsupported', hint: 'Chrome extensions do not exist in WebKit / WebView2.' })) }
  getAllExtensions() { return [] }
  getExtension() { return null }
  removeExtension() {}
}

const partitions = new Map()
export const defaultSession = new Session('')
partitions.set('', defaultSession)
configureDownloads({
  defaultSession,
  webContentsFromLabel: (label) => webContentsFromLabel(label),
  saveDialog: (...args) => dialog.showSaveDialog(...args),
})
configurePermissions({ defaultSession, webContentsFromLabel: (label) => webContentsFromLabel(label) })
configureWebRequest({
  defaultSession,
  webContentsFromLabel: (label) => webContentsFromLabel(label),
  fromPartition: (partition) => session.fromPartition(partition),
  windows: () => BrowserWindow.getAllWindows(),
})
configureTlsAuth({ defaultSession, webContentsFromLabel: (label) => webContentsFromLabel(label) })

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
