/**
 * Where the app's own files are, for `fs` and `app.getAppPath()`.
 *
 * The bundler plugins rewrite `__dirname` to project-relative paths such as
 * `/src/main` (BrowserWindow#loadFile needs that). Passed to `fs`, those name
 * the app's files:
 *
 * - in development, the project folder itself (like `electron .`),
 * - in a build, `<resources>/app`, where the bundler plugin stages the app's
 *   files and tauri.conf.json `bundle.resources` ships them (Electron's
 *   `resources/app` layout).
 *
 * A path is app-relative when it is absolute in POSIX form and its first
 * segment is a top-level entry of the project (`/src/…`, `/assets/…`,
 * `/package.json`), unless it lies under a real folder the app knows
 * (`app.getPath(…)`, `process.resourcesPath`, the working directory).
 * Everything else is a real path and is used as is.
 *
 * The plugins describe the project in `globalThis.__TAURI_ELECTRON_APP__`
 * (`{ root, entries }`; `root` is null in a build) from the main page's
 * first module.
 */
import processShim from '../process.js'

const realRoots = new Set()
let resourceRoot = null

function config() {
  return globalThis.__TAURI_ELECTRON_APP__ ?? null
}

const toSlashes = (p) => String(p).replace(/\\/g, '/')
const trimEnd = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/** Folders known to be real (app.getPath values and the like), checked before the app mapping. */
export function addRealRoots(paths) {
  for (const p of paths) if (p) realRoots.add(trimEnd(toSlashes(p)))
}

/** Override where a build's app files are (the resource directory); used by tests and by `fs` once known. */
export function setResourceRoot(dir) {
  resourceRoot = dir || null
}

/**
 * The app root as a real path: the project folder in development,
 * `<resources>/app` in a build. `resolveResources` is called when the
 * resource directory is not known yet (before the app is ready).
 */
export function appRoot(resolveResources) {
  const cfg = config()
  if (cfg?.root) return cfg.root
  const resources = resourceRoot ?? (processShim.resourcesPath || globalThis.process?.resourcesPath || resolveResources?.() || null)
  if (!resources) return null
  resourceRoot = resources
  return joinNative(resources, 'app')
}

function joinNative(base, rest) {
  const sep = /^[a-zA-Z]:[\\/]|^\\\\/.test(base) ? '\\' : '/'
  const tail = String(rest).replace(/^[\\/]+/, '')
  if (!tail) return base
  return base.replace(/[\\/]+$/, '') + sep + (sep === '\\' ? tail.replace(/\//g, '\\') : tail)
}

function underRealRoot(p) {
  for (const root of realRoots) {
    if (root !== '/' && (p === root || p.startsWith(`${root}/`))) return true
  }
  return false
}

/** Whether `p` (a string) names one of the app's own files. */
export function isAppPath(p) {
  const cfg = config()
  if (!cfg?.entries?.length || typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return false
  const first = p.split('/')[1]
  if (!first || !cfg.entries.includes(first)) return false
  return !underRealRoot(trimEnd(p))
}

/**
 * The real path for `p`: app-relative paths are mapped onto the app root,
 * anything else is returned unchanged. `app` tells which happened.
 */
export function resolveAppPath(p, resolveResources) {
  if (!isAppPath(p)) return { path: p, app: false }
  const root = appRoot(resolveResources)
  if (!root) return { path: p, app: false }
  return { path: joinNative(root, p), app: true }
}

/**
 * The inverse, for BrowserWindow#loadFile: a real path under the app root
 * (`path.join(app.getAppPath(), 'index.html')`) → the project-relative path
 * (`/index.html`). Other paths are returned unchanged.
 */
export function toProjectPath(p) {
  const root = appRoot()
  if (!root) return p
  const base = trimEnd(toSlashes(root))
  const value = toSlashes(p)
  const same = /^[a-zA-Z]:/.test(base) ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b
  if (same(value, base)) return '/'
  if (value.length > base.length && same(value.slice(0, base.length + 1), `${base}/`)) return value.slice(base.length)
  return p
}
