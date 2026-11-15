/**
 * What the Vite and webpack/rspack plugins share: which Node built-ins are
 * shimmed or stubbed, the `__dirname` / `import.meta.dirname` rewrite, and
 * the description and staging of the app's own files for `fs`.
 * CommonJS so the webpack plugin (often loaded from a CommonJS config) can
 * require it on every Node version; vite.js imports it as ES module.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Node built-ins that a webview cannot provide: `import fs from 'fs'` must not be a build error. */
const NODE_BUILTINS = [
  'cluster', 'http2', 'inspector', 'inspector/promises', 'repl', 'trace_events', 'v8', 'vm', 'wasi',
  'worker_threads',
]

/** Node built-ins tauri-electron implements (aliased, like `electron` itself). */
const NODE_SHIMS = {
  path: 'tauri-electron/path',
  'path/posix': 'tauri-electron/path',
  'path/win32': 'tauri-electron/path/win32',
  process: 'tauri-electron/process',
  events: 'tauri-electron/events',
  url: 'tauri-electron/url',
  buffer: 'tauri-electron/buffer',
  fs: 'tauri-electron/fs',
  'fs/promises': 'tauri-electron/fs/promises',
  // Electron's fs without asar support: the same thing here.
  'original-fs': 'tauri-electron/fs',
  util: 'tauri-electron/util',
  'util/types': 'tauri-electron/util/types',
  sys: 'tauri-electron/util',
  string_decoder: 'tauri-electron/string_decoder',
  stream: 'tauri-electron/stream',
  'stream/promises': 'tauri-electron/stream/promises',
  os: 'tauri-electron/os',
  child_process: 'tauri-electron/child_process',
  crypto: 'tauri-electron/crypto',
  http: 'tauri-electron/http',
  https: 'tauri-electron/https',
  assert: 'tauri-electron/assert',
  'assert/strict': 'tauri-electron/assert/strict',
  querystring: 'tauri-electron/querystring',
  punycode: 'tauri-electron/punycode',
  timers: 'tauri-electron/timers',
  'timers/promises': 'tauri-electron/timers/promises',
  perf_hooks: 'tauri-electron/perf_hooks',
  'stream/web': 'tauri-electron/stream/web',
  'stream/consumers': 'tauri-electron/stream/consumers',
  zlib: 'tauri-electron/zlib',
  constants: 'tauri-electron/constants',
  console: 'tauri-electron/console',
  module: 'tauri-electron/module',
  readline: 'tauri-electron/readline',
  'readline/promises': 'tauri-electron/readline/promises',
  async_hooks: 'tauri-electron/async_hooks',
  diagnostics_channel: 'tauri-electron/diagnostics_channel',
  tty: 'tauri-electron/tty',
  domain: 'tauri-electron/domain',
  net: 'tauri-electron/net',
  tls: 'tauri-electron/tls',
  dgram: 'tauri-electron/dgram',
  dns: 'tauri-electron/dns',
  'dns/promises': 'tauri-electron/dns/promises',
}

/** Electron helper packages tauri-electron replaces (aliased like `electron`). */
const PACKAGE_SHIMS = {
  '@electron/remote': 'tauri-electron/remote',
  '@electron/remote/renderer': 'tauri-electron/remote/renderer',
  '@electron/remote/main': 'tauri-electron/remote/main',
}

/** Dev-server endpoint the hidden main window posts its console output to. */
const LOG_ENDPOINT = '/__tauri-electron/log'

// Comments and quoted strings are matched (and kept) so that only real
// identifiers are rewritten. Template literals are scanned as code so
// `${__dirname}` inside them still works; `//` right after a `:` is a URL
// in one (`file://${__dirname}/index.html`), not a comment.
// `fileURLToPath(import.meta.url)` is how ES-module Electron code gets its
// file name (Node < 20.11 has no import.meta.dirname); rewritten as a whole so
// it yields the source file, not the URL of the bundled chunk.
const PATH_GLOBALS =
  /((?<!:)\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(?<![.$\w])__(dirname|filename)(?![$\w])|\bimport\.meta\.(dirname|filename)\b|\bfileURLToPath\(\s*import\.meta\.url\s*\)/g

// `require('x')` of a shimmed built-in, outside comments and strings.
const BUILTIN_REQUIRE =
  /((?<!:)\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(?<![.$\w])require\(\s*(['"])((?:node:)?[a-z_/-]+)\2\s*\)/g

/**
 * In a Vite (rolldown) build, CommonJS code that `require()`s an ES module
 * gets its namespace object, so `require('assert')(x)`, `new (require('events'))()`
 * or `require('console').log` would fail. Every shim's default export is the
 * complete Node-shaped module (callable where Node's is), so take that.
 */
function rewriteBuiltinRequires(code) {
  return code.replace(BUILTIN_REQUIRE, (match, skipped, _quote, id) => {
    if (skipped || !NODE_SHIMS[id.replace(/^node:/, '')]) return match
    return `((m) => (m && m.default) || m)(${match})`
  })
}

/** Cheap pre-check before running the rewrite. */
function mentionsRequire(code) {
  return code.includes('require(')
}

/** Replace `__dirname` & co. in `code` with the given project-relative paths. */
function rewritePathGlobals(code, dirname, filename) {
  return code.replace(PATH_GLOBALS, (match, skipped, legacy, meta) => {
    if (skipped) return match
    return JSON.stringify((legacy ?? meta) === 'dirname' ? dirname : filename)
  })
}

/** Cheap pre-check before running the rewrite. */
function mentionsPathGlobals(code) {
  return code.includes('__dirname') || code.includes('__filename') || code.includes('import.meta.')
}

// --- the app's own files (fs) ---------------------------------------------------------------

/**
 * Top-level names that are real folders on some operating system: an
 * absolute path starting with one of them is never taken for an app file,
 * even if the project has a folder of that name.
 */
const SYSTEM_ROOTS = new Set([
  'Applications', 'Library', 'System', 'Users', 'Volumes', 'bin', 'boot', 'dev', 'etc', 'home', 'lib',
  'lib64', 'media', 'mnt', 'nix', 'opt', 'private', 'proc', 'root', 'run', 'sbin', 'snap', 'srv', 'sys',
  'tmp', 'usr', 'var',
])

/**
 * What the `fs` shim needs to know about the project (see
 * src/internal/app-files.js): its top-level entries, which make an absolute
 * path such as `/src/data.json` (from the rewritten `__dirname`) an app
 * file, and in development the project folder itself.
 */
function appFilesConfig(root, { dev, sessionPreloads = [] }) {
  let entries = []
  try {
    entries = fs.readdirSync(root).filter((name) => !name.startsWith('.') && name !== 'src-tauri' && !SYSTEM_ROOTS.has(name))
  } catch {
    /* no project folder: nothing is app-relative */
  }
  const config = { root: dev ? root : null, entries }
  const electron = electronMajor(root)
  if (electron !== null) config.electron = electron
  // Which session preloads the renderers run (session.setPreloads does not warn about them).
  if (sessionPreloads.length) config.sessionPreloads = sessionPreloads.map((p) => p.name)
  return config
}

/**
 * Preload scripts that libraries register at runtime with
 * `session.registerPreloadScript` / `setPreloads` (paths inside their
 * package). tauri-electron cannot load a file at runtime, so the bundler
 * plugins put them in every renderer page when the app depends on the
 * library. `specifier` is tried first (a package export), then `files`.
 */
const SESSION_PRELOADS = [
  { name: 'electron-log', specifier: 'electron-log/preload', files: ['src/renderer/electron-log-preload.js', 'preload.js'] },
  { name: '@sentry/electron', specifier: '@sentry/electron/preload', files: [] },
]

function readPackageJson(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** A module id the bundler can import: a resolvable specifier as is, else an absolute file path. */
function resolveFrom(root, specifier, files = []) {
  try {
    require.resolve(specifier, { paths: [root] })
    return { id: specifier }
  } catch {
    /* not a package export: try the files */
  }
  for (const file of files) {
    const full = path.join(root, 'node_modules', ...specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1), file)
    if (fs.existsSync(full)) return { id: full, file: true }
  }
  return null
}

/**
 * The session preloads to put in renderer pages: `[{ name, id, file }]`.
 * `option` is the plugins' `sessionPreloads` option: false for none, or
 * extra module specifiers / project-relative files (added to the known
 * libraries the app depends on).
 */
function sessionPreloads(root, option) {
  if (option === false) return []
  const pkg = readPackageJson(root)
  const deps = { ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies }
  const found = []
  for (const known of SESSION_PRELOADS) {
    if (!deps[known.name]) continue
    const resolved = resolveFrom(root, known.specifier, known.files)
    if (resolved) found.push({ name: known.name, ...resolved })
  }
  for (const extra of [option ?? []].flat().filter(Boolean)) {
    if (/^\.{0,2}[\\/]/.test(extra)) found.push({ name: extra, id: path.resolve(root, extra), file: true })
    else found.push({ name: extra, ...(resolveFrom(root, extra) ?? { id: extra }) })
  }
  return found
}

/**
 * The major version of the `electron` package the project depends on
 * (`"^28.1.0"` → 28), or null. APIs that changed shape between Electron
 * versions follow it: clipboard reads are synchronous before 45.
 */
function electronMajor(root) {
  // The installed version, when there is one: a range such as `>=44 <46` does not say.
  try {
    const installed = JSON.parse(fs.readFileSync(require.resolve('electron/package.json', { paths: [root] }), 'utf8'))
    const major = /^(\d+)\./.exec(installed.version ?? '')
    if (major) return Number(major[1])
  } catch {
    /* not installed: read the range */
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const range = pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? pkg.optionalDependencies?.electron
    const match = typeof range === 'string' ? /(\d+)/.exec(range.replace(/^npm:electron@/, '')) : null
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

// --- Node built-ins in renderer pages -------------------------------------------------------

/** `nodeIntegration: true` or `sandbox: false` in a BrowserWindow's webPreferences. */
const NODE_WINDOW = /\bnodeIntegration\s*:\s*(?:true|!0)\b|\bsandbox\s*:\s*(?:false|!1)\b/
const SCANNED_SOURCE = /\.(?:[cm]?[jt]sx?)$/i
const SCAN_LIMIT = 5000

/** Whether a project source file (outside dependencies and build output) asks for Node in a window. */
function sourcesAskForNode(root) {
  let seen = 0
  const visit = (dir) => {
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of names) {
      if (entry.name.startsWith('.') || UNSTAGED_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (visit(full)) return true
      } else if (SCANNED_SOURCE.test(entry.name)) {
        if (++seen > SCAN_LIMIT) return false
        try {
          if (fs.statSync(full).size < 2_000_000 && NODE_WINDOW.test(fs.readFileSync(full, 'utf8'))) return true
        } catch {
          /* unreadable: skip */
        }
      }
    }
    return false
  }
  return visit(root)
}

/**
 * Whether renderer pages load the Node layer (tauri-electron/renderer-node),
 * which installs Node built-ins in windows the main process created with
 * `nodeIntegration: true` or `sandbox: false`. `option` is the plugins'
 * `rendererNode` option: true, false, or `'auto'` (default): when the app
 * depends on Electron < 20 (unsandboxed preloads by default) or its sources
 * mention `nodeIntegration: true` / `sandbox: false`.
 */
function rendererNode(root, option = 'auto') {
  if (option === true || option === false) return option
  const electron = electronMajor(root)
  if (electron !== null && electron < 20) return true
  return sourcesAskForNode(root)
}

/** Where the bundler plugins stage app files; tauri.conf.json maps it to the resource folder. */
const STAGING_DIR = path.join('src-tauri', 'electron-resources')

/** Never staged (the default selection): dependencies, the Tauri project, build output. */
const UNSTAGED_DIRS = new Set(['node_modules', 'src-tauri', 'dist', 'build', 'out', 'release', 'target', 'coverage'])
/** Sources the bundler compiles into the build; Electron apps read them through the bundle, not fs. */
const COMPILED = /\.(?:[cm]?[jt]sx?|css|s[ac]ss|less|styl|html?|vue|svelte|map)$/i
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json'])

function copyFiltered(from, to, filter) {
  let count = 0
  const stat = fs.statSync(from)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(from)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      count += copyFiltered(path.join(from, name), path.join(to, name), filter)
    }
    return count
  }
  if (!filter(from)) return 0
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return 1
}

/**
 * Copy the app's own files to `src-tauri/electron-resources/app/`, Electron's
 * `resources/app` layout, so `fs.readFileSync(path.join(__dirname, 'x.json'))`
 * finds them in a build. Does nothing unless that folder exists (apps opt in
 * with the folder and `"resources": { "electron-resources/": "" }` in
 * tauri.conf.json, which the scaffolder and the template set up).
 *
 * @param {string} root Project root.
 * @param {object} [options]
 * @param {false|string[]} [options.resources] `false`: stage nothing. A list
 *   of project-relative files or folders: stage exactly those. Default:
 *   every project file except dependencies, `src-tauri`, build output,
 *   dot-files, lockfiles and the sources the bundler compiles.
 * @param {string[]} [options.exclude] Extra top-level names to skip (the build's output folder).
 * @returns {number|null} Files staged, or null when the app has not opted in.
 */
function stageAppFiles(root, { resources, exclude = [] } = {}) {
  const staging = path.join(root, STAGING_DIR)
  if (resources === false || !fs.existsSync(staging)) return null
  const appDir = path.join(staging, 'app')
  fs.rmSync(appDir, { recursive: true, force: true })
  let count = 0
  if (Array.isArray(resources)) {
    for (const entry of resources) {
      const source = path.resolve(root, entry)
      if (fs.existsSync(source)) count += copyFiltered(source, path.join(appDir, path.relative(root, source)), () => true)
    }
    return count
  }
  const skip = new Set([...UNSTAGED_DIRS, ...exclude.map((dir) => path.relative(root, path.resolve(root, dir)).split(/[\\/]/)[0])])
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.') || skip.has(name) || LOCKFILES.has(name)) continue
    count += copyFiltered(path.join(root, name), path.join(appDir, name), (file) => !COMPILED.test(file) && !LOCKFILES.has(path.basename(file)))
  }
  return count
}

module.exports = {
  NODE_BUILTINS,
  NODE_SHIMS,
  PACKAGE_SHIMS,
  LOG_ENDPOINT,
  STAGING_DIR,
  rewritePathGlobals,
  mentionsPathGlobals,
  rewriteBuiltinRequires,
  mentionsRequire,
  appFilesConfig,
  electronMajor,
  sessionPreloads,
  rendererNode,
  stageAppFiles,
}
