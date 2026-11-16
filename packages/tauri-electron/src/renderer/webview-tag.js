/**
 * Electron's `<webview>` tag, for pages whose window was created with
 * `webPreferences.webviewTag: true` (installed by the renderer bootstrap).
 *
 * The page cannot create webviews itself: each element asks the main
 * process to attach a guest (src/main/views.js: `will-attach-webview`, a
 * child webview of the window, `did-attach-webview`), then keeps that native
 * webview over its own box by reporting its rectangle and visibility straight
 * to tauri-plugin-electron (the bridge's `view/bounds`, which only moves this
 * page's guests) on every animation frame where it changed. Methods go to
 * the guest's webContents in the main process; its events come back and are
 * dispatched on the element with Electron's properties. Getters
 * (`getURL()`, `canGoBack()`, …) answer from the state that comes with
 * every event.
 *
 * `webview` is not a valid custom element name (no hyphen), so elements are
 * upgraded by hand: `document.createElement('webview')` returns an upgraded
 * element, and a MutationObserver upgrades and attaches the ones that parsing
 * or `innerHTML` insert.
 *
 * The guest is a native webview drawn over the page: page content cannot
 * cover it, and only the window (not scrolling containers) clips it.
 */
import { postToMain, commandHandlers } from './ipc-renderer.js'
import { bridgeUrl } from '../internal/native.js'
import { deferred, report } from '../internal/runtime.js'
import { encode, decode, decodeArgs } from '../internal/serialize.js'

const PAGE = Math.random().toString(36).slice(2, 10)
let nextInstance = 1
/** Elements by the id of their current attachment. */
const elements = new Map()

const STRING_ATTRIBUTES = ['src', 'partition', 'preload', 'httpreferrer', 'useragent', 'webpreferences', 'blinkfeatures', 'disableblinkfeatures']
const BOOLEAN_ATTRIBUTES = ['nodeintegration', 'nodeintegrationinsubframes', 'plugins', 'disablewebsecurity', 'allowpopups']
const ATTRIBUTES = [...STRING_ATTRIBUTES, ...BOOLEAN_ATTRIBUTES]
const NOT_ATTACHED = 'The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.'

const INITIAL_STATE = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  devToolsOpened: false,
  audioMuted: false,
  userAgent: '',
}

function absolute(url) {
  try {
    return new URL(String(url), document.baseURI).href
  } catch {
    return String(url)
  }
}

commandHandlers['webview-attached'] = ({ instance, id }) => elements.get(instance)?._onAttached(id)
commandHandlers['webview-detached'] = ({ instance, reason }) => elements.get(instance)?._onRefused(reason)
commandHandlers['webview-event'] = ({ instance, event, props, state, args }) => elements.get(instance)?._onEvent(event, props, state, args)
commandHandlers['webview-result'] = ({ instance, id, ok, result, error }) => elements.get(instance)?._onResult(id, ok, result, error)

/** What the element adds to an `HTMLElement` named `webview`. */
class WebViewElement extends (globalThis.HTMLElement ?? class {}) {
  _init() {
    this._instance = null
    this._guestId = null
    this._attached = false
    this._state = { ...INITIAL_STATE }
    this._requests = new Map()
    this._nextRequest = 1
    this._findRequest = 0
    this._lastBounds = ''
    this._seq = 0
    this._frame = 0
    this._raf = 0
    this._sending = false
    this._resend = false
    this._failures = 0
    this._attributes = new MutationObserver((records) => {
      for (const record of records) this._onAttributeChanged(record.attributeName, record.oldValue)
    })
    this._attributes.observe(this, { attributes: true, attributeOldValue: true, attributeFilter: ATTRIBUTES })
  }

  // --- attachment ----------------------------------------------------------------------

  _params() {
    const params = {}
    for (const name of STRING_ATTRIBUTES) if (this.hasAttribute(name)) params[name] = this.getAttribute(name)
    for (const name of BOOLEAN_ATTRIBUTES) params[name] = this.hasAttribute(name)
    if (params.src) params.src = absolute(params.src)
    if (params.preload) params.preload = absolute(params.preload)
    return params
  }

  _connected() {
    if (this._instance || !this.isConnected) return
    this._instance = `${PAGE}-${nextInstance++}`
    elements.set(this._instance, this)
    const { bounds, visible } = this._measure()
    this._lastBounds = JSON.stringify({ bounds, visible })
    postToMain({ type: 'lifecycle', name: 'webview-attach', data: { instance: this._instance, params: this._params(), bounds, visible } }).catch(report('<webview> attach'))
  }

  _disconnected() {
    if (!this._instance || this.isConnected) return
    const instance = this._instance
    this._stopTracking()
    elements.delete(instance)
    this._instance = null
    this._guestId = null
    this._attached = false
    this._state = { ...INITIAL_STATE }
    for (const request of this._requests.values()) request.reject(new Error('The WebView was removed from the DOM'))
    this._requests.clear()
    postToMain({ type: 'lifecycle', name: 'webview-detach', data: { instance } }).catch(report('<webview> detach'))
  }

  _onAttached(id) {
    this._guestId = id
    this._attached = true
    this._startTracking()
    this.dispatchEvent(new Event('did-attach'))
  }

  _onRefused(reason) {
    if (reason && reason !== 'prevented') console.warn(`[tauri-electron] <webview>: ${reason}`)
  }

  _onAttributeChanged(name, oldValue) {
    const value = this.getAttribute(name)
    if (name !== 'src' || value === oldValue || !value || !this._attached) return
    this.loadURL(absolute(value)).catch(() => {})
  }

  // --- position ------------------------------------------------------------------------

  _measure() {
    const rect = this.getBoundingClientRect()
    let visible = this.isConnected && rect.width > 0 && rect.height > 0 && document.visibilityState !== 'hidden'
    if (visible) {
      visible = typeof this.checkVisibility === 'function' ? this.checkVisibility({ visibilityProperty: true }) : getComputedStyle(this).visibility !== 'hidden'
    }
    return { bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, visible }
  }

  _startTracking() {
    if (this._raf) return
    const tick = () => {
      this._raf = requestAnimationFrame(tick)
      this._report()
    }
    this._raf = requestAnimationFrame(tick)
    // Animation frames stop while the page is hidden: report that at once.
    this._onVisibility = () => this._report()
    document.addEventListener('visibilitychange', this._onVisibility)
  }

  _stopTracking() {
    cancelAnimationFrame(this._raf)
    this._raf = 0
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility)
  }

  _report() {
    if (!this._attached) return
    const { bounds, visible } = this._measure()
    const key = JSON.stringify({ bounds, visible })
    if (key === this._lastBounds) return
    this._lastBounds = key
    if (this._sending) {
      this._resend = true
      return
    }
    this._send(bounds, visible)
  }

  _send(bounds, visible) {
    this._sending = true
    const body = JSON.stringify({ instance: this._instance, seq: ++this._seq, ...bounds, visible })
    fetch(bridgeUrl('view/bounds'), { method: 'POST', body, headers: { 'content-type': 'text/plain' } })
      .then((response) => {
        // Not applied (the guest is not known yet): send it again, a few times at most.
        if (response.ok) this._failures = 0
        else if (++this._failures < 5) this._lastBounds = ''
      }, () => {})
      .finally(() => {
        this._sending = false
        if (this._resend && this._attached) {
          this._resend = false
          const { bounds: next, visible: shown } = JSON.parse(this._lastBounds)
          this._send(next, shown)
        }
      })
  }

  // --- guest events ----------------------------------------------------------------------

  _onEvent(type, props, state, args) {
    if (state) this._state = { ...this._state, ...state }
    if (type === 'state') return
    const event = new Event(type)
    const values = props ? decode(props) : {}
    if (type === 'ipc-message') values.args = decodeArgs(args)
    Object.assign(event, values)
    if (type === 'destroyed') {
      this._attached = false
      this._stopTracking()
    }
    this.dispatchEvent(event)
  }

  _onResult(id, ok, result, error) {
    const request = this._requests.get(id)
    if (!request) return
    this._requests.delete(id)
    if (ok) request.resolve(decode(result))
    else {
      const failure = new Error(error?.message ?? 'webview call failed')
      if (error?.name) failure.name = error.name
      request.reject(failure)
    }
  }

  /** Call `method` on the guest's webContents; resolves with its result. */
  _call(method, args = []) {
    if (!this._attached) return Promise.reject(new Error(NOT_ATTACHED))
    const id = this._nextRequest++
    const { promise, resolve, reject } = deferred()
    this._requests.set(id, { resolve, reject })
    postToMain({ type: 'lifecycle', name: 'webview-call', data: { instance: this._instance, method, args: encode(args), id } }).catch((error) => {
      this._requests.delete(id)
      reject(error)
    })
    return promise
  }

  /** For methods Electron runs synchronously: sent, errors reported. */
  _fire(method, args = []) {
    if (!this._attached) throw new Error(NOT_ATTACHED)
    this._call(method, args).catch(report(`webview.${method}`))
  }

  // --- Electron's WebviewTag methods ------------------------------------------------------

  loadURL(url, options) { return this._call('loadURL', [absolute(url), options]) }
  downloadURL(url, options) { this._fire('downloadURL', [absolute(url), options]) }
  getURL() { return this._state.url }
  getTitle() { return this._state.title }
  isLoading() { return this._state.loading }
  isLoadingMainFrame() { return this._state.loading }
  isWaitingForResponse() { return false }
  stop() { this._fire('stop') }
  reload() { this._fire('reload') }
  reloadIgnoringCache() { this._fire('reloadIgnoringCache') }
  canGoBack() { return this._state.canGoBack }
  canGoForward() { return this._state.canGoForward }
  canGoToOffset(offset) { return offset < 0 ? this._state.canGoBack : offset > 0 ? this._state.canGoForward : true }
  clearHistory() { this._fire('clearHistory') }
  goBack() { this._fire('goBack') }
  goForward() { this._fire('goForward') }
  goToIndex(index) { this._fire('goToIndex', [index]) }
  goToOffset(offset) { this._fire('goToOffset', [offset]) }
  isCrashed() { return false }
  setUserAgent(userAgent) {
    this._state.userAgent = String(userAgent)
    this._fire('setUserAgent', [String(userAgent)])
  }
  getUserAgent() { return this._state.userAgent }
  insertCSS(css) { return this._call('insertCSS', [String(css)]) }
  removeInsertedCSS(key) { return this._call('removeInsertedCSS', [key]) }
  executeJavaScript(code, userGesture) { return this._call('executeJavaScript', [String(code), userGesture]) }
  openDevTools() { this._fire('openDevTools') }
  closeDevTools() { this._fire('closeDevTools') }
  isDevToolsOpened() { return this._state.devToolsOpened }
  isDevToolsFocused() { return false }
  inspectElement(x, y) { this._fire('inspectElement', [x, y]) }
  inspectSharedWorker() {}
  inspectServiceWorker() {}
  setAudioMuted(muted) {
    this._state.audioMuted = Boolean(muted)
    this._fire('setAudioMuted', [Boolean(muted)])
  }
  isAudioMuted() { return this._state.audioMuted }
  isCurrentlyAudible() { return false }
  undo() { this._fire('undo') }
  redo() { this._fire('redo') }
  cut() { this._fire('cut') }
  copy() { this._fire('copy') }
  centerSelection() { this._fire('centerSelection') }
  paste() { this._fire('paste') }
  pasteAndMatchStyle() { this._fire('pasteAndMatchStyle') }
  delete() { this._fire('delete') }
  selectAll() { this._fire('selectAll') }
  unselect() { this._fire('unselect') }
  scrollToTop() { this._fire('scrollToTop') }
  scrollToBottom() { this._fire('scrollToBottom') }
  adjustSelection() {}
  replace(text) { this._fire('replace', [String(text)]) }
  replaceMisspelling(text) { this._fire('replaceMisspelling', [String(text)]) }
  insertText(text) { return this._call('insertText', [String(text)]) }
  findInPage(text, options = {}) {
    const requestId = ++this._findRequest
    this._fire('findInPage', [String(text), options, requestId])
    return requestId
  }
  stopFindInPage(action) { this._fire('stopFindInPage', [action]) }
  print(options = {}) { return this._call('print', [options]) }
  printToPDF(options = {}) { return this._call('printToPDF', [options]) }
  capturePage() {
    return Promise.reject(new Error('webview.capturePage() is not available in tauri-electron: call capturePage() on the guest webContents in the main process.'))
  }
  send(channel, ...args) { return this._call('send', [String(channel), ...args]) }
  sendInputEvent() {
    return Promise.reject(new Error('webview.sendInputEvent() is not available in tauri-electron.'))
  }
  setZoomFactor(factor) {
    this._state.zoomFactor = Number(factor)
    this._fire('setZoomFactor', [Number(factor)])
  }
  setZoomLevel(level) { this.setZoomFactor(Math.pow(1.2, Number(level))) }
  getZoomFactor() { return this._state.zoomFactor }
  getZoomLevel() { return Math.log(this._state.zoomFactor) / Math.log(1.2) }
  setVisualZoomLevelLimits() { return Promise.resolve() }
  showDefinitionForSelection() {}
  getWebContentsId() {
    if (this._guestId === null) throw new Error(NOT_ATTACHED)
    return this._guestId
  }
  focus() {
    if (this._attached) this._fire('focus')
    else HTMLElement.prototype.focus.call(this)
  }
}

// Attributes reflected as properties, like Electron's.
for (const name of STRING_ATTRIBUTES) {
  Object.defineProperty(WebViewElement.prototype, name, {
    configurable: true,
    get() { return name === 'src' && this.hasAttribute('src') ? absolute(this.getAttribute('src')) : this.getAttribute(name) ?? '' },
    set(value) { this.setAttribute(name, String(value)) },
  })
}
for (const name of BOOLEAN_ATTRIBUTES) {
  Object.defineProperty(WebViewElement.prototype, name, {
    configurable: true,
    get() { return this.hasAttribute(name) },
    set(value) { if (value) this.setAttribute(name, ''); else this.removeAttribute(name) },
  })
}

function isWebview(node) {
  return node?.nodeType === 1 && node.localName === 'webview'
}

/** Give a `webview` element the WebviewTag API (once). */
export function upgrade(element) {
  if (!isWebview(element) || element._webviewUpgraded) return element
  Object.setPrototypeOf(element, WebViewElement.prototype)
  Object.defineProperty(element, '_webviewUpgraded', { value: true })
  element._init()
  if (element.isConnected) element._connected()
  return element
}

function webviewsIn(node) {
  if (isWebview(node)) return [node]
  return node?.querySelectorAll ? [...node.querySelectorAll('webview')] : []
}

const STYLE = `:where(webview:not([hidden])) { display: flex; overflow: hidden; }
:where(webview)::before { content: ''; flex: 1 1 auto; width: 100%; height: 150px; }
:where(webview) > * { display: none !important; }`

let installed = false

/** Make `<webview>` work in this page. */
export function installWebviewTag() {
  if (installed || typeof document === 'undefined') return
  installed = true
  const createElement = Document.prototype.createElement
  Document.prototype.createElement = function (name, options) {
    const element = createElement.call(this, name, options)
    return String(name).toLowerCase() === 'webview' ? upgrade(element) : element
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) for (const element of webviewsIn(node)) if (element._webviewUpgraded) element._disconnected()
      for (const node of record.addedNodes) for (const element of webviewsIn(node)) {
        if (element._webviewUpgraded) element._connected()
        else upgrade(element)
      }
    }
  })
  const start = () => {
    const style = document.createElement('style')
    style.id = 'tauri-electron-webview'
    style.textContent = STYLE
    ;(document.head ?? document.documentElement).prepend(style)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    for (const element of document.querySelectorAll('webview')) upgrade(element)
  }
  if (document.documentElement) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}
