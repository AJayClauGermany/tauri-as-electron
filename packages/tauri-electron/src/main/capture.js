/**
 * webContents.printToPDF() and capturePage() (roadmap C8), on
 * tauri-plugin-electron's `print_to_pdf` / `capture_page` (src/capture.rs):
 *
 * - Linux (WebKitGTK): a print operation to GTK's "Print to File" printer
 *   (paper size, orientation, margins, scale, page ranges, backgrounds) and
 *   a snapshot of the visible page.
 * - Windows (WebView2): PrintToPdf with every option (its own header and
 *   footer for displayHeaderFooter) and CapturePreview.
 * - macOS (WKWebView): createPDF, one page as tall as the content (no paper
 *   size, margins, orientation, scale or page ranges), and takeSnapshot.
 *
 * headerTemplate / footerTemplate, preferCSSPageSize, generateTaggedPDF and
 * generateDocumentOutline have no counterpart in any webview: ignored.
 */
import { native, hasNativePlugin } from '../internal/native.js'
import { NotImplementedError, explainError, warnOnce } from '../internal/runtime.js'
import { platform } from '../process.js'
import { NativeImage } from './native-image.js'

/** Electron's paper formats, in inches. */
export const PAPER_FORMATS = Object.freeze({
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  ledger: { width: 17, height: 11 },
  a0: { width: 33.1, height: 46.8 },
  a1: { width: 23.4, height: 33.1 },
  a2: { width: 16.54, height: 23.4 },
  a3: { width: 11.7, height: 16.54 },
  a4: { width: 8.27, height: 11.7 },
  a5: { width: 5.83, height: 8.27 },
  a6: { width: 4.13, height: 5.83 },
})

const MICRONS_PER_INCH = 25400
const DEFAULT_MARGIN = 0.4

/** `'1-5, 8, 11-13'` → [[1, 5], [8, 8], [11, 13]] (1-based, inclusive). */
export function parsePageRanges(ranges) {
  if (ranges === undefined || ranges === null || ranges === '') return []
  // Electron < 21: { from, to }, 0-based.
  if (typeof ranges === 'object' && !Array.isArray(ranges)) {
    const from = Number(ranges.from ?? 0)
    const to = Number(ranges.to ?? from)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new Error('Invalid pageRanges')
    return [[from + 1, to + 1]]
  }
  if (typeof ranges !== 'string') throw new TypeError('pageRanges must be a String')
  return ranges.split(',').map((part) => {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part)
    if (!match) throw new Error(`Invalid pageRanges syntax: '${ranges}'`)
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    if (from < 1 || to < from) throw new Error(`Invalid pageRanges syntax: '${ranges}'`)
    return [from, to]
  })
}

/** Inches from a length Electron < 21 gave in microns (any size over 1000). */
const inches = (value) => (value > 1000 ? value / MICRONS_PER_INCH : value)

/**
 * Electron's printToPDF options → what tauri-plugin-electron takes (inches,
 * 1-based page ranges). Throws like Electron for invalid values.
 */
export function pdfOptions(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an Object')
  const flag = (name, fallback = false) => {
    const value = options[name] ?? fallback
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be a Boolean`)
    return value
  }
  const scale = options.scale ?? 1
  if (typeof scale !== 'number' || !(scale >= 0.1 && scale <= 2)) throw new RangeError('scale must be a Number between 0.1 and 2')

  let { width, height } = PAPER_FORMATS.letter
  const pageSize = options.pageSize ?? 'Letter'
  if (typeof pageSize === 'string') {
    const format = PAPER_FORMATS[pageSize.toLowerCase()]
    if (!format) throw new Error(`Invalid pageSize ${pageSize}`)
    ;({ width, height } = format)
  } else if (pageSize && typeof pageSize === 'object') {
    if (!pageSize.width || !pageSize.height) throw new Error('height and width properties are required for pageSize')
    width = inches(Number(pageSize.width))
    height = inches(Number(pageSize.height))
  } else {
    throw new TypeError('pageSize must be a String or Object')
  }

  const margins = options.margins ?? {}
  if (typeof margins !== 'object') throw new TypeError('margins must be an Object')
  // Electron < 21: marginsType 1 (none) / 2 (minimum); margins.marginType 'none' / 'printableArea'.
  const none = options.marginsType === 1 || options.marginsType === 2 || margins.marginType === 'none' || margins.marginType === 'printableArea'
  const margin = (side) => {
    if (none && margins[side] === undefined) return 0
    const value = margins[side] ?? DEFAULT_MARGIN
    if (typeof value !== 'number' || value < 0) throw new TypeError(`margins.${side} must be a non-negative Number`)
    return value
  }

  return {
    landscape: flag('landscape'),
    printBackground: flag('printBackground'),
    displayHeaderFooter: flag('displayHeaderFooter'),
    scale,
    pageWidth: width,
    pageHeight: height,
    marginTop: margin('top'),
    marginBottom: margin('bottom'),
    marginLeft: margin('left'),
    marginRight: margin('right'),
    pageRanges: parsePageRanges(options.pageRanges),
  }
}

const toBuffer = (bytes) => (globalThis.Buffer ? globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes)
const toBytes = (result) => (result instanceof ArrayBuffer ? new Uint8Array(result) : ArrayBuffer.isView(result) ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength) : Uint8Array.from(result ?? []))

function warnIgnored(options) {
  if (options.headerTemplate !== undefined || options.footerTemplate !== undefined) {
    warnOnce('printToPDF-templates', `printToPDF(): headerTemplate / footerTemplate are not supported by the webview${platform === 'win32' ? ' (WebView2 prints its own header and footer with displayHeaderFooter)' : ''}.`)
  }
  if (options.displayHeaderFooter && platform !== 'win32') warnOnce('printToPDF-headerFooter', 'printToPDF(): displayHeaderFooter is only applied on Windows (WebView2).')
  if (options.preferCSSPageSize) warnOnce('printToPDF-cssPageSize', 'printToPDF(): preferCSSPageSize is ignored; the page size comes from pageSize.')
  if (platform === 'darwin') warnOnce('printToPDF-mac', 'printToPDF() on macOS (WKWebView createPDF) makes one page as tall as the content: pageSize, margins, landscape, scale and pageRanges are not applied.')
}

/** `webContents.printToPDF(options)` → Promise<Buffer>. */
export async function printToPDF(contents, options = {}) {
  const normalized = pdfOptions(options)
  warnIgnored(options ?? {})
  if (!hasNativePlugin()) throw new NotImplementedError('webContents.printToPDF', { reason: 'plugin', hint: 'Printing to PDF needs tauri-plugin-electron.' })
  if (contents.isDestroyed()) throw new Error('Object has been destroyed')
  await contents._win._nativeReady.promise
  let result
  try {
    result = await native('print_to_pdf', { label: contents._label, options: normalized })
  } catch (error) {
    throw explainOrWrap('webContents.printToPDF', error)
  }
  return toBuffer(toBytes(result))
}

function explainOrWrap(api, error) {
  const explained = explainError(api, error)
  if (explained !== error && explained instanceof NotImplementedError) return explained
  return error instanceof Error ? error : new Error(String(error?.message ?? error))
}

/**
 * `webContents.capturePage(rect?, opts?)` → Promise<NativeImage> of the
 * visible page, cropped to `rect` (DIPs). `stayHidden` / `stayAwake` have
 * no meaning here. A window with nothing on screen gives an empty image.
 */
export async function capturePage(contents, rect, _opts) {
  if (!hasNativePlugin()) throw new NotImplementedError('webContents.capturePage', { reason: 'plugin', hint: 'Page capture needs tauri-plugin-electron.' })
  if (contents.isDestroyed()) throw new Error('Object has been destroyed')
  await contents._win._nativeReady.promise
  let result
  try {
    result = await native('capture_page', { label: contents._label })
  } catch (error) {
    throw explainOrWrap('webContents.capturePage', error)
  }
  const bytes = toBytes(result)
  if (!bytes.length) return new NativeImage()
  const image = new NativeImage({ bytes, scaleFactor: contents._win._state?.scaleFactor || 1 })
  if (rect && typeof rect === 'object' && (rect.width > 0 || rect.height > 0)) return image.crop(rect)
  return image
}
