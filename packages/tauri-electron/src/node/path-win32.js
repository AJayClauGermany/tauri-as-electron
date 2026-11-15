/**
 * Node's `path.win32`: Windows path rules (drive letters, UNC roots, `\` and
 * `/` as separators, case-insensitive comparisons), so that real Windows
 * paths from `app.getPath()` or `fs` can be taken apart and put together.
 *
 * `path` itself stays POSIX on every platform: the project-relative paths the
 * bundler plugins give `__dirname` are POSIX, and BrowserWindow#loadFile
 * relies on that.
 */

export const sep = '\\'
export const delimiter = ';'

const isSep = (c) => c === '/' || c === '\\'

function cwd() {
  const value = globalThis.process?.cwd?.()
  return typeof value === 'string' && value ? value : '\\'
}

function assertPath(p) {
  if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${p === null ? 'null' : typeof p}`)
}

/**
 * The root of `p`: `C:` (drive), `\\server\share` (UNC) or '' (none);
 * `absolute` when a separator follows it; `end` is where the rest starts.
 */
function splitRoot(p) {
  if (p.length >= 2 && isSep(p[0]) && isSep(p[1])) {
    // \\server\share\...
    let i = 2
    while (i < p.length && isSep(p[i])) i++
    const serverStart = i
    while (i < p.length && !isSep(p[i])) i++
    if (i < p.length && i > serverStart) {
      const server = p.slice(serverStart, i)
      while (i < p.length && isSep(p[i])) i++
      const shareStart = i
      while (i < p.length && !isSep(p[i])) i++
      if (i > shareStart) {
        const device = `\\\\${server}\\${p.slice(shareStart, i)}`
        return { device, absolute: true, end: i < p.length ? i + 1 : i, rootLength: i < p.length ? i + 1 : i }
      }
    }
    return { device: '', absolute: true, end: 1, rootLength: 1 }
  }
  if (p.length >= 2 && /[a-zA-Z]/.test(p[0]) && p[1] === ':') {
    const absolute = p.length > 2 && isSep(p[2])
    return { device: p.slice(0, 2), absolute, end: absolute ? 3 : 2, rootLength: absolute ? 3 : 2 }
  }
  if (p.length && isSep(p[0])) return { device: '', absolute: true, end: 1, rootLength: 1 }
  return { device: '', absolute: false, end: 0, rootLength: 0 }
}

function normalizeSegments(segments, allowAboveRoot) {
  const out = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (allowAboveRoot) out.push('..')
    } else {
      out.push(segment)
    }
  }
  return out
}

export function isAbsolute(p) {
  assertPath(p)
  return splitRoot(p).absolute
}

export function normalize(p) {
  assertPath(p)
  if (p === '') return '.'
  const { device, absolute, end } = splitRoot(p)
  let tail = normalizeSegments(p.slice(end).split(/[\\/]/), !absolute).join('\\')
  if (!tail && !absolute) tail = '.'
  if (tail && isSep(p[p.length - 1]) && p.length > end) tail += '\\'
  // Like Node (since the CVE-2025-27210 fix): a relative result built from a
  // segment that looks like a drive (`a\\C:\\x`) must not read as one.
  if (!device && !absolute && tail !== '.' && /[a-zA-Z]:(?:[\\/]|$)/.test(p)) tail = `.\\${tail}`
  return device + (absolute ? '\\' : '') + tail
}

export function join(...parts) {
  for (const part of parts) assertPath(part)
  const filtered = parts.filter((part) => part !== '')
  return filtered.length ? normalize(filtered.join('\\')) : '.'
}

export function resolve(...parts) {
  let resolvedDevice = ''
  let resolvedTail = ''
  let resolvedAbsolute = false
  for (let i = parts.length - 1; i >= -1; i--) {
    let p
    if (i >= 0) {
      p = parts[i]
      assertPath(p)
      if (!p) continue
    } else if (!resolvedDevice) {
      p = cwd()
    } else {
      // A drive-relative path (C:foo): resolve against the working directory
      // when it is on that drive, else against the drive's root (as Node does).
      p = cwd()
      if (p.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() && p[2] === '\\') p = `${resolvedDevice}\\`
    }
    const { device, absolute, end } = splitRoot(p)
    if (device) {
      if (resolvedDevice && device.toLowerCase() !== resolvedDevice.toLowerCase()) continue
      if (!resolvedDevice) resolvedDevice = device
    }
    if (resolvedAbsolute) {
      if (resolvedDevice) break
    } else {
      resolvedTail = `${p.slice(end)}\\${resolvedTail}`
      resolvedAbsolute = absolute
      if (absolute && resolvedDevice) break
    }
  }
  const tail = normalizeSegments(resolvedTail.split(/[\\/]/), !resolvedAbsolute).join('\\')
  return resolvedAbsolute ? `${resolvedDevice}\\${tail}` : `${resolvedDevice}${tail}` || '.'
}

export function dirname(p) {
  assertPath(p)
  if (!p) return '.'
  const { rootLength } = splitRoot(p)
  let end = -1
  let trailing = true
  for (let i = p.length - 1; i >= rootLength; i--) {
    if (isSep(p[i])) {
      if (!trailing) {
        end = i
        break
      }
    } else {
      trailing = false
    }
  }
  if (end === -1) return rootLength ? p.slice(0, rootLength) : '.'
  return p.slice(0, end)
}

export function basename(p, ext) {
  assertPath(p)
  const { device } = splitRoot(p)
  let start = device && !device.startsWith('\\') ? 2 : 0
  let end = p.length
  while (end > start && isSep(p[end - 1])) end--
  for (let i = end - 1; i >= start; i--) {
    if (isSep(p[i])) {
      start = i + 1
      break
    }
  }
  let base = p.slice(start, end)
  if (ext !== undefined && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length)
  return base
}

export function extname(p) {
  const base = basename(p)
  const index = base.lastIndexOf('.')
  return index <= 0 || base === '..' ? '' : base.slice(index)
}

export function relative(from, to) {
  assertPath(from)
  assertPath(to)
  if (from === to) return ''
  const a = resolve(from)
  const b = resolve(to)
  if (a.toLowerCase() === b.toLowerCase()) return ''
  const rootA = splitRoot(a)
  const rootB = splitRoot(b)
  if (rootA.device.toLowerCase() !== rootB.device.toLowerCase()) return b
  const partsA = a.slice(rootA.end).split('\\').filter(Boolean)
  const partsB = b.slice(rootB.end).split('\\').filter(Boolean)
  let i = 0
  while (i < partsA.length && i < partsB.length && partsA[i].toLowerCase() === partsB[i].toLowerCase()) i++
  return [...Array(partsA.length - i).fill('..'), ...partsB.slice(i)].join('\\')
}

export function parse(p) {
  assertPath(p)
  const { rootLength } = splitRoot(p)
  const root = p.slice(0, rootLength)
  const base = rootLength === p.length ? '' : basename(p)
  const ext = extname(base)
  const rest = p.slice(rootLength).replace(/[\\/]+$/, '')
  const dir = /[\\/]/.test(rest) ? dirname(p) : root
  return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base }
}

export function format(obj) {
  if (obj === null || typeof obj !== 'object') throw new TypeError('The "pathObject" argument must be of type object')
  const dir = obj.dir || obj.root || ''
  const base = obj.base || `${obj.name ?? ''}${obj.ext ? (obj.ext.startsWith('.') ? '' : '.') + obj.ext : ''}`
  if (!dir) return base
  return dir === obj.root ? `${dir}${base}` : `${dir}\\${base}`
}

export function toNamespacedPath(p) {
  if (typeof p !== 'string' || !p) return p
  const resolved = resolve(p)
  if (resolved.length <= 2) return p
  if (resolved.startsWith('\\\\')) {
    if (resolved[2] !== '?' && resolved[2] !== '.') return `\\\\?\\UNC\\${resolved.slice(2)}`
    return p
  }
  if (/^[a-zA-Z]:\\/.test(resolved)) return `\\\\?\\${resolved}`
  return p
}

const win32 = {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
  format,
  toNamespacedPath,
}
win32.win32 = win32

export default win32
