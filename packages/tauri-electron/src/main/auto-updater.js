/**
 * autoUpdater, implemented with @tauri-apps/plugin-updater.
 *
 * Electron's flow (check -> download automatically -> 'update-downloaded'
 * -> quitAndInstall()) maps directly onto Tauri's check() / download() /
 * install(). The update server and signing key come from `plugins.updater`
 * in tauri.conf.json (and tauri-plugin-updater must be registered in Rust);
 * setFeedURL() is recorded for getFeedURL() and the event arguments only.
 */
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { warnOnce } from '../internal/runtime.js'

class AutoUpdater extends EventEmitter {
  constructor() {
    super()
    this._feedURL = ''
    this._headers = {}
    this._update = null
    this._checking = false
  }

  setFeedURL(options) {
    const opts = typeof options === 'string' ? { url: options } : options ?? {}
    this._feedURL = String(opts.url ?? '')
    this._headers = { ...(opts.headers ?? {}) }
    warnOnce('autoUpdater.setFeedURL', 'autoUpdater.setFeedURL(): the update endpoints are read from `plugins.updater.endpoints` in tauri.conf.json; the URL is only recorded.')
  }

  getFeedURL() {
    return this._feedURL
  }

  _error(error) {
    const err = error instanceof Error ? error : new Error(String(error))
    if (this.listenerCount('error') > 0) this.emit('error', err, err.message)
    else console.error('[tauri-electron] autoUpdater:', err)
  }

  async checkForUpdates() {
    if (this._checking) return
    this._checking = true
    this.emit('checking-for-update', createEvent())
    try {
      const update = await check({ headers: this._headers })
      if (!update) {
        this.emit('update-not-available', createEvent())
        return
      }
      this.emit('update-available', createEvent())
      await update.download()
      this._update = update
      this.emit(
        'update-downloaded',
        createEvent(),
        update.body ?? '',
        update.version,
        update.date ? new Date(update.date) : new Date(),
        this._feedURL,
      )
    } catch (error) {
      this._error(error)
    } finally {
      this._checking = false
    }
  }

  async quitAndInstall() {
    if (!this._update) {
      this._error(new Error('No update available, can\'t quit and install'))
      return
    }
    this.emit('before-quit-for-update', createEvent())
    try {
      await this._update.install()
      await relaunch()
    } catch (error) {
      this._error(error)
    }
  }
}

export const autoUpdater = new AutoUpdater()
