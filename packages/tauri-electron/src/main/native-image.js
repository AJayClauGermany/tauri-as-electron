/**
 * A small subset of Electron's nativeImage. Images are kept as bytes (or a
 * URL to fetch them from) and handed to Tauri, which decodes PNG/ICO when the
 * `image-png` / `image-ico` cargo features of `tauri` are enabled.
 */
import { NotImplementedError } from '../internal/runtime.js'

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export class NativeImage {
  constructor({ bytes = null, url = null, mime = 'image/png' } = {}) {
    this._bytes = bytes
    this._url = url
    this._mime = mime
    this.isMacTemplateImage = false
  }

  /** Resolve to raw bytes (fetching `url` relative to the app if needed). */
  async _load() {
    if (this._bytes) return this._bytes
    if (!this._url) return null
    const response = await fetch(this._url)
    if (!response.ok) throw new Error(`Could not load image ${this._url}: HTTP ${response.status}`)
    this._bytes = new Uint8Array(await response.arrayBuffer())
    return this._bytes
  }

  isEmpty() {
    return !this._bytes && !this._url
  }

  toPNG() {
    return this._bytes
  }

  toDataURL() {
    return this._bytes ? `data:${this._mime};base64,${bytesToBase64(this._bytes)}` : ''
  }

  getSize() {
    return { width: 0, height: 0 }
  }

  setTemplateImage(flag) {
    this.isMacTemplateImage = Boolean(flag)
  }

  resize() {
    throw new NotImplementedError('nativeImage#resize')
  }
}

/**
 * Map a filesystem-looking path from Electron code to a URL served by the
 * app. Vite serves `public/` at the root, so `/public/icon.png` -> `/icon.png`.
 */
export function pathToAppUrl(p) {
  const clean = String(p).replace(/\\/g, '/').replace(/^file:\/\//, '').replace(/^\/+/, '')
  return '/' + clean.replace(/^public\//, '')
}

export const nativeImage = {
  createEmpty: () => new NativeImage(),
  createFromPath: (p) => new NativeImage({ url: pathToAppUrl(p) }),
  createFromBuffer: (buffer) => new NativeImage({ bytes: new Uint8Array(buffer) }),
  createFromDataURL(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl)
    if (!match) return new NativeImage()
    const bytes = match[2] ? base64ToBytes(match[3]) : new TextEncoder().encode(decodeURIComponent(match[3]))
    return new NativeImage({ bytes, mime: match[1] ?? 'image/png' })
  },
  createFromNamedImage: () => new NativeImage(),
  createThumbnailFromPath: () => Promise.reject(new NotImplementedError('nativeImage.createThumbnailFromPath')),
}

/** Accept whatever Electron accepts for an icon (path or NativeImage) and return bytes. */
export async function resolveImage(image) {
  if (!image) return null
  if (image instanceof NativeImage) return image._load()
  if (typeof image === 'string') return nativeImage.createFromPath(image)._load()
  if (image instanceof Uint8Array || image instanceof ArrayBuffer) return image
  return null
}
