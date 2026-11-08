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
import * as deepLink from '@tauri-apps/plugin-deep-link'
import * as autostart from '@tauri-apps/plugin-autostart'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { bus } from '../internal/bus.js'
import { deferred, isMainProcess, isPackagedBuild, report, warnOnce, NotImplementedError } from '../internal/runtime.js'
import { join as joinPath } from '../path.js'
import { applyProcessInfo, platform } from '../process.js'
import { loadProcessInfo, processInfo } from '../internal/native.js'
import { BrowserWindow, onPageLoad } from './browser-window.js'
import { Menu } from './menu.js'
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
    this._loginItem = { openAtLogin: false }
    this._protocolClients = new Set()
    this._accessibility = false
    this.userAgentFallback = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    this.runningUnderARM64Translation = false
    this.runningUnderRosettaTranslation = false
    this.commandLine = createCommandLine()
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
    const webview = getCurrentWebviewWindow()
    const [info, loginItem, name, version, locale, appPath, ...paths] = await Promise.all([
      loadProcessInfo(),
      settle(autostart.isEnabled()),
      settle(tauriApp.getName()),
      settle(tauriApp.getVersion()),
      settle(osLocale()),
      settle(tauriPath.resourceDir()),
      ...Object.values(PATH_RESOLVERS).map((resolve) => settle(resolve())),
      startMainBridge(),
      // Native events forwarded by tauri-plugin-electron.
      webview.listen('tauri-electron:activate', ({ payload }) => this.emit('activate', createEvent(), Boolean(payload))),
      webview.listen('tauri-electron:page-load', ({ payload }) => onPageLoad(payload)),
      webview.listen('tauri-electron:second-instance', ({ payload }) =>
        this.emit('second-instance', createEvent(), payload.argv ?? [], payload.cwd ?? '', {}),
      ),
      webview.listen('tauri-electron:opened', ({ payload }) => this._onOpened(payload)),
      initNativeTheme(),
      initScreen(),
    ])
    applyProcessInfo(info, { type: 'browser' })
    if (info?.execPath) Object.assign(this._paths, { exe: info.execPath })
    if (loginItem.ok) this._loginItem.openAtLogin = loginItem.value
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
    // macOS delivers the URL that launched the app before 'ready', as open-url.
    if (platform === 'darwin') {
      deepLink.getCurrent().then((urls) => urls && this._onOpened(urls), () => {})
    }
    this._ready = true
    this._readyDeferred.resolve()
    this.emit('ready', createEvent(), {})
  }

  /** macOS open-file / open-url (tauri::RunEvent::Opened). */
  _onOpened(urls) {
    for (const url of urls ?? []) {
      if (url.startsWith('file://')) this.emit('open-file', createEvent(), decodeURIComponent(new URL(url).pathname))
      else this.emit('open-url', createEvent(), url)
    }
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

  getGPUInfo() {
    return Promise.resolve({ auxAttributes: {}, gpuDevice: [] })
  }

  /** One native process hosts every webview. */
  getAppMetrics() {
    return [{
      pid: processInfo()?.pid ?? 0,
      type: 'Browser',
      creationTime: typeof performance !== 'undefined' ? performance.timeOrigin : Date.now(),
      cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 0, peakWorkingSetSize: 0 },
      sandboxed: false,
    }]
  }

  setAppLogsPath(path) {
    if (path) this._paths.logs = path
  }

  resolveProxy() {
    return Promise.resolve('DIRECT')
  }

  setProxy() {
    warnOnce('app.setProxy', 'app.setProxy() is ignored; Tauri webviews use the system proxy.')
    return Promise.resolve()
  }

  isAccessibilitySupportEnabled() {
    return this._accessibility
  }

  setAccessibilitySupportEnabled(enabled) {
    this._accessibility = Boolean(enabled)
  }

  get accessibilitySupportEnabled() { return this._accessibility }
  set accessibilitySupportEnabled(value) { this.setAccessibilitySupportEnabled(value) }

  get applicationMenu() { return Menu.getApplicationMenu() }
  set applicationMenu(menu) { Menu.setApplicationMenu(menu) }

  get badgeCount() { return this._badgeCount }
  set badgeCount(count) { this.setBadgeCount(count) }

  isInApplicationsFolder() {
    return false
  }

  moveToApplicationsFolder() {
    return false
  }

  isEmojiPanelSupported() {
    return false
  }

  showEmojiPanel() {}

  setActivationPolicy() {}

  isSecureKeyboardEntryEnabled() {
    return false
  }

  setSecureKeyboardEntryEnabled() {}

  startAccessingSecurityScopedResource() {
    return () => {}
  }

  setUserActivity() {}
  getCurrentActivityType() { return '' }
  invalidateCurrentActivity() {}
  resignCurrentActivity() {}
  updateCurrentActivity() {}
  configureHostResolver() {}
  isUnityRunning() { return false }

  getApplicationNameForProtocol() {
    return ''
  }

  getApplicationInfoForProtocol() {
    return Promise.reject(new NotImplementedError('app.getApplicationInfoForProtocol'))
  }

  getJumpListSettings() {
    return { minItems: 0, removedItems: [] }
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
   * Opt-in, like in Electron: enable the `single-instance` feature of
   * tauri-plugin-electron in src-tauri/Cargo.toml. The lock is then taken at startup - a second launch exits
   * before its main process runs - so the instance that gets here holds it.
   * Without that, there is no lock: this warns and returns true so the usual
   * `if (!app.requestSingleInstanceLock()) app.quit()` keeps working.
   */
  requestSingleInstanceLock() {
    if (!processInfo()?.singleInstance) {
      warnOnce('single-instance', "app.requestSingleInstanceLock(): no lock is taken. Enable the `single-instance` feature of tauri-plugin-electron in src-tauri/Cargo.toml.")
    }
    this._singleInstanceLock = true
    return true
  }

  hasSingleInstanceLock() {
    return Boolean(this._singleInstanceLock)
  }

  releaseSingleInstanceLock() {
    this._singleInstanceLock = false
  }

  setAppUserModelId() {}

  disableHardwareAcceleration() {}

  disableDomainBlockingFor3DAPIs() {}

  enableSandbox() {}

  /**
   * tauri-plugin-deep-link. Registration happens asynchronously; macOS needs
   * the scheme in tauri.conf.json (plugins.deep-link.desktop.schemes).
   */
  setAsDefaultProtocolClient(protocol) {
    if (platform === 'darwin') {
      warnOnce('protocol-client', 'app.setAsDefaultProtocolClient(): on macOS declare the scheme in tauri.conf.json (plugins.deep-link.desktop.schemes).')
      return this._protocolClients.has(protocol)
    }
    this._protocolClients.add(protocol)
    deepLink.register(protocol).catch((error) => {
      this._protocolClients.delete(protocol)
      report(`app.setAsDefaultProtocolClient(${protocol})`)(error)
    })
    return true
  }

  isDefaultProtocolClient(protocol) {
    deepLink.isRegistered(protocol).then((yes) => (yes ? this._protocolClients.add(protocol) : this._protocolClients.delete(protocol)), () => {})
    return this._protocolClients.has(protocol)
  }

  removeAsDefaultProtocolClient(protocol) {
    const had = this._protocolClients.delete(protocol)
    deepLink.unregister(protocol).catch(report(`app.removeAsDefaultProtocolClient(${protocol})`))
    return had
  }

  addRecentDocument() {}

  clearRecentDocuments() {}

  /** tauri-plugin-autostart. Only `openAtLogin` has an effect. */
  setLoginItemSettings(settings = {}) {
    if (settings.openAtLogin === undefined) return
    const enable = Boolean(settings.openAtLogin)
    this._loginItem.openAtLogin = enable
    ;(enable ? autostart.enable() : autostart.disable()).catch(report('app.setLoginItemSettings'))
  }

  getLoginItemSettings() {
    return {
      openAtLogin: this._loginItem.openAtLogin,
      openAsHidden: false,
      wasOpenedAtLogin: false,
      wasOpenedAsHidden: false,
      restoreState: false,
      executableWillLaunchAtLogin: this._loginItem.openAtLogin,
      launchItems: [],
      status: this._loginItem.openAtLogin ? 'enabled' : 'not-registered',
    }
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
bus.on('web-contents-created', (contents) => app.emit('web-contents-created', createEvent(), contents))
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

/** app.commandLine over the real process arguments (tauri-plugin-electron). */
function createCommandLine() {
  const appended = new Map()
  const fromArgv = (name) => {
    const argv = globalThis.process?.argv ?? []
    for (const arg of argv) {
      if (arg === `--${name}`) return ''
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
    }
    return undefined
  }
  return {
    appendSwitch(name, value = '') {
      appended.set(String(name), String(value))
    },
    appendArgument(arg) {
      appended.set(String(arg), '')
    },
    hasSwitch(name) {
      return appended.has(name) || fromArgv(name) !== undefined
    },
    getSwitchValue(name) {
      return appended.get(name) ?? fromArgv(name) ?? ''
    },
    removeSwitch(name) {
      appended.delete(name)
    },
  }
}
