/**
 * BrowserWindow and webContents, implemented with Tauri's WebviewWindow.
 *
 * Each BrowserWindow owns one Tauri WebviewWindow labelled
 * `electron-window-<id>`. Electron exposes many window getters synchronously
 * (getSize, isMaximized, getTitle, ...) while Tauri's are async, so the state
 * is cached here and refreshed from Tauri window events.
 *
 * Page-side behaviour (context menus, link clicks, window.open, console
 * messages, keyboard input, find-in-page) is reported by the renderer
 * bootstrap (src/renderer/bootstrap.js). Navigation events for every page,
 * remote ones included, come from tauri-plugin-electron's page-load hook.
 */
import { emitTo } from '@tauri-apps/api/event'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { Menu as TauriMenu } from '@tauri-apps/api/menu'
import { UserAttentionType, ProgressBarStatus } from '@tauri-apps/api/window'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { bus } from '../internal/bus.js'
import { TO_RENDERER, deferred, report, warnOnce, NotImplementedError, deserializeError } from '../internal/runtime.js'
import { encode, decode } from '../internal/serialize.js'
import { native, hasNativePlugin, processInfo } from '../internal/native.js'
import { platform } from '../process.js'
import { toProjectPath } from '../internal/app-files.js'
import { resolveImage } from './native-image.js'
import { IpcMain } from './ipc-main.js'
import { transferPorts } from './message-ports.js'
import { session as sessionModule } from './session.js'
import { toNativeSchemeUrl } from './protocol.js'
import { createWebviewWindow } from './native-window.js'
import { downloadURL } from './downloads.js'
import { printToPDF, capturePage } from './capture.js'
import { trustedOriginOf, registerTrustedRenderer, trustedRendererRegistered } from './trusted-origins.js'

const windows = new Map()

// Menu.setApplicationMenu gives every window the new menu: hide it again where the bar is hidden.
bus.on('application-menu-set', () => {
  for (const win of windows.values()) if (!win._state.menuBarVisible) win._applyMenuBarVisibility()
})
const contentsById = new Map()
const contentsByLabel = new Map()
let nextId = 1
let focusedId = null

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const isMac = platform === 'darwin'

/** Events the renderer bootstrap only reports while the main process listens for them. */
// `menu-bar-alt` is internal: Alt pressed alone, for autoHideMenuBar.
const RENDERER_EVENTS = new Set(['context-menu', 'before-input-event', 'console-message', 'will-navigate', 'will-frame-navigate', 'zoom-changed', 'menu-bar-alt'])

/**
 * Turn a loadFile() path into an app-relative URL Tauri understands. Real
 * paths under the app root (`path.join(app.getAppPath(), 'index.html')`)
 * become project-relative first.
 */
export function fileToUrl(filePath, options = {}) {
  let p = String(toProjectPath(String(filePath))).replace(/\\/g, '/')
  if (p.startsWith('file://')) p = p.slice('file://'.length)
  p = p.replace(/^\/+/, '')
  let url = encodeURI(p)
  if (options.query && Object.keys(options.query).length) url += `?${new URLSearchParams(options.query)}`
  else if (options.search) url += options.search.startsWith('?') ? options.search : `?${options.search}`
  if (options.hash) url += options.hash.startsWith('#') ? options.hash : `#${options.hash}`
  return url
}

/**
 * `loadURL('file:///…/index.html')` → the app page at that path. There are no
 * local files to load in Tauri; with __dirname rewritten to project-relative
 * paths, `file://${__dirname}/index.html` names the page in the build.
 */
export function fileUrlToAppUrl(url) {
  if (!/^file:\/\//i.test(url)) return url
  const parsed = new URL(url)
  return fileToUrl(decodeURIComponent(parsed.pathname)) + parsed.search + parsed.hash
}

/**
 * URLs served by our own frontend get the renderer bootstrap; remote pages do
 * not, except those of trusted origins (see `BrowserWindow#_hasBootstrap`).
 */
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

/** window.open() features string → BrowserWindow options (Electron's subset). */
export function parseWindowFeatures(features = '') {
  const options = {}
  for (const part of String(features).split(',')) {
    const [rawKey, rawValue = 'yes'] = part.split('=').map((s) => s.trim())
    if (!rawKey) continue
    const key = rawKey.toLowerCase()
    const value = rawValue.toLowerCase()
    const flag = value === 'yes' || value === '1' || value === 'true'
    const number = Number(rawValue)
    if (key === 'width' || key === 'innerwidth') options.width = number
    else if (key === 'height' || key === 'innerheight') options.height = number
    else if (key === 'left' || key === 'screenx') options.x = number
    else if (key === 'top' || key === 'screeny') options.y = number
    else if (key === 'resizable') options.resizable = flag
    else if (key === 'show') options.show = flag
    else if (key === 'frame') options.frame = flag
    else if (key === 'title') options.title = rawValue
  }
  return options
}

// ---------------------------------------------------------------------------
// webContents
// ---------------------------------------------------------------------------

/** Electron's webContents.navigationHistory, tracked from navigation events. */
class NavigationHistory {
  constructor(contents) {
    this._contents = contents
    this._entries = []
    this._index = -1
    this._pendingOffset = 0
  }

  _onNavigate(url, title) {
    if (this._pendingOffset) {
      this._index = Math.max(0, Math.min(this._entries.length - 1, this._index + this._pendingOffset))
      this._pendingOffset = 0
      if (this._entries[this._index]) this._entries[this._index].url = url
      return
    }
    if (this._entries[this._index]?.url === url) return
    this._entries.splice(this._index + 1)
    this._entries.push({ url, title: title ?? '' })
    this._index = this._entries.length - 1
  }

  _setTitle(title) {
    if (this._entries[this._index]) this._entries[this._index].title = title
  }

  canGoBack() { return this._index > 0 }
  canGoForward() { return this._index < this._entries.length - 1 }
  canGoToOffset(offset) { const i = this._index + offset; return i >= 0 && i < this._entries.length }
  getActiveIndex() { return this._index }
  length() { return this._entries.length }
  getEntryAtIndex(index) { const e = this._entries[index]; return e ? { ...e } : null }
  getAllEntries() { return this._entries.map((e) => ({ ...e })) }
  clear() { this._entries = this._entries.slice(this._index, this._index + 1); this._index = this._entries.length - 1 }
  removeEntryAtIndex(index) {
    if (index === this._index || !this._entries[index]) return false
    this._entries.splice(index, 1)
    if (index < this._index) this._index--
    return true
  }
  goBack() { this.goToOffset(-1) }
  goForward() { this.goToOffset(1) }
  goToIndex(index) { this.goToOffset(index - this._index) }
  goToOffset(offset) {
    if (!offset || !this.canGoToOffset(offset)) return
    this._pendingOffset = offset
    this._contents._command('history-go', { offset })
  }
}

/** Electron's WebFrameMain for the (only) main frame of a webContents. */
class WebFrameMain {
  constructor(contents) {
    this._contents = contents
    this.routingId = contents.id
    this.frameTreeNodeId = contents.id
    this.name = ''
    this.parent = null
    this.frames = []
    this.detached = false
  }

  get url() { return this._contents.getURL() }
  get origin() {
    try {
      const url = new URL(this.url)
      return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin
    } catch {
      return ''
    }
  }
  get top() { return this }
  get framesInSubtree() { return [this] }
  get processId() { return this._contents.getProcessId() }
  get osProcessId() { return this._contents.getOSProcessId() }
  get visibilityState() { return this._contents._win.isVisible() ? 'visible' : 'hidden' }
  isDestroyed() { return this._contents.isDestroyed() }
  send(channel, ...args) { this._contents.send(channel, ...args) }
  postMessage(channel, message, transfer) { this._contents.postMessage(channel, message, transfer) }
  executeJavaScript(code) { return this._contents.executeJavaScript(code) }
  reload() { this._contents.reload(); return true }
  collectJavaScriptCallStack() { return Promise.resolve(undefined) }
  toJSON() { return { url: this.url, origin: this.origin, routingId: this.routingId, processId: this.processId } }
}

export class WebContents extends EventEmitter {
  constructor(win) {
    super()
    this.id = win.id
    this._win = win
    this._url = ''
    this._title = ''
    this._zoomFactor = 1
    this._alive = false // the renderer bootstrap has reported did-finish-load
    this._loading = false
    this._queue = []
    this._pending = new Map()
    this._nextRequest = 1
    this._css = new Map()
    this._windowOpenHandler = null
    this._subscriptions = new Set()
    this._devToolsOpened = false
    this._audioMuted = false
    this._userAgent = ''
    this._findRequest = 0
    this.ipc = new IpcMain()
    this.navigationHistory = new NavigationHistory(this)
    this.mainFrame = new WebFrameMain(this)
    this.session = win._session
    this.hostWebContents = null
    this.devToolsWebContents = null
    this.opener = null
    this.debugger = {
      attach() { throw new NotImplementedError('webContents.debugger.attach', { reason: 'unsupported', hint: 'The Chrome DevTools Protocol is not reachable from a Tauri webview.' }) },
      detach() {},
      isAttached: () => false,
      sendCommand: () => Promise.reject(new NotImplementedError('webContents.debugger.sendCommand', { reason: 'unsupported' })),
      on() { return this },
      once() { return this },
      removeListener() { return this },
      off() { return this },
    }
    contentsById.set(this.id, this)
    // When the main process starts listening for a page-side event, tell the page.
    this._newListener = (name) => {
      if (!RENDERER_EVENTS.has(name) || this._subscriptions.has(name)) return
      this._subscriptions.add(name)
      if (this._label) this._sendSubscriptions()
    }
  }

  get _label() {
    return this._win._label
  }

  _post(message) {
    const { transferred, ...rest } = message
    const label = this._label
    const sent = emitTo(label, TO_RENDERER, { ...rest, to: label })
    if (!transferred) return sent.catch(report('webContents message'))
    // The ports postMessage() transferred live at `label` now; what reached
    // them meanwhile goes after this message, which creates them there.
    return sent.then(
      () => { for (const port of transferred) port._flushTransferred(label) },
      (error) => {
        report('webContents message')(error)
        for (const port of transferred) port._destinationGone()
      },
    )
  }

  /** The page is gone: messages still waiting for it drop, and the ports they carried close. */
  _dropQueue() {
    for (const message of this._queue.splice(0)) for (const port of message.transferred ?? []) port._destinationGone()
  }

  _postWhenAlive(message) {
    if (this._alive) this._post(message)
    else this._queue.push(message)
  }

  _command(name, data = {}) {
    this._postWhenAlive({ type: 'command', name, ...data })
  }

  _sendSubscriptions() {
    this._post({ type: 'command', name: 'subscribe', events: [...this._subscriptions] })
  }

  /** Called by the IPC bridge for messages from the renderer bootstrap. */
  _onLifecycle(name, data = {}) {
    switch (name) {
      case 'dom-ready':
        this._url = data.url ?? this._url
        if (this._subscriptions.size) this._sendSubscriptions()
        this.emit('dom-ready', createEvent())
        break
      case 'did-finish-load': {
        this._url = data.url ?? this._url
        this._title = data.title ?? this._title
        this._alive = true
        const queue = this._queue.splice(0)
        for (const message of queue) this._post(message)
        if (!hasNativePlugin()) this.navigationHistory._onNavigate(this._url, this._title)
        this.emit('did-finish-load', createEvent())
        this._win._onDidFinishLoad()
        break
      }
      case 'page-title-updated': {
        this._title = data.title
        this.navigationHistory._setTitle(data.title)
        const event = createEvent()
        this.emit('page-title-updated', event, data.title, true)
        this._win._onPageTitleUpdated(data.title)
        break
      }
      case 'unload':
        this._alive = false
        break
      case 'exec-result': {
        const pending = this._pending.get(data.id)
        if (!pending) return
        this._pending.delete(data.id)
        if (data.ok) pending.resolve(decode(data.result))
        else pending.reject(deserializeError(data.error))
        break
      }
      case 'did-navigate-in-page':
        this._url = data.url
        this.navigationHistory._onNavigate(data.url, this._title)
        this.emit('did-navigate-in-page', createEvent({ url: data.url }), data.url, true, this.getProcessId(), this.mainFrame.routingId)
        break
      case 'will-navigate': {
        const event = createEvent({ url: data.url, isMainFrame: true, isSameDocument: false, frame: this.mainFrame, initiator: this.mainFrame })
        this.emit('will-frame-navigate', event)
        if (!event.defaultPrevented) this.emit('will-navigate', event, data.url)
        if (!event.defaultPrevented) this._post({ type: 'command', name: 'navigate', url: data.url })
        break
      }
      case 'window-open':
        this._onWindowOpen(data)
        break
      case 'context-menu':
        this.emit('context-menu', createEvent(), { ...data, frame: this.mainFrame, pageURL: data.pageURL ?? this._url })
        break
      case 'menu-bar-alt':
        this._win._onMenuBarAlt()
        break
      case 'before-input-event':
        // Reported after the fact: preventDefault() cannot stop the page from seeing it.
        this.emit('before-input-event', createEvent(), data)
        break
      case 'console-message': {
        const levels = { verbose: 0, debug: 0, info: 1, log: 1, warning: 2, warn: 2, error: 3 }
        const event = createEvent({ level: data.level, message: data.message, lineNumber: data.lineNumber ?? 0, sourceId: data.sourceId ?? '', frame: this.mainFrame })
        this.emit('console-message', event, levels[data.level] ?? 1, data.message, data.lineNumber ?? 0, data.sourceId ?? '')
        break
      }
      case 'found-in-page':
        this.emit('found-in-page', createEvent(), data)
        break
      case 'zoom-changed':
        this.emit('zoom-changed', createEvent(), data.direction)
        break
      case 'drop-files':
        // Files dropped on the page (paths from Tauri's drag & drop event).
        break
      case 'webview-attach':
      case 'webview-detach':
      case 'webview-call':
      case 'guest-close':
        // <webview> elements of this page, window.close() in a guest (./views.js).
        bus.emit('guest-lifecycle', this, name, data)
        break
    }
  }

  /** Page loads reported by tauri-plugin-electron (every page, including remote ones). */
  _onPageLoad(kind, url) {
    if (kind === 'started') {
      this._loading = true
      this._url = url
      this.emit('did-start-loading', createEvent())
      this.emit('did-start-navigation', createEvent({ url, isSameDocument: false, isMainFrame: true, frame: this.mainFrame }), url, false, true)
      return
    }
    this._loading = false
    this._url = url
    this.navigationHistory._onNavigate(url, this._title)
    this.emit('did-navigate', createEvent({ url }), url, 200, 'OK')
    if (!this._win._hasBootstrap(url)) {
      // Nothing to talk to on this page (the last one's `unload` can be lost
      // while it goes away): loadURL() replaces the window instead.
      this._alive = false
      this._win._onDidFinishLoad(true)
    }
    this.emit('did-stop-loading', createEvent())
  }

  _onWindowOpen(data) {
    const details = {
      url: data.url,
      frameName: data.frameName ?? '',
      features: data.features ?? '',
      disposition: data.disposition ?? 'new-window',
      referrer: { url: this._url, policy: 'strict-origin-when-cross-origin' },
      postBody: undefined,
    }
    let result = { action: 'allow' }
    if (this._windowOpenHandler) {
      try {
        result = this._windowOpenHandler(details) ?? { action: 'deny' }
      } catch (error) {
        report('setWindowOpenHandler handler')(error)
        return
      }
    }
    if (result.action !== 'allow') return
    // Like Electron, the child inherits the opener's webPreferences.
    const options = {
      ...parseWindowFeatures(details.features),
      ...(result.overrideBrowserWindowOptions ?? {}),
    }
    options.webPreferences = { ...this._win._options.webPreferences, ...options.webPreferences }
    const child = new BrowserWindow(options)
    child.webContents.opener = this.mainFrame
    let url = details.url
    try {
      url = new URL(details.url, this._url || location.href).href
    } catch {
      /* keep as is */
    }
    child.loadURL(url)
    this.emit('did-create-window', child, { ...details, options })
  }

  send(channel, ...args) {
    if (this.isDestroyed()) throw new Error('Object has been destroyed')
    this._postWhenAlive({ type: 'send', channel: String(channel), args: encode(args) })
  }

  /** Transfers MessagePortMain objects; the page receives DOM MessagePorts in event.ports. */
  postMessage(channel, message, transfer = []) {
    if (this.isDestroyed()) throw new Error('Object has been destroyed')
    const args = encode([message])
    // Transferred (neutered) now, as in Electron, even if the message waits
    // for the page; the label is the page's when the message is sent.
    const ports = transferPorts(transfer, null, { deferQueue: true })
    this._postWhenAlive({ type: 'send', channel: String(channel), args, ...(ports ? { ports, transferred: [...transfer] } : {}) })
  }

  /** Runs `code` in the page and resolves with the (structured-cloneable) result. */
  executeJavaScript(code, _userGesture) {
    const id = this._nextRequest++
    const { promise, resolve, reject } = deferred()
    this._pending.set(id, { resolve, reject })
    this._command('execute', { id, code: String(code) })
    return promise
  }

  executeJavaScriptInIsolatedWorld(_worldId, scripts) {
    return Promise.all(scripts.map((script) => this.executeJavaScript(script.code))).then((results) => results.at(-1))
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

  stop() {
    this._command('stop')
  }

  // Deprecated (Electron 32) aliases of navigationHistory.
  canGoBack() { return this.navigationHistory.canGoBack() }
  canGoForward() { return this.navigationHistory.canGoForward() }
  canGoToOffset(offset) { return this.navigationHistory.canGoToOffset(offset) }
  goBack() { this.navigationHistory.goBack() }
  goForward() { this.navigationHistory.goForward() }
  goToIndex(index) { this.navigationHistory.goToIndex(index) }
  goToOffset(offset) { this.navigationHistory.goToOffset(offset) }
  clearHistory() { this.navigationHistory.clear() }

  getURL() {
    return this._url
  }

  getTitle() {
    return this._title || this._win._state.title
  }

  isLoading() {
    return this._loading || !this._alive
  }

  isLoadingMainFrame() {
    return this.isLoading()
  }

  isWaitingForResponse() {
    return false
  }

  isDestroyed() {
    return this._win.isDestroyed()
  }

  isCrashed() {
    return false
  }

  forcefullyCrashRenderer() {}

  isFocused() {
    return this._win.isFocused()
  }

  focus() {
    this._win.focus()
  }

  getType() {
    return 'window'
  }

  isOffscreen() {
    return false
  }

  // --- zoom --------------------------------------------------------------------

  setZoomFactor(factor) {
    if (!(factor > 0)) throw new Error("'zoomFactor' must be a double greater than 0.0")
    this._zoomFactor = factor
    this._win._call((n) => n.setZoom(factor), 'setZoomFactor')
  }

  getZoomFactor() {
    return this._zoomFactor
  }

  get zoomFactor() {
    return this.getZoomFactor()
  }

  set zoomFactor(factor) {
    this.setZoomFactor(factor)
  }

  setZoomLevel(level) {
    this.setZoomFactor(Math.pow(1.2, level))
  }

  getZoomLevel() {
    return Math.log(this._zoomFactor) / Math.log(1.2)
  }

  get zoomLevel() {
    return this.getZoomLevel()
  }

  set zoomLevel(level) {
    this.setZoomLevel(level)
  }

  setVisualZoomLevelLimits() {
    return Promise.resolve()
  }

  // --- page content ------------------------------------------------------------

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

  _execCommand(command, value) {
    const args = value === undefined ? JSON.stringify(command) : `${JSON.stringify(command)}, false, ${JSON.stringify(value)}`
    this.executeJavaScript(`document.execCommand(${args})`).catch(report(command))
  }

  undo() { this._execCommand('undo') }
  redo() { this._execCommand('redo') }
  cut() { this._execCommand('cut') }
  copy() { this._execCommand('copy') }
  paste() { this._execCommand('paste') }
  pasteAndMatchStyle() { this._execCommand('paste') }
  delete() { this._execCommand('delete') }
  selectAll() { this._execCommand('selectAll') }
  unselect() { this.executeJavaScript('window.getSelection()?.removeAllRanges()').catch(report('unselect')) }
  insertText(text) { this._execCommand('insertText', String(text)); return Promise.resolve() }
  replace(text) { this._execCommand('insertText', String(text)) }
  replaceMisspelling(text) { this._execCommand('insertText', String(text)) }
  centerSelection() {}
  scrollToTop() { this.executeJavaScript('window.scrollTo(0, 0)').catch(report('scrollToTop')) }
  scrollToBottom() { this.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight)').catch(report('scrollToBottom')) }
  copyImageAt() { warnOnce('copyImageAt', 'webContents.copyImageAt() is a no-op in tauri-electron.') }

  /** Uses window.find(); emits 'found-in-page' with the match count. */
  findInPage(text, options = {}) {
    const requestId = ++this._findRequest
    this._command('find', { requestId, text: String(text), options })
    return requestId
  }

  stopFindInPage(action = 'clearSelection') {
    this._command('stop-find', { action })
  }

  print(_options, callback) {
    this.executeJavaScript('window.print()').then(() => callback?.(true, ''), (error) => callback?.(false, String(error)))
  }

  getPrintersAsync() {
    return Promise.resolve([])
  }

  // --- devtools (tauri-plugin-electron; debug builds or its `devtools` feature) ---

  openDevTools() {
    if (this._win._options.webPreferences?.devTools === false) return
    native('open_devtools', { label: this._label }).then((opened) => {
      if (!opened) {
        warnOnce('devtools', 'webContents.openDevTools() needs a debug build (or the `devtools` feature of tauri-plugin-electron).')
        return
      }
      this._devToolsOpened = true
      this.emit('devtools-opened')
    }, () => warnOnce('devtools', 'webContents.openDevTools() needs tauri-plugin-electron.'))
  }

  closeDevTools() {
    if (!this._devToolsOpened) return
    this._devToolsOpened = false
    native('close_devtools', { label: this._label }).catch(report('closeDevTools'))
    this.emit('devtools-closed')
  }

  toggleDevTools() {
    if (this._devToolsOpened) this.closeDevTools()
    else this.openDevTools()
  }

  isDevToolsOpened() {
    return this._devToolsOpened
  }

  isDevToolsFocused() {
    return false
  }

  inspectElement() {
    this.openDevTools()
  }

  // --- misc ------------------------------------------------------------------

  setWindowOpenHandler(handler) {
    this._windowOpenHandler = typeof handler === 'function' ? handler : null
  }

  setAudioMuted(muted) {
    this._audioMuted = Boolean(muted)
    this.executeJavaScript(`document.querySelectorAll('audio,video').forEach((m) => { m.muted = ${this._audioMuted} })`).catch(report('setAudioMuted'))
  }

  isAudioMuted() {
    return this._audioMuted
  }

  get audioMuted() { return this._audioMuted }
  set audioMuted(value) { this.setAudioMuted(value) }

  isCurrentlyAudible() {
    return false
  }

  setUserAgent(userAgent) {
    this._userAgent = String(userAgent)
    warnOnce('setUserAgent', 'webContents.setUserAgent() applies to windows created afterwards (Tauri sets the user agent at creation).')
  }

  getUserAgent() {
    return this._userAgent || this.session?.getUserAgent?.() || (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  }

  get userAgent() { return this.getUserAgent() }
  set userAgent(value) { this.setUserAgent(value) }

  setBackgroundThrottling(allowed) {
    this._win._options.webPreferences = { ...this._win._options.webPreferences, backgroundThrottling: Boolean(allowed) }
  }

  getBackgroundThrottling() {
    return this._win._options.webPreferences?.backgroundThrottling !== false
  }

  get backgroundThrottling() { return this.getBackgroundThrottling() }
  set backgroundThrottling(value) { this.setBackgroundThrottling(value) }

  setIgnoreMenuShortcuts() {}
  setWebRTCIPHandlingPolicy(policy) { this._webRTCIPHandlingPolicy = policy }
  getWebRTCIPHandlingPolicy() { return this._webRTCIPHandlingPolicy ?? 'default' }
  setFrameRate() {}
  getFrameRate() { return 60 }
  invalidate() {}
  startDrag() { warnOnce('startDrag', 'webContents.startDrag() is a no-op in tauri-electron.') }
  beginFrameSubscription() { throw new NotImplementedError('webContents.beginFrameSubscription', { reason: 'unsupported' }) }
  endFrameSubscription() {}
  getMediaSourceId() { throw new NotImplementedError('webContents.getMediaSourceId', { reason: 'unsupported', hint: 'Sources cannot be chosen by the app: getUserMedia({ chromeMediaSource: \'desktop\' }) opens the webview\'s screen picker.' }) }

  /** Single native process: the app's pid (from tauri-plugin-electron). */
  getOSProcessId() {
    return processInfo()?.pid ?? 0
  }

  getProcessId() {
    return this.id
  }

  /** The visible page as a NativeImage (./capture.js). */
  capturePage(rect, opts) {
    return capturePage(this, rect, opts)
  }

  /** A PDF of the page (./capture.js). */
  printToPDF(options) {
    return printToPDF(this, options)
  }

  savePage() {
    return Promise.reject(new NotImplementedError('webContents.savePage', { reason: 'unsupported' }))
  }

  /** Emits the session's 'will-download' (./downloads.js). */
  downloadURL(url, options) {
    downloadURL(this.session, this, url, options)
  }

  close() {
    this._win.close()
  }
}

export const webContents = {
  getAllWebContents: () => [...contentsById.values()],
  getFocusedWebContents: () => BrowserWindow.getFocusedWindow()?.webContents ?? null,
  fromId: (id) => contentsById.get(id),
  fromFrame: (frame) => frame?._contents,
  fromDevToolsTargetId: () => undefined,
}

export function webContentsFromLabel(label) {
  return contentsByLabel.get(label)
}

/**
 * For ./views.js: the webContents of views and `<webview>` guests share the
 * ids, IPC routing (by webview label) and page-load events of windows.
 */
export const guests = {
  nextId: () => nextId++,
  all: () => [...contentsById.values()],
  register(contents, label) {
    contentsById.set(contents.id, contents)
    contentsByLabel.set(label, contents)
  },
  forgetLabel(label) {
    contentsByLabel.delete(label)
  },
  unregister(contents, label) {
    contentsById.delete(contents.id)
    if (label && contentsByLabel.get(label) === contents) contentsByLabel.delete(label)
  },
  absoluteAppUrl: (url) => absoluteAppUrl(url),
}

/** webFrameMain module: only main frames exist in tauri-electron. */
export const webFrameMain = {
  fromId: (_processId, routingId) => contentsById.get(routingId)?.mainFrame,
  fromFrameToken: () => undefined,
}

// ---------------------------------------------------------------------------
// BrowserWindow
// ---------------------------------------------------------------------------

/** Escape hatch: `new BrowserWindow({ tauri: { ...WebviewWindow options } })`. */
export class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.id = nextId++
    this._options = { ...options }
    this._generation = 0
    this._label = ''
    this._native = null
    this._creating = false
    this._nativeReady = deferred()
    this._nativeReady.promise.catch(() => {})
    this._destroyed = false
    this._shownOnce = false
    this._readyToShowEmitted = false
    this._loadWaiters = []
    this._parent = options.parent ?? null
    const prefs = options.webPreferences ?? {}
    this._session = prefs.session ?? (prefs.partition ? sessionModule.fromPartition(prefs.partition) : sessionModule.defaultSession)
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
      fullscreenable: options.fullscreenable !== false,
      enabled: true,
      alwaysOnTop: Boolean(options.alwaysOnTop),
      skipTaskbar: Boolean(options.skipTaskbar),
      kiosk: Boolean(options.kiosk),
      backgroundColor: options.backgroundColor ?? '#FFFFFF',
      scaleFactor: 1,
      menuBarVisible: !options.autoHideMenuBar,
      autoHideMenuBar: Boolean(options.autoHideMenuBar),
      opacity: options.opacity ?? 1,
      documentEdited: false,
      representedFilename: '',
      aspectRatio: 0,
    }
    this.webContents = new WebContents(this)
    if (options.autoHideMenuBar) this.webContents._newListener('menu-bar-alt')
    windows.set(this.id, this)
    bus.emit('browser-window-created', this)
    bus.emit('web-contents-created', this.webContents)
    if (options.modal && this._parent && !isMac) {
      // Electron on Windows/Linux disables the parent while a modal child is open.
      this._parent.setEnabled(false)
      this.once('closed', () => this._parent?.isDestroyed() || this._parent.setEnabled(true))
    }

    // Electron windows exist (and are shown) as soon as they are constructed.
    // Tauri needs the URL up front, so creation waits until the first
    // loadURL()/loadFile() - which virtually always happens synchronously
    // right after the constructor. Fall back to a blank window otherwise.
    setTimeout(() => {
      if (!this._native && !this._creating && !this._destroyed) this._createNative('about:blank')
    }, 0)
  }

  // --- native window lifecycle ---------------------------------------------

  /** Electron webPreferences / options → Tauri WebviewWindow options. */
  _nativeOptions(url) {
    const o = this._options
    const s = this._state
    const prefs = o.webPreferences ?? {}
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
      focus: s.visible && s.focusable && o.focusable !== false,
      focusable: s.focusable,
      contentProtected: Boolean(o.contentProtection),
      visibleOnAllWorkspaces: Boolean(o.visibleOnAllWorkspaces),
      shadow: o.hasShadow !== false,
      // Electron enables DevTools unless webPreferences.devTools is false.
      devtools: prefs.devTools !== false,
      ...this._session?._tauriWebviewOptions?.(),
    }
    if (hasPosition) Object.assign(native, { x: o.x, y: o.y })
    if (o.minWidth || o.minHeight) Object.assign(native, { minWidth: o.minWidth ?? 0, minHeight: o.minHeight ?? 0 })
    if (o.maxWidth || o.maxHeight) Object.assign(native, { maxWidth: o.maxWidth ?? 1e5, maxHeight: o.maxHeight ?? 1e5 })
    if (o.backgroundColor) native.backgroundColor = o.backgroundColor
    if (this._parent?._label) native.parent = this._parent._label
    if (o.titleBarStyle === 'hidden' || o.titleBarStyle === 'hiddenInset' || o.titleBarStyle === 'customButtonsOnHover') {
      // macOS keeps the traffic lights over the content; elsewhere Electron
      // removes the title bar (a frameless window).
      if (isMac) {
        native.titleBarStyle = 'overlay'
        native.hiddenTitle = true
      } else {
        native.decorations = false
      }
    }
    if (o.trafficLightPosition) native.trafficLightPosition = new LogicalPosition(o.trafficLightPosition.x, o.trafficLightPosition.y)
    if (o.tabbingIdentifier) native.tabbingIdentifier = o.tabbingIdentifier
    if (prefs.backgroundThrottling === false) native.backgroundThrottling = 'disabled'
    if (prefs.javascript === false) native.javascriptDisabled = true
    if (prefs.zoomFactor) this.webContents._zoomFactor = prefs.zoomFactor
    const userAgent = this.webContents._userAgent || this._session?._userAgent
    if (userAgent) native.userAgent = userAgent
    return { ...native, ...o.tauri }
  }

  /** What the renderer bootstrap reads synchronously before the preload runs. */
  _rendererConfig() {
    const prefs = this._options.webPreferences ?? {}
    const info = processInfo()
    // Electron's defaults: contextIsolation and sandbox on, nodeIntegration
    // off. Before Electron 20, preloads were not sandboxed by default.
    const contextIsolation = prefs.contextIsolation !== false
    const nodeIntegration = Boolean(prefs.nodeIntegration)
    const electronMajor = globalThis.__TAURI_ELECTRON_APP__?.electron
    const sandbox = prefs.sandbox ?? !(nodeIntegration || (typeof electronMajor === 'number' && electronMajor < 20))
    // Node built-ins for the page (nodeIntegration) or its unsandboxed preload,
    // which share one world here. tauri-plugin-electron grants the window.
    const node = !sandbox
    return {
      id: this.webContents.id,
      argv: [info?.execPath ?? '', ...(prefs.additionalArguments ?? []).map(String)],
      execPath: info?.execPath ?? '',
      pid: info?.pid ?? 0,
      // A context-isolated preload's `process.env` is not reachable from the
      // page in Electron. tauri-electron has no isolated world, so the
      // environment is only exposed when isolation is off anyway, or when
      // the window has Node (and can read it from the system anyway).
      env: contextIsolation && !node ? {} : info?.env ?? {},
      contextIsolation,
      nodeIntegration,
      sandbox,
      node,
      zoomFactor: this.webContents._zoomFactor,
      titleBarOverlay: this._titleBarOverlayConfig(),
      // The page may use <webview> (./views.js, ../renderer/webview-tag.js).
      webviewTag: Boolean(prefs.webviewTag),
    }
  }

  /**
   * The window controls the renderer bootstrap draws for `titleBarStyle:
   * 'hidden'` + `titleBarOverlay` (Windows and Linux; macOS keeps its own
   * traffic lights), or null.
   */
  _titleBarOverlayConfig() {
    const o = this._options
    const hidden = o.titleBarStyle === 'hidden' || o.titleBarStyle === 'hiddenInset' || o.titleBarStyle === 'customButtonsOnHover'
    if (isMac || !hidden || !o.titleBarOverlay) return null
    const overlay = o.titleBarOverlay === true ? {} : { ...o.titleBarOverlay }
    return { ...overlay, minimizable: this._state.minimizable, maximizable: this._state.maximizable, closable: this._state.closable }
  }

  _createNative(url) {
    const generation = ++this._generation
    const label = `electron-window-${this.id}${generation > 1 ? `-${generation}` : ''}`
    this._label = label
    this._creating = true
    contentsByLabel.set(label, this.webContents)
    url = toNativeSchemeUrl(url)
    this.webContents._url = url
    this.webContents._alive = false
    // With trusted origins, the renderer script for their pages is handed to
    // tauri-plugin-electron before the first window is created.
    const configured = hasNativePlugin()
      ? Promise.all([native('set_window_config', { label, config: this._rendererConfig() }).catch(report('window config')), registerTrustedRenderer()])
      : Promise.resolve()
    configured.then(() => {
      if (this._destroyed || this._label !== label) return
      this._spawnNative(label, url)
    })
  }

  _spawnNative(label, url) {
    // Created with the trusted origins' renderer script (an initialization script).
    this._trustedRenderer = trustedRendererRegistered()
    const native = createWebviewWindow(label, this._nativeOptions(url), {
      permissionHandler: typeof this._session?._handlers?.permissionRequest === 'function',
      // The session chose its proxy (setProxy), so a window without one goes direct.
      proxyConfigured: Boolean(this._session?._proxyConfigured),
      // The session.webRequest events with a listener (http(s) requests of the page).
      webRequest: this._session?.webRequest?._events?.() ?? [],
    })
    const previous = this._native
    this._native = native
    this._creating = false
    if (previous) {
      this._nativeReady = deferred()
      this._nativeReady.promise.catch(() => {})
      previous.destroy().catch(report('replace window'))
    }
    const isCurrent = () => this._native === native && !this._destroyed

    native.once('tauri://created', () => {
      if (!isCurrent()) return
      this._nativeReady.resolve(native)
      this._attachNativeListeners(native, isCurrent)
      this._refreshGeometry()
      if (this.webContents._zoomFactor !== 1) native.setZoom(this.webContents._zoomFactor).catch(report('setZoom'))
      if (this._options.icon) this.setIcon(this._options.icon)
      if (!this._state.menuBarVisible) this._applyMenuBarVisibility()
      if (!this._hasBootstrap(url)) {
        // No bootstrap in remote/blank pages: tauri-plugin-electron reports
        // the load; synthesize it if that does not happen in time.
        this._syntheticLoad = setTimeout(() => isCurrent() && this._onDidFinishLoad(true), hasNativePlugin() ? 3000 : 300)
      }
    })
    native.once('tauri://error', (event) => {
      if (!isCurrent()) return
      const error = new Error(`Failed to create window: ${JSON.stringify(event.payload)}`)
      this._nativeReady.reject(error)
      for (const waiter of this._loadWaiters.splice(0)) waiter.reject(error)
      this.webContents.emit('did-fail-load', createEvent(), -2, error.message, url, true, 0, 0)
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
      this.webContents.emit(focused ? 'focus' : 'blur')
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
    clearTimeout(this._syntheticLoad)
    this.webContents._dropQueue()
    windows.delete(this.id)
    contentsById.delete(this.id)
    contentsByLabel.delete(this._label)
    if (hasNativePlugin()) native('set_window_config', { label: this._label, config: null }).catch(() => {})
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
      if (!maximized && !minimized && !fullscreen) this._normalBounds = { x: s.x, y: s.y, width: s.width, height: s.height }
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

  /**
   * Whether a page at `url` runs the renderer bootstrap (and reports its
   * lifecycle): the app's own pages, and pages of trusted origins in a window
   * created with their renderer script.
   */
  _hasBootstrap(url) {
    if (url === 'about:blank') return false
    return isAppUrl(url) || (Boolean(this._trustedRenderer) && trustedOriginOf(url) !== null)
  }

  _onDidFinishLoad(synthetic = false) {
    clearTimeout(this._syntheticLoad)
    if (synthetic) {
      this.webContents._loading = false
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
    this.emit('page-title-updated', event, title, true)
    // Like Electron, the window title follows <title> unless prevented.
    if (!event.defaultPrevented && title) this.setTitle(title)
  }

  // --- loading -------------------------------------------------------------

  loadURL(url, options) {
    url = fileUrlToAppUrl(String(url))
    if (options?.userAgent) this.webContents._userAgent = options.userAgent
    const { promise, resolve, reject } = deferred()
    this._loadWaiters.push({ resolve, reject })
    if (!this._native && !this._creating) {
      this._createNative(url)
    } else if (this.webContents._alive && this._hasBootstrap(url)) {
      this.webContents._alive = false
      this.webContents._post({ type: 'command', name: 'navigate', url: absoluteAppUrl(url) })
    } else if (this._hasViews?.()) {
      // Child views live in this native window (./views.js): navigate it in place.
      this.webContents._alive = false
      native('view_navigate', { label: this._label, url: absoluteAppUrl(toNativeSchemeUrl(url)) }).catch((error) => {
        for (const waiter of this._loadWaiters.splice(0)) waiter.reject(error)
      })
    } else {
      // The current page has no bootstrap (blank or remote), so it cannot
      // navigate itself: replace the native window, keeping its geometry.
      this._options = { ...this._options, x: this._state.x, y: this._state.y, center: false }
      this._createNative(url)
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
    if (!this._native && !this._destroyed) {
      this._onDestroyed()
      return
    }
    this._call((n) => n.destroy(), 'destroy')
  }

  isDestroyed() {
    return this._destroyed
  }

  setEnabled(enabled) {
    this._state.enabled = Boolean(enabled)
    this._call((n) => n.setEnabled(Boolean(enabled)), 'setEnabled')
  }

  isEnabled() {
    return this._state.enabled
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
    this._call(async (n) => {
      await n.maximize()
      if (!this._state.visible) {
        this._state.visible = true
        await n.show()
      }
    }, 'maximize')
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

  get fullScreen() { return this.isFullScreen() }
  set fullScreen(flag) { this.setFullScreen(flag) }

  setSimpleFullScreen(flag) {
    this._state.fullscreen = Boolean(flag)
    this._call((n) => (isMac ? n.setSimpleFullscreen(Boolean(flag)) : n.setFullscreen(Boolean(flag))), 'setSimpleFullScreen')
  }

  isSimpleFullScreen() {
    return this.isFullScreen()
  }

  setFullScreenable(flag) {
    this._state.fullscreenable = Boolean(flag)
  }

  isFullScreenable() {
    return this._state.fullscreenable
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

  get title() { return this.getTitle() }
  set title(value) { this.setTitle(value) }

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

  /** Bounds of the window when it is neither maximized, minimized nor full screen. */
  getNormalBounds() {
    return this.isNormal() ? this.getBounds() : { ...(this._normalBounds ?? this.getBounds()) }
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

  setAspectRatio(aspectRatio) {
    this._state.aspectRatio = aspectRatio
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

  get resizable() { return this.isResizable() }
  set resizable(flag) { this.setResizable(flag) }

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

  moveAbove() {}

  setSkipTaskbar(flag) {
    this._state.skipTaskbar = Boolean(flag)
    this._call((n) => n.setSkipTaskbar(Boolean(flag)), 'setSkipTaskbar')
  }

  setVisibleOnAllWorkspaces(flag) {
    this._state.visibleOnAllWorkspaces = Boolean(flag)
    this._call((n) => n.setVisibleOnAllWorkspaces(Boolean(flag)), 'setVisibleOnAllWorkspaces')
  }

  isVisibleOnAllWorkspaces() {
    return Boolean(this._state.visibleOnAllWorkspaces)
  }

  setContentProtection(flag) {
    this._state.contentProtected = Boolean(flag)
    this._call((n) => n.setContentProtected(Boolean(flag)), 'setContentProtection')
  }

  isContentProtected() {
    return Boolean(this._state.contentProtected)
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
    this._state.hasShadow = Boolean(flag)
    this._call((n) => n.setShadow(Boolean(flag)), 'setHasShadow')
  }

  hasShadow() {
    return this._state.hasShadow !== false
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

  /** Windows taskbar overlay icon. */
  setOverlayIcon(overlay) {
    if (platform !== 'win32') return
    this._call(async (n) => n.setOverlayIcon((await resolveImage(overlay)) ?? undefined), 'setOverlayIcon')
  }

  setDocumentEdited(flag) {
    this._state.documentEdited = Boolean(flag)
  }

  isDocumentEdited() {
    return this._state.documentEdited
  }

  get documentEdited() { return this.isDocumentEdited() }
  set documentEdited(flag) { this.setDocumentEdited(flag) }

  setRepresentedFilename(filename) {
    this._state.representedFilename = filename
  }

  getRepresentedFilename() {
    return this._state.representedFilename
  }

  // Platform chrome Tauri does not expose to JavaScript: accepted, no effect.
  /** Restyle the window controls drawn for titleBarOverlay (color, symbolColor, height). */
  setTitleBarOverlay(options = {}) {
    if (!this._options.titleBarOverlay) return
    const current = this._options.titleBarOverlay === true ? {} : this._options.titleBarOverlay
    this._options.titleBarOverlay = { ...current, ...options }
    const overlay = this._titleBarOverlayConfig()
    if (!overlay) return
    if (hasNativePlugin() && this._label) native('set_window_config', { label: this._label, config: this._rendererConfig() }).catch(report('setTitleBarOverlay'))
    this.webContents._command('title-bar-overlay', { overlay })
  }
  setWindowButtonVisibility(visible) { this._windowButtonVisibility = Boolean(visible) }
  setWindowButtonPosition(position) { this._windowButtonPosition = position }
  getWindowButtonPosition() { return this._windowButtonPosition ?? this._options.trafficLightPosition ?? null }
  setTouchBar() {}
  setSheetOffset() {}
  addTabbedWindow() { warnOnce('addTabbedWindow', 'BrowserWindow.addTabbedWindow() is a no-op in tauri-electron.') }
  mergeAllWindows() {}
  moveTabToNewWindow() {}
  toggleTabBar() {}
  selectNextTab() {}
  selectPreviousTab() {}
  showAllTabs() {}
  setVibrancy() {}
  setBackgroundMaterial() {}
  setThumbarButtons() { return false }
  setThumbnailClip() { return false }
  setThumbnailToolTip() { return false }
  setAppDetails() {}
  setShape() {}
  previewFile() {}
  closeFilePreview() {}
  invalidateShadow() {}
  setAccentColor() {}
  getAccentColor() { return '' }
  getMediaSourceId() { throw new NotImplementedError('BrowserWindow.getMediaSourceId', { reason: 'unsupported', hint: 'Sources cannot be chosen by the app: getUserMedia({ chromeMediaSource: \'desktop\' }) opens the webview\'s screen picker.' }) }

  // --- menus ---------------------------------------------------------------------------

  setMenu(menu) {
    this._menu = menu ?? null
    this._call(async (n) => {
      // Tauri has no JS "remove menu" call; an empty menu is the closest match.
      const native = menu ? await menu._build() : await TauriMenu.new({ items: [] })
      await native.setAsWindowMenu(n)
      // A new menu shows: hide it again if the bar is meant to be hidden.
      if (!this._state.menuBarVisible) this._applyMenuBarVisibility()
    }, 'setMenu')
  }

  removeMenu() {
    this.setMenu(null)
  }

  /** Show or hide the window's menu bar (Windows and Linux; macOS has none per window). */
  _applyMenuBarVisibility() {
    if (isMac || !hasNativePlugin() || this._destroyed) return
    const visible = this._state.menuBarVisible
    this._call(() => native('set_menu_visible', { label: this._label, visible }), 'setMenuBarVisibility')
  }

  setMenuBarVisibility(visible) {
    this._state.menuBarVisible = Boolean(visible)
    this._applyMenuBarVisibility()
  }

  isMenuBarVisible() {
    return this._state.menuBarVisible
  }

  /** Hides the menu bar; Alt (pressed and released alone) toggles it, as in Electron. */
  setAutoHideMenuBar(hide) {
    hide = Boolean(hide)
    if (hide === this._state.autoHideMenuBar) return
    this._state.autoHideMenuBar = hide
    this._state.menuBarVisible = !hide
    if (hide) this.webContents._newListener('menu-bar-alt')
    this._applyMenuBarVisibility()
  }

  _onMenuBarAlt() {
    if (!this._state.autoHideMenuBar) return
    this._state.menuBarVisible = !this._state.menuBarVisible
    this._applyMenuBarVisibility()
  }

  isMenuBarAutoHide() {
    return this._state.autoHideMenuBar
  }

  get autoHideMenuBar() { return this.isMenuBarAutoHide() }
  set autoHideMenuBar(hide) { this.setAutoHideMenuBar(hide) }

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
    throw new NotImplementedError('BrowserWindow.getNativeWindowHandle', { reason: 'unsupported', hint: 'Native handles exist only in Rust (tauri::Window::hwnd / ns_window / gtk_window).' })
  }

  capturePage(rect, opts) {
    return this.webContents.capturePage(rect, opts)
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

  // contentView, setBrowserView & co. come from ./views.js, which also
  // extends fromWebContents and fromBrowserView to views.
  static fromBrowserView() {
    return null
  }
}

/** Electron 28+ name for a window without web contents; aliased for convenience. */
export const BaseWindow = BrowserWindow

/** Route page-load events from tauri-plugin-electron to the right webContents. */
export function onPageLoad({ label, url, event }) {
  contentsByLabel.get(label)?._onPageLoad(event, url)
}
