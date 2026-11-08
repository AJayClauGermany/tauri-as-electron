/**
 * clipboard, implemented with @tauri-apps/plugin-clipboard-manager.
 *
 * Follows the current Electron API, where clipboard access is async
 * (`readText(): Promise<string>`, `write(ClipboardItem[])`, ...), and keeps
 * the older synchronous-style helpers (writeHTML, writeImage, ...) for apps
 * written against earlier Electron versions. Reads can only be async on
 * Tauri, so `await clipboard.readText()` is the portable spelling.
 */
import { readText, writeText, writeHtml, writeImage, readImage, clear } from '@tauri-apps/plugin-clipboard-manager'
import { NotImplementedError, report } from '../internal/runtime.js'
import { resolveImage, nativeImage } from './native-image.js'

// Custom formats (writeBuffer) and the macOS find pasteboard have no Tauri
// API; they are kept in memory, so they only round-trip within this app run.
const buffers = new Map()
let findText = ''

async function readClipboardImage() {
  try {
    const image = await readImage()
    const [rgba, size] = await Promise.all([image.rgba(), image.size()])
    return nativeImage.createFromBitmap(rgba, { width: size.width, height: size.height, format: 'rgba' })
  } catch {
    return nativeImage.createEmpty()
  }
}

/** Electron's ClipboardItem (modelled on the W3C class). */
export class ClipboardItem {
  constructor(items = {}) {
    this._items = { ...items }
  }

  get types() {
    return Object.keys(this._items)
  }

  async getType(type) {
    if (!(type in this._items)) throw new DOMException(`The type '${type}' was not found`, 'NotFoundError')
    const value = await this._items[type]
    if (value instanceof Blob || (value && typeof value === 'object')) return value
    return new Blob([String(value)], { type })
  }
}

async function asText(value) {
  value = await value
  if (value instanceof Blob) return value.text()
  return value == null ? undefined : String(value)
}

async function asBytes(value) {
  value = await value
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  return resolveImage(value)
}

async function writeItems(items) {
  const item = items[0]
  if (!item) return clear()
  const get = (type) => (item.types.includes(type) ? item._items[type] : undefined)
  const html = await asText(get('text/html'))
  const text = await asText(get('text/plain'))
  const png = get('image/png')
  if (png !== undefined) return writeImage(await asBytes(png))
  if (html !== undefined) return writeHtml(html, text)
  if (text !== undefined) return writeText(text)
  throw new Error(`Unsupported clipboard types: ${item.types.join(', ')}`)
}

export const clipboard = {
  readText() {
    return readText().catch(() => '')
  },

  writeText(text) {
    return writeText(String(text))
  },

  /** Current API: ClipboardItem[]. Legacy API: { text, html, image }. */
  write(data) {
    if (Array.isArray(data)) return writeItems(data)
    data = data ?? {}
    if (data.image) return clipboard.writeImage(data.image)
    if (data.html) return writeHtml(String(data.html), data.text)
    return writeText(String(data.text ?? ''))
  },

  async read() {
    const text = await clipboard.readText()
    return text ? [new ClipboardItem({ 'text/plain': text })] : []
  },

  async has(mimetype) {
    if (buffers.has(mimetype)) return true
    if (mimetype === 'image/png' || mimetype === 'image') return !(await readClipboardImage()).isEmpty()
    if (mimetype !== 'text/plain' && mimetype !== 'text') return false
    return (await clipboard.readText()) !== ''
  },

  /** Async (Tauri reads the clipboard asynchronously): `await clipboard.readImage()`. */
  readImage() {
    return readClipboardImage()
  },

  /** In-memory only: custom formats do not reach the OS clipboard. */
  writeBuffer(format, buffer) {
    buffers.set(String(format), new Uint8Array(buffer))
  },

  readBuffer(format) {
    return buffers.get(String(format)) ?? new Uint8Array(0)
  },

  readFindText() {
    return findText
  },

  writeFindText(text) {
    findText = String(text)
  },

  clear() {
    clear().catch(report('clipboard.clear'))
  },

  /** Linux selection clipboard: not available through Tauri. */
  selection: undefined,

  // --- APIs removed in recent Electron versions, kept for older apps ------
  writeHTML(markup, _type) {
    return writeHtml(String(markup))
  },
  writeImage(image) {
    return resolveImage(image).then((bytes) => bytes && writeImage(bytes))
  },
  availableFormats() {
    return ['text/plain', ...buffers.keys()]
  },
  readHTML() {
    throw new NotImplementedError('clipboard.readHTML', { reason: 'unimplemented', hint: 'tauri-plugin-clipboard-manager reads text and images only.' })
  },
  readRTF() {
    throw new NotImplementedError('clipboard.readRTF', { reason: 'unsupported' })
  },
  writeRTF() {
    throw new NotImplementedError('clipboard.writeRTF', { reason: 'unsupported' })
  },
  readBookmark() {
    throw new NotImplementedError('clipboard.readBookmark', { reason: 'unsupported' })
  },
  writeBookmark() {
    throw new NotImplementedError('clipboard.writeBookmark', { reason: 'unsupported' })
  },
}
