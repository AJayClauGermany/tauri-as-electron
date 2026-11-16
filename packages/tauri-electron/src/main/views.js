/**
 * Views: `View`, `WebContentsView`, the legacy `BrowserView`,
 * `BrowserWindow#contentView` and the main-process side of the `<webview>`
 * tag, on child webviews of a Tauri window (tauri-plugin-electron's
 * `child-webviews` feature, src/views.rs).
 *
 * Every `WebContentsView` and every `<webview>` guest has a real
 * webContents (`GuestWebContents`, the BrowserWindow webContents with a
 * `GuestHost` in place of the window): IPC, `executeJavaScript`, navigation
 * events, `webContents.fromId` / `getAllWebContents`, downloads and
 * permission requests work as for windows. Its Tauri webview (label
 * `electron-view-<id>`) is created once the view is in a window's view tree,
 * hidden when the view leaves it, moved when it joins another window's tree,
 * and closed by `webContents.close()`.
 *
 * Pages without the renderer bootstrap (remote pages) are driven from Rust:
 * `loadURL` / `reload` navigate the webview, `executeJavaScript` evaluates
 * the code there (results as JSON; promises are awaited by polling).
 *
 * `<webview>`: the element (src/renderer/webview-tag.js) asks the main
 * process to attach a guest (`will-attach-webview`, `did-attach-webview`),
 * reports its box straight to Rust, calls guest methods through here and
 * receives the guest's events.
 */
import { invoke } from '@tauri-apps/api/core'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { bus } from '../internal/bus.js'
import { native, hasNativePlugin, hasFeature, featureError } from '../internal/native.js'
import { NotImplementedError, deferred, report, warnOnce } from '../internal/runtime.js'
import { encode, decodeArgs } from '../internal/serialize.js'
import { BrowserWindow, WebContents, guests, fileToUrl, fileUrlToAppUrl } from './browser-window.js'
import { session as sessionModule } from './session.js'
import { toNativeSchemeUrl } from './protocol.js'
import { registerTrustedRenderer, trustedRendererRegistered } from './trusted-origins.js'

const FEATURE = 'child-webviews'

/** Throws unless views can be created here. */
function requireViews(api) {
  if (!hasNativePlugin()) throw new NotImplementedError(api, { reason: 'plugin', hint: 'Views need tauri-plugin-electron.' })
  if (!hasFeature(FEATURE)) throw featureError(api, FEATURE)
}

// ---------------------------------------------------------------------------
// executeJavaScript for pages without the renderer bootstrap
// ---------------------------------------------------------------------------

let nextEval = 1

/** Runs `code` and answers `{ ok, value | undef | error }`, or `{ pending }` for a promise (kept until polled). */
export function evalScript(id, code) {
  return `(() => {
  const store = window.__tauriElectronEval || (window.__tauriElectronEval = {})
  const fail = (e) => ({ ok: false, error: { name: (e && e.name) || 'Error', message: String((e && e.message) || e) } })
  const done = (v) => { try { return v === undefined ? { ok: true, undef: true } : { ok: true, value: JSON.parse(JSON.stringify(v) ?? 'null') } } catch (e) { return fail(e) } }
  try {
    const result = (0, eval)(${JSON.stringify(String(code))})
    if (result && typeof result.then === 'function') {
      store[${id}] = { pending: true }
      result.then((v) => { store[${id}] = done(v) }, (e) => { store[${id}] = fail(e) })
      return { pending: true }
    }
    return done(result)
  } catch (e) { return fail(e) }
})()`
}

/** The settled result of evalScript's promise `id`; `{ gone }` once the page changed. */
export function pollScript(id) {
  return `(() => { const store = window.__tauriElectronEval; const r = store && store[${id}]; if (!r) return { gone: true }; if (r.pending) return { pending: true }; delete store[${id}]; return r })()`
}

function parseAnswer(raw) {
  if (!raw) return { ok: false, error: { name: 'Error', message: 'Script failed to execute' } }
  try {
    const answer = typeof raw === 'string' ? JSON.parse(raw) : raw
    return answer && typeof answer === 'object' ? answer : { ok: true, value: answer }
  } catch {
    return { ok: false, error: { name: 'Error', message: 'Script result is not serializable' } }
  }
}

function settle(answer) {
  if (answer.ok) return answer.undef ? undefined : answer.value
  const error = new Error(answer.error?.message ?? 'Script failed to execute')
  if (answer.error?.name) error.name = answer.error.name
  throw error
}

/** executeJavaScript through Rust (`view_eval`): any page, values as JSON. */
async function evaluateInView(contents, code) {
  const id = nextEval++
  const run = (script) => native('view_eval', { label: contents._label, script }).then(parseAnswer)
  let answer = await run(evalScript(id, code))
  let wait = 15
  while (answer.pending) {
    if (contents.isDestroyed()) throw new Error('The webContents was destroyed')
    await new Promise((resolve) => setTimeout(resolve, wait))
    wait = Math.min(wait * 2, 200)
    answer = await run(pollScript(id))
    if (answer.gone) throw new Error('The page navigated before the script finished')
  }
  return settle(answer)
}

/** Commands the renderer bootstrap would run, as script for a page without it. */
const SCRIPT_COMMANDS = {
  'history-go': ({ offset }) => `history.go(${Number(offset) || 0})`,
  stop: () => 'window.stop()',
}

// ---------------------------------------------------------------------------
// Guest webContents
// ---------------------------------------------------------------------------

/**
 * What a guest's webContents needs from "its window" (the role a
 * BrowserWindow plays for a window's webContents): identity, session,
 * webPreferences, loading, zoom, focus, and the Tauri webview's lifecycle.
 */
class GuestHost {
  constructor({ kind, webPreferences = {}, session }) {
    this.id = guests.nextId()
    this._contentsType = kind // webContents.getType(): 'browserView' or 'webview'
    this._options = { webPreferences: { ...webPreferences } }
    this._session = session
    this._label = ''
    this._generation = 0
    this._native = false
    this._creating = null
    this._destroyed = false
    this._window = null // the BrowserWindow the Tauri webview is in
    this._pendingUrl = null
    this._loadWaiters = []
    this._state = { title: '' }
    this._visible = true
    this._focused = false
    this._placement = null // { bounds, visible } last sent to Rust
    this._trustedRenderer = false // created with the trusted origins' renderer script
    this.webContents = null
  }

  /**
   * Settles as a window's `_nativeReady` does, for code shared with windows
   * (./capture.js): once the webview exists; rejects while the view is in no window.
   */
  get _nativeReady() {
    const promise = (this._creating ?? Promise.resolve()).then(() => {
      if (!this._native) throw new Error('The view is not in a window')
    })
    return { promise }
  }

  /** Whether a page at `url` runs the renderer bootstrap: app pages and, as in windows, trusted origins. */
  _hasBootstrap(url) {
    return BrowserWindow.prototype._hasBootstrap.call(this, url)
  }

  isDestroyed() {
    return this._destroyed
  }

  isVisible() {
    return this._visible
  }

  isFocused() {
    return this._focused
  }

  focus() {
    if (this._native) this._update({ focus: true })
  }

  close() {
    this.destroy()
  }

  /** Not a window: no title bar overlay (used by BrowserWindow#_rendererConfig). */
  _titleBarOverlayConfig() {
    return null
  }

  _rendererConfig() {
    return { ...BrowserWindow.prototype._rendererConfig.call(this), guest: this._contentsType }
  }

  /** Tauri webview options (a WindowConfig, as for create_window). */
  _nativeOptions(label, url, bounds) {
    const prefs = this._options.webPreferences
    const options = {
      label,
      url,
      x: bounds.x,
      y: bounds.y,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      focus: false,
      devtools: prefs.devTools !== false,
      ...this._session?._tauriWebviewOptions?.(),
    }
    if (prefs.javascript === false) options.javascriptDisabled = true
    if (prefs.backgroundThrottling === false) options.backgroundThrottling = 'disabled'
    if (tauriColor(this._backgroundColor)) options.backgroundColor = tauriColor(this._backgroundColor)
    if (prefs.transparent) options.transparent = true
    const userAgent = this.webContents._userAgent || this._session?._userAgent
    if (userAgent) options.userAgent = userAgent
    return options
  }

  /** Create the Tauri webview in `win` (once its native window exists). */
  _create(win, placement, extras = {}) {
    if (this._creating || this._native || this._destroyed) return this._creating ?? Promise.resolve()
    this._window = win
    this._placement = placement
    // The page: `_pendingUrl` (set by loadURL()), read when the webview is
    // made and kept until it exists: a creation abandoned (window gone) or
    // retried in the window the view moved to keeps it; one that fails is
    // reported to the waiting loadURL()s and drops it.
    let url = 'about:blank'
    this._creating = (async () => {
      await win._nativeReady.promise
      if (this._destroyed || win.isDestroyed()) return
      url = this._pendingUrl ?? 'about:blank'
      const generation = ++this._generation
      const label = `electron-view-${this.id}${generation > 1 ? `-${generation}` : ''}`
      this._label = label
      guests.register(this.webContents, label)
      this.webContents._url = url
      this.webContents._alive = false
      await Promise.all([native('set_window_config', { label, config: this._rendererConfig() }), registerTrustedRenderer()])
      // Created with the trusted origins' renderer script (an initialization script).
      this._trustedRenderer = trustedRendererRegistered()
      const { bounds, visible } = this._placement
      await native('view_create', {
        window: win._label,
        options: this._nativeOptions(label, url, bounds),
        extras: {
          ...extras,
          bounds,
          visible,
          permissionHandler: typeof this._session?._handlers?.permissionRequest === 'function',
          proxyConfigured: Boolean(this._session?._proxyConfigured),
          webRequest: this._session?.webRequest?._events?.() ?? [],
        },
      })
      if (this._destroyed) {
        // Destroyed while being created: destroy() found nothing native to clean up.
        native('set_window_config', { label, config: null }).catch(() => {})
        return native('view_close', { label }).catch(() => {})
      }
      this._native = true
      // The window closed while the webview was being created (_onWindowGone
      // had nothing native to forget then): forget it now (finally() below
      // creates it in the window it was moved to meanwhile, if any).
      if (win.isDestroyed()) {
        const movedTo = this._window
        const next = this._pendingUrl
        this._onWindowGone()
        if (next) this._pendingUrl = next
        if (movedTo !== win) this._window = movedTo
        return
      }
      // A loadURL() made while the webview was being created. As for a
      // BrowserWindow, the next finished load settles the waiting loadURL()s
      // (here possibly the created page's, if it finishes before the
      // navigation starts; its events also report its URL meanwhile).
      const next = this._pendingUrl
      this._pendingUrl = null
      if (next && next !== url) this._navigate(next)
      if (this.webContents._zoomFactor !== 1) this._call((n) => n.setZoom(this.webContents._zoomFactor), 'setZoomFactor')
      // A placement that changed while the webview was being created.
      const latest = this._placement
      if (latest !== placement) {
        this._placement = placement
        this._place(latest)
      }
    })()
      .catch((error) => {
        // No webview for the label: its window config and guest entry go too.
        if (this._label && !this._native) {
          guests.forgetLabel(this._label)
          native('set_window_config', { label: this._label, config: null }).catch(() => {})
        }
        // Created again in the window it moved to (below): not a failed load.
        if (this._movedAway(win)) return
        report('create view')(error)
        // The loads waiting for this creation failed: a later attach does not retry them.
        const failedUrl = this._pendingUrl ?? url
        this._pendingUrl = null
        this._loadFailed(error, failedUrl)
      })
      .finally(() => {
        this._creating = null
        // Moved to another window while `win` went away (whichever way the
        // creation ended): create it there, with the latest loadURL().
        if (this._movedAway(win)) this._create(this._window, this._placement)
      })
    return this._creating
  }

  /** Not created, and now in a live window other than `win`. */
  _movedAway(win) {
    const target = this._window
    return !this._native && !this._destroyed && Boolean(target) && target !== win && !target.isDestroyed()
  }

  /** Navigate the created webview (loadURL()). */
  _navigate(url) {
    this.webContents._alive = false
    this.webContents._url = url
    native('view_navigate', { label: this._label, url: guests.absoluteAppUrl(url) }).catch((error) => this._loadFailed(error, url))
  }

  _loadFailed(error, url) {
    for (const waiter of this._loadWaiters.splice(0)) waiter.reject(error)
    this.webContents?.emit('did-fail-load', createEvent(), -2, String(error?.message ?? error), url, true, 0, 0)
  }

  _update(update) {
    if (!this._native || this._destroyed) return Promise.resolve()
    return native('view_update', { label: this._label, update }).catch(report('view update'))
  }

  /** Where the view is and whether it shows. */
  _place(placement) {
    const previous = this._placement
    this._placement = placement
    if (!this._native) return
    const update = {}
    if (!previous || JSON.stringify(previous.bounds) !== JSON.stringify(placement.bounds)) update.bounds = placement.bounds
    if (!previous || previous.visible !== placement.visible) update.visible = placement.visible
    if (Object.keys(update).length) this._update(update)
  }

  /** In `win` (created there, or moved from another window), placed, or hidden when `win` is null. */
  _attach(win, placement) {
    if (this._destroyed) return
    if (!win) {
      this._visible = false
      this._place({ ...(this._placement ?? placement), visible: false })
      return
    }
    this._visible = placement.visible
    if (!this._native && !this._creating) {
      this._create(win, placement)
      return
    }
    if (this._window !== win) {
      // Into another window: Rust moves the webview there, then places it.
      this._window = win
      this._placement = placement
      const moved = this._creating ?? Promise.resolve()
      moved.then(() => win._nativeReady.promise).then(() => {
        if (!this._native || this._window !== win) return
        const { bounds, visible } = this._placement
        return this._update({ window: win._label, bounds, visible })
      }).catch(report('move view'))
      return
    }
    this._place(placement)
  }

  /** The window's native window is gone, and this webview with it. */
  _onWindowGone() {
    if (!this._native) return
    this._native = false
    // Its page ended; what is sent now waits for the page in the next window.
    this.webContents._alive = false
    this.webContents._pageEnded(this._label, { keepQueue: true })
    guests.forgetLabel(this._label)
    native('set_window_config', { label: this._label, config: null }).catch(() => {})
    // A view can be put into another window: it reloads its page there.
    this._pendingUrl = this.webContents._url || null
    this._window = null
  }

  _call(fn, what) {
    if (this._destroyed) return Promise.resolve()
    const facade = {
      setZoom: (value) => invoke('plugin:webview|set_webview_zoom', { label: this._label, value }),
    }
    const ready = this._creating ?? Promise.resolve()
    return ready.then(() => (this._native ? fn(facade) : undefined)).catch(report(`webContents.${what}`))
  }

  loadURL(url, options) {
    url = toNativeSchemeUrl(fileUrlToAppUrl(String(url)))
    if (options?.userAgent) this.webContents._userAgent = options.userAgent
    const { promise, resolve, reject } = deferred()
    if (this._destroyed) {
      reject(new Error('Object has been destroyed'))
      return promise
    }
    this._loadWaiters.push({ resolve, reject })
    if (!this._native) {
      // Loaded when the webview is made (or, if it is being made, right after).
      this._pendingUrl = url
      return promise
    }
    this._navigate(url)
    return promise
  }

  loadFile(filePath, options) {
    return this.loadURL(fileToUrl(filePath, options))
  }

  _onDidFinishLoad(synthetic = false) {
    if (synthetic) {
      this.webContents._loading = false
      this.webContents.emit('dom-ready', createEvent())
      this.webContents.emit('did-finish-load', createEvent())
    }
    for (const waiter of this._loadWaiters.splice(0)) waiter.resolve()
  }

  _onPageTitleUpdated(title) {
    this._state.title = title
  }

  _onMenuBarAlt() {}

  /** `webContents.close()`: the webview goes away; the webContents is destroyed. */
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    const label = this._label
    const wasNative = this._native
    this._native = false
    if (wasNative) {
      native('view_close', { label }).catch(report('close view'))
      native('set_window_config', { label, config: null }).catch(() => {})
    }
    guests.unregister(this.webContents, label)
    this.webContents._pageEnded(label)
    for (const waiter of this._loadWaiters.splice(0)) waiter.reject(new Error('The webContents was destroyed'))
    this.webContents.emit('destroyed', createEvent())
  }
}

/** The webContents of a view or `<webview>` guest. */
export class GuestWebContents extends WebContents {
  getType() {
    return this._win._contentsType
  }

  /** The window the view (or the `<webview>`'s page) is in. */
  getOwnerBrowserWindow() {
    return this._win._window ?? null
  }

  /** Pages without the bootstrap get bootstrap commands as script. */
  _command(name, data = {}) {
    if (this._alive || !this._win._native || this._win._hasBootstrap(this._url)) return super._command(name, data)
    const script = SCRIPT_COMMANDS[name]?.(data)
    if (script) evaluateInView(this, script).catch(report(`webContents ${name}`))
  }

  async executeJavaScript(code, userGesture) {
    if (this.isDestroyed()) throw new Error('Object has been destroyed')
    await this._win._creating
    // Pages with the bootstrap run it there (structured-clone results).
    if (this._alive || !this._win._native || this._win._hasBootstrap(this._url)) return super.executeJavaScript(code, userGesture)
    return evaluateInView(this, code)
  }

  /** Pages without the bootstrap never report through it: their loads come from Rust only. */
  isLoading() {
    return this._loading || (!this._alive && this._win._hasBootstrap(this._url))
  }

  reload() {
    if (this._alive) return super.reload()
    if (this._win._native) native('view_navigate', { label: this._label, reload: true }).catch(report('reload'))
  }

  _onWindowOpen(data) {
    // <webview> without `allowpopups`: window.open() and target=_blank do nothing.
    if (this._win._options.webPreferences.disablePopups) return
    super._onWindowOpen(data)
  }

  /** `ipcRenderer.sendToHost()` from this page: an 'ipc-message' on the `<webview>` element. */
  _sendToHost(channel, args) {
    this._tag?.forward('ipc-message', { channel: String(channel), frameId: [this.getProcessId(), this.mainFrame.routingId] }, args)
  }

  close() {
    this._win.destroy()
  }

  destroy() {
    this._win.destroy()
  }
}

function createGuest(kind, webPreferences = {}, contents, setup) {
  if (contents) {
    if (!(contents instanceof GuestWebContents) || contents._win._view || contents.isDestroyed()) {
      throw new Error('webContents must be the unused webContents of a WebContentsView')
    }
    return contents
  }
  const session = webPreferences.session ?? (webPreferences.partition ? sessionModule.fromPartition(webPreferences.partition) : sessionModule.defaultSession)
  const host = new GuestHost({ kind, webPreferences, session })
  const created = new GuestWebContents(host)
  host.webContents = created
  if (webPreferences.zoomFactor > 0) created._zoomFactor = webPreferences.zoomFactor
  setup?.(created)
  bus.emit('web-contents-created', created)
  return created
}

/** Electron colors (`#RGB`, `#RRGGBB`, `#AARRGGBB`) as Tauri reads them (`#RRGGBBAA`), or null. */
export function tauriColor(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color ?? '').trim())?.[1]
  if (!hex) return null
  if (hex.length === 3) return `#${[...hex].map((c) => c + c).join('')}`
  if (hex.length === 6) return `#${hex}`
  return `#${hex.slice(2)}${hex.slice(0, 2)}`
}

// ---------------------------------------------------------------------------
// View tree
// ---------------------------------------------------------------------------

const EMPTY = Object.freeze({ x: 0, y: 0, width: 0, height: 0 })

function checkBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') throw new TypeError('bounds must be an object')
  const out = {}
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(bounds[key] ?? 0)
    if (!Number.isFinite(value)) throw new TypeError(`bounds.${key} must be a number`)
    out[key] = Math.round(value)
  }
  return out
}

/** Electron's View: a rectangle in a window that holds other views. */
export class View extends EventEmitter {
  constructor() {
    super()
    this._children = []
    this._parent = null
    this._window = null // set on the window's root view (and kept on its descendants)
    this._bounds = { ...EMPTY }
    this._visible = true
    this._backgroundColor = null
  }

  get children() {
    return [...this._children]
  }

  /** Adds `view` (on top, or at `index`); a view already in a tree moves here. */
  addChildView(view, index) {
    if (!(view instanceof View)) throw new TypeError('Expected a View')
    if (view === this || view._contains(this)) throw new Error('A view cannot be added to itself or its descendants')
    if (view._isRoot) throw new Error('The content view of a window cannot be added to another view')
    view._parent?._detach(view)
    if (view === view._window?._contentViewRef) view._window._contentViewRef = null
    const at = index === undefined || index === null ? this._children.length : Math.max(0, Math.min(this._children.length, Math.floor(Number(index) || 0)))
    this._children.splice(at, 0, view)
    view._parent = this
    view._setWindow(this._windowOf())
    this._windowOf()?._restackViews(at < this._children.length - 1 ? null : view)
  }

  removeChildView(view) {
    if (!this._children.includes(view)) return
    this._detach(view)
    view._setWindow(null)
  }

  _detach(view) {
    this._children = this._children.filter((child) => child !== view)
    view._parent = null
  }

  _contains(view) {
    return this._children.some((child) => child === view || child._contains(view))
  }

  setBounds(bounds) {
    const next = checkBounds(bounds)
    const changed = JSON.stringify(next) !== JSON.stringify(this._bounds)
    this._bounds = next
    this._layout()
    if (changed) this.emit('bounds-changed')
  }

  getBounds() {
    return { ...this._bounds }
  }

  setVisible(visible) {
    this._visible = Boolean(visible)
    this._layout()
  }

  getVisible() {
    return this._visible
  }

  setBackgroundColor(color) {
    this._backgroundColor = String(color)
  }

  setBorderRadius() {
    warnOnce('View.setBorderRadius', 'View.setBorderRadius() is a no-op in tauri-electron.')
  }

  _windowOf() {
    return this._window
  }

  /** Origin of this view in its window's content area. */
  _origin() {
    let x = 0
    let y = 0
    for (let view = this; view && !view._isRoot; view = view._parent) {
      x += view._bounds.x
      y += view._bounds.y
    }
    return { x, y }
  }

  _shown() {
    for (let view = this; view; view = view._parent) if (!view._visible) return false
    return Boolean(this._window)
  }

  /** Every WebContentsView in this subtree, in drawing order. */
  _webContentsViews(out = []) {
    if (this._host) out.push(this)
    for (const child of this._children) child._webContentsViews(out)
    return out
  }

  _setWindow(win) {
    if (this._isRoot) return
    this._window = win
    for (const child of this._children) child._setWindow(win)
    this._layout()
  }

  /** Re-place the webviews of this subtree. */
  _layout() {
    for (const view of this._webContentsViews()) view._placeWebview()
  }
}

const ROOT = Symbol('window content view')

/** Electron's WebContentsView: a View showing a webContents. */
export class WebContentsView extends View {
  constructor(options = {}) {
    super()
    if (options[ROOT]) {
      // A window's content view: its own webContents.
      this.webContents = options[ROOT].webContents
      this._isRoot = true
      this._window = options[ROOT]
      this._host = null
      return
    }
    requireViews('new WebContentsView()')
    const contents = createGuest('browserView', options.webPreferences, options.webContents)
    this.webContents = contents
    this._host = contents._win
    this._host._view = this
  }

  setBackgroundColor(color) {
    super.setBackgroundColor(color)
    this._host._backgroundColor = String(color)
    const backgroundColor = tauriColor(color)
    if (backgroundColor) this._host._update({ backgroundColor })
    else warnOnce(`view color ${color}`, `WebContentsView.setBackgroundColor('${color}'): only hex colors are applied.`)
  }

  _placeWebview() {
    if (this._isRoot) return
    const { x, y } = this._origin()
    const placement = { bounds: { x, y, width: this._bounds.width, height: this._bounds.height }, visible: this._shown() }
    this._host._attach(this._window, placement)
  }
}

/** A window's content view: its own webContents, under every child view. */
class WindowContentView extends WebContentsView {
  constructor(win) {
    super({ [ROOT]: win })
  }

  getBounds() {
    const [width, height] = this._window.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  setBounds() {}

  setVisible() {}

  getVisible() {
    return this._window.isVisible()
  }

  setBackgroundColor(color) {
    this._window.setBackgroundColor(color)
  }
}

// ---------------------------------------------------------------------------
// BrowserWindow integration
// ---------------------------------------------------------------------------

/** Windows with views: re-place auto-resized ones on resize, forget webviews on close. */
function trackWindow(win) {
  if (win._viewsTracked) return
  win._viewsTracked = true
  win._lastContentSize = win.getContentSize()
  win.on('resize', () => {
    const before = win._lastContentSize
    const after = win.getContentSize()
    win._lastContentSize = after
    // setContentView(view): it fills the window.
    const content = win._contentViewRef
    if (content && !content._isRoot) content.setBounds({ x: 0, y: 0, width: after[0], height: after[1] })
    for (const view of win._browserViews ?? []) view._autoResize(before, after)
  })
  win.once('closed', () => {
    for (const host of guestHosts()) if (host._window === win) {
      if (host._contentsType === 'webview') host.destroy()
      else host._onWindowGone()
    }
  })
}

function guestHosts() {
  return guests.all().map((contents) => contents._win).filter((host) => host instanceof GuestHost)
}

Object.defineProperties(BrowserWindow.prototype, {
  contentView: {
    configurable: true,
    get() {
      return this.getContentView()
    },
    set(view) {
      this.setContentView(view)
    },
  },
})

Object.assign(BrowserWindow.prototype, {
  getContentView() {
    this._contentViewRef ??= new WindowContentView(this)
    return this._contentViewRef
  },

  /** The view fills the window's content area; the window's own page stays underneath. */
  setContentView(view) {
    if (!(view instanceof View)) throw new TypeError('Expected a View')
    if (view === this._contentViewRef) return
    if (!view._isRoot) requireViews('BrowserWindow.setContentView')
    const previous = this._contentViewRef
    if (previous && !previous._isRoot) previous._setWindow(null)
    view._parent?._detach(view)
    this._contentViewRef = view
    trackWindow(this)
    const [width, height] = this.getContentSize()
    view._bounds = { x: 0, y: 0, width, height }
    view._setWindow(this)
    this._restackViews(null)
  },

  /** Whether child webviews live in this native window (it is then navigated in place). */
  _hasViews() {
    return guestHosts().some((host) => host._window === this && host._native)
  },

  /** Stack the window's webviews in tree order (Linux), or raise `top`'s subtree. */
  _restackViews(top) {
    trackWindow(this)
    const root = this._contentViewRef
    const views = top ? top._webContentsViews() : root?._webContentsViews() ?? []
    for (const view of views) {
      const host = view._host
      const raise = () => host._update({ top: true })
      if (host._creating) host._creating.then(raise)
      else raise()
    }
  },

  setBrowserView(view) {
    for (const existing of this.getBrowserViews()) if (existing !== view) this.removeBrowserView(existing)
    if (view) this.addBrowserView(view)
  },

  getBrowserView() {
    const views = this.getBrowserViews()
    if (views.length > 1) throw new Error('This BrowserWindow has multiple BrowserViews, use getBrowserViews() instead')
    return views[0] ?? null
  },

  addBrowserView(view) {
    if (!(view instanceof BrowserView)) throw new TypeError('Expected a BrowserView')
    this._browserViews ??= []
    if (!this._browserViews.includes(view)) this._browserViews.push(view)
    for (const win of BrowserWindow.getAllWindows()) if (win !== this && win._browserViews?.includes(view)) win.removeBrowserView(view)
    view._lastWindow = this
    this.contentView.addChildView(view._view)
  },

  removeBrowserView(view) {
    if (!this._browserViews?.includes(view)) return
    this._browserViews = this._browserViews.filter((v) => v !== view)
    this.contentView.removeChildView(view._view)
  },

  setTopBrowserView(view) {
    if (!this._browserViews?.includes(view)) throw new Error('Given BrowserView is not attached to the window')
    this._browserViews = [...this._browserViews.filter((v) => v !== view), view]
    this.contentView.addChildView(view._view)
  },

  getBrowserViews() {
    return [...(this._browserViews ?? [])]
  },
})

const fromWebContents = BrowserWindow.fromWebContents
/** Views and `<webview>` guests: the window they are shown in. */
BrowserWindow.fromWebContents = (contents) => (contents instanceof GuestWebContents ? contents.getOwnerBrowserWindow() : fromWebContents(contents))
BrowserWindow.fromBrowserView = (view) => BrowserWindow.getAllWindows().find((win) => win._browserViews?.includes(view)) ?? null

/** Electron's deprecated BrowserView, on a WebContentsView. */
export class BrowserView extends EventEmitter {
  constructor(options = {}) {
    super()
    requireViews('new BrowserView()')
    this._view = new WebContentsView(options)
    this._autoResizeFlags = {}
  }

  get webContents() {
    return this._view.webContents
  }

  setBounds(bounds) {
    this._view.setBounds(bounds)
  }

  getBounds() {
    return this._view.getBounds()
  }

  setBackgroundColor(color) {
    this._view.setBackgroundColor(color)
  }

  /** Resize with the window: width / height grow with it, horizontal / vertical scale proportionally. */
  setAutoResize(flags = {}) {
    this._autoResizeFlags = { width: Boolean(flags.width), height: Boolean(flags.height), horizontal: Boolean(flags.horizontal), vertical: Boolean(flags.vertical) }
  }

  _autoResize([w0, h0], [w1, h1]) {
    const flags = this._autoResizeFlags
    if (!flags.width && !flags.height && !flags.horizontal && !flags.vertical) return
    let { x, y, width, height } = this._view.getBounds()
    if (flags.horizontal && w0 > 0) {
      x = (x * w1) / w0
      width = (width * w1) / w0
    } else if (flags.width) width += w1 - w0
    if (flags.vertical && h0 > 0) {
      y = (y * h1) / h0
      height = (height * h1) / h0
    } else if (flags.height) height += h1 - h0
    this._view.setBounds({ x, y, width: Math.max(0, width), height: Math.max(0, height) })
  }
}

// ---------------------------------------------------------------------------
// <webview>: the main-process side
// ---------------------------------------------------------------------------

/** Guest options an embedder with these values forces on its `<webview>`s (Electron's rule). */
const INHERITED = [
  ['contextIsolation', true],
  ['javascript', false],
  ['nodeIntegration', false],
  ['sandbox', true],
  ['nodeIntegrationInSubFrames', false],
]

/** `webpreferences="a=1, b=no"` → `{ a: 1, b: false }`. */
export function parseWebPreferences(text = '') {
  const out = {}
  for (const part of String(text).split(/\s*,\s*/)) {
    const [rawKey, ...rest] = part.split('=')
    const key = rawKey?.trim()
    if (!key) continue
    const value = rest.join('=').trim()
    if (value === '' || value === 'yes' || value === 'true') out[key] = true
    else if (value === 'no' || value === 'false') out[key] = false
    else if (value !== '' && !Number.isNaN(Number(value))) out[key] = Number(value)
    else out[key] = value
  }
  return out
}

/** The guest's webPreferences from the element's attributes, as Electron builds them. */
export function webviewPreferences(embedderPreferences = {}, params = {}, embedderZoom = 1) {
  const prefs = {
    nodeIntegration: Boolean(params.nodeintegration),
    nodeIntegrationInSubFrames: Boolean(params.nodeintegrationinsubframes),
    plugins: Boolean(params.plugins),
    zoomFactor: embedderZoom,
    disablePopups: !params.allowpopups,
    webSecurity: !params.disablewebsecurity,
    enableBlinkFeatures: params.blinkfeatures,
    disableBlinkFeatures: params.disableblinkfeatures,
    partition: params.partition || undefined,
    ...parseWebPreferences(params.webpreferences),
  }
  if (params.preload) prefs.preload = params.preload
  // The embedder's effective values (Electron's defaults filled in).
  const embedder = {
    contextIsolation: embedderPreferences.contextIsolation !== false,
    javascript: embedderPreferences.javascript !== false,
    nodeIntegration: Boolean(embedderPreferences.nodeIntegration),
    sandbox: embedderPreferences.sandbox ?? !embedderPreferences.nodeIntegration,
    nodeIntegrationInSubFrames: Boolean(embedderPreferences.nodeIntegrationInSubFrames),
  }
  for (const [name, value] of INHERITED) if (embedder[name] === value) prefs[name] = value
  return prefs
}

/** webContents methods a `<webview>` element may call on its guest. */
const WEBVIEW_METHODS = new Set([
  'loadURL', 'downloadURL', 'stop', 'reload', 'reloadIgnoringCache', 'goBack', 'goForward', 'goToIndex', 'goToOffset',
  'clearHistory', 'setUserAgent', 'insertCSS', 'removeInsertedCSS', 'executeJavaScript', 'openDevTools', 'closeDevTools',
  'inspectElement', 'setAudioMuted', 'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll',
  'unselect', 'scrollToTop', 'scrollToBottom', 'replace', 'replaceMisspelling', 'insertText', 'findInPage', 'stopFindInPage',
  'print', 'printToPDF', 'send', 'setZoomFactor', 'setZoomLevel', 'setVisualZoomLevelLimits', 'focus', 'centerSelection',
])

/** Guest events re-dispatched on the element, with the properties Electron gives them. */
const FORWARDED = {
  'did-start-loading': () => ({}),
  'did-stop-loading': () => ({}),
  'did-finish-load': () => ({}),
  'did-fail-load': (_e, errorCode, errorDescription, validatedURL, isMainFrame) => ({ errorCode, errorDescription, validatedURL, isMainFrame }),
  'dom-ready': () => ({}),
  'page-title-updated': (_e, title, explicitSet) => ({ title, explicitSet }),
  'did-start-navigation': (_e, url, isInPlace, isMainFrame) => ({ url, isInPlace, isMainFrame }),
  'did-navigate': (_e, url, httpResponseCode, httpStatusText) => ({ url, httpResponseCode, httpStatusText }),
  'did-navigate-in-page': (_e, url, isMainFrame) => ({ url, isMainFrame }),
  'console-message': (_e, level, message, line, sourceId) => ({ level, message, line, sourceId }),
  'found-in-page': (_e, result) => ({ result }),
  'context-menu': (_e, params) => ({ params: { ...params, frame: undefined } }),
  'devtools-opened': () => ({}),
  'devtools-closed': () => ({}),
  destroyed: () => ({}),
}

/** One `<webview>` element's guest, as seen from the main process. */
class Tag {
  constructor(embedder, instance, contents) {
    this.embedder = embedder
    this.instance = instance
    this.contents = contents
  }

  state() {
    const c = this.contents
    return {
      url: c.getURL(),
      title: c.getTitle(),
      loading: c.isLoading(),
      canGoBack: c.navigationHistory.canGoBack(),
      canGoForward: c.navigationHistory.canGoForward(),
      zoomFactor: c.getZoomFactor(),
      devToolsOpened: c.isDevToolsOpened(),
      audioMuted: c.isAudioMuted(),
      userAgent: c.getUserAgent(),
    }
  }

  forward(type, props = {}, args) {
    if (this.embedder.isDestroyed()) return
    // `event`, not `type`: the command's own fields are `type` and `name`.
    this.embedder._command('webview-event', { instance: this.instance, event: type, props: encode(props), state: this.state(), ...(args ? { args } : {}) })
  }

  /** Re-dispatch the guest's events on the element. */
  listen() {
    for (const [type, props] of Object.entries(FORWARDED)) {
      this.contents.on(type, (...args) => {
        if (type === 'did-navigate') this.forward('load-commit', { url: args[1], isMainFrame: true })
        this.forward(type, props(...args))
      })
    }
  }
}

const tags = new Map() // `${embedder.id}:${instance}` → Tag

function tagKey(embedder, instance) {
  return `${embedder.id}:${instance}`
}

/** The BrowserWindow a page is shown in: its own window, or the window of the view it is in. */
function windowOfContents(contents) {
  return contents instanceof GuestWebContents ? contents.getOwnerBrowserWindow() : contents._win
}

function reply(embedder, name, data) {
  if (!embedder.isDestroyed()) embedder._command(name, data)
}

function attachWebview(embedder, { instance, params = {}, bounds, visible = true }) {
  const fail = (message) => {
    warnOnce(`webview:${message}`, `<webview>: ${message}`)
    reply(embedder, 'webview-detached', { instance, reason: message })
  }
  const prefs = embedder._win?._options?.webPreferences ?? {}
  if (!prefs.webviewTag) return fail('the embedder was not created with webPreferences.webviewTag')
  if (!hasNativePlugin() || !hasFeature(FEATURE)) return fail(`<webview> needs the \`${FEATURE}\` feature of tauri-plugin-electron`)
  const win = windowOfContents(embedder)
  if (!win || win.isDestroyed()) return fail('the embedder is not in a window')
  const webPreferences = webviewPreferences(prefs, params, embedder.getZoomFactor())
  const event = createEvent()
  embedder.emit('will-attach-webview', event, webPreferences, params)
  if (event.defaultPrevented) return reply(embedder, 'webview-detached', { instance, reason: 'prevented' })
  const contents = createGuest('webview', webPreferences, null, (guest) => {
    guest.hostWebContents = embedder
  })
  const host = contents._win
  host._window = win
  if (params.useragent) contents._userAgent = String(params.useragent)
  const tag = new Tag(embedder, instance, contents)
  contents._tag = tag
  tags.set(tagKey(embedder, instance), tag)
  contents.once('destroyed', () => tags.delete(tagKey(embedder, instance)))
  tag.listen()
  trackWindow(win)
  if (params.src) host._pendingUrl = toNativeSchemeUrl(fileUrlToAppUrl(String(params.src)))
  embedder.emit('did-attach-webview', createEvent(), contents)
  // The element reports its box to Rust once the guest exists there.
  host._create(win, { bounds: checkBounds(bounds ?? EMPTY), visible: Boolean(visible) }, { embedder: embedder._label, instance }).then(() => {
    if (host._native) reply(embedder, 'webview-attached', { instance, id: contents.id })
    else reply(embedder, 'webview-detached', { instance, reason: 'the guest could not be created' })
  })
}

async function callWebview(embedder, { instance, method, args, id }) {
  const tag = tags.get(tagKey(embedder, instance))
  const answer = (body) => id && reply(embedder, 'webview-result', { instance, id, ...body })
  try {
    if (!tag || tag.contents.isDestroyed()) throw new Error('The WebView is not attached')
    if (!WEBVIEW_METHODS.has(method)) throw new Error(`webview.${method}() is not available`)
    const values = decodeArgs(args)
    if (method === 'findInPage') tag.contents._findRequest = Math.max(0, (Number(values[2]) || 1) - 1)
    const result = await tag.contents[method](...values)
    answer({ ok: true, result: encode(method === 'findInPage' ? undefined : result) })
  } catch (error) {
    answer({ ok: false, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } })
  }
  // Methods change what the element's getters report (zoom, user agent, mute).
  tag?.forward('state')
}

/** The embedder page went away: so do its `<webview>`s. */
function dropEmbedderTags(embedder) {
  for (const tag of [...tags.values()]) if (tag.embedder === embedder) tag.contents._win.destroy()
}

bus.on('guest-lifecycle', (contents, name, data = {}) => {
  switch (name) {
    case 'webview-attach':
      if (!contents._webviewTracked) {
        contents._webviewTracked = true
        contents.on('did-start-loading', () => dropEmbedderTags(contents))
        contents.once('destroyed', () => dropEmbedderTags(contents))
      }
      attachWebview(contents, data)
      break
    case 'webview-detach':
      tags.get(tagKey(contents, data.instance))?.contents._win.destroy()
      break
    case 'webview-call':
      callWebview(contents, data)
      break
    case 'guest-close':
      // window.close() in a <webview> guest: the element's 'close' event.
      contents._tag?.forward('close')
      break
  }
})

bus.on('session-permission-handler', (session) => {
  const labels = guestHosts().filter((host) => host._native && host._session === session).map((host) => host._label)
  if (labels.length) native('permission_handler', { labels, enabled: typeof session._handlers.permissionRequest === 'function' }).catch(report('setPermissionRequestHandler'))
})
