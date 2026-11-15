/**
 * `@electron/remote` in a renderer: the main process's objects, used as if
 * they were local (`remote.getCurrentWindow().setTitle('x')`,
 * `remote.dialog.showOpenDialog(...)`, `new remote.BrowserWindow(...)`).
 *
 * Every property read, assignment and call is a synchronous request to the
 * main process (./main.js, which must be `initialize()`d and `enable()`
 * this window's webContents), as in Electron. Main-process objects arrive
 * as proxies; renderer functions passed to the main process (event
 * listeners, menu `click` handlers) are called back asynchronously.
 * Promises returned by main-process methods resolve here when they settle.
 * Proxies the page drops are released in the main process.
 */
import { ipcRenderer } from '../renderer/ipc-renderer.js'
import { isMainProcess } from '../internal/runtime.js'
import { MARK, REQUEST, RELEASE, CALLBACK, PROMISE, CLASSES, MODULES } from './protocol.js'

const contextId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** Proxies by main-process id: `{ ref: WeakRef, count }` (count: times main sent the id). */
const entries = new Map()
/** The id behind each proxy. */
const proxyIds = new WeakMap()
/** Renderer callbacks by id, and the id of each function. */
const callbacks = new Map()
const callbackIds = new WeakMap()
let nextCallbackId = 1
/** Pending main-process promises by id. */
const promises = new Map()

const release = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(({ id, entry }) => {
      if (entries.get(id) === entry) entries.delete(id)
      ipcRenderer.send(RELEASE, { contextId, id, count: entry.count })
    })
  : null

let listening = false
function listen() {
  if (listening) return
  listening = true
  ipcRenderer.on(CALLBACK, (_event, message) => {
    if (message?.contextId !== contextId) return
    const callback = callbacks.get(message.id)
    if (callback) callback(...fromMeta(message.args ?? []))
  })
  ipcRenderer.on(PROMISE, (_event, message) => {
    if (message?.contextId !== contextId) return
    const pending = promises.get(message.id)
    if (!pending) return
    promises.delete(message.id)
    if (message.ok) pending.resolve(fromMeta(message.value))
    else pending.reject(remoteError(message.error))
  })
}

const ERRORS = { TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError }

function remoteError(data) {
  const error = new (ERRORS[data?.name] ?? Error)(data?.message ?? 'Unknown error')
  if (data?.name) error.name = data.name
  if (data?.stack) error.stack = data.stack
  return error
}

function request(message) {
  if (isMainProcess) throw new Error('@electron/remote cannot be required in the browser process. Instead require("@electron/remote/main").')
  listen()
  const response = ipcRenderer.sendSync(REQUEST, { ...message, contextId })
  if (response === undefined) {
    throw new Error('@electron/remote/main is not initialized: call require("@electron/remote/main").initialize() in the main process.')
  }
  if (!response.ok) throw remoteError(response.error)
  return fromMeta(response.value)
}

function isPlain(value) {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** A renderer value as the main process receives it. */
function toArg(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  const id = proxyIds.get(value)
  if (id !== undefined) return { [MARK]: 'ref', id }
  if (typeof value === 'function') {
    let callbackId = callbackIds.get(value)
    if (callbackId === undefined) {
      callbackId = nextCallbackId++
      callbackIds.set(value, callbackId)
      callbacks.set(callbackId, value)
    }
    return { [MARK]: 'callback', id: callbackId }
  }
  if (seen.has(value)) throw new TypeError('@electron/remote: cannot send a circular structure')
  if (Array.isArray(value)) {
    seen.add(value)
    const out = value.map((item) => toArg(item, seen))
    seen.delete(value)
    return out
  }
  if (isPlain(value)) {
    seen.add(value)
    const out = {}
    for (const key of Object.keys(value)) out[key] = toArg(value[key], seen)
    seen.delete(value)
    return out
  }
  return value
}

function fromMeta(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(fromMeta)
  if (!isPlain(value)) return value
  const kind = value[MARK]
  if (kind === 'object' || kind === 'function') return proxyFor(value)
  if (kind === 'promise') {
    return new Promise((resolve, reject) => promises.set(value.id, { resolve, reject }))
  }
  const out = {}
  for (const key of Object.keys(value)) out[key] = fromMeta(value[key])
  return out
}

function proxyFor(meta) {
  const existing = entries.get(meta.id)
  const alive = existing?.ref?.deref?.() ?? existing?.strong
  if (alive) {
    existing.count++
    return alive
  }
  const { id } = meta
  const methods = new Set(meta.members ?? [])
  const bound = new Map()
  const target = meta[MARK] === 'function' ? function remoteFunction() {} : {}
  const proxy = new Proxy(target, {
    get(_target, prop) {
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toPrimitive) return () => `[remote ${meta.name || 'object'}]`
        return undefined
      }
      // Not a thenable: `await remoteObject` must not ask the main process for `then`.
      if (prop === 'then') return undefined
      if (methods.has(prop)) {
        let method = bound.get(prop)
        if (!method) {
          method = (...args) => request({ op: 'call', id, prop, args: toArg(args) })
          bound.set(prop, method)
        }
        return method
      }
      return request({ op: 'get', id, prop })
    },
    set(_target, prop, value) {
      if (typeof prop === 'symbol') return false
      request({ op: 'set', id, prop, value: toArg(value) })
      return true
    },
    has(_target, prop) {
      if (typeof prop === 'symbol') return false
      return methods.has(prop) || request({ op: 'has', id, prop })
    },
    apply(_target, _this, args) {
      return request({ op: 'call', id, prop: null, args: toArg(args) })
    },
    construct(_target, args) {
      return request({ op: 'construct', id, args: toArg(args) })
    },
  })
  proxyIds.set(proxy, id)
  const entry = { count: 1 }
  if (release && typeof WeakRef === 'function') {
    entry.ref = new WeakRef(proxy)
    release.register(proxy, { id, entry })
  } else {
    entry.strong = proxy // no FinalizationRegistry: kept for the page's lifetime
  }
  entries.set(id, entry)
  return proxy
}

/**
 * A stand-in for `remote.<module>`, resolved on first use (importing
 * @electron/remote asks the main process nothing).
 */
function lazy(callable, resolve) {
  let resolved
  const real = () => (resolved ??= resolve())
  return new Proxy(callable ? function remoteModule() {} : {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : Reflect.get(real(), prop)),
    set: (_t, prop, value) => Reflect.set(real(), prop, value),
    has: (_t, prop) => Reflect.has(real(), prop),
    apply: (_t, _this, args) => Reflect.apply(real(), undefined, args),
    construct: (_t, args) => Reflect.construct(real(), args),
  })
}

const moduleProxy = (name) => lazy(CLASSES.has(name), () => request({ op: 'module', name }))

export function getCurrentWindow() {
  return request({ op: 'current-window' })
}

export function getCurrentWebContents() {
  return request({ op: 'current-web-contents' })
}

export function getGlobal(name) {
  return request({ op: 'global', name: String(name) })
}

/** A module of the main process: `electron`, or a Node built-in (`fs`, `path`, …). */
function remoteRequire(name) {
  return request({ op: 'require', name: String(name) })
}
export { remoteRequire as require }

export const process = lazy(false, () => request({ op: 'process' }))

export const app = moduleProxy('app')
export const autoUpdater = moduleProxy('autoUpdater')
export const BaseWindow = moduleProxy('BaseWindow')
export const BrowserView = moduleProxy('BrowserView')
export const BrowserWindow = moduleProxy('BrowserWindow')
export const clipboard = moduleProxy('clipboard')
export const contentTracing = moduleProxy('contentTracing')
export const crashReporter = moduleProxy('crashReporter')
export const desktopCapturer = moduleProxy('desktopCapturer')
export const dialog = moduleProxy('dialog')
export const globalShortcut = moduleProxy('globalShortcut')
export const inAppPurchase = moduleProxy('inAppPurchase')
export const ipcMain = moduleProxy('ipcMain')
export const Menu = moduleProxy('Menu')
export const MenuItem = moduleProxy('MenuItem')
export const MessageChannelMain = moduleProxy('MessageChannelMain')
export const nativeImage = moduleProxy('nativeImage')
export const nativeTheme = moduleProxy('nativeTheme')
export const net = moduleProxy('net')
export const netLog = moduleProxy('netLog')
export const Notification = moduleProxy('Notification')
export const powerMonitor = moduleProxy('powerMonitor')
export const powerSaveBlocker = moduleProxy('powerSaveBlocker')
export const protocol = moduleProxy('protocol')
export const pushNotifications = moduleProxy('pushNotifications')
export const safeStorage = moduleProxy('safeStorage')
export const screen = moduleProxy('screen')
export const session = moduleProxy('session')
export const ShareMenu = moduleProxy('ShareMenu')
export const shell = moduleProxy('shell')
export const systemPreferences = moduleProxy('systemPreferences')
export const TouchBar = moduleProxy('TouchBar')
export const Tray = moduleProxy('Tray')
export const utilityProcess = moduleProxy('utilityProcess')
export const webContents = moduleProxy('webContents')
export const WebContentsView = moduleProxy('WebContentsView')
export const webFrameMain = moduleProxy('webFrameMain')

const remote = {
  getCurrentWindow, getCurrentWebContents, getGlobal, require: remoteRequire, process,
  app, autoUpdater, BaseWindow, BrowserView, BrowserWindow, clipboard, contentTracing, crashReporter,
  desktopCapturer, dialog, globalShortcut, inAppPurchase, ipcMain, Menu, MenuItem, MessageChannelMain,
  nativeImage, nativeTheme, net, netLog, Notification, powerMonitor, powerSaveBlocker, protocol,
  pushNotifications, safeStorage, screen, session, ShareMenu, shell, systemPreferences, TouchBar, Tray,
  utilityProcess, webContents, WebContentsView, webFrameMain,
}
if (MODULES.some((name) => !(name in remote))) throw new Error('@electron/remote: module list out of sync')

export default remote
