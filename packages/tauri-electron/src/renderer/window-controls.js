/**
 * Window controls for `titleBarStyle: 'hidden'` + `titleBarOverlay` on
 * Windows and Linux. Electron draws native minimize / maximize / close
 * buttons over the top-right corner of such a frameless window; Tauri has
 * none, so the renderer bootstrap draws them (in a shadow root, above the
 * page) with the overlay's `color`, `symbolColor` and `height`.
 * `win.setTitleBarOverlay()` restyles them.
 *
 * `navigator.windowControlsOverlay` (`visible`, `getTitlebarAreaRect()`,
 * `geometrychange`) is provided when the webview has none, and the
 * title-bar area is exposed as the CSS custom properties
 * `--titlebar-area-x`, `--titlebar-area-y`, `--titlebar-area-width` and
 * `--titlebar-area-height` (WebKit has no `env(titlebar-area-*)`).
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { report } from '../internal/runtime.js'
import { commandHandlers } from './ipc-renderer.js'

const BUTTON_WIDTH = 46
export const DEFAULT_HEIGHT = 32

const ICONS = {
  minimize: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 5.5h10" stroke="currentColor" fill="none"/></svg>',
  maximize: '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none"/></svg>',
  restore: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z" stroke="currentColor" fill="none"/></svg>',
  close: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" fill="none"/></svg>',
}

/** Electron's titleBarOverlay option (true or an object) → what the bootstrap draws. */
export function normalizeOverlay(overlay, current = {}) {
  if (!overlay) return null
  const value = overlay === true ? {} : overlay
  return {
    color: value.color ?? current.color ?? 'transparent',
    symbolColor: value.symbolColor ?? current.symbolColor ?? '',
    height: Number(value.height ?? current.height ?? DEFAULT_HEIGHT) || DEFAULT_HEIGHT,
    minimizable: value.minimizable ?? current.minimizable ?? true,
    maximizable: value.maximizable ?? current.maximizable ?? true,
    closable: value.closable ?? current.closable ?? true,
  }
}

/** The title-bar area: the top strip left of the controls. */
export function titlebarAreaRect(overlay, viewportWidth) {
  const buttons = ['minimizable', 'maximizable', 'closable'].filter((k) => overlay[k] !== false).length
  return { x: 0, y: 0, width: Math.max(0, viewportWidth - buttons * BUTTON_WIDTH), height: overlay.height }
}

class WindowControlsOverlay extends EventTarget {
  constructor(state) {
    super()
    this._state = state
    this.ongeometrychange = null
  }

  get visible() {
    return Boolean(this._state.overlay)
  }

  getTitlebarAreaRect() {
    const r = this._state.overlay ? titlebarAreaRect(this._state.overlay, innerWidth) : { x: 0, y: 0, width: 0, height: 0 }
    return new DOMRect(r.x, r.y, r.width, r.height)
  }

  _changed() {
    const event = new Event('geometrychange')
    event.titlebarAreaRect = this.getTitlebarAreaRect()
    event.visible = this.visible
    this.ongeometrychange?.(event)
    this.dispatchEvent(event)
  }
}

export function installWindowControls(initial) {
  const state = { overlay: normalizeOverlay(initial) }
  if (!state.overlay) return null
  const win = getCurrentWindow()
  const host = document.createElement('div')
  host.setAttribute('data-tauri-electron', 'window-controls')
  // Inline so the bootstrap's drag-region code sees it: the buttons never drag the window.
  host.setAttribute('style', 'position:fixed;top:0;right:0;z-index:2147483647;display:flex;-webkit-app-region:no-drag;app-region:no-drag')
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>
    :host { all: initial; }
    .bar { display: flex; height: var(--h); background: var(--bg); color: var(--fg); }
    @media (prefers-color-scheme: dark) { .bar { color: var(--fg-dark); } }
    button { all: unset; width: ${BUTTON_WIDTH}px; height: 100%; display: grid; place-items: center; cursor: default; }
    button:hover { background: rgba(128, 128, 128, 0.25); }
    button:active { background: rgba(128, 128, 128, 0.4); }
    button.close:hover { background: #e81123; color: #fff; }
    button.close:active { background: #f1707a; color: #fff; }
    button[hidden] { display: none; }
  </style><div class="bar" part="bar"><button class="minimize" title="Minimize" aria-label="Minimize">${ICONS.minimize}</button><button class="maximize" title="Maximize" aria-label="Maximize">${ICONS.maximize}</button><button class="close" title="Close" aria-label="Close">${ICONS.close}</button></div>`
  const bar = root.querySelector('.bar')
  const [minimize, maximize, close] = root.querySelectorAll('button')
  minimize.addEventListener('click', () => win.minimize().catch(report('window controls: minimize')))
  maximize.addEventListener('click', () => win.toggleMaximize().catch(report('window controls: maximize')))
  close.addEventListener('click', () => win.close().catch(report('window controls: close')))
  for (const button of [minimize, maximize, close]) button.addEventListener('dblclick', (event) => event.stopPropagation())

  let overlayApi = navigator.windowControlsOverlay
  if (!overlayApi) {
    overlayApi = new WindowControlsOverlay(state)
    try {
      Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlayApi, configurable: true })
    } catch {
      /* read-only navigator: the CSS variables still work */
    }
  }

  const apply = () => {
    const o = state.overlay
    host.style.display = o ? 'flex' : 'none'
    if (!o) return
    bar.style.setProperty('--h', `${o.height}px`)
    bar.style.setProperty('--bg', o.color)
    bar.style.setProperty('--fg', o.symbolColor || '#1f1f1f')
    bar.style.setProperty('--fg-dark', o.symbolColor || '#f2f2f2')
    minimize.hidden = o.minimizable === false
    maximize.hidden = o.maximizable === false
    close.hidden = o.closable === false
    const rect = titlebarAreaRect(o, innerWidth)
    const css = document.documentElement.style
    css.setProperty('--titlebar-area-x', `${rect.x}px`)
    css.setProperty('--titlebar-area-y', `${rect.y}px`)
    css.setProperty('--titlebar-area-width', `${rect.width}px`)
    css.setProperty('--titlebar-area-height', `${rect.height}px`)
    overlayApi._changed?.()
  }

  const showMaximized = (maximized) => {
    maximize.innerHTML = maximized ? ICONS.restore : ICONS.maximize
    maximize.title = maximize.ariaLabel = maximized ? 'Restore' : 'Maximize'
  }
  const refreshMaximized = () => win.isMaximized().then(showMaximized, () => {})
  win.onResized(refreshMaximized).catch(() => {})
  refreshMaximized()
  addEventListener('resize', apply)

  const mount = () => {
    ;(document.body ?? document.documentElement).appendChild(host)
    apply()
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  commandHandlers['title-bar-overlay'] = ({ overlay }) => {
    state.overlay = overlay ? normalizeOverlay(overlay, state.overlay ?? {}) : null
    apply()
  }
  return { host, state, apply }
}
