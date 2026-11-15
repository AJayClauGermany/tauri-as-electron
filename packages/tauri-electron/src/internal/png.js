/**
 * Synchronous PNG decoding and encoding (with fflate's zlib), so that
 * nativeImage can resize, crop and encode images synchronously, as Electron
 * does, without a canvas. Decodes every colour type and bit depth, Adam7
 * interlacing and tRNS transparency; encodes 8-bit RGBA.
 */
import { unzlibSync, zlibSync } from 'fflate'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
// Adam7 passes: x start, y start, x step, y step.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]

const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0

export function isPng(bytes) {
  return Boolean(bytes) && bytes.length > 8 && SIGNATURE.every((v, i) => bytes[i] === v)
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Undo the per-row filters of one (sub)image; returns its rows and where the next one starts. */
function unfilter(data, offset, rowBytes, rows, bpp) {
  const out = new Uint8Array(rowBytes * rows)
  for (let y = 0; y < rows; y++) {
    const type = data[offset++]
    const row = y * rowBytes
    const prev = row - rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[offset++]
      const a = x >= bpp ? out[row + x - bpp] : 0
      const b = y > 0 ? out[prev + x] : 0
      const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0
      let value
      switch (type) {
        case 0: value = raw; break
        case 1: value = raw + a; break
        case 2: value = raw + b; break
        case 3: value = raw + ((a + b) >> 1); break
        case 4: value = raw + paeth(a, b, c); break
        default: throw new Error(`Invalid PNG filter ${type}`)
      }
      out[row + x] = value & 0xff
    }
  }
  return { rows: out, next: offset }
}

/** `{ width, height, rgba }` for a PNG, or null for anything else. Throws on a corrupt PNG. */
export function decodePng(bytes) {
  if (!isPng(bytes)) return null
  let offset = 8
  let header = null
  let palette = null
  let transparency = null
  const idat = []
  while (offset + 8 <= bytes.length) {
    const length = be32(bytes, offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = { width: be32(data, 0), height: be32(data, 4), depth: data[8], color: data[9], interlace: data[12] }
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (!header || !CHANNELS[header.color]) throw new Error('Invalid PNG')
  const { width, height, depth, color, interlace } = header
  const channels = CHANNELS[color]
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0))
  let at = 0
  for (const d of idat) {
    joined.set(d, at)
    at += d.length
  }
  const data = unzlibSync(joined)
  const bitsPerPixel = channels * depth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const max = (1 << depth) - 1
  const rgba = new Uint8Array(width * height * 4)

  // Sample `index` of a row (in units of `depth` bits), scaled to 0–255 (palette indices unscaled).
  const sample = (row, base, index) => {
    if (depth === 8) return row[base + index]
    if (depth === 16) return row[base + index * 2]
    const bit = index * depth
    const value = (row[base + (bit >> 3)] >> (8 - depth - (bit & 7))) & max
    return color === 3 ? value : Math.round((value * 255) / max)
  }
  // The raw sample value (for comparing with tRNS colours).
  const rawSample = (row, base, index) => {
    if (depth === 16) return (row[base + index * 2] << 8) | row[base + index * 2 + 1]
    if (depth === 8) return row[base + index]
    const bit = index * depth
    return (row[base + (bit >> 3)] >> (8 - depth - (bit & 7))) & max
  }

  const put = (row, base, x, target) => {
    const i = target * 4
    const s = x * channels
    switch (color) {
      case 0: {
        const g = sample(row, base, s)
        rgba[i] = rgba[i + 1] = rgba[i + 2] = g
        rgba[i + 3] = transparency && rawSample(row, base, s) === ((transparency[0] << 8) | transparency[1]) ? 0 : 255
        break
      }
      case 2:
        rgba[i] = sample(row, base, s)
        rgba[i + 1] = sample(row, base, s + 1)
        rgba[i + 2] = sample(row, base, s + 2)
        rgba[i + 3] = transparency &&
          rawSample(row, base, s) === ((transparency[0] << 8) | transparency[1]) &&
          rawSample(row, base, s + 1) === ((transparency[2] << 8) | transparency[3]) &&
          rawSample(row, base, s + 2) === ((transparency[4] << 8) | transparency[5]) ? 0 : 255
        break
      case 3: {
        const index = sample(row, base, s)
        rgba[i] = palette?.[index * 3] ?? 0
        rgba[i + 1] = palette?.[index * 3 + 1] ?? 0
        rgba[i + 2] = palette?.[index * 3 + 2] ?? 0
        rgba[i + 3] = transparency && index < transparency.length ? transparency[index] : 255
        break
      }
      case 4:
        rgba[i] = rgba[i + 1] = rgba[i + 2] = sample(row, base, s)
        rgba[i + 3] = sample(row, base, s + 1)
        break
      case 6:
        rgba[i] = sample(row, base, s)
        rgba[i + 1] = sample(row, base, s + 1)
        rgba[i + 2] = sample(row, base, s + 2)
        rgba[i + 3] = sample(row, base, s + 3)
        break
    }
  }

  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]]
  let offsetIn = 0
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx)
    const ph = Math.ceil((height - y0) / dy)
    if (pw <= 0 || ph <= 0) continue
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8)
    const { rows, next } = unfilter(data, offsetIn, rowBytes, ph, bpp)
    offsetIn = next
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) put(rows, y * rowBytes, x, (y0 + y * dy) * width + x0 + x * dx)
    }
  }
  return { width, height, rgba }
}

let crcTable = null
function crc32(bytes, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 8-bit RGBA pixels → PNG bytes. */
export function encodePng(rgba, width, height) {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const chunks = [['IHDR', ihdr], ['IDAT', zlibSync(raw, { level: 6 })], ['IEND', new Uint8Array(0)]]
  const out = new Uint8Array(8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0))
  out.set(SIGNATURE)
  let at = 8
  const outView = new DataView(out.buffer)
  for (const [type, data] of chunks) {
    outView.setUint32(at, data.length)
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i)
    out.set(data, at + 8)
    outView.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length))
    at += 12 + data.length
  }
  return out
}

/** One axis of a resample: box-averages when shrinking, interpolates linearly when growing. */
function resampleAxis(src, srcLen, dstLen, lines, get, set) {
  const scale = srcLen / dstLen
  for (let line = 0; line < lines; line++) {
    for (let d = 0; d < dstLen; d++) {
      const acc = [0, 0, 0, 0]
      if (scale > 1) {
        const from = d * scale
        const to = from + scale
        let weight = 0
        for (let s = Math.floor(from); s < Math.min(Math.ceil(to), srcLen); s++) {
          const w = Math.min(s + 1, to) - Math.max(s, from)
          const px = get(src, line, s)
          for (let c = 0; c < 4; c++) acc[c] += px[c] * w
          weight += w
        }
        for (let c = 0; c < 4; c++) acc[c] /= weight
      } else {
        const pos = Math.max(0, Math.min(srcLen - 1, (d + 0.5) * scale - 0.5))
        const s0 = Math.floor(pos)
        const s1 = Math.min(s0 + 1, srcLen - 1)
        const t = pos - s0
        const a = get(src, line, s0)
        const b = get(src, line, s1)
        for (let c = 0; c < 4; c++) acc[c] = a[c] * (1 - t) + b[c] * t
      }
      set(line, d, acc)
    }
  }
}

/** Resize RGBA pixels (alpha-premultiplied while resampling, so edges do not darken). */
export function resizeRgba(rgba, width, height, newWidth, newHeight) {
  const pre = new Float32Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255
    pre[i * 4] = rgba[i * 4] * a
    pre[i * 4 + 1] = rgba[i * 4 + 1] * a
    pre[i * 4 + 2] = rgba[i * 4 + 2] * a
    pre[i * 4 + 3] = rgba[i * 4 + 3]
  }
  const pixel = (buf, i) => [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
  const wide = new Float32Array(newWidth * height * 4)
  resampleAxis(pre, width, newWidth, height, (buf, y, x) => pixel(buf, (y * width + x) * 4), (y, x, v) => wide.set(v, (y * newWidth + x) * 4))
  const out = new Float32Array(newWidth * newHeight * 4)
  resampleAxis(wide, height, newHeight, newWidth, (buf, x, y) => pixel(buf, (y * newWidth + x) * 4), (x, y, v) => out.set(v, (y * newWidth + x) * 4))
  const result = new Uint8Array(newWidth * newHeight * 4)
  for (let i = 0; i < newWidth * newHeight; i++) {
    const a = out[i * 4 + 3]
    const k = a > 0 ? 255 / a : 0
    result[i * 4] = Math.round(Math.min(255, out[i * 4] * k))
    result[i * 4 + 1] = Math.round(Math.min(255, out[i * 4 + 1] * k))
    result[i * 4 + 2] = Math.round(Math.min(255, out[i * 4 + 2] * k))
    result[i * 4 + 3] = Math.round(Math.min(255, a))
  }
  return result
}

/** The `width` × `height` area at `x`, `y` (clamped to the image). */
export function cropRgba(rgba, width, height, x, y, cropWidth, cropHeight) {
  x = Math.max(0, Math.min(width, Math.round(x)))
  y = Math.max(0, Math.min(height, Math.round(y)))
  cropWidth = Math.max(0, Math.min(width - x, Math.round(cropWidth)))
  cropHeight = Math.max(0, Math.min(height - y, Math.round(cropHeight)))
  const out = new Uint8Array(cropWidth * cropHeight * 4)
  for (let row = 0; row < cropHeight; row++) {
    const from = ((y + row) * width + x) * 4
    out.set(rgba.subarray(from, from + cropWidth * 4), row * cropWidth * 4)
  }
  return { rgba: out, width: cropWidth, height: cropHeight }
}
