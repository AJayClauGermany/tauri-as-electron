/**
 * POSIX subset of Node's `path` module.
 *
 * Electron main-process code usually builds file locations with
 * `path.join(__dirname, 'index.html')`. The Vite plugin replaces `__dirname`
 * with the module's directory relative to the project root (for example
 * `/src`), and BrowserWindow#loadFile resolves the result against the app's
 * own URL, so this pure-string implementation is all that is needed.
 *
 * `path.win32` is a real Windows implementation (./node/path-win32.js), for
 * taking apart the Windows paths `app.getPath()` and `fs` return. `path`
 * itself stays POSIX on every platform.
 */
import win32Path from './node/path-win32.js'

export const sep = '/'
export const delimiter = ':'

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
  return String(p).startsWith('/')
}

export function normalize(p) {
  p = String(p)
  if (p === '') return '.'
  const absolute = isAbsolute(p)
  const trailing = p.endsWith('/')
  let result = normalizeSegments(p.split('/'), !absolute).join('/')
  if (!result && !absolute) result = '.'
  if (result && trailing) result += '/'
  return (absolute ? '/' : '') + result
}

export function join(...parts) {
  const filtered = parts.filter((part) => part !== '' && part != null).map(String)
  return filtered.length ? normalize(filtered.join('/')) : '.'
}

export function resolve(...parts) {
  let resolved = ''
  for (let i = parts.length - 1; i >= 0 && !isAbsolute(resolved); i--) {
    const part = String(parts[i] ?? '')
    if (part) resolved = resolved ? `${part}/${resolved}` : part
  }
  if (!isAbsolute(resolved)) resolved = `/${resolved}`
  const result = '/' + normalizeSegments(resolved.split('/'), false).join('/')
  return result
}

export function dirname(p) {
  p = String(p)
  if (!p) return '.'
  const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p
  const index = trimmed.lastIndexOf('/')
  if (index === -1) return '.'
  if (index === 0) return '/'
  return trimmed.slice(0, index)
}

export function basename(p, ext) {
  p = String(p).replace(/\/+$/, '')
  let base = p.slice(p.lastIndexOf('/') + 1)
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length)
  return base
}

export function extname(p) {
  const base = basename(p)
  const index = base.lastIndexOf('.')
  return index <= 0 ? '' : base.slice(index)
}

export function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean)
  const b = resolve(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/')
}

export function parse(p) {
  const root = isAbsolute(p) ? '/' : ''
  const base = basename(p)
  const ext = extname(p)
  const dir = dirname(p)
  return { root, dir: dir === '.' && !String(p).includes('/') ? '' : dir, base, ext, name: ext ? base.slice(0, -ext.length) : base }
}

export function format(obj) {
  const dir = obj.dir || obj.root || ''
  const base = obj.base || `${obj.name ?? ''}${obj.ext ?? ''}`
  if (!dir) return base
  return dir === obj.root ? `${dir}${base}` : `${dir}/${base}`
}

export function toNamespacedPath(p) {
  return p
}

const path = {
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
path.posix = path
path.win32 = win32Path
win32Path.posix = path

export const posix = path
export const win32 = win32Path
export default path
