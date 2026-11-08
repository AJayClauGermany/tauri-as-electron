/**
 * Placeholders for Electron modules tauri-electron does not implement yet.
 *
 * Event subscription methods (on/once/...) only warn, so app startup code
 * keeps running; any other method throws a NotImplementedError naming the
 * API, which makes gaps obvious (the kitchen sink relies on this).
 */
import { NotImplementedError, warnOnce } from '../internal/runtime.js'

const LISTENER_METHODS = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'prependListener'])

export function unsupportedModule(name, hint) {
  const target = { __tauriElectronUnsupported: true }
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj || typeof prop === 'symbol' || prop === 'then') return obj[prop]
      if (LISTENER_METHODS.has(prop)) {
        return () => {
          warnOnce(`${name}.${prop}`, `${name}.${String(prop)}() is ignored: ${name} is not implemented yet.`)
          return proxy
        }
      }
      return () => {
        throw new NotImplementedError(`${name}.${String(prop)}`, hint)
      }
    },
  })
  return proxy
}

export function unsupportedClass(name, hint) {
  return class {
    static __tauriElectronUnsupported = true
    constructor() {
      throw new NotImplementedError(`new ${name}()`, hint)
    }
  }
}

export const autoUpdater = unsupportedModule('autoUpdater', 'use @tauri-apps/plugin-updater')
export const crashReporter = unsupportedModule('crashReporter')
export const contentTracing = unsupportedModule('contentTracing')
export const desktopCapturer = unsupportedModule('desktopCapturer')
export const inAppPurchase = unsupportedModule('inAppPurchase')
export const net = unsupportedModule('net', 'use fetch() or @tauri-apps/plugin-http')
export const netLog = unsupportedModule('netLog')
export const powerMonitor = unsupportedModule('powerMonitor')
export const powerSaveBlocker = unsupportedModule('powerSaveBlocker')
export const protocol = unsupportedModule('protocol', 'register URI scheme protocols from Rust')
export const pushNotifications = unsupportedModule('pushNotifications')
export const safeStorage = unsupportedModule('safeStorage', 'consider tauri-plugin-stronghold or the keyring crate')
export const session = unsupportedModule('session')
export const systemPreferences = unsupportedModule('systemPreferences')
export const utilityProcess = unsupportedModule('utilityProcess', 'use a sidecar via @tauri-apps/plugin-shell')
export const webFrameMain = unsupportedModule('webFrameMain')
export const webUtils = { getPathForFile: (file) => file?.path ?? '' }

export const BrowserView = unsupportedClass('BrowserView')
export const WebContentsView = unsupportedClass('WebContentsView')
export const MessageChannelMain = unsupportedClass('MessageChannelMain')
export const ShareMenu = unsupportedClass('ShareMenu')
export const TouchBar = unsupportedClass('TouchBar')
export const View = unsupportedClass('View')
export const sharedTexture = unsupportedModule('sharedTexture')
export const ImageView = unsupportedClass('ImageView')
export const IpcMainServiceWorker = unsupportedClass('IpcMainServiceWorker')
