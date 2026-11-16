/**
 * TLS and HTTP authentication events of BrowserWindow pages, from
 * tauri-plugin-electron (src/tls_auth.rs):
 *
 * - `certificate-error` (webContents, then app) when the webview rejects a
 *   server certificate, after the session's `setCertificateVerifyProc`
 *   (asked first: 0 trusts, -3 lets 'certificate-error' decide, anything
 *   else rejects). Not trusted: the load fails with `did-fail-load`, as in
 *   Electron. Linux (WebKitGTK `load-failed-with-tls-errors`, main frames;
 *   a trusted certificate is allowed for its host and the page reloaded)
 *   and Windows (WebView2 `ServerCertificateErrorDetected`).
 * - `login` (webContents, then app) for HTTP authentication: the callback's
 *   credentials answer it; without `preventDefault()` it is cancelled, as in
 *   Electron. Linux (WebKitGTK `authenticate`) and Windows (WebView2
 *   `BasicAuthenticationRequested`).
 * - `select-client-certificate` (webContents, then app) when a server asks
 *   for a client certificate: Windows only (WebView2
 *   `ClientCertificateRequested`); without `preventDefault()` the first
 *   certificate is used.
 *
 * macOS: wry's WKNavigationDelegate does not forward these, so none are
 * emitted there; WKWebView keeps its own behaviour.
 */
import { createEvent } from '../internal/emitter.js'
import { native } from '../internal/native.js'
import { report } from '../internal/runtime.js'
import { certificateFromPem } from './certificate.js'
import { onPageRequest } from './web-request.js'

let resolveContents = () => null
let defaultSessionRef = null

export function configureTlsAuth({ webContentsFromLabel, defaultSession }) {
  if (webContentsFromLabel) resolveContents = webContentsFromLabel
  if (defaultSession) defaultSessionRef = defaultSession
}

/** Certificate problems, most serious first (Chromium's MapCertStatusToNetError order). */
const TLS_ERRORS = [
  ['generic-error', 'net::ERR_CERT_INVALID', -207],
  ['revoked', 'net::ERR_CERT_REVOKED', -206],
  ['unknown-ca', 'net::ERR_CERT_AUTHORITY_INVALID', -202],
  ['bad-identity', 'net::ERR_CERT_COMMON_NAME_INVALID', -200],
  ['insecure', 'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM', -208],
  ['expired', 'net::ERR_CERT_DATE_INVALID', -201],
  ['not-activated', 'net::ERR_CERT_DATE_INVALID', -201],
]

/** The platform's certificate problems → Chromium's error `{ name, code }`. */
export function certificateErrorOf(errors = []) {
  const found = TLS_ERRORS.find(([flag]) => errors.includes(flag)) ?? TLS_ERRORS[0]
  return { name: found[1], code: found[2] }
}

function respond(id, answer) {
  return native('tls_auth_respond', { id, answer }).catch(report('certificate / login answer'))
}

/** Electron's failed load: did-fail-load, and loadURL() rejects. */
function failLoad(webContents, url, { name, code }) {
  if (!webContents) return
  const description = name.replace(/^net::/, '')
  webContents.emit('did-fail-load', createEvent(), code, description, url, true, 0, 0)
  const waiters = webContents._win?._loadWaiters?.splice(0) ?? []
  if (!waiters.length) return
  const error = Object.assign(new Error(`${description} (${code}) loading '${url}'`), { errno: code, code: description, url })
  for (const waiter of waiters) waiter.reject(error)
}

/** Ask the session's setCertificateVerifyProc: 0, -2 or -3 (or another net error). */
function verifyProc(session, request) {
  const proc = session?._handlers?.certificateVerify
  if (typeof proc !== 'function') return Promise.resolve(-3)
  return new Promise((resolve) => {
    let answered = false
    const callback = (result) => {
      if (answered) return
      answered = true
      resolve(Number(result))
    }
    try {
      proc(request, callback)
    } catch (error) {
      report('setCertificateVerifyProc')(error)
      callback(-2)
    }
  })
}

/** `tauri-electron:certificate-error`: `{ id, label, url, errors, certificate: [pem, ...], isMainFrame }`. */
export async function onCertificateError(payload, app) {
  const { id, label, url = '', errors = [], isMainFrame = true } = payload
  const webContents = resolveContents(label) ?? null
  const session = webContents?.session ?? defaultSessionRef
  const certificate = certificateFromPem(payload.certificate ?? [])
  const error = certificateErrorOf(errors)
  let answered = false
  const decide = (trusted) => {
    if (answered) return
    answered = true
    respond(id, { trusted })
    if (!trusted && isMainFrame) failLoad(webContents, url, error)
  }
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {}
  const verdict = await verifyProc(session, {
    hostname,
    certificate,
    validatedCertificate: certificate,
    isIssuedByKnownRoot: false,
    verificationResult: error.name,
    errorCode: error.code,
  })
  if (verdict === 0) return decide(true)
  if (verdict !== -3) return decide(false)
  const event = createEvent()
  const callback = (trusted) => decide(Boolean(trusted))
  try {
    webContents?.emit('certificate-error', event, url, error.name, certificate, callback, isMainFrame)
    app?.emit('certificate-error', event, webContents, url, error.name, certificate, callback, isMainFrame)
  } catch (thrown) {
    report("'certificate-error' listener")(thrown)
  }
  if (!event.defaultPrevented) decide(false)
}

/** `tauri-electron:login`: `{ id, label, url, scheme, host, port, realm, isProxy }`. */
export function onLogin(payload, app) {
  const { id, label, url = '' } = payload
  const webContents = resolveContents(label) ?? null
  let answered = false
  const callback = (username, password) => {
    if (answered) return
    answered = true
    respond(id, username === undefined || username === null ? { cancel: true } : { username: String(username), password: String(password ?? '') })
  }
  const event = createEvent()
  const details = { url }
  const authInfo = { isProxy: Boolean(payload.isProxy), scheme: payload.scheme ?? 'basic', host: payload.host ?? '', port: payload.port ?? 0, realm: payload.realm ?? '' }
  try {
    webContents?.emit('login', event, details, authInfo, callback)
    app?.emit('login', event, webContents, details, authInfo, callback)
  } catch (error) {
    report("'login' listener")(error)
  }
  if (!event.defaultPrevented) callback()
}

/** `tauri-electron:select-client-certificate`: `{ id, label, url, certificates: [[pem, ...], ...] }`. */
export function onSelectClientCertificate(payload, app) {
  const { id, label, url = '' } = payload
  const webContents = resolveContents(label) ?? null
  const list = (payload.certificates ?? []).map((chain) => certificateFromPem(chain))
  let answered = false
  const callback = (certificate) => {
    if (answered) return
    answered = true
    const index = certificate ? list.findIndex((c) => c === certificate || (c.fingerprint && c.fingerprint === certificate.fingerprint)) : -1
    respond(id, { certificate: index })
  }
  const event = createEvent()
  try {
    webContents?.emit('select-client-certificate', event, url, list, callback)
    app?.emit('select-client-certificate', event, webContents, url, list, callback)
  } catch (error) {
    report("'select-client-certificate' listener")(error)
  }
  if (!event.defaultPrevented) callback(list[0])
}

/** The main window's listeners for these events and for page requests (./web-request.js). */
export function listenTlsAuthEvents(webview, app) {
  return Promise.all([
    webview.listen('tauri-electron:web-request', ({ payload }) => onPageRequest(payload)),
    webview.listen('tauri-electron:certificate-error', ({ payload }) => onCertificateError(payload, app)),
    webview.listen('tauri-electron:login', ({ payload }) => onLogin(payload, app)),
    webview.listen('tauri-electron:select-client-certificate', ({ payload }) => onSelectClientCertificate(payload, app)),
  ])
}
