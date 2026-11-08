/**
 * Electron's `app` module.
 *
 * Electron's `app` getters (getPath, getVersion, getLocale, ...) are
 * synchronous, while Tauri's equivalents are async. tauri-electron resolves
 * all of them *before* emitting `ready`, so they can be read synchronously
 * from the `ready` handler onwards - exactly where Electron code uses them.
 */
import * as tauriApp from '@tauri-apps/api/app'
import * as tauriPath from '@tauri-apps/api/path'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow'
import { locale as osLocale } from '@tauri-apps/plugin-os'
import { exit as processExit, relaunch as processRelaunch } from '@tauri-apps/plugin-process'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { bus } from '../internal/bus.js'
import { deferred, isMainProcess, isPackagedBuild, report, warnOnce, NotImplementedError } from '../internal/runtime.js'
import { join as joinPath } from '../path.js'
import { BrowserWindow } from './browser-window.js'
import { startMainBridge } from './ipc-main.js'
import { initNativeTheme } from './native-theme.js'
import { initScreen } from './screen.js'

/** Electron path name -> Tauri path resolver. */
const PATH_RESOLVERS = {
  home: tauriPath.homeDir,
  appData: tauriPath.configDir,
  userData: tauriPath.appConfigDir,
  sessionData: tauriPath.appConfigDir,
  temp: tauriPath.tempDir,
  exe: tauriPath.resourceDir,
  module: tauriPath.resourceDir,
  desktop: tauriPath.desktopDir,
  documents: tauriPath.documentDir,
  downloads: tauriPath.downloadDir,
  music: tauriPath.audioDir,
  pictures: tauriPath.pictureDir,
  videos: tauriPath.videoDir,
  logs: tauriPath.appLogDir,
  crashDumps: tauriPath.appLogDir,
  cache: tauriPath.cacheDir,
}

const HOME_FALLBACKS = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  music: 'Music',
  pictures: 'Pictures',
  videos: 'Videos',
}

/**
 * When the main page reloads (Vite HMR during development), windows created
 * by the previous run are orphaned and their labels would clash. Electron
 * tooling restarts the whole app in that case; closing them is the analogue.
 */
async function closeStaleWindows() {
  try {
    const stale = (await getAllWebviewWindows()).filter((w) => w.label.startsWith('electron-window-'))
    await Promise.all(stale.map((w) => w.destroy()))
  } catch (error) {
    report('closing stale windows')(error)
  }
}

class App extends EventEmitter {
  constructor() {
    super()
    this._ready = false
    this._readyDeferred = deferred()
    this._quitting = false
    this._relaunchOnExit = false
    this._name = ''
    this._version = ''
    this._locale = 'en-US'
    this._paths = {}
    this._appPath = ''
    this._badgeCount = 0
    this._aboutPanelOptions = {}
    this.isPackaged = isPackagedBuild()
    this.commandLine = {
      appendSwitch() {},
      appendArgument() {},
      hasSwitch: () => false,
      getSwitchValue: () => '',
      removeSwitch() {},
    }
    this.dock = {
      bounce: () => 0,
      cancelBounce() {},
      downloadFinished() {},
      setBadge: (text) => this.setBadgeCount(Number(text) || 0),
      getBadge: () => (this._badgeCount ? String(this._badgeCount) : ''),
      hide: () => tauriApp.setDockVisibility(false).catch(report('app.dock.hide')),
      show: () => tauriApp.setDockVisibility(true).catch(report('app.dock.show')),
      isVisible: () => true,
      setMenu() {},
      getMenu: () => null,
      setIcon() {},
    }
  }

  // --- lifecycle -----------------------------------------------------------------

  async _boot() {
    await closeStaleWindows()
    const settle = (promise) => promise.then((value) => ({ ok: true, value }), () => ({ ok: false }))
    const [name, version, locale, appPath, ...paths] = await Promise.all([
      settle(tauriApp.getName()),
      settle(tauriApp.getVersion()),
      settle(osLocale()),
      settle(tauriPath.resourceDir()),
      ...Object.values(PATH_RESOLVERS).map((resolve) => settle(resolve())),
      startMainBridge(),
      // Forwarded by the template's lib.rs from tauri::RunEvent::Reopen (macOS).
      getCurrentWebviewWindow().listen('tauri-electron:activate', ({ payload }) =>
        this.emit('activate', createEvent(), Boolean(payload)),
      ),
      initNativeTheme(),
      initScreen(),
    ])
    if (name.ok && !this._name) this._name = name.value
    if (version.ok) this._version = version.value
    if (locale.ok && locale.value) this._locale = locale.value
    if (appPath.ok) this._appPath = appPath.value
    Object.keys(PATH_RESOLVERS).forEach((key, index) => {
      if (paths[index]?.ok && !(key in this._paths)) this._paths[key] = paths[index].value
    })
    // Like Electron on Linux, fall back to ~/<Name> when XDG user dirs are unset.
    const home = this._paths.home
    for (const [key, folder] of Object.entries(HOME_FALLBACKS)) {
      if (home && !(key in this._paths)) this._paths[key] = joinPath(home, folder)
    }

    this.emit('will-finish-launching')
    this._ready = true
    this._readyDeferred.resolve()
    this.emit('ready', createEvent(), {})
  }

  isReady() {
    return this._ready
  }

  whenReady() {
    return this._readyDeferred.promise
  }

  _allWindowsClosed() {
    if (this._quitting) return
    if (this.listenerCount('window-all-closed') > 0) this.emit('window-all-closed')
    else this.quit()
  }

  /** Close every window (honouring `close` preventDefault), then exit. */
  async quit() {
    if (this._quitting) return
    const beforeQuit = createEvent()
    this.emit('before-quit', beforeQuit)
    if (beforeQuit.defaultPrevented) return
    this._quitting = true

    const open = BrowserWindow.getAllWindows()
    const closed = open.map((win) => new Promise((resolve) => {
      if (win.isDestroyed()) return resolve(true)
      const onClosed = () => resolve(true)
      win.once('closed', onClosed)
      const onPrevented = (prevented) => {
        if (prevented !== win) return
        bus.off('window-close-prevented', onPrevented)
        win.off('closed', onClosed)
        resolve(false)
      }
      bus.on('window-close-prevented', onPrevented)
      win.close()
    }))
    const results = await Promise.all(closed)
    if (results.includes(false)) {
      this._quitting = false
      return
    }

    const willQuit = createEvent()
    this.emit('will-quit', willQuit)
    if (willQuit.defaultPrevented) {
      this._quitting = false
      return
    }
    this.emit('quit', createEvent(), 0)
    this.exit(0)
  }

  exit(code = 0) {
    this._quitting = true
    const run = this._relaunchOnExit ? processRelaunch() : processExit(code)
    run.catch(report('app.exit'))
  }

  relaunch() {
    this._relaunchOnExit = true
  }

  focus() {
    BrowserWindow.getAllWindows()[0]?.focus()
  }

  hide() {
    tauriApp.hide().catch(report('app.hide'))
  }

  show() {
    tauriApp.show().catch(report('app.show'))
  }

  isHidden() {
    return false
  }

  // --- info --------------------------------------------------------------------------

  getName() {
    return this._name
  }

  setName(name) {
    this._name = String(name)
  }

  get name() {
    return this._name
  }

  set name(value) {
    this.setName(value)
  }

  getVersion() {
    return this._version
  }

  getLocale() {
    return this._locale
  }

  getSystemLocale() {
    return this._locale
  }

  getPreferredSystemLanguages() {
    return [this._locale]
  }

  getLocaleCountryCode() {
    return this._locale.split(/[-_]/)[1] ?? ''
  }

  getAppPath() {
    return this._appPath
  }

  getPath(name) {
    if (!(name in this._paths)) {
      if (!this._ready) throw new Error(`app.getPath('${name}') called before the app was ready`)
      throw new Error(`Failed to get '${name}' path`)
    }
    return this._paths[name]
  }

  setPath(name, value) {
    this._paths[name] = value
  }

  getGPUFeatureStatus() {
    return {}
  }

  getAppMetrics() {
    return []
  }

  // --- misc --------------------------------------------------------------------------

  setBadgeCount(count = 0) {
    this._badgeCount = count
    getCurrentWindow().setBadgeCount(count > 0 ? count : undefined).catch(report('app.setBadgeCount'))
    return true
  }

  getBadgeCount() {
    return this._badgeCount
  }

  setAboutPanelOptions(options) {
    this._aboutPanelOptions = { ...options }
  }

  showAboutPanel() {
    warnOnce('showAboutPanel', 'app.showAboutPanel(): use a Menu item with role "about" instead.')
  }

  /**
   * Single-instance locking needs tauri-plugin-single-instance (Rust side).
   * Returning true keeps the usual Electron boilerplate working.
   */
  requestSingleInstanceLock() {
    warnOnce('single-instance', 'app.requestSingleInstanceLock() always returns true; add tauri-plugin-single-instance for real locking.')
    return true
  }

  hasSingleInstanceLock() {
    return true
  }

  releaseSingleInstanceLock() {}

  setAppUserModelId() {}

  disableHardwareAcceleration() {}

  disableDomainBlockingFor3DAPIs() {}

  enableSandbox() {}

  setAsDefaultProtocolClient() {
    warnOnce('protocol-client', 'app.setAsDefaultProtocolClient() needs tauri-plugin-deep-link; returning false.')
    return false
  }

  isDefaultProtocolClient() {
    return false
  }

  removeAsDefaultProtocolClient() {
    return false
  }

  addRecentDocument() {}

  clearRecentDocuments() {}

  setLoginItemSettings() {
    warnOnce('login-item', 'app.setLoginItemSettings() needs tauri-plugin-autostart; ignored.')
  }

  getLoginItemSettings() {
    return { openAtLogin: false, openAsHidden: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false }
  }

  setUserTasks() {
    return false
  }

  setJumpList() {}

  getFileIcon() {
    return Promise.reject(new NotImplementedError('app.getFileIcon'))
  }

  importCertificate() {
    throw new NotImplementedError('app.importCertificate')
  }
}

export const app = new App()

// Re-emit window lifecycle events on `app`, like Electron does.
bus.on('browser-window-created', (win) => app.emit('browser-window-created', createEvent(), win))
bus.on('browser-window-focus', (win) => app.emit('browser-window-focus', createEvent(), win))
bus.on('browser-window-blur', (win) => app.emit('browser-window-blur', createEvent(), win))
bus.on('quit-requested', () => app.quit())
bus.on('browser-window-closed', () => {
  if (BrowserWindow.getAllWindows().length === 0) app._allWindowsClosed()
})

if (isMainProcess) {
  // Let the user's main script register its listeners first (it runs
  // synchronously after this module is evaluated), then boot.
  queueMicrotask(() => app._boot().catch(report('app startup')))
}
