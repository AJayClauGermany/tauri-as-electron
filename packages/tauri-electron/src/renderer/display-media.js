/**
 * Chromium's desktop capture through getUserMedia, which Electron apps use
 * with a source from desktopCapturer.getSources():
 *
 *   getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })
 *
 * WebKit and WebView2 do not know these constraints, so such a request
 * becomes getDisplayMedia() (roadmap C9). The source cannot be preselected:
 * the webview's picker appears (the desktop portal on Linux, WebView2's on
 * Windows, the system's on macOS). The main process is told first
 * (src/main/display-media.js), so the request is answered like Electron's
 * (permission handler, 'media') rather than by the display media handler.
 * Desktop audio alone (`audio` with chromeMediaSource, no video) keeps the
 * audio tracks of a screen capture, when the webview offers any.
 */
import { report } from '../internal/runtime.js'

export const DESKTOP_CAPTURE_CHANNEL = 'tauri-electron:desktop-capture'

const DESKTOP_SOURCES = new Set(['desktop', 'screen', 'window', 'tab'])

function desktopConstraint(constraint) {
  if (!constraint || typeof constraint !== 'object') return null
  const mandatory = constraint.mandatory ?? {}
  const source = mandatory.chromeMediaSource ?? constraint.chromeMediaSource
  if (!DESKTOP_SOURCES.has(source)) return null
  return { source, id: String(mandatory.chromeMediaSourceId ?? constraint.chromeMediaSourceId ?? ''), mandatory }
}

/** Chromium's `mandatory` min / max sizes and frame rates as standard constraints. */
function trackConstraints(mandatory) {
  const out = {}
  for (const [name, key] of [['width', 'Width'], ['height', 'Height'], ['frameRate', 'FrameRate']]) {
    const range = {}
    if (typeof mandatory[`max${key}`] === 'number') range.max = mandatory[`max${key}`]
    if (typeof mandatory[`min${key}`] === 'number') range.min = mandatory[`min${key}`]
    if (Object.keys(range).length) out[name] = range
  }
  return Object.keys(out).length ? out : true
}

/**
 * getUserMedia constraints → `{ sourceId, video, audio, display }` for a
 * desktop capture (`display` is what getDisplayMedia gets), else null.
 */
export function desktopRequest(constraints) {
  const video = desktopConstraint(constraints?.video)
  const audio = desktopConstraint(constraints?.audio)
  if (!video && !audio) return null
  return {
    sourceId: video?.id || audio?.id || '',
    video: Boolean(video),
    audio: Boolean(audio),
    display: { video: video ? trackConstraints(video.mandatory) : true, audio: Boolean(audio) },
  }
}

/**
 * Wrap `mediaDevices.getUserMedia`; `announce(request)` tells the main
 * process before getDisplayMedia() is called.
 */
export function installDesktopCapture(mediaDevices, announce) {
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function' || mediaDevices.__tauriElectronDesktop) return false
  const getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)
  mediaDevices.getUserMedia = async function (constraints) {
    const request = desktopRequest(constraints)
    if (!request) return getUserMedia(constraints)
    if (typeof mediaDevices.getDisplayMedia !== 'function') {
      throw new DOMException('Desktop capture needs getDisplayMedia(), which this webview does not provide', 'NotSupportedError')
    }
    try {
      await announce({ sourceId: request.sourceId, audio: request.audio })
    } catch (error) {
      report('desktop capture')(error)
    }
    const stream = await mediaDevices.getDisplayMedia(request.display)
    if (!request.video) {
      for (const track of stream.getVideoTracks()) {
        track.stop()
        stream.removeTrack(track)
      }
    }
    return stream
  }
  Object.defineProperty(mediaDevices, '__tauriElectronDesktop', { value: true })
  return true
}
