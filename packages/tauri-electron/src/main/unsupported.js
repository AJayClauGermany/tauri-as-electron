/**
 * Placeholders for Electron modules tauri-electron does not implement yet.
 *
 * Event subscription methods (on/once/...) only warn, so app startup code
 * keeps running; any other method throws a NotImplementedError naming the
 * API, which makes gaps obvious (the kitchen sink relies on this).
 */
import { NotImplementedError, warnOnce } from '../internal/runtime.js'

const LISTENER_METHODS = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'prependListener'])

export function unsupportedModule(name, details) {
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
        throw new NotImplementedError(`${name}.${String(prop)}`, details)
      }
    },
  })
  return proxy
}

export function unsupportedClass(name, details) {
  return class {
    static __tauriElectronUnsupported = true
    constructor() {
      throw new NotImplementedError(`new ${name}()`, details)
    }
  }
}

// Chromium / Node features with no counterpart in Tauri: not planned.
const CHROMIUM = { reason: 'unsupported', hint: 'A Chromium feature with no counterpart in WebKit / WebView2.' }
export const contentTracing = unsupportedModule('contentTracing', CHROMIUM)
export const desktopCapturer = unsupportedModule('desktopCapturer', { reason: 'unsupported', hint: 'Screen capture needs a Rust command; the webview cannot enumerate screens.' })
export const inAppPurchase = unsupportedModule('inAppPurchase', { reason: 'unsupported', hint: 'StoreKit needs a Rust / Swift integration.' })
export const netLog = unsupportedModule('netLog', CHROMIUM)
export const pushNotifications = unsupportedModule('pushNotifications', { reason: 'unsupported', hint: 'APNs registration needs a Rust / Swift integration.' })
export const utilityProcess = unsupportedModule('utilityProcess', { reason: 'unsupported', hint: 'There is no Node.js runtime. Run Node code as a sidecar via @tauri-apps/plugin-shell, or move it to Rust.' })
export const sharedTexture = unsupportedModule('sharedTexture', CHROMIUM)

// Electron's view hierarchy: a Tauri window holds exactly one webview.
const VIEWS = { reason: 'unsupported', hint: 'Electron views have no Tauri equivalent; use one BrowserWindow per webview.' }
export const BrowserView = unsupportedClass('BrowserView', VIEWS)
export const View = unsupportedClass('View', VIEWS)
export const ImageView = unsupportedClass('ImageView', VIEWS)
export const WebContentsView = unsupportedClass('WebContentsView', { reason: 'unimplemented', hint: "Tauri's multi-webview windows (unstable) could back this." })
export const ShareMenu = unsupportedClass('ShareMenu', { reason: 'unimplemented', hint: 'The macOS share sheet needs a Rust command.' })
export const IpcMainServiceWorker = unsupportedClass('IpcMainServiceWorker', CHROMIUM)

/**
 * macOS Touch Bar: accepted and ignored, so `win.setTouchBar(new TouchBar(...))`
 * keeps working (Tauri has no Touch Bar API).
 */
class TouchBarItem {
  constructor(options = {}) {
    Object.assign(this, options)
  }
}

export class TouchBar {
  constructor(options = {}) {
    this.items = options.items ?? []
    this.escapeItem = options.escapeItem ?? null
  }

  static TouchBarButton = class TouchBarButton extends TouchBarItem {}
  static TouchBarColorPicker = class TouchBarColorPicker extends TouchBarItem {}
  static TouchBarGroup = class TouchBarGroup extends TouchBarItem {}
  static TouchBarLabel = class TouchBarLabel extends TouchBarItem {}
  static TouchBarPopover = class TouchBarPopover extends TouchBarItem {}
  static TouchBarScrubber = class TouchBarScrubber extends TouchBarItem {}
  static TouchBarSegmentedControl = class TouchBarSegmentedControl extends TouchBarItem {}
  static TouchBarSlider = class TouchBarSlider extends TouchBarItem {}
  static TouchBarSpacer = class TouchBarSpacer extends TouchBarItem {}
  static TouchBarOtherItemsProxy = class TouchBarOtherItemsProxy extends TouchBarItem {}
}
