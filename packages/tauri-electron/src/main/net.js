/**
 * net, implemented with @tauri-apps/plugin-http.
 *
 * Electron's main process is not a browser page, so `net.fetch` /
 * `net.request` are not subject to CORS. The hidden main window is, so
 * requests go through plugin-http (Rust's reqwest), which is not. Allowed
 * URLs are governed by the `http:` scope in the main capability.
 */
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError, warnOnce } from '../internal/runtime.js'

/** fetch() for Electron's main process (no CORS). */
export function netFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  // Local schemes plugin-http cannot fetch are served by the webview itself.
  if (/^(data|blob):/i.test(url)) return fetch(input, init)
  if (init?.bypassCustomProtocolHandlers !== undefined) {
    init = { ...init }
    delete init.bypassCustomProtocolHandlers
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
    try {
      const response = await netFetch(this.url, {
        method: this.method,
        headers,
        body,
        redirect: this._redirect === 'manual' ? 'manual' : this._redirect,
        signal: this._controller?.signal,
      })
      if (this._aborted) return
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
