/**
 * A subset of Electron's nativeImage. Images are kept as encoded bytes (or a
 * URL to fetch them from), plus raw pixels when created from a bitmap, and
 * handed to Tauri, which decodes PNG/ICO when the `image-png` / `image-ico`
 * cargo features of `tauri` are enabled.
 *
 * Synchronous getters work from what can be read synchronously: getSize()
 * parses the PNG/GIF/JPEG/BMP header; bitmaps are encoded to PNG with a
 * canvas (toDataURL is synchronous). Resizing/cropping encoded images needs
 * an asynchronous decode, so it is not implemented.
 */
import { NotImplementedError } from '../internal/runtime.js'
import { base64ToBytes, bytesToBase64 } from '../internal/serialize.js'

const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const be16 = (b, i) => (b[i] << 8) | b[i + 1]
const le16 = (b, i) => b[i] | (b[i + 1] << 8)
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0

/** Pixel size from an encoded image header, or null if unknown. */
export function parseImageSize(bytes) {
  if (!bytes || bytes.length < 10) return null
  // PNG: signature, then the IHDR chunk.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length >= 24) {
    return { width: be32(bytes, 16), height: be32(bytes, 20) }
  }
  // GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { width: le16(bytes, 6), height: le16(bytes, 8) }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) return { width: Math.abs(le32(bytes, 18)), height: Math.abs(le32(bytes, 22)) }
  // JPEG: walk the markers to a start-of-frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null
      const marker = bytes[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const length = be16(bytes, i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: be16(bytes, i + 7), height: be16(bytes, i + 5) }
      }
      i += 2 + length
    }
  }
  return null
}

/** BGRA <-> RGBA (the same swap both ways). */
function swapRedBlue(pixels) {
  const out = new Uint8ClampedArray(pixels.length)
  for (let i = 0; i < pixels.length; i += 4) {
    out[i] = pixels[i + 2]
    out[i + 1] = pixels[i + 1]
    out[i + 2] = pixels[i]
    out[i + 3] = pixels[i + 3]
  }
  return out
}

function canvasFor(rgba, width, height) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
  return canvas
}

function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? null : base64ToBytes(dataUrl.slice(comma + 1))
}

export class NativeImage {
  constructor({ bytes = null, url = null, mime = 'image/png', rgba = null, width = 0, height = 0, scaleFactor = 1 } = {}) {
    this._bytes = bytes
    this._url = url
    this._mime = mime
    this._rgba = rgba
    this._pixelSize = rgba ? { width, height } : null
    this._scaleFactor = scaleFactor || 1
    this.isMacTemplateImage = false
  }

  /** Encoded bytes, encoding a bitmap to PNG on first use. */
  _encoded() {
    if (!this._bytes && this._rgba) {
      const canvas = canvasFor(this._rgba, this._pixelSize.width, this._pixelSize.height)
      if (canvas) {
        this._bytes = dataUrlBytes(canvas.toDataURL('image/png'))
        this._mime = 'image/png'
      }
    }
    return this._bytes
  }

  /** Resolve to raw bytes (fetching `url` relative to the app if needed). */
  async _load() {
    if (this._encoded()) return this._bytes
    if (!this._url) return null
    const response = await fetch(this._url)
    if (!response.ok) throw new Error(`Could not load image ${this._url}: HTTP ${response.status}`)
    this._bytes = new Uint8Array(await response.arrayBuffer())
    return this._bytes
  }

  isEmpty() {
    return !this._bytes && !this._url && !this._rgba
  }

  /** The encoded bytes (not re-encoded if the image was created from a JPEG/GIF). */
  toPNG() {
    return this._encoded()
  }

  toJPEG(quality = 90) {
    if (!this._rgba) throw new NotImplementedError('nativeImage#toJPEG', { reason: 'unimplemented', hint: 'Only images created from a bitmap can be encoded.' })
    const canvas = canvasFor(this._rgba, this._pixelSize.width, this._pixelSize.height)
    return canvas ? dataUrlBytes(canvas.toDataURL('image/jpeg', quality / 100)) : null
  }

  /** BGRA pixels, like Electron (only for images created from a bitmap). */
  toBitmap() {
    if (!this._rgba) throw new NotImplementedError('nativeImage#toBitmap', { reason: 'unimplemented', hint: 'Only images created from a bitmap can be decoded.' })
    return new Uint8Array(swapRedBlue(this._rgba).buffer)
  }

  getBitmap() {
    return this.toBitmap()
  }

  toDataURL() {
    const bytes = this._encoded()
    return bytes ? `data:${this._mime};base64,${bytesToBase64(bytes)}` : ''
  }

  /** Size in DIPs (pixels / scaleFactor). { 0, 0 } until the bytes are known. */
  getSize(scaleFactor = this._scaleFactor) {
    const pixels = this._pixelSize ?? parseImageSize(this._bytes)
    if (!pixels) return { width: 0, height: 0 }
    return { width: Math.round(pixels.width / scaleFactor), height: Math.round(pixels.height / scaleFactor) }
  }

  getAspectRatio() {
    const { width, height } = this.getSize()
    return height ? width / height : 1
  }

  getScaleFactors() {
    return [this._scaleFactor]
  }

  setTemplateImage(flag) {
    this.isMacTemplateImage = Boolean(flag)
  }

  isTemplateImage() {
    return this.isMacTemplateImage
  }

  addRepresentation() {}

  resize() {
    throw new NotImplementedError('nativeImage#resize', { reason: 'unimplemented', hint: 'Could be done with an OffscreenCanvas.' })
  }

  crop() {
    throw new NotImplementedError('nativeImage#crop', { reason: 'unimplemented', hint: 'Could be done with an OffscreenCanvas.' })
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
  createFromBuffer: (buffer, options = {}) => {
    const bytes = new Uint8Array(buffer)
    if (options.width && options.height && !parseImageSize(bytes)) {
      // Raw BGRA pixels, as Electron accepts with width/height.
      return nativeImage.createFromBitmap(bytes, options)
    }
    return new NativeImage({ bytes, scaleFactor: options.scaleFactor })
  },
  /** BGRA pixels (Electron's native format); `format: 'rgba'` for RGBA input. */
  createFromBitmap(buffer, { width, height, scaleFactor = 1, format = 'bgra' } = {}) {
    const pixels = new Uint8ClampedArray(new Uint8Array(buffer))
    if (!width || !height || pixels.length < width * height * 4) throw new Error('Invalid buffer size')
    const rgba = format === 'rgba' ? pixels : swapRedBlue(pixels)
    return new NativeImage({ rgba, width, height, scaleFactor })
  },
  createFromDataURL(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl)
    if (!match) return new NativeImage()
    const bytes = match[2] ? base64ToBytes(match[3]) : new TextEncoder().encode(decodeURIComponent(match[3]))
    return new NativeImage({ bytes, mime: match[1] ?? 'image/png' })
  },
  createFromNamedImage: () => new NativeImage(),
  createThumbnailFromPath: () => Promise.reject(new NotImplementedError('nativeImage.createThumbnailFromPath', { reason: 'unimplemented' })),
}

/** Accept whatever Electron accepts for an icon (path or NativeImage) and return bytes. */
export async function resolveImage(image) {
  if (!image) return null
  if (image instanceof NativeImage) return image._load()
  if (typeof image === 'string') return nativeImage.createFromPath(image)._load()
  if (image instanceof Uint8Array || image instanceof ArrayBuffer) return image
  return null
}
