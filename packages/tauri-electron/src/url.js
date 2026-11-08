/**
 * `node:url` for Electron code. The common use in a main script is
 *
 *   const __dirname = path.dirname(fileURLToPath(import.meta.url))
 *
 * which the Vite plugin rewrites at build time (so the result is a
 * project-relative path, not the bundle's URL). This module covers the
 * remaining calls with the WHATWG `URL` class the webview already has.
 */

/** `file:///a/b` → `/a/b`; an http(s)/tauri URL (a page of this app) → its path. */
export function fileURLToPath(url) {
  const parsed = url instanceof URL ? url : new URL(String(url))
  return decodeURIComponent(parsed.pathname)
}

/** A path → `file://` URL (absolute paths only make sense on the file system). */
export function pathToFileURL(path) {
  const normalized = String(path).replace(/\\/g, '/')
  return new URL(`file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized)}`)
}

/** Legacy `url.parse()` shaped on top of `URL`. */
export function parse(input, parseQueryString = false) {
  let parsed
  try {
    parsed = new URL(String(input))
  } catch {
    parsed = new URL(String(input), 'relative:///')
  }
  const relative = parsed.protocol === 'relative:'
  return {
    protocol: relative ? null : parsed.protocol,
    slashes: !relative && parsed.href.startsWith(`${parsed.protocol}//`),
    auth: parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}` : null,
    host: relative ? null : parsed.host,
    port: parsed.port || null,
    hostname: relative ? null : parsed.hostname,
    hash: parsed.hash || null,
    search: parsed.search || null,
    query: parseQueryString ? Object.fromEntries(parsed.searchParams) : parsed.search ? parsed.search.slice(1) : null,
    pathname: parsed.pathname,
    path: `${parsed.pathname}${parsed.search}`,
    href: relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href,
  }
}

/** Legacy `url.format()` for the objects `parse()` returns (and `URL`s). */
export function format(input) {
  if (input instanceof URL) return input.href
  if (typeof input === 'string') return input
  const { protocol = '', slashes, auth, host, hostname, port, pathname = '', search, query, hash } = input ?? {}
  const authority = host ?? (hostname ? `${hostname}${port ? `:${port}` : ''}` : '')
  const scheme = protocol ? `${protocol}${protocol.endsWith(':') ? '' : ':'}` : ''
  const withSlashes = slashes || /^(https?|file|ftp|ws|wss):?$/.test(protocol ?? '') ? '//' : ''
  const credentials = auth ? `${auth}@` : ''
  const queryString = search ?? (query ? `?${typeof query === 'string' ? query : new URLSearchParams(query)}` : '')
  return `${scheme}${withSlashes}${credentials}${authority}${pathname}${queryString}${hash ?? ''}`
}

export function resolve(from, to) {
  return new URL(String(to), new URL(String(from), 'relative:///')).href.replace(/^relative:\/\//, '')
}

const WhatwgURL = globalThis.URL
const WhatwgURLSearchParams = globalThis.URLSearchParams
export { WhatwgURL as URL, WhatwgURLSearchParams as URLSearchParams }

export default { fileURLToPath, pathToFileURL, parse, format, resolve, URL: WhatwgURL, URLSearchParams: WhatwgURLSearchParams }
