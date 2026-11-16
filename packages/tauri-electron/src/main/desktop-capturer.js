/**
 * desktopCapturer (roadmap C9), on tauri-plugin-electron's `desktop_sources`
 * (feature `desktop-capturer`, on by default): screens and windows with
 * thumbnails, from X11 on Linux (screens only, without thumbnails, under
 * Wayland), GDI on Windows and CoreGraphics on macOS.
 *
 * The ids look like Electron's (`screen:<display>:0`, `window:<native id>:0`),
 * but no webview can capture a source chosen by the app: a page that passes
 * one to getUserMedia({ chromeMediaSource: 'desktop' }) gets getDisplayMedia()
 * and its picker (see ./display-media.js and src/renderer/display-media.js).
 */
import { native, hasNativePlugin, featureError } from '../internal/native.js'
import { NotImplementedError, explainError, isMainProcess, inTauri } from '../internal/runtime.js'
import { NativeImage } from './native-image.js'

function base64ToBytes(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const image = (base64) => (base64 ? new NativeImage({ bytes: base64ToBytes(base64) }) : new NativeImage())

/** Electron's getSources options → the command's. */
export function sourceOptions(options) {
  if (!options || !Array.isArray(options.types)) throw new TypeError("desktopCapturer.getSources: 'types' must be an Array of 'screen' and / or 'window'")
  const size = options.thumbnailSize ?? { width: 150, height: 150 }
  const dimension = (value) => Math.max(0, Math.round(Number(value) || 0))
  return {
    screens: options.types.includes('screen'),
    windows: options.types.includes('window'),
    thumbnailWidth: dimension(size.width),
    thumbnailHeight: dimension(size.height),
    fetchWindowIcons: Boolean(options.fetchWindowIcons),
  }
}

/** A DesktopCapturerSource as Electron returns it. */
export function toSource(raw, fetchWindowIcons) {
  const isWindow = String(raw.id).startsWith('window:')
  return {
    id: raw.id,
    name: raw.name,
    thumbnail: image(raw.thumbnail),
    display_id: raw.displayId ?? '',
    appIcon: isWindow && fetchWindowIcons ? image(raw.appIcon) : null,
  }
}

export const desktopCapturer = {
  async getSources(options) {
    const request = sourceOptions(options)
    if (!inTauri || !hasNativePlugin()) throw new NotImplementedError('desktopCapturer.getSources', { reason: 'plugin', hint: 'desktopCapturer needs tauri-plugin-electron.' })
    if (!isMainProcess) throw new NotImplementedError('desktopCapturer.getSources', { reason: 'permission', hint: 'Since Electron 17 desktopCapturer is a main-process API: call it there (ipcMain.handle) and send the sources to the page.' })
    if (!request.screens && !request.windows) return []
    let sources
    try {
      sources = await native('desktop_sources', { options: request })
    } catch (error) {
      if (error?.code === 'ERR_FEATURE_DISABLED') throw featureError('desktopCapturer.getSources', 'desktop-capturer')
      const explained = explainError('desktopCapturer.getSources', error)
      throw explained instanceof Error ? explained : new Error(String(error?.message ?? error))
    }
    return sources.map((raw) => toSource(raw, request.fetchWindowIcons))
  },
}
