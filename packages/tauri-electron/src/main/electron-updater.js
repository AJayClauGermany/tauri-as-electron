/**
 * `electron-updater` (electron-builder's auto-update library), on
 * @tauri-apps/plugin-updater. The bundler plugins alias `electron-updater`
 * to this module, like `electron` itself.
 *
 *   const { autoUpdater } = require('electron-updater')
 *   autoUpdater.checkForUpdatesAndNotify()
 *
 * The update server, the signing key and the artifacts come from Tauri:
 * `plugins.updater` in tauri.conf.json (and the `updater` feature of
 * tauri-plugin-electron). electron-builder's `latest.yml` feeds are not
 * read: `setFeedURL()`, `channel`, `allowPrerelease` and `allowDowngrade`
 * are recorded (the channel and the feed URL are sent to the update server
 * as `X-Electron-Updater-*` headers, so an endpoint can serve channels).
 *
 * As in electron-updater, `checkForUpdates()` does nothing (resolves to
 * null) in an unpackaged app unless `forceDevUpdateConfig` is set.
 */
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { EventEmitter } from '../internal/emitter.js'
import { hasFeature, featureError } from '../internal/native.js'
import { app } from './app.js'
import { Notification } from './notification.js'

export const DOWNLOAD_PROGRESS = 'download-progress'
export const UPDATE_DOWNLOADED = 'update-downloaded'

/** electron-updater's CancellationError. */
export class CancellationError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancellationError'
  }
}

/** builder-util-runtime's CancellationToken (cancels waiting for a download; the transfer itself runs to its end). */
export class CancellationToken extends EventEmitter {
  constructor(parent) {
    super()
    this._cancelled = false
    this._handlers = []
    if (parent) parent.onCancel(() => this.cancel())
  }

  get cancelled() {
    return this._cancelled
  }

  cancel() {
    if (this._cancelled) return
    this._cancelled = true
    for (const handler of this._handlers.splice(0)) {
      try {
        handler()
      } catch {
        /* ignore */
      }
    }
    this.emit('cancel')
  }

  onCancel(handler) {
    if (this._cancelled) handler()
    else this._handlers.push(handler)
  }

  createPromise(executor) {
    if (this._cancelled) return Promise.reject(new CancellationError())
    return new Promise((resolve, reject) => {
      this.onCancel(() => reject(new CancellationError()))
      executor(resolve, reject, (handler) => this.onCancel(handler))
    })
  }

  dispose() {
    this._handlers = []
  }
}

/** A semver object as electron-updater exposes `currentVersion` (`.version`, `.compare()`, `toString()`). */
export function parseSemver(version) {
  const raw = String(version ?? '0.0.0').replace(/^v/, '')
  const [main, prerelease = ''] = raw.split('+')[0].split(/-(.*)/s)
  const [major = 0, minor = 0, patch = 0] = main.split('.').map((n) => Number(n) || 0)
  const pre = prerelease ? prerelease.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : []
  return {
    raw,
    version: raw.split('+')[0],
    major,
    minor,
    patch,
    prerelease: pre,
    format() {
      return this.version
    },
    toString() {
      return this.version
    },
    compare(other) {
      const b = typeof other === 'object' ? other : parseSemver(other)
      for (const key of ['major', 'minor', 'patch']) if (this[key] !== b[key]) return this[key] > b[key] ? 1 : -1
      if (!pre.length || !b.prerelease.length) return pre.length === b.prerelease.length ? 0 : pre.length ? -1 : 1
      for (let i = 0; i < Math.max(pre.length, b.prerelease.length); i++) {
        const x = pre[i]
        const y = b.prerelease[i]
        if (x === undefined) return -1
        if (y === undefined) return 1
        if (x !== y) return typeof x === typeof y ? (x > y ? 1 : -1) : typeof x === 'number' ? -1 : 1
      }
      return 0
    },
  }
}

/** Tauri's Update → electron-updater's UpdateInfo. */
export function toUpdateInfo(update) {
  const raw = update.rawJson ?? {}
  const date = update.date ?? raw.pub_date
  const parsed = date ? new Date(date) : new Date()
  return {
    version: update.version,
    releaseDate: Number.isNaN(parsed.getTime()) ? String(date) : parsed.toISOString(),
    releaseName: raw.name ?? update.version,
    releaseNotes: update.body ?? raw.notes ?? null,
    files: [],
    path: '',
    sha512: '',
  }
}

/** UpdaterSignal: typed listeners for the download events. */
class UpdaterSignal {
  constructor(emitter) {
    this.emitter = emitter
  }

  login(handler) {
    this.emitter.on('login', handler)
  }

  progress(handler) {
    this.emitter.on(DOWNLOAD_PROGRESS, handler)
  }

  updateDownloaded(handler) {
    this.emitter.on(UPDATE_DOWNLOADED, handler)
  }

  updateCancelled(handler) {
    this.emitter.on('update-cancelled', handler)
  }
}

export class AppUpdater extends EventEmitter {
  constructor() {
    super()
    this.autoDownload = true
    this.autoInstallOnAppQuit = true
    this.autoRunAppAfterInstall = true
    this.allowPrerelease = false
    this.allowDowngrade = false
    this.fullChangelog = false
    this.forceDevUpdateConfig = false
    this.disableWebInstaller = false
    this.disableDifferentialDownload = false
    this.requestHeaders = null
    this.netSession = undefined
    this.updateConfigPath = null
    this.logger = console
    this.signals = new UpdaterSignal(this)
    this._channel = null
    this._feed = null
    this._update = null
    this._info = null
    this._downloadPromise = null
    this._downloaded = false
    this._checkPromise = null
    this._installOnQuit = false
  }

  /** The running app's version (a semver object, as in electron-updater). */
  get currentVersion() {
    return parseSemver(app.getVersion())
  }

  get channel() {
    return this._channel
  }

  set channel(value) {
    if (value != null && (typeof value !== 'string' || !value)) throw new Error(`Channel must be a string, but got: ${value}`)
    this._channel = value
    // electron-updater: setting a channel allows downgrades to it.
    this.allowDowngrade = true
  }

  /** Recorded: the feed comes from `plugins.updater.endpoints` in tauri.conf.json. */
  setFeedURL(options) {
    this._feed = typeof options === 'string' ? { provider: 'generic', url: options } : { ...options }
    this.logger?.info?.('[tauri-electron] electron-updater: the update endpoints come from plugins.updater in tauri.conf.json; setFeedURL() is recorded only.')
  }

  getFeedURL() {
    return this._feed?.url ?? null
  }

  addAuthHeader(token) {
    this.requestHeaders = { ...this.requestHeaders, authorization: token }
  }

  isUpdaterActive() {
    if (!app.isPackaged && !this.forceDevUpdateConfig) {
      this.logger?.info?.('Skip checkForUpdates because application is not packed and dev update config is not forced')
      return false
    }
    return true
  }

  _headers() {
    const headers = { ...this.requestHeaders }
    if (this._channel) headers['X-Electron-Updater-Channel'] = this._channel
    if (this._feed?.url) headers['X-Electron-Updater-Feed'] = String(this._feed.url)
    return headers
  }

  _error(error) {
    const err = error instanceof Error ? error : new Error(String(error))
    this.emit('error', err, err.stack ?? err.message)
    return err
  }

  /** Resolves to { isUpdateAvailable, updateInfo, versionInfo, downloadPromise, cancellationToken }, or null when inactive. */
  checkForUpdates() {
    if (!this.isUpdaterActive()) return Promise.resolve(null)
    this._checkPromise ??= this._check().finally(() => {
      this._checkPromise = null
    })
    return this._checkPromise
  }

  async _check() {
    this.emit('checking-for-update')
    let update
    try {
      if (!hasFeature('updater')) throw featureError('electron-updater autoUpdater', 'updater')
      update = await check({ headers: this._headers() })
    } catch (error) {
      throw this._error(error)
    }
    if (!update) {
      const info = { version: this.currentVersion.version, releaseDate: new Date().toISOString(), files: [], path: '', sha512: '' }
      this.logger?.info?.('Update for version ' + info.version + ' is not available (latest version: ' + info.version + ').')
      this.emit('update-not-available', info)
      return { isUpdateAvailable: false, updateInfo: info, versionInfo: info }
    }
    const info = toUpdateInfo(update)
    if (this._update && this._update !== update) this._update.close?.().catch?.(() => {})
    this._update = update
    this._info = info
    this._downloaded = false
    this._downloadPromise = null
    this.logger?.info?.(`Found version ${info.version}`)
    this.emit('update-available', info)
    const cancellationToken = new CancellationToken()
    const result = { isUpdateAvailable: true, updateInfo: info, versionInfo: info, cancellationToken }
    if (this.autoDownload) {
      result.downloadPromise = this.downloadUpdate(cancellationToken)
      // An auto download that fails is reported through 'error' (and the promise), not as unhandled.
      result.downloadPromise.catch(() => {})
    }
    return result
  }

  /** Download the update found by checkForUpdates(); resolves to the downloaded files (none are exposed here). */
  downloadUpdate(cancellationToken = new CancellationToken()) {
    const update = this._update
    if (!update) return Promise.reject(this._error(new Error('Please check update first')))
    if (this._downloadPromise) return this._downloadPromise
    const info = this._info
    let total = 0
    let transferred = 0
    const started = Date.now()
    const download = update.download((event) => {
      if (cancellationToken.cancelled) return
      if (event.event === 'Started') total = event.data.contentLength ?? 0
      if (event.event !== 'Progress') return
      transferred += event.data.chunkLength
      const seconds = Math.max((Date.now() - started) / 1000, 0.001)
      this.emit(DOWNLOAD_PROGRESS, {
        total,
        delta: event.data.chunkLength,
        transferred,
        percent: total ? Math.min(100, (transferred / total) * 100) : 0,
        bytesPerSecond: Math.round(transferred / seconds),
      })
    }, { headers: this._headers() })
    this._downloadPromise = cancellationToken.createPromise((resolve, reject) => {
      download.then(() => {
        if (cancellationToken.cancelled) return
        this._downloaded = true
        this._armInstallOnQuit()
        this.emit(UPDATE_DOWNLOADED, { ...info, downloadedFile: '' })
        resolve([])
      }, (error) => reject(this._error(error)))
    }).catch((error) => {
      this._downloadPromise = null
      if (error instanceof CancellationError) {
        this.logger?.info?.('Cancelled')
        this.emit('update-cancelled', info)
      }
      throw error
    })
    return this._downloadPromise
  }

  /** Check, download, and show a notification when the update is ready (as electron-updater does). */
  async checkForUpdatesAndNotify(notification) {
    const result = await this.checkForUpdates()
    if (!result?.downloadPromise) return result
    result.downloadPromise.then(() => {
      const version = result.updateInfo.version
      const name = app.getName()
      const title = (notification?.title ?? 'A new update is ready to install').replace('{appName}', name).replace('{version}', version)
      const body = (notification?.body ?? '{appName} version {version} has been downloaded and will be automatically installed on exit')
        .replace('{appName}', name)
        .replace('{version}', version)
      if (Notification.isSupported()) new Notification({ title, body }).show()
    }, () => {})
    return result
  }

  /** Install the downloaded update and restart (unless `isForceRunAfter` is false and autoRunAppAfterInstall is off). */
  async quitAndInstall(_isSilent = false, isForceRunAfter = false) {
    if (!this._downloaded || !this._update) {
      this._error(new Error('No update available, can\'t quit and install'))
      return
    }
    this._installOnQuit = false
    this.emit('before-quit-for-update')
    try {
      await this._update.install()
      if (isForceRunAfter || this.autoRunAppAfterInstall) await relaunch()
      else app.exit(0)
    } catch (error) {
      this._error(error)
    }
  }

  /** autoInstallOnAppQuit: install a downloaded update when the app quits (without relaunching). */
  _armInstallOnQuit() {
    if (this._installOnQuit) return
    this._installOnQuit = true
    app.once('will-quit', (event) => {
      if (!this._installOnQuit || !this.autoInstallOnAppQuit || !this._downloaded) return
      this._installOnQuit = false
      event.preventDefault()
      this._update.install().catch((error) => this._error(error)).finally(() => app.exit(0))
    })
  }
}

// The platform updaters of electron-updater: all the same updater here.
export class BaseUpdater extends AppUpdater {}
export class NsisUpdater extends BaseUpdater {}
export class MacUpdater extends AppUpdater {}
export class AppImageUpdater extends BaseUpdater {}
export class DebUpdater extends BaseUpdater {}
export class RpmUpdater extends BaseUpdater {}
export class PacmanUpdater extends BaseUpdater {}
export { UpdaterSignal }

/** electron-updater's `autoUpdater`. */
export const autoUpdater = new AppUpdater()

export default {
  autoUpdater,
  AppUpdater,
  BaseUpdater,
  NsisUpdater,
  MacUpdater,
  AppImageUpdater,
  DebUpdater,
  RpmUpdater,
  PacmanUpdater,
  CancellationToken,
  CancellationError,
  UpdaterSignal,
  DOWNLOAD_PROGRESS,
  UPDATE_DOWNLOADED,
}
