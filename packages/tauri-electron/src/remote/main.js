/**
 * `@electron/remote/main`: the main-process half of the remote module.
 *
 *   require('@electron/remote/main').initialize()
 *   require('@electron/remote/main').enable(win.webContents)
 *
 * Answers the renderer's synchronous requests (./renderer.js) with the
 * main process's own objects: values that can be copied are copied, other
 * objects and functions are kept here in a table per renderer page and
 * handed out as references. See ./protocol.js for the wire format.
 */
import * as electron from '../index.js'
import { ipcMain } from '../main/ipc-main.js'
import { BrowserWindow } from '../main/browser-window.js'
import { isMainProcess, serializeError } from '../internal/runtime.js'
import { MARK, REQUEST, RELEASE, CALLBACK, PROMISE } from './protocol.js'

const ELECTRON_IDS = new Set(['electron', 'electron/main', 'electron/common', 'electron/renderer'])

let initialized = false
const enabled = new WeakSet()
/** Renderer pages by webContents: `{ contextId, objects, ids, sent, members, callbacks, nextId }`. */
const contexts = new WeakMap()

function isPromise(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'
}

/** Values the IPC encoding copies as they are. */
function isLeaf(value) {
  return value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value) ||
    value instanceof Map || value instanceof Set || value instanceof Error
}

function isPlain(value) {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Names of the methods of `value` (own and inherited), which the renderer calls without asking first. */
function methodNames(value) {
  const names = new Set()
  const stop = typeof value === 'function' ? Function.prototype : Object.prototype
  for (let o = value; o && o !== stop; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === 'constructor' || names.has(name)) continue
      const descriptor = Object.getOwnPropertyDescriptor(o, name)
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') names.add(name)
    }
  }
  if (typeof value === 'function') for (const name of ['call', 'apply', 'bind']) names.delete(name)
  return [...names]
}

function context(sender, contextId) {
  let ctx = contexts.get(sender)
  if (!ctx || ctx.contextId !== contextId) {
    ctx = { sender, contextId, objects: new Map(), ids: new Map(), sent: new Map(), members: new Map(), callbacks: new Map(), nextId: 1 }
    contexts.set(sender, ctx)
    if (!sender._remoteCleanup && typeof sender.once === 'function') {
      sender._remoteCleanup = true
      sender.once('destroyed', () => contexts.delete(sender))
    }
  }
  return ctx
}

function send(ctx, channel, payload) {
  if (contexts.get(ctx.sender) !== ctx || ctx.sender.isDestroyed?.()) return
  try {
    ctx.sender.send(channel, { contextId: ctx.contextId, ...payload })
  } catch {
    /* the page is gone */
  }
}

function reference(ctx, value) {
  let id = ctx.ids.get(value)
  if (id === undefined) {
    id = ctx.nextId++
    ctx.ids.set(value, id)
    ctx.objects.set(id, value)
    ctx.members.set(id, methodNames(value))
  }
  ctx.sent.set(id, (ctx.sent.get(id) ?? 0) + 1)
  const name = typeof value === 'function' ? value.name : value.constructor?.name
  return { [MARK]: typeof value === 'function' ? 'function' : 'object', id, members: ctx.members.get(id), name: name ?? '' }
}

/** A main-process value as the renderer receives it. */
function toMeta(ctx, value, seen = new Set()) {
  if (typeof value === 'symbol') return undefined
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (isPromise(value) && typeof value !== 'function') {
    const id = ctx.nextId++
    Promise.resolve(value).then(
      (result) => send(ctx, PROMISE, { id, ok: true, value: toMeta(ctx, result) }),
      (error) => send(ctx, PROMISE, { id, ok: false, error: serializeError(error) }),
    )
    return { [MARK]: 'promise', id }
  }
  if (typeof value === 'function') return reference(ctx, value)
  if (isLeaf(value)) return value
  if (seen.has(value)) return reference(ctx, value)
  if (Array.isArray(value)) {
    seen.add(value)
    const out = value.map((item) => toMeta(ctx, item, seen))
    seen.delete(value)
    return out
  }
  // Plain data is copied; objects with behaviour (modules such as `dialog`,
  // event objects, class instances) stay here and are referenced.
  if (isPlain(value) && !Object.values(value).some((item) => typeof item === 'function')) {
    seen.add(value)
    const out = {}
    for (const key of Object.keys(value)) out[key] = toMeta(ctx, value[key], seen)
    seen.delete(value)
    return out
  }
  return reference(ctx, value)
}

/** An argument from the renderer: references resolved, callbacks made callable. */
function fromMeta(ctx, value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => fromMeta(ctx, item))
  if (!isPlain(value)) return value
  const kind = value[MARK]
  if (kind === 'ref') {
    if (!ctx.objects.has(value.id)) throw new Error(`@electron/remote: the remote object ${value.id} was released`)
    return ctx.objects.get(value.id)
  }
  if (kind === 'callback') {
    let callback = ctx.callbacks.get(value.id)
    if (!callback) {
      const id = value.id
      // Called asynchronously in the renderer, as with Electron's remote module.
      callback = function remoteCallback(...args) {
        send(ctx, CALLBACK, { id, args: toMeta(ctx, args) })
      }
      ctx.callbacks.set(id, callback)
    }
    return callback
  }
  const out = {}
  for (const key of Object.keys(value)) out[key] = fromMeta(ctx, value[key])
  return out
}

function target(ctx, id) {
  if (!ctx.objects.has(id)) throw new Error(`@electron/remote: the remote object ${id} was released`)
  return ctx.objects.get(id)
}

function remoteRequire(name) {
  if (ELECTRON_IDS.has(name)) return electron
  // The main page's require() (tauri-electron/require, which serves the Node layer).
  if (typeof globalThis.require !== 'function') throw new Error(`@electron/remote: the main process has no require() for '${name}'`)
  return globalThis.require(name)
}

function answer(sender, request) {
  const ctx = context(sender, request.contextId)
  const args = () => fromMeta(ctx, request.args ?? [])
  switch (request.op) {
    case 'module': {
      if (!(request.name in electron)) throw new Error(`@electron/remote: electron has no module '${request.name}'`)
      return toMeta(ctx, electron[request.name])
    }
    case 'require':
      return toMeta(ctx, remoteRequire(String(request.name)))
    case 'global':
      return toMeta(ctx, globalThis[request.name])
    case 'process':
      return toMeta(ctx, globalThis.process)
    case 'current-window':
      return toMeta(ctx, BrowserWindow.fromWebContents(sender) ?? null)
    case 'current-web-contents':
      return toMeta(ctx, sender)
    case 'get':
      return toMeta(ctx, target(ctx, request.id)[request.prop])
    case 'has':
      return request.prop in Object(target(ctx, request.id))
    case 'set':
      target(ctx, request.id)[request.prop] = fromMeta(ctx, request.value)
      return true
    case 'call': {
      const object = target(ctx, request.id)
      if (request.prop == null) return toMeta(ctx, object(...args()))
      const method = object[request.prop]
      if (typeof method !== 'function') throw new TypeError(`${String(request.prop)} is not a function`)
      return toMeta(ctx, method.apply(object, args()))
    }
    case 'construct': {
      const Constructor = target(ctx, request.id)
      return toMeta(ctx, new Constructor(...args()))
    }
    default:
      throw new Error(`@electron/remote: unknown request '${request.op}'`)
  }
}

function onRequest(event, request) {
  const sender = event.sender
  if (!enabled.has(sender)) {
    event.returnValue = { ok: false, error: { name: 'Error', message: '@electron/remote is disabled for this WebContents. Call require("@electron/remote/main").enable(webContents) to enable it.' } }
    return
  }
  try {
    event.returnValue = { ok: true, value: answer(sender, request ?? {}) }
  } catch (error) {
    event.returnValue = { ok: false, error: serializeError(error) }
  }
}

function onRelease(event, { contextId, id, count } = {}) {
  const ctx = contexts.get(event.sender)
  if (!ctx || ctx.contextId !== contextId || !ctx.objects.has(id)) return
  const left = (ctx.sent.get(id) ?? 0) - (count ?? 1)
  if (left > 0) {
    ctx.sent.set(id, left)
    return
  }
  ctx.ids.delete(ctx.objects.get(id))
  ctx.objects.delete(id)
  ctx.sent.delete(id)
  ctx.members.delete(id)
}

/** Start answering remote requests. Call once in the main process. */
export function initialize() {
  if (!isMainProcess && typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    throw new Error('@electron/remote/main can only be initialized in the main process')
  }
  if (initialized) return
  initialized = true
  ipcMain.on(REQUEST, onRequest)
  ipcMain.on(RELEASE, onRelease)
}

export function isInitialized() {
  return initialized
}

/** Let the renderer of `webContents` use @electron/remote. */
export function enable(webContents) {
  if (!webContents || typeof webContents !== 'object') throw new TypeError('enable() expects a WebContents')
  enabled.add(webContents)
}

/** For tests: forget every renderer and grant. */
export function _reset() {
  initialized = false
  ipcMain.removeListener(REQUEST, onRequest)
  ipcMain.removeListener(RELEASE, onRelease)
}

export default { initialize, isInitialized, enable }
