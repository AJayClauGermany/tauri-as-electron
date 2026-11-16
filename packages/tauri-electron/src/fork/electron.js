/**
 * `electron` inside a Node.js child of tauri-electron: a `utilityProcess`
 * or a `child_process.fork` child. The fork builds of the bundler plugins
 * alias `electron` here, and the child bootstrap answers `require('electron')`
 * with it.
 *
 * Electron gives a utility process `net` (and `systemPreferences` on macOS);
 * the main-process modules do not exist there. Here they are objects that
 * throw a clear error when used, so that importing them is not a build error.
 */
const MAIN_ONLY = [
  'app', 'autoUpdater', 'BaseWindow', 'BrowserView', 'BrowserWindow', 'clipboard', 'contentTracing',
  'contextBridge', 'crashReporter', 'desktopCapturer', 'dialog', 'globalShortcut', 'inAppPurchase',
  'ipcMain', 'ipcRenderer', 'Menu', 'MenuItem', 'MessageChannelMain', 'MessagePortMain', 'nativeImage',
  'nativeTheme', 'Notification', 'powerMonitor', 'powerSaveBlocker', 'protocol', 'pushNotifications',
  'safeStorage', 'screen', 'session', 'shell', 'TouchBar', 'Tray', 'utilityProcess', 'webContents',
  'WebContentsView', 'webFrame', 'webFrameMain', 'webUtils',
]

function unavailableError(name) {
  const error = new Error(`electron.${name} is not available in a utility process or forked child: it belongs to the main process. Ask the main process for it over process.parentPort / process.send.`)
  error.code = 'ERR_TAURI_ELECTRON_MAIN_ONLY'
  return error
}

function unavailable(name) {
  const fail = () => {
    throw unavailableError(name)
  }
  return new Proxy(function unavailableModule() {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined
      if (prop === '__tauriElectronUnavailable') return true
      return fail()
    },
    apply: fail,
    construct: fail,
  })
}

/** Electron's utility-process `net`: `fetch` is Node's own. */
export const net = {
  fetch: (input, init) => globalThis.fetch(input, init),
  isOnline: () => true,
  get online() {
    return true
  },
  request() {
    const error = new Error('net.request is not available in a tauri-electron utility process: use net.fetch, or node:http / node:https.')
    error.code = 'ERR_TAURI_ELECTRON_UNSUPPORTED'
    throw error
  },
}

/** Only a few macOS settings exist in Electron's utility process; none here. */
export const systemPreferences = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined
      return () => {
        const error = new Error(`systemPreferences.${String(prop)} is not available in a tauri-electron utility process.`)
        error.code = 'ERR_TAURI_ELECTRON_UNSUPPORTED'
        throw error
      }
    },
  },
)

export const app = unavailable('app')
export const autoUpdater = unavailable('autoUpdater')
export const BaseWindow = unavailable('BaseWindow')
export const BrowserView = unavailable('BrowserView')
export const BrowserWindow = unavailable('BrowserWindow')
export const clipboard = unavailable('clipboard')
export const contentTracing = unavailable('contentTracing')
export const contextBridge = unavailable('contextBridge')
export const crashReporter = unavailable('crashReporter')
export const desktopCapturer = unavailable('desktopCapturer')
export const dialog = unavailable('dialog')
export const globalShortcut = unavailable('globalShortcut')
export const inAppPurchase = unavailable('inAppPurchase')
export const ipcMain = unavailable('ipcMain')
export const ipcRenderer = unavailable('ipcRenderer')
export const Menu = unavailable('Menu')
export const MenuItem = unavailable('MenuItem')
export const MessageChannelMain = unavailable('MessageChannelMain')
export const MessagePortMain = unavailable('MessagePortMain')
export const nativeImage = unavailable('nativeImage')
export const nativeTheme = unavailable('nativeTheme')
export const Notification = unavailable('Notification')
export const powerMonitor = unavailable('powerMonitor')
export const powerSaveBlocker = unavailable('powerSaveBlocker')
export const protocol = unavailable('protocol')
export const pushNotifications = unavailable('pushNotifications')
export const safeStorage = unavailable('safeStorage')
export const screen = unavailable('screen')
export const session = unavailable('session')
export const shell = unavailable('shell')
export const TouchBar = unavailable('TouchBar')
export const Tray = unavailable('Tray')
export const utilityProcess = unavailable('utilityProcess')
export const webContents = unavailable('webContents')
export const WebContentsView = unavailable('WebContentsView')
export const webFrame = unavailable('webFrame')
export const webFrameMain = unavailable('webFrameMain')
export const webUtils = unavailable('webUtils')

const electron = { net, systemPreferences }
for (const name of MAIN_ONLY) {
  Object.defineProperty(electron, name, { enumerable: false, get: () => unavailable(name) })
}

export default electron
