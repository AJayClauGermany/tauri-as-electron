/**
 * BrowserWindow and webContents, implemented with Tauri's WebviewWindow.
 *
 * Each BrowserWindow owns one Tauri WebviewWindow labelled
 * `electron-window-<id>`. Electron exposes many window getters synchronously
 * (getSize, isMaximized, getTitle, ...) while Tauri's are async, so the state
 * is cached here and refreshed from Tauri window events.
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emitTo } from '@tauri-apps/api/event'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { Menu as TauriMenu } from '@tauri-apps/api/menu'
import { UserAttentionType, ProgressBarStatus } from '@tauri-apps/api/window'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { bus } from '../internal/bus.js'
import { TO_RENDERER, deferred, report, warnOnce, NotImplementedError, deserializeError } from '../internal/runtime.js'
import { resolveImage } from './native-image.js'

const windows = new Map()
const contentsById = new Map()
const contentsByLabel = new Map()
let nextId = 1
let focusedId = null

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Turn a loadFile() path into an app-relative URL Tauri understands. */
export function fileToUrl(filePath, options = {}) {
  let p = String(filePath).replace(/\\/g, '/')
  if (p.startsWith('file://')) p = p.slice('file://'.length)
  p = p.replace(/^\/+/, '')
  let url = encodeURI(p)
  if (options.query && Object.keys(options.query).length) url += `?${new URLSearchParams(options.query)}`
  else if (options.search) url += options.search.startsWith('?') ? options.search : `?${options.search}`
  if (options.hash) url += options.hash.startsWith('#') ? options.hash : `#${options.hash}`
  return url
}

/** URLs served by our own frontend get the renderer bootstrap; remote pages do not. */
function isAppUrl(url) {
  if (!SCHEME.test(url)) return true
  return typeof location !== 'undefined' && url.startsWith(location.origin)
}

function absoluteAppUrl(url) {
  if (SCHEME.test(url)) return url
  return new URL(url.replace(/^\/*/, '/'), location.origin).href
}

function toPhysicalToLogical(value, scale) {
  return Math.round(value / (scale || 1))
}

// ---------------------------------------------------------------------------
// webContents
// ---------------------------------------------------------------------------

export class WebContents extends EventEmitter {
  constructor(win) {
    super()
    this.id = win.id
    this._win = win
    this._url = ''
    this._title = ''
    this._zoomFactor = 1
    this._alive = false // the renderer bootstrap has reported did-finish-load
    this._queue = []
    this._pending = new Map()
    this._nextRequest = 1
    this._css = new Map()
    this._windowOpenHandler = null
    this.session = undefined
    contentsById.set(this.id, this)
  }

  get _label() {
    return this._win._label
  }

  _post(message) {
    return emitTo(this._label, TO_RENDERER, { ...message, to: this._label }).catch(report('webContents message'))
  }

  /** Called by the IPC bridge for lifecycle messages from the renderer bootstrap. */
  _onLifecycle(name, data = {}) {
    if (name === 'dom-ready') {
      this._url = data.url ?? this._url
      this.emit('dom-ready', createEvent())
    } else if (name === 'did-finish-load') {
      this._url = data.url ?? this._url
      this._title = data.title ?? this._title
      this._alive = true
      const queue = this._queue.splice(0)
      for (const message of queue) this._post(message)
      this.emit('did-finish-load', createEvent())
      this._win._onDidFinishLoad()
    } else if (name === 'page-title-updated') {
      this._title = data.title
      const event = createEvent()
      this.emit('page-title-updated', event, data.title)
      this._win._onPageTitleUpdated(data.title)
    } else if (name === 'unload') {
      this._alive = false
    } else if (name === 'exec-result') {
      const pending = this._pending.get(data.id)
      if (!pending) return
      this._pending.delete(data.id)
      if (data.ok) pending.resolve(data.result)
      else pending.reject(deserializeError(data.error))
    }
  }

  send(channel, ...args) {
    if (this.isDestroyed()) throw new Error('Object has been destroyed')
    const message = { type: 'send', channel: String(channel), args }
    if (this._alive) this._post(message)
    else this._queue.push(message)
  }

  postMessage(channel, message) {
    this.send(channel, message)
  }

  /** Runs `code` in the page and resolves with the (JSON-serializable) result. */
  executeJavaScript(code) {
    const id = this._nextRequest++
    const { promise, resolve, reject } = deferred()
    this._pending.set(id, { resolve, reject })
    const message = { type: 'command', name: 'execute', id, code: String(code) }
    if (this._alive) this._post(message)
    else this._queue.push(message)
    return promise
  }

  loadURL(url, options) {
    return this._win.loadURL(url, options)
  }

  loadFile(filePath, options) {
    return this._win.loadFile(filePath, options)
  }

  reload() {
    if (this._alive) {
      this._alive = false
      this._post({ type: 'command', name: 'reload' })
    }
  }

  reloadIgnoringCache() {
    this.reload()
  }

  getURL() {
    return this._url
  }

  getTitle() {
    return this._title || this._win._state.title
  }

  isLoading() {
    return !this._alive
  }

  isDestroyed() {
    return this._win.isDestroyed()
  }

  isFocused() {
    return this._win.isFocused()
  }

  focus() {
    this._win.focus()
  }

  setZoomFactor(factor) {
    this._zoomFactor = factor
    this._win._call((native) => native.setZoom(factor), 'setZoomFactor')
  }

  getZoomFactor() {
    return this._zoomFactor
  }

  setZoomLevel(level) {
    this.setZoomFactor(Math.pow(1.2, level))
  }

  getZoomLevel() {
    return Math.log(this._zoomFactor) / Math.log(1.2)
  }

  insertCSS(css) {
    const key = `tauri-electron-css-${this._nextRequest++}`
    this._css.set(key, css)
    return this.executeJavaScript(
      `(() => { const s = document.createElement('style'); s.id = ${JSON.stringify(key)}; s.textContent = ${JSON.stringify(String(css))}; document.head.appendChild(s); })()`,
    ).then(() => key)
  }

  removeInsertedCSS(key) {
    this._css.delete(key)
    return this.executeJavaScript(`document.getElementById(${JSON.stringify(key)})?.remove()`).then(() => undefined)
  }

  _execCommand(command) {
    this.executeJavaScript(`document.execCommand(${JSON.stringify(command)})`).catch(report(command))
  }

  undo() { this._execCommand('undo') }
  redo() { this._execCommand('redo') }
  cut() { this._execCommand('cut') }
  copy() { this._execCommand('copy') }
  paste() { this._execCommand('paste') }
  delete() { this._execCommand('delete') }
  selectAll() { this._execCommand('selectAll') }
  unselect() { this.executeJavaScript('window.getSelection()?.removeAllRanges()').catch(report('unselect')) }

  print() {
    this.executeJavaScript('window.print()').catch(report('print'))
  }

  setWindowOpenHandler(handler) {
    this._windowOpenHandler = handler
    warnOnce('setWindowOpenHandler', 'webContents.setWindowOpenHandler() is stored but window.open() is not intercepted yet.')
  }

  openDevTools() {
    warnOnce('devtools', 'webContents.openDevTools() is not available from JavaScript in Tauri. In debug builds, right-click the page and choose "Inspect".')
  }

  closeDevTools() {}

  toggleDevTools() {
    this.openDevTools()
  }

  isDevToolsOpened() {
    return false
  }

  setAudioMuted() {
    warnOnce('setAudioMuted', 'webContents.setAudioMuted() is a no-op in tauri-electron.')
  }

  isAudioMuted() {
    return false
  }

  getOSProcessId() {
    return 0
  }

  getProcessId() {
    return 0
  }

  capturePage() {
    return Promise.reject(new NotImplementedError('webContents.capturePage'))
  }

  printToPDF() {
    return Promise.reject(new NotImplementedError('webContents.printToPDF'))
  }

  close() {
    this._win.close()
  }
}

export const webContents = {
  getAllWebContents: () => [...contentsById.values()],
  getFocusedWebContents: () => BrowserWindow.getFocusedWindow()?.webContents ?? null,
  fromId: (id) => contentsById.get(id),
  fromFrame: () => undefined,
  fromDevToolsTargetId: () => undefined,
}

export function webContentsFromLabel(label) {
  return contentsByLabel.get(label)
}

// ---------------------------------------------------------------------------
// BrowserWindow
// ---------------------------------------------------------------------------

export class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.id = nextId++
    this._options = { ...options }
    this._generation = 0
    this._label = ''
    this._native = null
    this._nativeReady = deferred()
    this._destroyed = false
    this._shownOnce = false
    this._readyToShowEmitted = false
    this._loadWaiters = []
    this._parent = options.parent ?? null
    const width = options.width ?? 800
    const height = options.height ?? 600
    this._state = {
      title: options.title ?? (typeof document !== 'undefined' ? document.title : '') ?? '',
      x: options.x ?? 0,
      y: options.y ?? 0,
      width,
      height,
      contentWidth: width,
      contentHeight: height,
      minWidth: options.minWidth ?? 0,
      minHeight: options.minHeight ?? 0,
      maxWidth: options.maxWidth ?? 0,
      maxHeight: options.maxHeight ?? 0,
      visible: options.show !== false,
      focused: false,
      maximized: false,
      minimized: false,
      fullscreen: Boolean(options.fullscreen || options.kiosk),
      resizable: options.resizable !== false,
      movable: options.movable !== false,
      minimizable: options.minimizable !== false,
      maximizable: options.maximizable !== false,
      closable: options.closable !== false,
      focusable: options.focusable !== false,
      alwaysOnTop: Boolean(options.alwaysOnTop),
      skipTaskbar: Boolean(options.skipTaskbar),
      kiosk: Boolean(options.kiosk),
      backgroundColor: options.backgroundColor ?? '#FFFFFF',
      scaleFactor: 1,
      menuBarVisible: true,
      opacity: options.opacity ?? 1,
      documentEdited: false,
      representedFilename: '',
    }
    this.webContents = new WebContents(this)
    windows.set(this.id, this)
    bus.emit('browser-window-created', this)

    // Electron windows exist (and are shown) as soon as they are constructed.
    // Tauri needs the URL up front, so creation waits until the first
    // loadURL()/loadFile() - which virtually always happens synchronously
    // right after the constructor. Fall back to a blank window otherwise.
    setTimeout(() => {
      if (!this._native && !this._destroyed) this._createNative('about:blank')
    }, 0)
  }

  // --- native window lifecycle ---------------------------------------------

  _nativeOptions(url) {
    const o = this._options
    const s = this._state
    const hasPosition = o.x !== undefined && o.y !== undefined
    const native = {
      url,
      title: s.title,
      width: s.width,
      height: s.height,
      center: o.center ?? !hasPosition,
      resizable: s.resizable,
      maximizable: s.maximizable,
      minimizable: s.minimizable,
      closable: s.closable,
      alwaysOnTop: s.alwaysOnTop,
      fullscreen: s.fullscreen,
      skipTaskbar: s.skipTaskbar,
      decorations: o.frame !== false,
      transparent: Boolean(o.transparent),
      visible: s.visible,
      focus: s.visible && s.focusable,
      focusable: s.focusable,
      contentProtected: Boolean(o.contentProtection),
      visibleOnAllWorkspaces: Boolean(o.visibleOnAllWorkspaces),
    }
    if (hasPosition) Object.assign(native, { x: o.x, y: o.y })
    if (o.minWidth || o.minHeight) Object.assign(native, { minWidth: o.minWidth ?? 0, minHeight: o.minHeight ?? 0 })
    if (o.maxWidth || o.maxHeight) Object.assign(native, { maxWidth: o.maxWidth ?? 1e5, maxHeight: o.maxHeight ?? 1e5 })
    if (o.backgroundColor) native.backgroundColor = o.backgroundColor
    if (this._parent?._label) native.parent = this._parent._label
    if (o.titleBarStyle === 'hidden' || o.titleBarStyle === 'hiddenInset') {
      native.titleBarStyle = 'overlay'
      native.hiddenTitle = true
    }
    if (o.trafficLightPosition) native.trafficLightPosition = new LogicalPosition(o.trafficLightPosition.x, o.trafficLightPosition.y)
    if (o.webPreferences?.devTools === false) native.devtools = false
    if (o.webPreferences?.zoomFactor) this.webContents._zoomFactor = o.webPreferences.zoomFactor
    return native
  }

  _createNative(url) {
    const generation = ++this._generation
    this._label = `electron-window-${this.id}${generation > 1 ? `-${generation}` : ''}`
    contentsByLabel.set(this._label, this.webContents)
    this.webContents._url = url
    this.webContents._alive = false
    const native = new WebviewWindow(this._label, this._nativeOptions(url))
    this._native = native
    const isCurrent = () => this._native === native && !this._destroyed

    native.once('tauri://created', () => {
      if (!isCurrent()) return
      this._nativeReady.resolve(native)
      this._attachNativeListeners(native, isCurrent)
      this._refreshGeometry()
      if (this.webContents._zoomFactor !== 1) native.setZoom(this.webContents._zoomFactor).catch(report('setZoom'))
      if (this._options.icon) this.setIcon(this._options.icon)
      if (!isAppUrl(url) || url === 'about:blank') {
        // No bootstrap in remote/blank pages: synthesize load events.
        setTimeout(() => isCurrent() && this._onDidFinishLoad(true), 300)
      }
    })
    native.once('tauri://error', (event) => {
      if (!isCurrent()) return
      const error = new Error(`Failed to create window: ${JSON.stringify(event.payload)}`)
      this._nativeReady.reject(error)
      for (const waiter of this._loadWaiters.splice(0)) waiter.reject(error)
      console.error('[tauri-electron]', error)
    })
  }

  _attachNativeListeners(native, isCurrent) {
    native.onResized(() => isCurrent() && this._scheduleRefresh('resize'))
    native.onMoved(() => isCurrent() && this._scheduleRefresh('move'))
    native.onScaleChanged(({ payload }) => {
      if (isCurrent()) this._state.scaleFactor = payload.scaleFactor
    })
    native.onFocusChanged(({ payload: focused }) => {
      if (!isCurrent() || this._state.focused === focused) return
      this._state.focused = focused
      if (focused) focusedId = this.id
      else if (focusedId === this.id) focusedId = null
      this.emit(focused ? 'focus' : 'blur', createEvent())
      bus.emit(focused ? 'browser-window-focus' : 'browser-window-blur', this)
    })
    native.onCloseRequested((tauriEvent) => {
      if (!isCurrent()) return
      const event = createEvent()
      this.emit('close', event)
      if (event.defaultPrevented) {
        tauriEvent.preventDefault()
        bus.emit('window-close-prevented', this)
      }
    })
    native.listen('tauri://destroyed', () => {
      if (isCurrent()) this._onDestroyed()
    })
  }

  _onDestroyed() {
    if (this._destroyed) return
    this._destroyed = true
    windows.delete(this.id)
    contentsById.delete(this.id)
    contentsByLabel.delete(this._label)
    if (focusedId === this.id) focusedId = null
    this.webContents.emit('destroyed', createEvent())
    this.emit('closed')
    bus.emit('browser-window-closed', this)
  }

  _call(fn, what) {
    if (this._destroyed) return Promise.resolve()
    return this._nativeReady.promise.then(fn).catch(report(`BrowserWindow.${what}`))
  }

  _scheduleRefresh(reason) {
    clearTimeout(this._refreshTimer)
    this._refreshTimer = setTimeout(() => this._refreshGeometry(reason), 16)
  }

  async _refreshGeometry(reason) {
    const native = this._native
    if (!native || this._destroyed) return
    try {
      const [scale, position, outer, inner, maximized, minimized, fullscreen, visible] = await Promise.all([
        native.scaleFactor(),
        native.outerPosition(),
        native.outerSize(),
        native.innerSize(),
        native.isMaximized(),
        native.isMinimized(),
        native.isFullscreen(),
        native.isVisible(),
      ])
      const s = this._state
      const before = { ...s }
      Object.assign(s, {
        scaleFactor: scale,
        x: toPhysicalToLogical(position.x, scale),
        y: toPhysicalToLogical(position.y, scale),
        width: toPhysicalToLogical(outer.width, scale),
        height: toPhysicalToLogical(outer.height, scale),
        contentWidth: toPhysicalToLogical(inner.width, scale),
        contentHeight: toPhysicalToLogical(inner.height, scale),
        maximized,
        minimized,
        fullscreen,
        visible,
      })
      if (reason === 'resize') this.emit('resize', createEvent())
      if (reason === 'move') this.emit('move', createEvent())
      if (maximized !== before.maximized) this.emit(maximized ? 'maximize' : 'unmaximize', createEvent())
      if (minimized !== before.minimized) this.emit(minimized ? 'minimize' : 'restore', createEvent())
      if (fullscreen !== before.fullscreen) this.emit(fullscreen ? 'enter-full-screen' : 'leave-full-screen', createEvent())
      if (visible !== before.visible) this.emit(visible ? 'show' : 'hide', createEvent())
    } catch (error) {
      report('window state refresh')(error)
    }
  }

  _onDidFinishLoad(synthetic = false) {
    if (synthetic) {
      this.webContents.emit('dom-ready', createEvent())
      this.webContents.emit('did-finish-load', createEvent())
    }
    for (const waiter of this._loadWaiters.splice(0)) waiter.resolve()
    if (!this._readyToShowEmitted) {
      this._readyToShowEmitted = true
      this.emit('ready-to-show', createEvent())
    }
  }

  _onPageTitleUpdated(title) {
    const event = createEvent()
    this.emit('page-title-updated', event, title, false)
    // Like Electron, the window title follows <title> unless prevented.
    if (!event.defaultPrevented && title) this.setTitle(title)
  }

  // --- loading -------------------------------------------------------------

  loadURL(url) {
    url = String(url)
    const { promise, resolve, reject } = deferred()
    this._loadWaiters.push({ resolve, reject })
    if (!this._native) {
      this._createNative(url)
    } else if (this.webContents._alive && isAppUrl(url)) {
      this.webContents._alive = false
      this.webContents._post({ type: 'command', name: 'navigate', url: absoluteAppUrl(url) })
    } else {
      // The current page has no bootstrap (blank or remote), so it cannot
      // navigate itself: replace the native window, keeping its geometry.
      const old = this._native
      this._options = { ...this._options, x: this._state.x, y: this._state.y, center: false }
      this._createNative(url)
      old.destroy().catch(report('replace window'))
    }
    return promise
  }

  loadFile(filePath, options) {
    return this.loadURL(fileToUrl(filePath, options))
  }

  reload() {
    this.webContents.reload()
  }

  // --- visibility / focus ----------------------------------------------------

  show() {
    this._state.visible = true
    this._call(async (n) => {
      await n.show()
      await n.setFocus()
    }, 'show')
  }

  showInactive() {
    this._state.visible = true
    this._call((n) => n.show(), 'showInactive')
  }

  hide() {
    this._state.visible = false
    this._call((n) => n.hide(), 'hide')
  }

  isVisible() {
    return this._state.visible
  }

  focus() {
    this._call((n) => n.setFocus(), 'focus')
  }

  blur() {
    warnOnce('blur', 'BrowserWindow.blur() is a no-op in tauri-electron.')
  }

  isFocused() {
    return this._state.focused
  }

  close() {
    this._call((n) => n.close(), 'close')
  }

  destroy() {
    this._call((n) => n.destroy(), 'destroy')
  }

  isDestroyed() {
    return this._destroyed
  }

  // --- state -----------------------------------------------------------------

  minimize() {
    this._state.minimized = true
    this._call((n) => n.minimize(), 'minimize')
  }

  restore() {
    this._state.minimized = false
    this._call(async (n) => {
      await n.unminimize()
      if (!this._state.visible) await n.show()
      await n.setFocus()
    }, 'restore')
  }

  isMinimized() {
    return this._state.minimized
  }

  maximize() {
    this._state.maximized = true
    this._call((n) => n.maximize(), 'maximize')
  }

  unmaximize() {
    this._state.maximized = false
    this._call((n) => n.unmaximize(), 'unmaximize')
  }

  isMaximized() {
    return this._state.maximized
  }

  isNormal() {
    return !this._state.maximized && !this._state.minimized && !this._state.fullscreen
  }

  setFullScreen(flag) {
    this._state.fullscreen = Boolean(flag)
    this._call((n) => n.setFullscreen(Boolean(flag)), 'setFullScreen')
  }

  isFullScreen() {
    return this._state.fullscreen
  }

  setSimpleFullScreen(flag) {
    this.setFullScreen(flag)
  }

  isSimpleFullScreen() {
    return this.isFullScreen()
  }

  setFullScreenable() {}

  isFullScreenable() {
    return true
  }

  setKiosk(flag) {
    this._state.kiosk = Boolean(flag)
    this.setFullScreen(flag)
  }

  isKiosk() {
    return this._state.kiosk
  }

  // --- title -------------------------------------------------------------------

  setTitle(title) {
    this._state.title = String(title)
    this._call((n) => n.setTitle(String(title)), 'setTitle')
  }

  getTitle() {
    return this._state.title
  }

  // --- geometry ------------------------------------------------------------------

  getBounds() {
    const s = this._state
    return { x: s.x, y: s.y, width: s.width, height: s.height }
  }

  setBounds(bounds) {
    const next = { ...this.getBounds(), ...bounds }
    this.setPosition(next.x, next.y)
    this.setSize(next.width, next.height)
  }

  getContentBounds() {
    const s = this._state
    return { x: s.x, y: s.y, width: s.contentWidth, height: s.contentHeight }
  }

  setContentBounds(bounds) {
    const next = { ...this.getContentBounds(), ...bounds }
    this.setPosition(next.x, next.y)
    this.setContentSize(next.width, next.height)
  }

  getNormalBounds() {
    return this.getBounds()
  }

  getSize() {
    return [this._state.width, this._state.height]
  }

  setSize(width, height) {
    Object.assign(this._state, { width, height })
    this._call((n) => n.setSize(new LogicalSize(width, height)), 'setSize')
  }

  getContentSize() {
    return [this._state.contentWidth, this._state.contentHeight]
  }

  setContentSize(width, height) {
    Object.assign(this._state, { contentWidth: width, contentHeight: height })
    this._call((n) => n.setSize(new LogicalSize(width, height)), 'setContentSize')
  }

  getPosition() {
    return [this._state.x, this._state.y]
  }

  setPosition(x, y) {
    Object.assign(this._state, { x, y })
    this._call((n) => n.setPosition(new LogicalPosition(x, y)), 'setPosition')
  }

  center() {
    this._call((n) => n.center(), 'center')
  }

  setMinimumSize(width, height) {
    Object.assign(this._state, { minWidth: width, minHeight: height })
    this._call((n) => n.setMinSize(width || height ? new LogicalSize(width, height) : null), 'setMinimumSize')
  }

  getMinimumSize() {
    return [this._state.minWidth, this._state.minHeight]
  }

  setMaximumSize(width, height) {
    Object.assign(this._state, { maxWidth: width, maxHeight: height })
    this._call((n) => n.setMaxSize(width || height ? new LogicalSize(width || 1e5, height || 1e5) : null), 'setMaximumSize')
  }

  getMaximumSize() {
    return [this._state.maxWidth, this._state.maxHeight]
  }

  setAspectRatio() {
    warnOnce('setAspectRatio', 'BrowserWindow.setAspectRatio() is a no-op in tauri-electron.')
  }

  // --- behaviour flags -------------------------------------------------------------

  setResizable(flag) {
    this._state.resizable = Boolean(flag)
    this._call((n) => n.setResizable(Boolean(flag)), 'setResizable')
  }

  isResizable() {
    return this._state.resizable
  }

  setMovable(flag) {
    this._state.movable = Boolean(flag)
    warnOnce('setMovable', 'BrowserWindow.setMovable() only updates cached state in tauri-electron.')
  }

  isMovable() {
    return this._state.movable
  }

  setMinimizable(flag) {
    this._state.minimizable = Boolean(flag)
    this._call((n) => n.setMinimizable(Boolean(flag)), 'setMinimizable')
  }

  isMinimizable() {
    return this._state.minimizable
  }

  setMaximizable(flag) {
    this._state.maximizable = Boolean(flag)
    this._call((n) => n.setMaximizable(Boolean(flag)), 'setMaximizable')
  }

  isMaximizable() {
    return this._state.maximizable
  }

  setClosable(flag) {
    this._state.closable = Boolean(flag)
    this._call((n) => n.setClosable(Boolean(flag)), 'setClosable')
  }

  isClosable() {
    return this._state.closable
  }

  setFocusable(flag) {
    this._state.focusable = Boolean(flag)
    this._call((n) => n.setFocusable(Boolean(flag)), 'setFocusable')
  }

  isFocusable() {
    return this._state.focusable
  }

  setAlwaysOnTop(flag) {
    this._state.alwaysOnTop = Boolean(flag)
    this._call((n) => n.setAlwaysOnTop(Boolean(flag)), 'setAlwaysOnTop')
  }

  isAlwaysOnTop() {
    return this._state.alwaysOnTop
  }

  moveTop() {
    this.focus()
  }

  setSkipTaskbar(flag) {
    this._state.skipTaskbar = Boolean(flag)
    this._call((n) => n.setSkipTaskbar(Boolean(flag)), 'setSkipTaskbar')
  }

  setVisibleOnAllWorkspaces(flag) {
    this._call((n) => n.setVisibleOnAllWorkspaces(Boolean(flag)), 'setVisibleOnAllWorkspaces')
  }

  setContentProtection(flag) {
    this._call((n) => n.setContentProtected(Boolean(flag)), 'setContentProtection')
  }

  setIgnoreMouseEvents(ignore) {
    this._call((n) => n.setIgnoreCursorEvents(Boolean(ignore)), 'setIgnoreMouseEvents')
  }

  setBackgroundColor(color) {
    this._state.backgroundColor = color
    this._call((n) => n.setBackgroundColor(color), 'setBackgroundColor')
  }

  getBackgroundColor() {
    return this._state.backgroundColor
  }

  setOpacity(opacity) {
    this._state.opacity = opacity
    warnOnce('setOpacity', 'BrowserWindow.setOpacity() only updates cached state in tauri-electron.')
  }

  getOpacity() {
    return this._state.opacity
  }

  setHasShadow(flag) {
    this._call((n) => n.setShadow(Boolean(flag)), 'setHasShadow')
  }

  setProgressBar(progress) {
    const status = progress < 0 ? ProgressBarStatus.None : progress > 1 ? ProgressBarStatus.Indeterminate : ProgressBarStatus.Normal
    const value = Math.max(0, Math.min(100, Math.round(progress * 100)))
    this._call((n) => n.setProgressBar({ status, progress: value }), 'setProgressBar')
  }

  flashFrame(flag) {
    this._call((n) => n.requestUserAttention(flag ? UserAttentionType.Informational : null), 'flashFrame')
  }

  setIcon(icon) {
    this._call(async (n) => {
      const image = await resolveImage(icon)
      if (image) await n.setIcon(image)
    }, 'setIcon')
  }

  setDocumentEdited(flag) {
    this._state.documentEdited = Boolean(flag)
  }

  isDocumentEdited() {
    return this._state.documentEdited
  }

  setRepresentedFilename(filename) {
    this._state.representedFilename = filename
  }

  getRepresentedFilename() {
    return this._state.representedFilename
  }

  // --- menus ---------------------------------------------------------------------------

  setMenu(menu) {
    this._call(async (n) => {
      // Tauri has no JS "remove menu" call; an empty menu is the closest match.
      const native = menu ? await menu._build() : await TauriMenu.new({ items: [] })
      await native.setAsWindowMenu(n)
    }, 'setMenu')
  }

  removeMenu() {
    this.setMenu(null)
  }

  setMenuBarVisibility(visible) {
    this._state.menuBarVisible = Boolean(visible)
  }

  isMenuBarVisible() {
    return this._state.menuBarVisible
  }

  setAutoHideMenuBar() {}

  isMenuBarAutoHide() {
    return false
  }

  // --- parent / child ---------------------------------------------------------------------

  getParentWindow() {
    return this._parent
  }

  setParentWindow(parent) {
    this._parent = parent
    warnOnce('setParentWindow', 'BrowserWindow.setParentWindow() only takes effect for windows created afterwards.')
  }

  getChildWindows() {
    return BrowserWindow.getAllWindows().filter((win) => win._parent === this)
  }

  isModal() {
    return Boolean(this._options.modal)
  }

  getNativeWindowHandle() {
    throw new NotImplementedError('BrowserWindow.getNativeWindowHandle')
  }

  capturePage() {
    return this.webContents.capturePage()
  }

  // --- statics ------------------------------------------------------------------------------

  static getAllWindows() {
    return [...windows.values()]
  }

  static getFocusedWindow() {
    return focusedId != null ? windows.get(focusedId) ?? null : null
  }

  static fromId(id) {
    return windows.get(id) ?? null
  }

  static fromWebContents(contents) {
    return contents?._win ?? null
  }

  static fromBrowserView() {
    return null
  }
}

/** Electron 28+ name for a window without web contents; aliased for convenience. */
export const BaseWindow = BrowserWindow
