/**
 * protocol, on top of tauri-plugin-electron's custom URI schemes.
 *
 * Tauri registers URI schemes when the app is built, so each scheme passed
 * to `protocol.handle()` must also be declared in Rust:
 *
 *   tauri_plugin_electron::Builder::new().protocol("app").build()
 *
 * Requests for those schemes are forwarded to the main process and answered
 * by the handler registered here, which returns a `Response` like in
 * Electron. On Windows and Android, Tauri serves a scheme as
 * `http://<scheme>.localhost/<path>`; handlers still see `<scheme>://...`.
 *
 * The deprecated `register{File,Buffer,String,Http}Protocol` callback forms
 * are adapters onto `handle()`; files are read with `net.fetch('file://…')`.
 */
import { NotImplementedError } from '../internal/runtime.js'
import { onBridgeRequest, startBridgeListener } from '../internal/native.js'
import { base64ToBytes, bytesToBase64 } from '../internal/serialize.js'
import { platform } from '../process.js'
import { pathToFileURL } from '../url.js'
import { protocolWithWebRequest } from './web-request.js'

const BUILTIN = new Set(['http', 'https', 'file', 'about', 'data', 'blob', 'ws', 'wss'])
const handlers = new Map()
const privileged = new Map()

/** True for URLs whose scheme is a custom one (not http/https/file/...). */
export function isCustomScheme(url) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(String(url))
  return Boolean(match) && !BUILTIN.has(match[1].toLowerCase()) && match[1].toLowerCase() !== 'tauri'
}

/** `scheme://host/path` -> the URL Tauri serves it at on this platform. */
export function toNativeSchemeUrl(url, onPlatform = platform) {
  if (!isCustomScheme(url)) return String(url)
  if (onPlatform !== 'win32' && onPlatform !== 'android') return String(url)
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(String(url))
  if (!match) return String(url)
  const [, scheme, , rest] = match
  return `http://${scheme.toLowerCase()}.localhost${rest.startsWith('/') ? rest : `/${rest}`}`
}

/** The URL Tauri reports -> the `scheme://` URL Electron handlers expect. */
export function fromNativeSchemeUrl(url, scheme, onPlatform = platform) {
  const prefix = `http://${scheme.toLowerCase()}.localhost`
  if ((onPlatform === 'win32' || onPlatform === 'android') && String(url).toLowerCase().startsWith(prefix)) {
    const rest = String(url).slice(prefix.length)
    return `${scheme}://localhost${rest.startsWith('/') ? rest : `/${rest}`}`
  }
  return String(url)
}

async function serializeResponse(response) {
  if (!(response instanceof Response)) {
    // Deprecated callback APIs (and lazy handlers) may return plain objects.
    response = toResponse(response)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: bytesToBase64(bytes),
    base64: true,
  }
}

/** Accepts what the deprecated register*Protocol callbacks accept. */
function toResponse(value) {
  if (value instanceof Response) return value
  if (value == null) return new Response(null, { status: 404 })
  if (typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer) return new Response(value)
  const headers = new Headers(value.headers ?? {})
  if (value.mimeType && !headers.has('content-type')) {
    headers.set('content-type', value.charset ? `${value.mimeType}; charset=${value.charset}` : value.mimeType)
  }
  if (value.error !== undefined && value.error !== 0) return new Response(null, { status: 500 })
  return new Response(value.data ?? null, { status: value.statusCode ?? 200, headers })
}

/** Answer a request Rust forwarded for a custom scheme (exported for tests). */
export async function onRequest(payload) {
  const handler = handlers.get(payload.scheme)
  if (!handler) return { status: 404, body: `No handler registered for '${payload.scheme}'` }
  const method = payload.method ?? 'GET'
  const init = { method, headers: payload.headers ?? [] }
  if (method !== 'GET' && method !== 'HEAD' && payload.body) init.body = base64ToBytes(payload.body)
  const request = new Request(fromNativeSchemeUrl(payload.url, payload.scheme), init)
  // session.webRequest of the requesting page's session applies around the handler.
  const serve = async (req) => toResponse(await handler(req))
  return serializeResponse(await protocolWithWebRequest(request, payload.from, serve, serveOther))
}

/** A webRequest redirect to another URL: its scheme's handler, or net.fetch. */
async function serveOther(request) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(request.url)?.[1]?.toLowerCase()
  if (scheme && handlers.has(scheme)) return toResponse(await handlers.get(scheme)(request))
  const { fetchDirect } = await import('./net.js')
  return fetchDirect(request.url, { method: request.method, headers: [...request.headers.entries()] })
}

let listening = false
function listen() {
  if (listening) return
  listening = true
  onBridgeRequest('protocol', onRequest)
  startBridgeListener()
}

function adaptCallbackProtocol(scheme, legacyHandler, transform) {
  protocol.handle(scheme, (request) => new Promise((resolve) => {
    const legacyRequest = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), referrer: request.referrer }
    legacyHandler(legacyRequest, (result) => resolve(transform(result)))
  }))
  return true
}

export const protocol = {
  registerSchemesAsPrivileged(schemes) {
    for (const entry of schemes ?? []) privileged.set(entry.scheme, entry.privileges ?? {})
  },

  /** Privileges recorded by registerSchemesAsPrivileged (informational). */
  _privileges: privileged,

  handle(scheme, handler) {
    if (handlers.has(scheme)) throw new Error(`Failed to register protocol: ${scheme}`)
    handlers.set(scheme, handler)
    listen()
  },

  unhandle(scheme) {
    handlers.delete(scheme)
  },

  isProtocolHandled(scheme) {
    return Promise.resolve(handlers.has(scheme) || BUILTIN.has(String(scheme).toLowerCase()))
  },

  // --- deprecated callback APIs ---------------------------------------------
  registerStringProtocol(scheme, handler) {
    return adaptCallbackProtocol(scheme, handler, (result) => toResponse(typeof result === 'string' ? { data: result, mimeType: 'text/plain' } : result))
  },

  registerBufferProtocol(scheme, handler) {
    return adaptCallbackProtocol(scheme, handler, (result) => toResponse(result))
  },

  registerHttpProtocol(scheme, handler) {
    return adaptCallbackProtocol(scheme, handler, async (result) => {
      const { fetchDirect } = await import('./net.js')
      return fetchDirect(result.url, { method: result.method ?? 'GET', headers: result.headers, body: result.uploadData?.data })
    })
  },

  /** The callback gets a path or `{ path, headers, statusCode }` (or `{ error }`, or nothing: 404). */
  registerFileProtocol(scheme, handler) {
    return adaptCallbackProtocol(scheme, handler, async (result) => {
      const path = typeof result === 'string' ? result : result?.path
      if (!path || (result?.error !== undefined && result.error !== 0)) return new Response(null, { status: 404 })
      const { fetchDirect } = await import('./net.js')
      let file
      try {
        file = await fetchDirect(pathToFileURL(path))
      } catch (error) {
        if (error?.name === 'NotImplementedError') throw error
        return new Response(null, { status: error?.message === 'net::ERR_ACCESS_DENIED' ? 403 : 404 })
      }
      const headers = new Headers(file.headers)
      for (const [name, value] of Object.entries(result?.headers ?? {})) headers.set(name, value)
      if (result?.mimeType) headers.set('content-type', result.charset ? `${result.mimeType}; charset=${result.charset}` : result.mimeType)
      const status = result?.statusCode ?? 200
      // Statuses that cannot carry a body (Response() throws otherwise).
      return new Response([101, 204, 205, 304].includes(status) ? null : file.body, { status, headers })
    })
  },

  registerStreamProtocol() {
    throw new NotImplementedError('protocol.registerStreamProtocol', { reason: 'unsupported', hint: 'Use protocol.handle() and return a Response.' })
  },

  unregisterProtocol(scheme) {
    return handlers.delete(scheme)
  },

  isProtocolRegistered(scheme) {
    return handlers.has(scheme)
  },

  interceptFileProtocol() {
    throw new NotImplementedError('protocol.interceptFileProtocol', { reason: 'unsupported', hint: 'Tauri cannot intercept built-in schemes.' })
  },
  interceptStringProtocol() {
    throw new NotImplementedError('protocol.interceptStringProtocol', { reason: 'unsupported', hint: 'Tauri cannot intercept built-in schemes.' })
  },
  interceptBufferProtocol() {
    throw new NotImplementedError('protocol.interceptBufferProtocol', { reason: 'unsupported', hint: 'Tauri cannot intercept built-in schemes.' })
  },
  interceptHttpProtocol() {
    throw new NotImplementedError('protocol.interceptHttpProtocol', { reason: 'unsupported', hint: 'Tauri cannot intercept built-in schemes.' })
  },
  interceptStreamProtocol() {
    throw new NotImplementedError('protocol.interceptStreamProtocol', { reason: 'unsupported', hint: 'Tauri cannot intercept built-in schemes.' })
  },
  uninterceptProtocol() {
    return false
  },
  isProtocolIntercepted() {
    return false
  },
}

