/**
 * Node's `tls`, backed by tauri-plugin-electron (Cargo feature `node-tls`,
 * rustls): `tls.connect()` and `tls.createServer()` over node-net's TCP.
 *
 * Certificates are checked against Mozilla's root store (as Node's bundled
 * one), or against `ca` when given; `servername` sets SNI and the name the
 * certificate must match. `rejectUnauthorized: false` still records the
 * outcome in `authorized` / `authorizationError`. Upgrading an existing
 * socket (`{ socket }`, STARTTLS) is not implemented; `getPeerCertificate()`
 * has the raw DER and fingerprints, not the parsed subject.
 */
import { NotImplementedError } from '../internal/runtime.js'
import { Buffer } from './buffer.js'
import { createHash } from './crypto.js'
import { Socket, Server, normalizeConnectArgs } from './net.js'

export const DEFAULT_MIN_VERSION = 'TLSv1.2'
export const DEFAULT_MAX_VERSION = 'TLSv1.3'
export const DEFAULT_ECDH_CURVE = 'auto'
export const DEFAULT_CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256'
/** Node lists its bundled roots here; the PEM texts of rustls' roots are not available. */
export const rootCertificates = Object.freeze([])

/** OpenSSL's messages for the codes Node reports. */
const REASONS = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unable to verify the first certificate',
  CERT_HAS_EXPIRED: 'certificate has expired',
  CERT_NOT_YET_VALID: 'certificate is not yet valid',
  CERT_REVOKED: 'certificate revoked',
  CERT_SIGNATURE_FAILURE: 'certificate signature failure',
  UNABLE_TO_GET_ISSUER_CERT: 'unable to get issuer certificate',
}

function pems(value) {
  if (value === undefined || value === null) return []
  return [value].flat().map((item) => (typeof item === 'string' ? item : Buffer.from(item).toString()))
}

function pem(value) {
  return value === undefined || value === null ? undefined : pems(value).join('\n')
}

function tlsError(error, host) {
  if (error?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return Object.assign(new Error(`Hostname/IP does not match certificate's altnames: Host: ${host}. is not in the cert's altnames`), { code: error.code, host, reason: error.message })
  }
  if (error?.code && REASONS[error.code]) return Object.assign(new Error(REASONS[error.code]), { code: error.code })
  return error
}

const VERIFIED_FOR = Symbol('tauri-electron.verifiedFor')

function fingerprint(raw, algorithm) {
  return createHash(algorithm).update(raw).digest('hex').toUpperCase().match(/../g).join(':')
}

/** Node's TLSSocket. */
export class TLSSocket extends Socket {
  constructor(socket, options = {}) {
    if (socket instanceof Socket) {
      throw new NotImplementedError('new tls.TLSSocket(socket)', { reason: 'unimplemented', hint: 'Upgrading an existing socket (STARTTLS) is not implemented yet: use tls.connect() to a TLS port.' })
    }
    super(options)
    this.encrypted = true
    this.authorized = false
    this.authorizationError = null
    this.alpnProtocol = false
    this.servername = undefined
    this._session = {}
  }

  /** Session details from Rust, for a client or an accepted connection. */
  _attach(id, info = {}) {
    super._attach(id, info)
    this._session = info
    this.authorized = Boolean(info.authorized)
    this.authorizationError = info.authorizationError ?? null
    this.alpnProtocol = info.alpnProtocol ?? false
    this.servername = info.servername ?? undefined
  }

  getPeerCertificate() {
    if (!this._session.peerCertificate) return {}
    const raw = Buffer.from(this._session.peerCertificate, 'base64')
    const cert = { raw, fingerprint: fingerprint(raw, 'sha1'), fingerprint256: fingerprint(raw, 'sha256'), fingerprint512: fingerprint(raw, 'sha512'), subject: {}, issuer: {} }
    // The name rustls checked the certificate against, for checkServerIdentity().
    Object.defineProperty(cert, VERIFIED_FOR, { value: this.authorized ? this.servername : undefined })
    return cert
  }

  getProtocol() {
    return this._session.protocol ?? null
  }

  getCipher() {
    const name = this._session.cipher ?? ''
    return { name, standardName: name, version: this.getProtocol() }
  }

  getSession() {
    return undefined
  }

  isSessionReused() {
    return false
  }

  getEphemeralKeyInfo() {
    return {}
  }

  setServername() {}

  setMaxSendFragment() {
    return true
  }

  exportKeyingMaterial() {
    throw new NotImplementedError('tlsSocket.exportKeyingMaterial', { reason: 'unimplemented' })
  }
}

/** `tls.connect(options, [cb])`, `(port, [host], [options], [cb])` or `(path, [options], [cb])`. */
export function connect(...args) {
  const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined
  let options = {}
  if (args[0] !== null && typeof args[0] === 'object') {
    options = { ...args[0] }
  } else {
    if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) options.path = args.shift()
    else {
      options.port = args.shift()
      if (typeof args[0] === 'string') options.host = args.shift()
    }
    if (args[0] !== null && typeof args[0] === 'object') options = { ...args[0], ...options }
  }
  if (options.socket) {
    throw new NotImplementedError('tls.connect({ socket })', { reason: 'unimplemented', hint: 'Upgrading an existing socket (STARTTLS) is not implemented yet.' })
  }
  const merged = { ...(options.secureContext?.context ?? {}), ...options }
  const rejectUnauthorized = merged.rejectUnauthorized ?? globalThis.process?.env?.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
  const host = merged.host ?? 'localhost'
  const servername = merged.servername ?? (/^[\d.:]+$/.test(host) ? undefined : host)
  const socket = new TLSSocket(null, merged)
  socket._connectError = (error) => tlsError(error, servername ?? host)
  socket._onConnected = () =>
    queueMicrotask(() => {
      // Node calls checkServerIdentity after the chain is trusted (pinning, custom name rules).
      if (socket.authorized && typeof merged.checkServerIdentity === 'function') {
        const error = merged.checkServerIdentity(servername ?? host, socket.getPeerCertificate())
        if (error instanceof Error) return socket.destroy(error)
      }
      socket.emit('secureConnect')
    })
  return socket._connect(merged, callback, {
    servername,
    rejectUnauthorized,
    ca: pems(merged.ca),
    cert: pem(merged.cert),
    key: pem(merged.key),
    ALPNProtocols: (merged.ALPNProtocols ?? []).map((p) => (typeof p === 'string' ? p : Buffer.from(p).toString())),
  })
}

/** Node's tls.Server: emits 'secureConnection' with a TLSSocket after the handshake. */
export class TLSServer extends Server {
  constructor(options = {}, listener) {
    if (typeof options === 'function') [listener, options] = [options, {}]
    super(options)
    if (listener) this.on('secureConnection', listener)
  }

  _tlsOptions() {
    const options = { ...(this._options.secureContext?.context ?? {}), ...this._options }
    return {
      cert: pem(options.cert) ?? '',
      key: pem(options.key) ?? '',
      ca: pems(options.ca),
      requestCert: Boolean(options.requestCert),
      rejectUnauthorized: options.rejectUnauthorized ?? true,
      ALPNProtocols: (options.ALPNProtocols ?? []).map((p) => (typeof p === 'string' ? p : Buffer.from(p).toString())),
    }
  }

  _createSocket() {
    return new TLSSocket(null, { allowHalfOpen: this._options.allowHalfOpen })
  }

  /** Node emits 'connection' for the TCP socket, then 'secureConnection'; here both follow the handshake. */
  _onConnection(socket) {
    this.emit('connection', socket)
    this.emit('secureConnection', socket)
  }

  setSecureContext(options) {
    this._options = { ...this._options, ...options }
  }

  addContext() {}
}
export { TLSServer as Server }

export function createServer(options, listener) {
  return new TLSServer(options, listener)
}

/** Node's SecureContext: here just the options, merged into connect / createServer. */
export function createSecureContext(options = {}) {
  return { context: { ...options } }
}

/**
 * rustls checks the name during the handshake, and certificates are not
 * parsed in JavaScript: this passes only a certificate rustls verified for
 * `hostname`, and fails any other (never a silent pass).
 */
export function checkServerIdentity(hostname, cert) {
  const verified = cert?.[VERIFIED_FOR]
  if (verified && String(verified).toLowerCase() === String(hostname).toLowerCase()) return undefined
  return Object.assign(new Error(`Hostname/IP does not match certificate's altnames: Host: ${hostname}. tauri-electron can only confirm names rustls verified during the handshake`), {
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    host: hostname,
    reason: 'not verified by rustls',
    cert,
  })
}

export function getCiphers() {
  return ['tls_aes_256_gcm_sha384', 'tls_aes_128_gcm_sha256', 'tls_chacha20_poly1305_sha256', 'ecdhe-ecdsa-aes256-gcm-sha384', 'ecdhe-ecdsa-aes128-gcm-sha256', 'ecdhe-ecdsa-chacha20-poly1305', 'ecdhe-rsa-aes256-gcm-sha384', 'ecdhe-rsa-aes128-gcm-sha256', 'ecdhe-rsa-chacha20-poly1305']
}

export function convertALPNProtocols(protocols, out) {
  const buffers = protocols.map((p) => Buffer.from(p))
  out.ALPNProtocols = Buffer.concat(buffers.flatMap((b) => [Buffer.from([b.length]), b]))
}

export default {
  TLSSocket, Server: TLSServer, connect, createServer, createSecureContext, checkServerIdentity, getCiphers,
  convertALPNProtocols, rootCertificates, DEFAULT_MIN_VERSION, DEFAULT_MAX_VERSION, DEFAULT_ECDH_CURVE, DEFAULT_CIPHERS,
}
