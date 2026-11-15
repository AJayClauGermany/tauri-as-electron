/**
 * net, implemented with @tauri-apps/plugin-http.
 *
 * Electron's main process is not a browser page, so `net.fetch` /
 * `net.request` are not subject to CORS. The hidden main window is, so
 * requests go through plugin-http (Rust's reqwest), which is not. Allowed
 * URLs are governed by the `http:` scope in the main capability.
 * `file://` URLs are read through Node `fs` (feature `node-fs` of
 * tauri-plugin-electron), as in Electron, with a content type from the
 * file extension: the usual body of a `protocol.handle()` handler.
 */
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError, warnOnce, inTauri, explainError } from '../internal/runtime.js'
import { mimeType } from '../internal/mime.js'
import { native, hasFeature, featureError } from '../internal/native.js'
import { encodeFrame, responseBytes } from '../internal/node-bridge.js'
import { resolveAppPath } from '../internal/app-files.js'
import { platform } from '../process.js'

const FILE_ERRORS = { ENOENT: 'ERR_FILE_NOT_FOUND', ENOTDIR: 'ERR_FILE_NOT_FOUND', EISDIR: 'ERR_FILE_NOT_FOUND', EACCES: 'ERR_ACCESS_DENIED', EPERM: 'ERR_ACCESS_DENIED' }

/** A file URL's path (`/C:/x` → `C:\x` on Windows); the app's own files map as in `fs`. */
export function filePath(url, onPlatform = platform) {
  let path = decodeURIComponent(url.pathname)
  if (onPlatform === 'win32') {
    path = /^\/[a-zA-Z]:/.test(path) ? path.slice(1).replace(/\//g, '\\') : url.host ? `\\\\${url.host}${path.replace(/\//g, '\\')}` : path
  }
  return resolveAppPath(path).path
}

/** `file://` → a Response with the file, read with the `node_fs` command (feature `node-fs`). */
async function fetchFile(url, method) {
  const api = 'net.fetch(file://)'
  if (!inTauri || !hasFeature('node-fs')) throw featureError(api, 'node-fs')
  let bytes
  try {
    bytes = responseBytes(await native('node_fs', encodeFrame('read', { path: filePath(url) })))
  } catch (error) {
    if (error?.code === 'ERR_FEATURE_DISABLED') throw featureError(api, 'node-fs')
    if (!error?.syscall) throw explainError(api, error)
    throw new Error(`net::${FILE_ERRORS[error.code] ?? 'ERR_FAILED'}`, { cause: error })
  }
  const response = new Response(method === 'HEAD' ? null : bytes, {
    status: 200,
    headers: { 'content-type': mimeType(url.pathname), 'content-length': String(bytes.byteLength) },
  })
  Object.defineProperty(response, 'url', { value: url.href })
  return response
}

/** fetch() for Electron's main process (no CORS). */
/** The default session's proxy (session.setProxy / app.setProxy), for net.fetch. */
let defaultProxy = null

export function setDefaultProxy(url) {
  defaultProxy = url || null
}

/** In `init`: the request is a session's own (session.fetch), which does not take the default session's proxy. */
export const OWN_PROXY = Symbol('tauri-electron:own-proxy')

/** In `init`: the session whose webRequest listeners apply (session.fetch, net.request({ session })). */
export const VIA_SESSION = Symbol('tauri-electron:session')
/** In `init`: the partition whose session's webRequest listeners apply (net.request({ partition })). */
export const VIA_PARTITION = Symbol('tauri-electron:partition')

/** session.webRequest's pipeline (./web-request.js), around fetchDirect. */
let requestHook = null
export function setRequestHook(hook) {
  requestHook = hook
}

export function netFetch(input, init) {
  if (requestHook) return requestHook(input, init, fetchDirect)
  return fetchDirect(input, init)
}

/** netFetch without session.webRequest (protocol handlers reading files, the pipeline itself). */
export function fetchDirect(input, init) {
  if (init && (VIA_SESSION in init || VIA_PARTITION in init)) {
    init = { ...init }
    delete init[VIA_SESSION]
    delete init[VIA_PARTITION]
  }
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  // Local schemes plugin-http cannot fetch are served by the webview itself.
  if (/^(data|blob):/i.test(url)) return fetch(input, init)
  if (/^file:/i.test(url)) return fetchFile(new URL(url), String(init?.method ?? input?.method ?? 'GET').toUpperCase())
  if (init?.bypassCustomProtocolHandlers !== undefined) {
    init = { ...init }
    delete init.bypassCustomProtocolHandlers
  }
  if (init?.[OWN_PROXY]) {
    init = { ...init }
    delete init[OWN_PROXY]
  } else if (defaultProxy && init?.proxy === undefined) {
    init = { ...init, proxy: { all: defaultProxy } }
  }
  return httpFetch(input, init)
}

/** Headers -> Node-style object: lowercase names, repeated set-cookie as an array. */
export function toNodeHeaders(headers) {
  const out = {}
  const raw = []
  const entries = typeof headers?.entries === 'function' ? [...headers.entries()] : Object.entries(headers ?? {})
  for (const [name, value] of entries) {
    raw.push(name, value)
    const key = name.toLowerCase()
    if (key === 'set-cookie') {
      out[key] = [...(out[key] ?? []), value]
    } else if (key in out) {
      out[key] = `${out[key]}, ${value}`
    } else {
      out[key] = value
    }
  }
  return { headers: out, rawHeaders: raw }
}

/** `Basic realm="x"` → { scheme: 'basic', realm: 'x' } (null without a header). */
export function parseAuthenticate(header) {
  const match = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)(.*)$/.exec(String(header ?? ''))
  if (!header || !match) return null
  const realm = /realm\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/i.exec(match[2])
  return { scheme: match[1].toLowerCase(), realm: realm ? (realm[1] ?? realm[2]).replace(/\\(.)/g, '$1') : '' }
}

/** Electron's request options -> { url, method, headers }. */
export function normalizeRequestOptions(options) {
  if (typeof options === 'string' || options instanceof URL) return { url: String(options), method: 'GET', headers: {} }
  let url = options.url
  if (!url) {
    const protocol = options.protocol ?? 'http:'
    const host = options.host ?? `${options.hostname ?? 'localhost'}${options.port ? `:${options.port}` : ''}`
    url = `${protocol}//${host}${options.path ?? '/'}`
  }
  return { url, method: (options.method ?? 'GET').toUpperCase(), headers: { ...(options.headers ?? {}) }, redirect: options.redirect ?? 'follow' }
}

/** Electron's IncomingMessage. */
export class IncomingMessage extends EventEmitter {
  constructor(response) {
    super()
    this.statusCode = response.status
    this.statusMessage = response.statusText ?? ''
    const { headers, rawHeaders } = toNodeHeaders(response.headers)
    this.headers = headers
    this.rawHeaders = rawHeaders
    this.httpVersion = '1.1'
    this.httpVersionMajor = 1
    this.httpVersionMinor = 1
    this.ok = response.ok
  }
}

/** Electron's ClientRequest (a writable stream in Electron; buffered here). */
export class ClientRequest extends EventEmitter {
  constructor(options, callback) {
    super()
    const { url, method, headers, redirect } = normalizeRequestOptions(options)
    this.url = url
    this.method = method
    this._headers = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), [k, v]]))
    this._chunks = []
    this._ended = false
    this._aborted = false
    this._redirect = redirect
    this._controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    // The session whose webRequest listeners apply (the default one otherwise).
    this._session = typeof options === 'object' && !(options instanceof URL) ? options.session ?? null : null
    this._partition = typeof options === 'object' && !(options instanceof URL) ? options.partition : undefined
    this.chunkedEncoding = false
    if (callback) this.once('response', callback)
  }

  setHeader(name, value) {
    if (this._ended) throw new Error('Cannot set headers after they are sent')
    this._headers.set(String(name).toLowerCase(), [name, value])
  }

  getHeader(name) {
    return this._headers.get(String(name).toLowerCase())?.[1]
  }

  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase())
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') callback = encoding
    if (this._ended) throw new Error('Write after end')
    this._chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
    callback?.()
    return true
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') [callback, chunk] = [chunk, undefined]
    if (typeof encoding === 'function') callback = encoding
    if (this._ended) return this
    if (chunk !== undefined && chunk !== null) this.write(chunk)
    this._ended = true
    this._send().finally(() => callback?.())
    return this
  }

  abort() {
    if (this._aborted) return
    this._aborted = true
    this._controller?.abort()
    this.emit('abort')
    this.emit('close')
  }

  followRedirect() {
    warnOnce('net.followRedirect', 'ClientRequest.followRedirect(): redirects are followed automatically by plugin-http.')
  }

  getUploadProgress() {
    return { active: !this._ended, started: this._ended, current: 0, total: 0 }
  }

  /** A 401 / 407 asking for Basic credentials, with a 'login' listener: the header to retry with, or null. */
  async _login(response) {
    if ((response.status !== 401 && response.status !== 407) || this.listenerCount('login') === 0) return null
    const isProxy = response.status === 407
    const challenge = parseAuthenticate(response.headers.get(isProxy ? 'proxy-authenticate' : 'www-authenticate'))
    if (challenge?.scheme !== 'basic') return null
    const url = new URL(this.url)
    const authInfo = { isProxy, scheme: 'basic', host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80), realm: challenge.realm }
    const answer = await new Promise((resolve) => {
      let answered = false
      this.emit('login', authInfo, (username, password) => {
        if (answered) return
        answered = true
        resolve(username === undefined || username === null ? null : { username: String(username), password: String(password ?? '') })
      })
    })
    if (!answer) return null
    const token = btoa(String.fromCharCode(...new TextEncoder().encode(`${answer.username}:${answer.password}`)))
    return { header: isProxy ? 'Proxy-Authorization' : 'Authorization', value: `Basic ${token}` }
  }

  async _send() {
    const length = this._chunks.reduce((n, c) => n + c.length, 0)
    let body
    if (length > 0) {
      body = new Uint8Array(length)
      let offset = 0
      for (const chunk of this._chunks) {
        body.set(chunk, offset)
        offset += chunk.length
      }
    }
    const headers = Object.fromEntries([...this._headers.values()].map(([k, v]) => [k, String(v)]))
    const via = this._session ? { [VIA_SESSION]: this._session } : this._partition !== undefined ? { [VIA_PARTITION]: String(this._partition) } : {}
    try {
      let response
      for (;;) {
        response = await netFetch(this.url, {
          method: this.method,
          headers,
          body,
          redirect: this._redirect === 'manual' ? 'manual' : this._redirect,
          signal: this._controller?.signal,
          ...via,
        })
        if (this._aborted) return
        // 'login': HTTP Basic authentication, answered by the listener.
        const credentials = await this._login(response)
        if (!credentials) break
        response.body?.cancel().catch(() => {})
        headers[credentials.header] = credentials.value
      }
      this.emit('finish')
      const message = new IncomingMessage(response)
      this.emit('response', message)
      if (response.body?.getReader) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done || this._aborted) break
          message.emit('data', value)
        }
      } else {
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (buffer.length) message.emit('data', buffer)
      }
      if (this._aborted) return
      message.emit('end')
      this.emit('close')
    } catch (error) {
      if (this._aborted) return
      if (this.listenerCount('error') > 0) this.emit('error', error instanceof Error ? error : new Error(String(error)))
      else console.error('[tauri-electron] net.request failed:', error)
      this.emit('close')
    }
  }
}

export const net = {
  fetch: netFetch,

  request(options, callback) {
    return new ClientRequest(options, callback)
  },

  isOnline() {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false
  },

  get online() {
    return net.isOnline()
  },

  resolveHost() {
    return Promise.reject(new NotImplementedError('net.resolveHost', { reason: 'unimplemented', hint: 'DNS lookups need a Rust command.' }))
  },
}
