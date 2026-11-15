/**
 * session.setPermissionRequestHandler applied to BrowserWindows, on
 * tauri-plugin-electron (src/permissions.rs).
 *
 * Linux (WebKitGTK) holds each request until the handler's callback answers,
 * as in Electron. Windows and macOS must answer synchronously in Rust, so the
 * first request of a permission per window and origin gets the platform's
 * default (a WebView2 / WebKit prompt) while the handler runs; its answer
 * applies to later requests. Without a handler everything is granted
 * (Electron's default).
 */
import { native, hasNativePlugin } from '../internal/native.js'
import { report } from '../internal/runtime.js'

let resolveContents = () => null
let defaultSessionRef = null

export function configurePermissions({ webContentsFromLabel, defaultSession }) {
  if (webContentsFromLabel) resolveContents = webContentsFromLabel
  if (defaultSession) defaultSessionRef = defaultSession
}

function originOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin
  } catch {
    return ''
  }
}

/** `tauri-electron:permission-request` from tauri-plugin-electron. */
export function onPermissionRequest({ id, label, permission, mediaTypes = [], url = '' }) {
  const webContents = resolveContents(label) ?? null
  const session = webContents?.session ?? defaultSessionRef
  const handler = session?._handlers?.permissionRequest
  let answered = false
  const callback = (granted) => {
    if (answered) return
    answered = true
    native('permission_respond', { id, label, url, permission, mediaTypes: [...mediaTypes], granted: Boolean(granted) }).catch(report('permission request'))
  }
  if (typeof handler !== 'function') return callback(true)
  const details = { requestingUrl: url, securityOrigin: originOf(url), isMainFrame: true, embeddingOrigin: originOf(url) }
  if (permission === 'media') details.mediaTypes = [...mediaTypes]
  try {
    handler(webContents, permission, callback, details)
  } catch (error) {
    report('setPermissionRequestHandler handler')(error)
    callback(false)
  }
}

/** Tell Rust which windows' sessions have a request handler. */
export function syncPermissionHandler(session, windows) {
  if (!hasNativePlugin()) return
  const labels = windows.filter((win) => !win.isDestroyed() && win._label && win.webContents.session === session).map((win) => win._label)
  if (!labels.length) return
  native('permission_handler', { labels, enabled: typeof session._handlers.permissionRequest === 'function' }).catch(report('setPermissionRequestHandler'))
}
