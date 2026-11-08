/** nativeTheme: cached OS theme, kept fresh via Tauri's theme-changed event. */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { setTheme } from '@tauri-apps/api/app'
import { EventEmitter } from '../internal/emitter.js'
import { inTauri, report } from '../internal/runtime.js'

function mediaPrefersDark() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

class NativeTheme extends EventEmitter {
  constructor() {
    super()
    this._systemDark = mediaPrefersDark()
    this._source = 'system'
    this.shouldUseHighContrastColors = false
    this.shouldUseInvertedColorScheme = false
    this.inForcedColorsMode = false
    this.prefersReducedTransparency = false
  }

  get shouldUseDarkColors() {
    if (this._source === 'dark') return true
    if (this._source === 'light') return false
    return this._systemDark
  }

  get shouldUseDarkColorsForSystemIntegratedUI() {
    return this.shouldUseDarkColors
  }

  get themeSource() {
    return this._source
  }

  set themeSource(value) {
    if (!['system', 'light', 'dark'].includes(value)) return
    const before = this.shouldUseDarkColors
    this._source = value
    setTheme(value === 'system' ? null : value).catch(report('nativeTheme.themeSource'))
    if (before !== this.shouldUseDarkColors) this.emit('updated')
  }

  _setSystemTheme(theme) {
    const before = this.shouldUseDarkColors
    this._systemDark = theme === 'dark'
    if (before !== this.shouldUseDarkColors) this.emit('updated')
  }
}

export const nativeTheme = new NativeTheme()

export async function initNativeTheme() {
  if (!inTauri) return
  const win = getCurrentWindow()
  try {
    const theme = await win.theme()
    if (theme) nativeTheme._systemDark = theme === 'dark'
  } catch (error) {
    report('nativeTheme init')(error)
  }
  win.onThemeChanged(({ payload }) => nativeTheme._setSystemTheme(payload)).catch(report('nativeTheme listener'))
}
