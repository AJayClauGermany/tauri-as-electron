/**
 * A subset of Electron's nativeImage. Images are kept as encoded bytes (or a
 * URL to fetch them from), plus raw pixels when created from a bitmap, and
 * handed to Tauri, which decodes PNG/ICO when the `image-png` / `image-ico`
 * cargo features of `tauri` are enabled.
 *
 * Synchronous getters work from what can be read synchronously: getSize()
 * parses the PNG/GIF/JPEG/BMP header; PNGs are decoded and bitmaps encoded
 * to PNG in JavaScript (../internal/png.js), so resize(), crop(), toBitmap()
 * and toPNG() are synchronous for PNGs and bitmaps, as in Electron. Other
 * formats (JPEG, GIF, …) and images still to be fetched are decoded with
 * createImageBitmap when they are used (`resolveImage`, an icon); their
 * resized / cropped copies report their size at once but have no bytes
 * until then.
 *
 * createFromPath reads absolute paths through Node `fs` (feature `node-fs`
 * of tauri-plugin-electron); the app's own files (`/public/icon.png`,
 * `path.join(__dirname, 'icon.png')`) are fetched from the app.
 */
import { NotImplementedError, inTauri } from '../internal/runtime.js'
import { base64ToBytes, bytesToBase64 } from '../internal/serialize.js'
import { decodePng, encodePng, isPng, resizeRgba, cropRgba } from '../internal/png.js'
import { nodeCallSync } from '../internal/node-bridge.js'
import { isAppPath } from '../internal/app-files.js'
import { fileURLToPath } from '../url.js'

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

/** Pixels of encoded bytes, decoded by the webview (any format it reads). */
async function decodeAsync(bytes, mime) {
  const png = decodePng(bytes)
  if (png) return png
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new NotImplementedError('nativeImage decoding', { reason: 'unsupported', hint: 'Only PNG images can be decoded without createImageBitmap / OffscreenCanvas.' })
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
  return { width: bitmap.width, height: bitmap.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

function sniffMime(bytes, fallback = 'image/png') {
  if (!bytes || bytes.length < 4) return fallback
  if (isPng(bytes)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon'
  if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return fallback
}

function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? null : base64ToBytes(dataUrl.slice(comma + 1))
}

export class NativeImage {
  /**
   * `pending` (with `width` / `height`): pixels that only an asynchronous
   * decode can produce, `() => Promise<{ width, height, rgba }>`.
   */
  constructor({ bytes = null, url = null, mime, rgba = null, width = 0, height = 0, scaleFactor = 1, pending = null } = {}) {
    this._bytes = bytes
    this._url = url
    this._mime = mime ?? sniffMime(bytes)
    this._rgba = rgba
    this._pending = pending
    this._pixelSize = rgba || pending ? { width, height } : null
    this._scaleFactor = scaleFactor || 1
    this.isMacTemplateImage = false
  }

  /** Encoded bytes, encoding a bitmap to PNG on first use. */
  _encoded() {
    if (!this._bytes && this._rgba) {
      this._bytes = encodePng(this._rgba, this._pixelSize.width, this._pixelSize.height)
      this._mime = 'image/png'
    }
    return this._bytes
  }

  /** `{ width, height, rgba }` when they can be had synchronously (a bitmap or a PNG), else null. */
  _pixels() {
    if (!this._rgba && this._bytes && isPng(this._bytes)) {
      try {
        const { width, height, rgba } = decodePng(this._bytes)
        this._rgba = rgba
        this._pixelSize = { width, height }
      } catch {
        return null
      }
    }
    return this._rgba ? { ...this._pixelSize, rgba: this._rgba } : null
  }

  /** Pixels, decoding (and fetching) as needed. */
  async _decodedPixels() {
    const ready = this._pixels()
    if (ready) return ready
    const bytes = await this._load()
    if (!bytes) return null
    if (this._rgba) return { ...this._pixelSize, rgba: this._rgba }
    return decodeAsync(bytes, this._mime)
  }

  /** Resolve to raw bytes (fetching `url` relative to the app, or finishing a pending decode). */
  async _load() {
    if (this._pending) {
      const pending = this._pending
      this._pending = null
      const result = await pending()
      if (result) {
        this._rgba = result.rgba
        this._pixelSize = { width: result.width, height: result.height }
      }
    }
    if (this._encoded()) return this._bytes
    if (!this._url) return null
    const response = await fetch(this._url)
    if (!response.ok) throw new Error(`Could not load image ${this._url}: HTTP ${response.status}`)
    this._bytes = new Uint8Array(await response.arrayBuffer())
    this._mime = sniffMime(this._bytes, this._mime)
    return this._bytes
  }

  isEmpty() {
    return !this._bytes && !this._url && !this._rgba && !this._pending
  }

  /**
   * A new image from this one's pixels (`transform` returns null for an
   * empty result): now if they can be had synchronously, else once decoded.
   * `sizeOf` gives the result's size from the source's pixel size, so a
   * pending copy reports its size at once when the source's is known.
   */
  _derive(transform, sizeOf) {
    const pixels = this._pixels()
    if (pixels) {
      const out = transform(pixels)
      return out ? new NativeImage({ rgba: out.rgba, width: out.width, height: out.height, scaleFactor: this._scaleFactor }) : new NativeImage()
    }
    if (this.isEmpty()) return new NativeImage()
    const known = this._knownPixelSize()
    const size = known ? sizeOf(known) : { width: 0, height: 0 }
    if (known && (!size.width || !size.height)) return new NativeImage()
    return new NativeImage({
      pending: async () => {
        const source = await this._decodedPixels()
        return source ? transform(source) : null
      },
      width: size.width,
      height: size.height,
      scaleFactor: this._scaleFactor,
    })
  }

  /** The encoded bytes (not re-encoded if the image was created from a JPEG/GIF). */
  toPNG() {
    return this._encoded()
  }

  toJPEG(quality = 90) {
    const pixels = this._pixels()
    if (!pixels) throw new NotImplementedError('nativeImage#toJPEG', { reason: 'unimplemented', hint: 'Only PNG images and bitmaps can be re-encoded synchronously.' })
    const canvas = canvasFor(pixels.rgba, pixels.width, pixels.height)
    return canvas ? dataUrlBytes(canvas.toDataURL('image/jpeg', quality / 100)) : null
  }

  /** BGRA pixels, like Electron (PNG images and bitmaps). */
  toBitmap() {
    const pixels = this._pixels()
    if (!pixels) throw new NotImplementedError('nativeImage#toBitmap', { reason: 'unimplemented', hint: 'Only PNG images and bitmaps can be decoded synchronously.' })
    return new Uint8Array(swapRedBlue(pixels.rgba).buffer)
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

  /** The image's size in pixels when known synchronously, else null. */
  _knownPixelSize() {
    const size = this._pixelSize ?? parseImageSize(this._bytes)
    return size && size.width && size.height ? size : null
  }

  /** `{ width?, height?, quality? }` in DIPs; one side alone keeps the aspect ratio. */
  resize(options = {}) {
    const scale = this._scaleFactor
    // Target size in pixels for a source of `pw` × `ph` pixels.
    const target = (pw, ph) => {
      let width = options.width === undefined ? undefined : options.width * scale
      let height = options.height === undefined ? undefined : options.height * scale
      if (width === undefined && height === undefined) return { width: pw, height: ph }
      if (width === undefined) width = (pw * height) / ph
      if (height === undefined) height = (ph * width) / pw
      return { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) }
    }
    return this._derive((p) => {
      const size = target(p.width, p.height)
      if (!size.width || !size.height) return null
      return size.width === p.width && size.height === p.height ? p : { ...size, rgba: resizeRgba(p.rgba, p.width, p.height, size.width, size.height) }
    }, (known) => target(known.width, known.height))
  }

  /** `{ x, y, width, height }` in DIPs, clamped to the image. */
  crop(rect = {}) {
    const scale = this._scaleFactor
    const area = (pw, ph) => {
      const x = Math.max(0, Math.min(pw, Math.round((rect.x ?? 0) * scale)))
      const y = Math.max(0, Math.min(ph, Math.round((rect.y ?? 0) * scale)))
      return {
        x,
        y,
        width: Math.max(0, Math.min(pw - x, Math.round((rect.width ?? 0) * scale))),
        height: Math.max(0, Math.min(ph - y, Math.round((rect.height ?? 0) * scale))),
      }
    }
    return this._derive((p) => {
      const a = area(p.width, p.height)
      return a.width && a.height ? cropRgba(p.rgba, p.width, p.height, a.x, a.y, a.width, a.height) : null
    }, (known) => area(known.width, known.height))
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

const isAbsolute = (p) => /^\/(?!\/)|^[a-zA-Z]:[\\/]|^\\\\/.test(p)

/** The file's bytes, read through Node `fs`; undefined when `fs` cannot be used, null when the file cannot be read. */
function readDiskImage(path) {
  if (!inTauri) return undefined
  try {
    return nodeCallSync({ api: 'nativeImage.createFromPath', module: 'fs', feature: 'node-fs', op: 'read', args: { path }, toError: (body) => Object.assign(new Error(body.code), body) })
  } catch (error) {
    return error?.syscall ? null : undefined
  }
}

/** `icon@2x.png` is a 2x image, as Electron reads it. */
function scaleFromName(p) {
  const match = /@(\d+(?:\.\d+)?)x\.[^./\\]+$/.exec(p)
  return match ? Number(match[1]) : 1
}

export const nativeImage = {
  createEmpty: () => new NativeImage(),
  /**
   * Absolute paths on disk are read synchronously through Node `fs`; the
   * app's own files (and everything when `fs` is unavailable) are fetched
   * from the app when used. A file that cannot be read gives an empty image.
   */
  createFromPath(p) {
    let path = p instanceof URL ? fileURLToPath(p) : String(p)
    if (/^file:/i.test(path)) path = fileURLToPath(path)
    const scaleFactor = scaleFromName(path)
    if (isAbsolute(path) && !isAppPath(path)) {
      const bytes = readDiskImage(path)
      if (bytes === null) return new NativeImage()
      if (bytes) return new NativeImage({ bytes, scaleFactor })
    }
    return new NativeImage({ url: pathToAppUrl(p), scaleFactor })
  },
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
  /** Images only: the file scaled to fit `size`, keeping its aspect ratio. */
  async createThumbnailFromPath(path, size) {
    if (!size || !(size.width > 0) || !(size.height > 0)) throw new TypeError('size must be { width, height } with positive values')
    const image = nativeImage.createFromPath(path)
    try {
      await image._load()
    } catch {
      // reported below as an empty image
    }
    const { width, height } = image.getSize()
    if (image.isEmpty() || !width || !height) throw new Error(`Failed to get thumbnail from local thumbnail cache reference: ${path}`)
    const scale = Math.min(size.width / width, size.height / height)
    const thumbnail = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
    await thumbnail._load()
    return thumbnail
  },
}

/** Accept whatever Electron accepts for an icon (path or NativeImage) and return bytes. */
export async function resolveImage(image) {
  if (!image) return null
  if (image instanceof NativeImage) return image._load()
  if (typeof image === 'string') return nativeImage.createFromPath(image)._load()
  if (image instanceof Uint8Array || image instanceof ArrayBuffer) return image
  return null
}
