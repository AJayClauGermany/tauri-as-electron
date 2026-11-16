/**
 * Screen sharing (roadmap C9): `session.setDisplayMediaRequestHandler` and
 * Chromium's `getUserMedia({ chromeMediaSource: 'desktop' })`, decided here
 * for the `display-capture` requests tauri-plugin-electron forwards
 * (src/display_media.rs, through the permission requests of ./permissions.js).
 *
 * - A page's `getDisplayMedia()` calls the session's display media handler,
 *   like Electron; without one it is denied (Electron rejects it too).
 *   `callback({ video })` grants it, `callback({})` denies it. The source
 *   the handler names is not applied: the webview's picker (the desktop
 *   portal on Linux, WebView2's on Windows) lets the user choose.
 *   `useSystemPicker: true` grants without calling the handler.
 * - `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } })`
 *   becomes `getDisplayMedia()` in the page (src/renderer/display-media.js),
 *   which first tells the main process over IPC; that request then goes to
 *   the permission request handler ('media', as in Electron), not to the
 *   display media handler, when it names no source (the whole desktop, as in
 *   Electron's docs) or one desktopCapturer.getSources() returned (other ids
 *   are refused, as Chromium refuses unknown sources).
 * - macOS (WKWebView) reports no screen-capture requests: WebKit asks the
 *   user itself and neither handler is called.
 */
import { report } from '../internal/runtime.js'

/** Channel of the page's "a desktop getUserMedia() follows" message. */
export const DESKTOP_CAPTURE_CHANNEL = 'tauri-electron:desktop-capture'
/** How long such a message stays valid. */
const INTENT_MS = 15_000

const intents = new Map()
/**
 * Source ids desktopCapturer.getSources() returned in this process, with
 * when. As in Electron, a page that names a source needs an id the main
 * process handed it. Without an id a page asks for the whole desktop
 * (Electron's documented way to capture desktop audio), which Electron
 * decides with the permission request handler ('media'), not the display
 * media handler (that one is for getDisplayMedia()), and grants without a
 * permission handler: the same here. Ids are forgotten after a while, so
 * the table stays small however often an app lists sources.
 */
const issuedSources = new Map()
const SOURCE_ID_MS = 60 * 60_000

/** Remember the ids desktopCapturer.getSources() gave out. */
export function rememberDesktopSources(ids, now = Date.now()) {
  for (const [id, at] of issuedSources) if (now - at >= SOURCE_ID_MS) issuedSources.delete(id)
  for (const id of ids) issuedSources.set(String(id), now)
}

/**
 * The page `label` is about to turn a desktop getUserMedia() into
 * getDisplayMedia(). False (nothing recorded) for a source id the main
 * process did not hand out (recently).
 */
export function noteDesktopCapture(label, request = {}, now = Date.now()) {
  const sourceId = String(request?.sourceId ?? '')
  if (sourceId) {
    const at = issuedSources.get(sourceId)
    if (at === undefined || now - at >= SOURCE_ID_MS) return false
  }
  const list = (intents.get(label) ?? []).filter((intent) => now - intent.at < INTENT_MS)
  list.push({ at: now, sourceId, audio: Boolean(request.audio) })
  intents.set(label, list)
  return true
}

function takeIntent(label, now = Date.now()) {
  const list = (intents.get(label) ?? []).filter((intent) => now - intent.at < INTENT_MS)
  const intent = list.shift()
  if (list.length) intents.set(label, list)
  else intents.delete(label)
  return intent ?? null
}

// The IPC handler for those messages is ./desktop-capture-channel.js.

function originOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin
  } catch {
    return ''
  }
}

/**
 * A `display-capture` request of window `label`; `callback(granted)` answers
 * it (once).
 */
export function onDisplayMediaRequest({ label, webContents, session, mediaTypes = [], url = '' }, callback) {
  const audioRequested = mediaTypes.includes('audio')
  const intent = takeIntent(label)
  if (intent) {
    const handler = session?._handlers?.permissionRequest
    if (typeof handler !== 'function') return callback(true)
    const details = {
      requestingUrl: url,
      securityOrigin: originOf(url),
      embeddingOrigin: originOf(url),
      isMainFrame: true,
      mediaTypes: audioRequested || intent.audio ? ['video', 'audio'] : ['video'],
    }
    try {
      handler(webContents, 'media', (granted) => callback(Boolean(granted)), details)
    } catch (error) {
      report('setPermissionRequestHandler handler')(error)
      callback(false)
    }
    return
  }
  const handler = session?._handlers?.displayMedia
  if (typeof handler !== 'function') return callback(false)
  if (session._handlers.displayMediaOptions?.useSystemPicker) return callback(true)
  const request = {
    frame: webContents?.mainFrame ?? null,
    securityOrigin: originOf(url),
    videoRequested: true,
    audioRequested,
    userGesture: true,
  }
  let answered = false
  const respond = (streams) => {
    if (answered) return
    answered = true
    callback(Boolean(streams && streams.video))
  }
  try {
    handler(request, respond)
  } catch (error) {
    report('setDisplayMediaRequestHandler handler')(error)
    respond(null)
  }
}
