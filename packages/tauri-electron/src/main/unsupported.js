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

export const contentTracing = unsupportedModule('contentTracing')
export const desktopCapturer = unsupportedModule('desktopCapturer')
export const inAppPurchase = unsupportedModule('inAppPurchase')
export const netLog = unsupportedModule('netLog')
export const pushNotifications = unsupportedModule('pushNotifications')
export const utilityProcess = unsupportedModule('utilityProcess', 'run Node code as a sidecar via @tauri-apps/plugin-shell')

export const BrowserView = unsupportedClass('BrowserView')
export const WebContentsView = unsupportedClass('WebContentsView')
export const ShareMenu = unsupportedClass('ShareMenu')
export const View = unsupportedClass('View')
export const sharedTexture = unsupportedModule('sharedTexture')
export const ImageView = unsupportedClass('ImageView')
export const IpcMainServiceWorker = unsupportedClass('IpcMainServiceWorker')

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
