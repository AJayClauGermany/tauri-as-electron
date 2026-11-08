/**
 * clipboard, implemented with @tauri-apps/plugin-clipboard-manager.
 *
 * Follows the current Electron API, where clipboard access is async
 * (`readText(): Promise<string>`, `write(ClipboardItem[])`, ...), and keeps
 * the older synchronous-style helpers (writeHTML, writeImage, ...) for apps
 * written against earlier Electron versions. Reads can only be async on
 * Tauri, so `await clipboard.readText()` is the portable spelling.
 */
import { readText, writeText, writeHtml, writeImage, clear } from '@tauri-apps/plugin-clipboard-manager'
import { NotImplementedError, report } from '../internal/runtime.js'
import { resolveImage } from './native-image.js'

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
    if (mimetype !== 'text/plain' && mimetype !== 'text') return false
    return (await clipboard.readText()) !== ''
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
    return ['text/plain']
  },
  readHTML() {
    throw new NotImplementedError('clipboard.readHTML')
  },
  readImage() {
    throw new NotImplementedError('clipboard.readImage')
  },
  readRTF() {
    throw new NotImplementedError('clipboard.readRTF')
  },
  writeRTF() {
    throw new NotImplementedError('clipboard.writeRTF')
  },
  readBookmark() {
    throw new NotImplementedError('clipboard.readBookmark')
  },
  writeBookmark() {
    throw new NotImplementedError('clipboard.writeBookmark')
  },
  readFindText() {
    return ''
  },
  writeFindText() {},
}
