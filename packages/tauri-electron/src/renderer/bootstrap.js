/**
 * Injected into every renderer page by the Vite plugin (before the preload).
 *
 * - Reads the window's configuration synchronously (webPreferences
 *   .additionalArguments → process.argv, ...) from tauri-plugin-electron.
 * - Reports page lifecycle to the main process so that `ready-to-show`,
 *   `did-finish-load`, `page-title-updated`, queued webContents.send() and
 *   webContents.executeJavaScript() work.
 * - Implements page-side Electron behaviour: no default context menu
 *   (`context-menu` event instead), window.open() / target=_blank through
 *   setWindowOpenHandler, `will-navigate`, `did-navigate-in-page`,
 *   `console-message`, `before-input-event`, find-in-page,
 *   `-webkit-app-region: drag`, and file drops with real paths
 *   (webUtils.getPathForFile).
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { applyProcessInfo, installProcessShim } from '../process.js'
import { isRenderer, report } from '../internal/runtime.js'
import { syncRequest } from '../internal/native.js'
import { postToMain, rendererReady, commandHandlers } from './ipc-renderer.js'
import { registerFilePath } from './web-utils.js'

installProcessShim()

/** Events the main process listens for (sent by webContents on subscription). */
const subscribed = new Set()
let forwarding = false

function lifecycle(name, data) {
  return postToMain({ type: 'lifecycle', name, data }).catch((error) => {
    if (!forwarding) report(`lifecycle ${name}`)(error)
  })
}

function readWindowConfig() {
  try {
    const { status, text } = syncRequest('window-config')
    return status === 200 ? JSON.parse(text) : null
  } catch {
    return null // no tauri-plugin-electron
  }
}

// --- lifecycle -------------------------------------------------------------------

function trackLifecycle() {
  const whenDom = new Promise((resolve) => {
    if (document.readyState !== 'loading') resolve()
    else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
  })
  const whenLoaded = new Promise((resolve) => {
    if (document.readyState === 'complete') resolve()
    else window.addEventListener('load', () => resolve(), { once: true })
  })

  Promise.all([rendererReady, whenDom])
    .then(() => lifecycle('dom-ready', { url: location.href }))
    .then(() => Promise.all([rendererReady, whenLoaded]))
    .then(() => {
      lifecycle('did-finish-load', { url: location.href, title: document.title })
      let lastTitle = document.title
      if (lastTitle) lifecycle('page-title-updated', { title: lastTitle })
      new MutationObserver(() => {
        if (document.title === lastTitle) return
        lastTitle = document.title
        lifecycle('page-title-updated', { title: lastTitle })
      }).observe(document.head ?? document.documentElement, { subtree: true, childList: true, characterData: true })
    })

  window.addEventListener('pagehide', () => lifecycle('unload'))
}

// --- navigation: links, window.open, in-page navigation -----------------------------

function absolute(url) {
  try {
    return new URL(String(url), location.href).href
  } catch {
    return String(url)
  }
}

function requestWindow(url, frameName = '', features = '', disposition) {
  lifecycle('window-open', {
    url: absolute(url),
    frameName,
    features,
    disposition: disposition ?? (features ? 'new-window' : 'foreground-tab'),
  })
}

function trackNavigation() {
  // Like Electron: window.open() goes through webContents.setWindowOpenHandler
  // and, when allowed, opens a new BrowserWindow. It returns null here
  // (Electron returns a WindowProxy).
  window.open = function open(url = '', target = '_blank', features = '') {
    if (['_self', '_top', '_parent'].includes(target)) {
      location.href = absolute(url)
      return window
    }
    requestWindow(url, target === '_blank' ? '' : String(target ?? ''), String(features ?? ''))
    return null
  }

  const onLinkClick = (event) => {
    if (event.defaultPrevented || event.button > 1) return
    const link = event.target?.closest?.('a[href]')
    if (!link || link.hasAttribute('download')) return
    const href = link.href
    if (/^javascript:/i.test(href)) return
    const newWindow = link.target === '_blank' || event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey
    if (newWindow) {
      event.preventDefault()
      const disposition = event.shiftKey ? 'new-window' : event.button === 1 || event.ctrlKey || event.metaKey ? 'background-tab' : 'foreground-tab'
      requestWindow(href, link.target === '_blank' ? '' : link.target, '', disposition)
      return
    }
    if (!subscribed.has('will-navigate') && !subscribed.has('will-frame-navigate')) return
    const target = new URL(href)
    const here = new URL(location.href)
    if (target.hash && target.href.split('#')[0] === here.href.split('#')[0]) return // in-page
    event.preventDefault()
    lifecycle('will-navigate', { url: href })
  }
  window.addEventListener('click', onLinkClick)
  window.addEventListener('auxclick', onLinkClick)

  let lastUrl = location.href
  const inPage = () => {
    if (location.href === lastUrl) return
    lastUrl = location.href
    lifecycle('did-navigate-in-page', { url: lastUrl })
  }
  const pushState = history.pushState
  history.pushState = function (...args) {
    const result = pushState.apply(this, args)
    inPage()
    return result
  }
  window.addEventListener('popstate', inPage)
  window.addEventListener('hashchange', inPage)
}

// --- context menu, console, keyboard ------------------------------------------------

function isEditable(element) {
  if (!element) return false
  if (element.isContentEditable) return true
  if (element.tagName === 'TEXTAREA') return !element.readOnly && !element.disabled
  if (element.tagName === 'INPUT') {
    const nonText = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']
    return !nonText.includes(element.type) && !element.readOnly && !element.disabled
  }
  return false
}

export function contextMenuParams(event) {
  const target = event.target instanceof Element ? event.target : null
  const link = target?.closest?.('a[href]')
  const media = target?.closest?.('img,video,audio,canvas')
  const mediaType = { IMG: 'image', VIDEO: 'video', AUDIO: 'audio', CANVAS: 'canvas' }[media?.tagName] ?? 'none'
  const selection = String(window.getSelection?.() ?? '')
  const editable = isEditable(target)
  return {
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
    linkURL: link?.href ?? '',
    linkText: link?.textContent ?? '',
    pageURL: location.href,
    frameURL: location.href,
    srcURL: media?.currentSrc || media?.src || '',
    mediaType,
    hasImageContents: mediaType === 'image',
    isEditable: editable,
    selectionText: selection,
    titleText: target?.title ?? '',
    altText: target?.alt ?? '',
    suggestedFilename: '',
    selectionStartOffset: 0,
    referrerPolicy: { url: '', policy: 'default' },
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: document.characterSet,
    inputFieldType: editable ? 'plainText' : 'none',
    formControlType: target?.tagName === 'INPUT' ? `input-${target.type}` : target?.tagName === 'TEXTAREA' ? 'text-area' : 'none',
    spellcheckEnabled: editable && target.spellcheck !== false,
    menuSourceType: event.button === 2 ? 'mouse' : 'keyboard',
    mediaFlags: { inError: false, isPaused: Boolean(media?.paused), isMuted: Boolean(media?.muted), canSave: false, hasAudio: false, isLooping: Boolean(media?.loop), isControlsVisible: Boolean(media?.controls), canToggleControls: false, canPrint: false, canRotate: false, canShowPictureInPicture: false, isShowingPictureInPicture: false, canLoop: false },
    editFlags: {
      canUndo: editable,
      canRedo: editable,
      canCut: editable && selection.length > 0,
      canCopy: selection.length > 0,
      canPaste: editable,
      canDelete: editable && selection.length > 0,
      canSelectAll: true,
      canEditRichly: Boolean(target?.isContentEditable),
    },
  }
}

function trackPageEvents() {
  // Electron shows no built-in context menu; apps build their own from the
  // `context-menu` event. Page handlers that preventDefault() win.
  window.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) return
    event.preventDefault()
    if (subscribed.has('context-menu')) lifecycle('context-menu', contextMenuParams(event))
  })

  const LEVEL = { debug: 'debug', log: 'info', info: 'info', warn: 'warning', error: 'error' }
  for (const method of Object.keys(LEVEL)) {
    const original = console[method].bind(console)
    console[method] = (...args) => {
      original(...args)
      if (forwarding || !subscribed.has('console-message')) return
      forwarding = true
      try {
        const message = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? String(a) : safeJson(a))).join(' ')
        lifecycle('console-message', { level: LEVEL[method], message, lineNumber: 0, sourceId: location.href })
      } finally {
        forwarding = false
      }
    }
  }
  window.addEventListener('error', (event) => {
    if (subscribed.has('console-message')) lifecycle('console-message', { level: 'error', message: `Uncaught ${event.error ?? event.message}`, lineNumber: event.lineno ?? 0, sourceId: event.filename ?? '' })
  })

  const onKey = (event) => {
    if (!subscribed.has('before-input-event')) return
    const modifiers = []
    if (event.shiftKey) modifiers.push('shift')
    if (event.ctrlKey) modifiers.push('control')
    if (event.altKey) modifiers.push('alt')
    if (event.metaKey) modifiers.push('meta')
    if (event.repeat) modifiers.push('isautorepeat')
    lifecycle('before-input-event', {
      type: event.type === 'keydown' ? 'keyDown' : 'keyUp',
      key: event.key,
      code: event.code,
      isAutoRepeat: event.repeat,
      isComposing: event.isComposing,
      shift: event.shiftKey,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      location: event.location,
      modifiers,
    })
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)

  window.addEventListener('wheel', (event) => {
    if (event.ctrlKey && subscribed.has('zoom-changed')) lifecycle('zoom-changed', { direction: event.deltaY < 0 ? 'in' : 'out' })
  }, { passive: true })
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// --- find in page -----------------------------------------------------------------

let find = { text: '', ordinal: 0, matches: 0 }

function countMatches(text, matchCase) {
  if (!text) return 0
  const haystack = matchCase ? document.body?.innerText ?? '' : (document.body?.innerText ?? '').toLowerCase()
  const needle = matchCase ? text : text.toLowerCase()
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++
  return count
}

commandHandlers.find = ({ requestId, text, options = {} }) => {
  const forward = options.forward !== false
  const matchCase = Boolean(options.matchCase)
  const newSession = options.findNext !== false && (options.findNext === true || text !== find.text)
  if (newSession) {
    window.getSelection()?.removeAllRanges()
    find = { text, ordinal: 0, matches: countMatches(text, matchCase) }
  }
  const found = find.matches > 0 && window.find?.(text, matchCase, !forward, true, false, false, false)
  if (found) {
    find.ordinal = forward ? (find.ordinal % find.matches) + 1 : find.ordinal <= 1 ? find.matches : find.ordinal - 1
  }
  const rect = found ? window.getSelection()?.getRangeAt(0)?.getBoundingClientRect() : null
  lifecycle('found-in-page', {
    requestId,
    activeMatchOrdinal: found ? find.ordinal : 0,
    matches: find.matches,
    selectionArea: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : { x: 0, y: 0, width: 0, height: 0 },
    finalUpdate: true,
  })
}

commandHandlers['stop-find'] = ({ action }) => {
  find = { text: '', ordinal: 0, matches: 0 }
  if (action !== 'keepSelection' && action !== 'activateSelection') window.getSelection()?.removeAllRanges()
}

commandHandlers['history-go'] = ({ offset }) => history.go(offset)
commandHandlers.stop = () => window.stop()
commandHandlers.subscribe = ({ events }) => {
  subscribed.clear()
  for (const name of events ?? []) subscribed.add(name)
}

// --- -webkit-app-region: drag -------------------------------------------------------

/**
 * Electron frameless windows are dragged by areas styled
 * `-webkit-app-region: drag`. WebKit drops that property from the CSSOM, so
 * rules are read from the style sheets' source text as well.
 */
const regionRules = []
const scannedSheets = new WeakSet()
const fetchedHrefs = new Set()
const REGION = /(?:-webkit-)?app-region\s*:\s*(no-drag|drag)/i

function scanCss(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const region = REGION.exec(match[2])
    if (!region) continue
    for (const selector of match[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!selector.startsWith('@')) regionRules.push({ selector, value: region[1].toLowerCase() })
    }
  }
}

function scanStyles() {
  for (const style of document.querySelectorAll('style')) {
    if (scannedSheets.has(style)) continue
    scannedSheets.add(style)
    scanCss(style.textContent ?? '')
  }
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const href = link.href
    if (fetchedHrefs.has(href) || !href.startsWith(location.origin)) continue
    fetchedHrefs.add(href)
    fetch(href).then((r) => r.text()).then(scanCss).catch(() => {})
  }
}

function regionOf(element) {
  const inline = REGION.exec(element.getAttribute?.('style') ?? '')
  if (inline) return inline[1].toLowerCase()
  const computed = getComputedStyle(element)
  const value = computed.getPropertyValue('-webkit-app-region') || computed.getPropertyValue('app-region')
  if (value === 'drag' || value === 'no-drag') return value
  let result = null
  for (const rule of regionRules) {
    try {
      if (element.matches(rule.selector)) result = rule.value
    } catch {
      /* selector WebKit cannot parse */
    }
  }
  return result
}

export function inDragRegion(element) {
  for (let el = element; el && el.nodeType === 1; el = el.parentElement) {
    const region = regionOf(el)
    if (region) return region === 'drag'
  }
  return false
}

function trackDragRegions() {
  const start = () => {
    scanStyles()
    new MutationObserver(scanStyles).observe(document.head ?? document.documentElement, { childList: true, subtree: true, characterData: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
  const win = getCurrentWindow()
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.detail > 1 || !inDragRegion(event.target)) return
    event.preventDefault()
    win.startDragging().catch(report('-webkit-app-region drag'))
  })
  window.addEventListener('dblclick', (event) => {
    if (event.button === 0 && inDragRegion(event.target)) win.toggleMaximize().catch(report('-webkit-app-region double-click'))
  })
}

// --- file drops ---------------------------------------------------------------------

/**
 * Tauri delivers dropped files natively (with paths). Re-dispatch them as the
 * HTML5 drag events Electron pages expect; `webUtils.getPathForFile(file)`
 * returns the real path. The File objects carry names, not contents.
 */
function trackFileDrops() {
  let files = []
  let lastTarget = null
  const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
  const fire = (type, position, target) => {
    const ratio = window.devicePixelRatio || 1
    const x = (position?.x ?? 0) / ratio
    const y = (position?.y ?? 0) / ratio
    target ??= document.elementFromPoint(x, y) ?? document.body
    let dataTransfer
    try {
      dataTransfer = new DataTransfer()
      for (const file of files) dataTransfer.items.add(file)
    } catch {
      dataTransfer = undefined
    }
    const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer })
    target.dispatchEvent(event)
    return target
  }
  getCurrentWebview().onDragDropEvent(({ payload }) => {
    switch (payload.type) {
      case 'enter':
        files = (payload.paths ?? []).map((p) => registerFilePath(new File([], basename(p)), p))
        lastTarget = fire('dragenter', payload.position)
        break
      case 'over': {
        const ratio = window.devicePixelRatio || 1
        const target = document.elementFromPoint(payload.position.x / ratio, payload.position.y / ratio) ?? document.body
        if (target !== lastTarget) {
          if (lastTarget) fire('dragleave', payload.position, lastTarget)
          fire('dragenter', payload.position, target)
          lastTarget = target
        }
        fire('dragover', payload.position, target)
        break
      }
      case 'drop':
        if (payload.paths?.length && !files.length) files = payload.paths.map((p) => registerFilePath(new File([], basename(p)), p))
        fire('drop', payload.position)
        files = []
        lastTarget = null
        break
      case 'leave':
        if (lastTarget) fire('dragleave', { x: 0, y: 0 }, lastTarget)
        files = []
        lastTarget = null
        break
    }
  }).catch(report('file drop listener'))
}

if (isRenderer) {
  const config = readWindowConfig()
  if (config) {
    applyProcessInfo(config, {
      type: 'renderer',
      contextIsolated: config.contextIsolation,
      sandboxed: config.sandbox,
    })
  } else {
    installProcessShim().type = 'renderer'
  }
  trackLifecycle()
  trackNavigation()
  trackPageEvents()
  trackDragRegions()
  trackFileDrops()
  // Like Electron, window.close() closes the BrowserWindow ('close' is still emitted).
  window.close = () => {
    getCurrentWindow().close().catch(report('window.close'))
  }
}
