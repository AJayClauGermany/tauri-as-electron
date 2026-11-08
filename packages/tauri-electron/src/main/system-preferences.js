/**
 * systemPreferences: best effort from CSS media queries and CSS system
 * colors (Tauri has no plugin for OS preferences). macOS user defaults and
 * notifications are not readable: getters return empty defaults and
 * subscriptions never fire.
 */
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError } from '../internal/runtime.js'
import { nativeTheme } from './native-theme.js'

function mediaMatches(query) {
  return typeof matchMedia === 'function' && matchMedia(query).matches
}

/** Resolve a CSS color (e.g. the `AccentColor` system color) to 'rrggbbaa'. */
export function resolveCssColor(color) {
  if (typeof document === 'undefined' || !document.body) return ''
  const probe = document.createElement('div')
  probe.style.color = 'rgba(1, 2, 3, 0.5)'
  probe.style.color = color
  if (probe.style.color === 'rgba(1, 2, 3, 0.5)') return '' // unsupported value
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  return rgbToHex(computed)
}

export function rgbToHex(rgb) {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(rgb ?? '')
  if (!match) return ''
  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4])
  return [match[1], match[2], match[3], alpha * 255]
    .map((v) => Math.round(Number(v)).toString(16).padStart(2, '0'))
    .join('')
}

/** Electron color names -> CSS system colors. */
const CSS_SYSTEM_COLORS = {
  'window-background': 'Canvas',
  window: 'Canvas',
  'window-frame-text': 'CanvasText',
  'window-text': 'CanvasText',
  'text-color': 'CanvasText',
  'label-color': 'CanvasText',
  'control-background': 'Field',
  'control-text': 'FieldText',
  'button-text': 'ButtonText',
  '3d-face': 'ButtonFace',
  highlight: 'Highlight',
  'highlight-text': 'HighlightText',
  'selected-text-background': 'Highlight',
  'selected-text': 'HighlightText',
  'keyboard-focus-indicator': 'AccentColor',
  'control-accent': 'AccentColor',
  'link': 'LinkText',
  hotlight: 'LinkText',
  'disabled-control-text': 'GrayText',
  'gray-text': 'GrayText',
}

const USER_DEFAULT_EMPTY = { string: '', boolean: false, integer: 0, float: 0, double: 0, url: '', array: [], dictionary: {} }

let nextSubscription = 1

class SystemPreferences extends EventEmitter {
  constructor() {
    super()
    this.accessibilityDisplayShouldReduceTransparency = false
    this.effectiveAppearance = undefined
  }

  isDarkMode() {
    return nativeTheme.shouldUseDarkColors
  }

  getEffectiveAppearance() {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  isHighContrastColorScheme() {
    return nativeTheme.shouldUseHighContrastColors || mediaMatches('(prefers-contrast: more)')
  }

  isInvertedColorScheme() {
    return nativeTheme.shouldUseInvertedColorScheme
  }

  getAnimationSettings() {
    const prefersReducedMotion = mediaMatches('(prefers-reduced-motion: reduce)')
    return { shouldRenderRichAnimation: !prefersReducedMotion, scrollAnimationsEnabledBySystem: !prefersReducedMotion, prefersReducedMotion }
  }

  getAccentColor() {
    return resolveCssColor('AccentColor')
  }

  getColor(name) {
    const css = CSS_SYSTEM_COLORS[name]
    const hex = css ? resolveCssColor(css) : ''
    return hex ? `#${hex.slice(0, 6)}` : '#000000'
  }

  getSystemColor(name) {
    return this.getColor(String(name))
  }

  // --- macOS user defaults -------------------------------------------------------
  getUserDefault(_key, type) {
    const value = USER_DEFAULT_EMPTY[type]
    return Array.isArray(value) ? [] : value && typeof value === 'object' ? {} : value
  }
  setUserDefault() {}
  removeUserDefault() {}
  registerDefaults() {}

  // --- notifications (never fire) ----------------------------------------------------
  subscribeNotification() { return nextSubscription++ }
  subscribeLocalNotification() { return nextSubscription++ }
  subscribeWorkspaceNotification() { return nextSubscription++ }
  unsubscribeNotification() {}
  unsubscribeLocalNotification() {}
  unsubscribeWorkspaceNotification() {}
  postNotification() {}
  postLocalNotification() {}
  postWorkspaceNotification() {}

  // --- media / accessibility / security ---------------------------------------------
  getMediaAccessStatus() {
    return 'granted'
  }
  askForMediaAccess() {
    return Promise.resolve(true)
  }
  isTrustedAccessibilityClient() {
    return false
  }
  canPromptTouchID() {
    return false
  }
  promptTouchID() {
    return Promise.reject(new NotImplementedError('systemPreferences.promptTouchID', { reason: 'unimplemented', hint: 'Needs a Rust command (LocalAuthentication on macOS).' }))
  }
  isAeroGlassEnabled() {
    return true
  }
  isSwipeTrackingFromScrollEventsEnabled() {
    return false
  }
}

export const systemPreferences = new SystemPreferences()
