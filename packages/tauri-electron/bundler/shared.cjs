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
const { forkEntriesInSource, mentionsFork } = require('./fork.cjs')

/** Node built-ins that a webview cannot provide: `import fs from 'fs'` must not be a build error. */
const NODE_BUILTINS = [
  'cluster', 'http2', 'inspector', 'inspector/promises', 'repl', 'trace_events', 'v8', 'wasi',
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
  vm: 'tauri-electron/vm',
  worker_threads: 'tauri-electron/worker_threads',
}

/**
 * npm packages with native code tauri-electron re-implements on
 * tauri-plugin-electron's `keytar`, `sqlite` and `pty` features (part of
 * PACKAGE_SHIMS). Their real builds cannot load in a webview.
 */
const NATIVE_MODULE_SHIMS = {
  keytar: 'tauri-electron/keytar',
  'better-sqlite3': 'tauri-electron/better-sqlite3',
  sqlite3: 'tauri-electron/sqlite3',
  'node-pty': 'tauri-electron/node-pty',
}

/** Electron helper packages tauri-electron replaces (aliased like `electron`). */
const PACKAGE_SHIMS = {
  '@electron/remote': 'tauri-electron/remote',
  '@electron/remote/renderer': 'tauri-electron/remote/renderer',
  '@electron/remote/main': 'tauri-electron/remote/main',
  ...NATIVE_MODULE_SHIMS,
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
  /((?<!:)\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(?<![.$\w])require\(\s*(['"])((?:node:)?[a-z0-9_/-]+)\2\s*\)/g

/**
 * In a Vite (rolldown) build, CommonJS code that `require()`s an ES module
 * gets its namespace object, so `require('assert')(x)`, `new (require('events'))()`
 * or `require('console').log` would fail. Every shim's default export is the
 * complete Node-shaped module (callable where Node's is), so take that; the
 * same for the native-module shims (`new (require('better-sqlite3'))(file)`).
 */
function rewriteBuiltinRequires(code) {
  return code.replace(BUILTIN_REQUIRE, (match, skipped, _quote, id) => {
    if (skipped || !(NODE_SHIMS[id.replace(/^node:/, '')] || NATIVE_MODULE_SHIMS[id])) return match
    return `((m) => (m && m.default) || m)(${match})`
  })
}

/** Cheap pre-check before running the rewrite. */
function mentionsRequire(code) {
  return code.includes('require(')
}

/**
 * Replace `__dirname` & co. in `code` with the given project-relative paths
 * (`toCode` turns a path into the code that replaces them: a string literal,
 * or an expression for code that runs in a forked Node.js).
 */
function rewritePathGlobals(code, dirname, filename, toCode = JSON.stringify) {
  return code.replace(PATH_GLOBALS, (match, skipped, legacy, meta) => {
    if (skipped) return match
    return toCode((legacy ?? meta) === 'dirname' ? dirname : filename)
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
const SCAN_LIMIT = 20000

/** Whether a project source file (outside dependencies and build output) asks for Node in a window. */
function sourcesAskForNode(root, scan) {
  return sourceScan(root, scan).node
}

/**
 * Whether renderer pages load the Node layer (tauri-electron/renderer-node),
 * which installs Node built-ins in windows the main process created with
 * `nodeIntegration: true` or `sandbox: false`. `option` is the plugins'
 * `rendererNode` option: true, false, or `'auto'` (default): when the app
 * depends on Electron < 20 (unsandboxed preloads by default) or its sources
 * mention `nodeIntegration: true` / `sandbox: false`.
 */
function rendererNode(root, option = 'auto', scan) {
  if (option === true || option === false) return option
  const electron = electronMajor(root)
  if (electron !== null && electron < 20) return true
  return sourcesAskForNode(root, scan)
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

// --- custom schemes (protocol.handle) ---------------------------------------------------------

/**
 * Schemes Tauri must know when the app is built: tauri-plugin-electron
 * registers each one as a URI scheme protocol, forwarded to the handler
 * `protocol.handle()` registers at runtime. The bundler plugins find them
 * in the app's source and write them to `src-tauri/electron-schemes.json`,
 * which the app's build.rs hands to `tauri_plugin_electron::bundled_schemes!()`.
 */
const SCHEMES_FILE = path.join('src-tauri', 'electron-schemes.json')

/** Schemes that libraries register on their own, by package name. */
const LIBRARY_SCHEMES = {
  '@sentry/electron': ['sentry-ipc'],
}

/** Never registered: the webview's own schemes and Tauri's. */
const RESERVED_SCHEMES = new Set([
  'http', 'https', 'file', 'about', 'data', 'blob', 'ws', 'wss', 'javascript', 'mailto', 'ftp',
  'tauri', 'tauri-electron', 'ipc', 'asset', 'chrome', 'chrome-extension', 'devtools', 'view-source',
])

const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/
const QUOTED_SCHEME = /['"`]([a-zA-Z][a-zA-Z0-9+.-]*)['"`]/
// protocol.handle('x', …), protocol.registerFileProtocol('x', …), session.protocol.handle('x', …)
const HANDLE_CALL = /\bprotocol\s*\.\s*(?:handle|register(?:String|Buffer|File|Http|Stream)Protocol)\s*\(\s*['"`]([a-zA-Z][a-zA-Z0-9+.-]*)['"`]/g
// protocol.registerSchemesAsPrivileged([{ scheme: 'x', … }, …])
const PRIVILEGED_CALL = /\bregisterSchemesAsPrivileged\s*\(\s*\[([\s\S]*?)\]\s*\)/g
const SCHEME_PROPERTY = /\bscheme\s*:\s*['"`]([a-zA-Z][a-zA-Z0-9+.-]*)['"`]/g
const SCHEME_SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i

/** The custom schemes a piece of source code passes to `protocol`. */
function schemesInSource(code) {
  const found = new Set()
  if (!code.includes('rotocol') && !code.includes('registerSchemesAsPrivileged')) return found
  for (const match of code.matchAll(HANDLE_CALL)) found.add(match[1].toLowerCase())
  for (const call of code.matchAll(PRIVILEGED_CALL)) {
    for (const match of call[1].matchAll(SCHEME_PROPERTY)) found.add(match[1].toLowerCase())
  }
  return found
}

/**
 * One walk over the project's own sources (outside dependencies, `src-tauri`
 * and build output) for what the plugins look for: whether a window asks for
 * Node (`node`) and the custom schemes passed to `protocol` (`schemes`).
 * The plugins pass `lazySourceScan(root)` to `rendererNode` and
 * `writeSchemes`, which walk only if they need to.
 */
function scanSources(root) {
  // forks: fork entry points (project path → source file), forkCalls: whether anything forks (bundler/fork.cjs).
  // workerThreads / workers: worker_threads scripts (collectWorkers).
  const result = { node: false, schemes: new Set(), forks: new Map(), forkCalls: false, workerThreads: false, workers: [] }
  let seen = 0
  let dirs = 0
  const visit = (dir, depth) => {
    // Bounded however the tree looks: folders count too, not only source files.
    if (depth > 32 || ++dirs > SCAN_LIMIT) return
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      if (seen > SCAN_LIMIT || dirs > SCAN_LIMIT) return
      if (entry.name.startsWith('.') || UNSTAGED_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      // Symbolic links are not followed (Dirent reports them as such), so the walk ends.
      if (entry.isDirectory()) {
        visit(full, depth + 1)
      } else if (SCHEME_SOURCE.test(entry.name)) {
        if (++seen > SCAN_LIMIT) return
        try {
          if (fs.statSync(full).size > 4 * 1024 * 1024) continue
          const code = fs.readFileSync(full, 'utf8')
          if (!result.node && SCANNED_SOURCE.test(entry.name) && NODE_WINDOW.test(code)) result.node = true
          for (const scheme of schemesInSource(code)) result.schemes.add(scheme)
          if (mentionsFork(code)) result.forkCalls = true
          for (const fork of forkEntriesInSource(code, full, root)) result.forks.set(fork.key, fork.file)
          if (SCANNED_SOURCE.test(entry.name)) collectWorkers(code, full, root, result)
        } catch {
          /* unreadable: skip */
        }
      }
    }
  }
  visit(root, 0)
  return result
}

/** `scan`: a `scanSources()` result, a `lazySourceScan()` function, or nothing (walk now). */
function sourceScan(root, scan) {
  if (typeof scan === 'function') return scan()
  return scan ?? scanSources(root)
}

/** `scanSources(root)`, run on the first call only. */
function lazySourceScan(root) {
  let result = null
  return () => (result ??= scanSources(root))
}

/**
 * Every custom scheme the app uses: found in its source (outside
 * dependencies, `src-tauri` and build output), those of libraries it
 * depends on, and `extra` (the plugins' `schemes` option; `false` turns
 * the collection off). Sorted, lower case, reserved schemes left out.
 */
function collectSchemes(root, extra, scan) {
  if (extra === false) return []
  const found = new Set(sourceScan(root, scan).schemes)
  const pkg = readPackageJson(root)
  const deps = { ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies }
  for (const [name, schemes] of Object.entries(LIBRARY_SCHEMES)) if (deps[name]) schemes.forEach((s) => found.add(s))
  for (const scheme of [extra ?? []].flat()) if (scheme) found.add(String(scheme).toLowerCase())
  return [...found].filter((s) => SCHEME_NAME.test(s) && !RESERVED_SCHEMES.has(s)).sort()
}

/**
 * Write the schemes to `src-tauri/electron-schemes.json` (only when the
 * project has a `src-tauri` folder, and only when they changed, so Cargo
 * does not rebuild for nothing). Returns the schemes, or null when nothing
 * was written.
 */
function writeSchemes(root, extra, scan) {
  if (extra === false || !fs.existsSync(path.join(root, 'src-tauri'))) return null
  const schemes = collectSchemes(root, extra, scan)
  const file = path.join(root, SCHEMES_FILE)
  const text = JSON.stringify(schemes) + '\n'
  let current = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    /* not written yet */
  }
  if (current !== text) fs.writeFileSync(file, text)
  return schemes
}

// --- worker_threads: the scripts `new Worker(...)` runs -----------------------------------------

/** `require('worker_threads')`, `from 'node:worker_threads'`, `import('worker_threads')`. */
const WORKER_THREADS = /(?:\brequire\s*\(\s*|\bfrom\s*|\bimport\s*\(\s*)['"](?:node:)?worker_threads['"]/
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function mentionsWorkerThreads(code) {
  return code.includes('worker_threads') && WORKER_THREADS.test(code)
}

/** The local names `Worker` goes by in a file (`{ Worker: NodeWorker }`, `{ Worker as W }`). */
function workerNames(code) {
  const names = new Set(['Worker'])
  for (const match of code.matchAll(/\bWorker\s*(?::|\bas\b)\s*([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  return names
}

/** Index just past the string, template or comment starting at `i`, or -1 if none starts there. */
function skipLiteral(code, i) {
  const ch = code[i]
  if (ch === '/' && code[i + 1] === '/') {
    const end = code.indexOf('\n', i)
    return end === -1 ? code.length : end
  }
  if (ch === '/' && code[i + 1] === '*') {
    const end = code.indexOf('*/', i + 2)
    return end === -1 ? code.length : end + 2
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    let j = i + 1
    while (j < code.length && code[j] !== ch) {
      if (code[j] === '\\') j++
      else if (ch === '`' && code[j] === '$' && code[j + 1] === '{') {
        // Skip the substitution (balanced braces).
        let depth = 1
        j += 2
        while (j < code.length && depth) {
          const skipped = skipLiteral(code, j)
          if (skipped !== -1) {
            j = skipped
            continue
          }
          if (code[j] === '{') depth++
          else if (code[j] === '}') depth--
          j++
        }
        continue
      }
      j++
    }
    return j + 1
  }
  return -1
}

/**
 * Split `text` at top-level occurrences of `separator` (a character), outside
 * brackets, strings and comments. `end`: stop at the first unmatched closing
 * bracket (returns its index as `stop`).
 */
function splitTopLevel(text, separator, start = 0) {
  const parts = []
  let depth = 0
  let from = start
  let i = start
  for (; i < text.length; i++) {
    const skipped = skipLiteral(text, i)
    if (skipped !== -1) {
      i = skipped - 1
      continue
    }
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && ch === separator) {
      parts.push(text.slice(from, i))
      from = i + 1
    } else if (depth === 0 && separator === ',' && ch === ';') break
  }
  parts.push(text.slice(from, i))
  return { parts, stop: i }
}

function stringValue(expr) {
  const match = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(expr) ?? /^`((?:\\.|[^`\\$]|\$(?!\{))*)`$/s.exec(expr)
  if (!match) return null
  const raw = match.length === 3 ? match[2] : match[1]
  return raw.replace(/\\(.)/g, '$1')
}

function stripParens(expr) {
  let value = expr.trim()
  while (value.startsWith('(') && value.endsWith(')') && splitTopLevel(value, '\0', 1).stop === value.length - 1) value = value.slice(1, -1).trim()
  return value
}

const META_FILE = /^(?:__filename|import\.meta\.filename|fileURLToPath\(\s*import\.meta\.url\s*\)|(?:url\.)?fileURLToPath\(\s*import\.meta\.url\s*\)|import\.meta\.url|new\s+URL\(\s*import\.meta\.url\s*\))$/
const META_DIR = /^(?:__dirname|import\.meta\.dirname|(?:path\.)?dirname\(\s*(?:__filename|import\.meta\.filename|(?:url\.)?fileURLToPath\(\s*import\.meta\.url\s*\))\s*\))$/
const PATH_CALL = /^(?:(?:path|nodePath|pathModule)(?:\.posix|\.win32)?\.)?(join|resolve)\(([\s\S]*)\)$/

/**
 * The value of a path expression in `file`, as far as it can be known
 * statically: string literals, `__dirname` / `__filename` and their ES
 * module forms, `path.join` / `path.resolve`, `+` and template literals,
 * `new URL('…', import.meta.url)`, `require.resolve('…')`, and a `const`
 * holding one of those. Returns a string or null.
 */
function staticPath(expr, scope, depth = 0) {
  if (depth > 4) return null
  const value = stripParens(expr)
  const literal = stringValue(value)
  if (literal !== null) return literal
  if (META_FILE.test(value)) return scope.file
  if (META_DIR.test(value)) return path.dirname(scope.file)
  if (value === 'process.cwd()') return scope.root
  let match = /^new\s+URL\(\s*([\s\S]+?)\s*,\s*import\.meta\.url\s*\)$/.exec(value)
  if (match) {
    const relative = staticPath(match[1], scope, depth + 1)
    return relative === null ? null : path.resolve(path.dirname(scope.file), relative.replace(/^file:\/\//, ''))
  }
  match = /^require\.resolve\(\s*([\s\S]+?)\s*\)$/.exec(value)
  if (match) {
    const request = staticPath(match[1], scope, depth + 1)
    return request === null || !request.startsWith('.') ? null : path.resolve(path.dirname(scope.file), request)
  }
  match = PATH_CALL.exec(value)
  if (match) {
    const args = splitTopLevel(match[2], ',').parts.map((part) => part.trim()).filter(Boolean)
    const segments = args.map((arg) => staticPath(arg, scope, depth + 1))
    if (!segments.length || segments.includes(null)) return null
    return match[1] === 'join' ? path.join(...segments) : path.resolve(scope.root, ...segments)
  }
  const template = /^`([\s\S]*)`$/.exec(value)
  if (template) {
    let out = ''
    let rest = template[1]
    while (rest.length) {
      const at = rest.indexOf('${')
      if (at === -1) {
        out += rest
        break
      }
      out += rest.slice(0, at)
      const { stop } = splitTopLevel(rest, '\0', at + 2)
      const inner = staticPath(rest.slice(at + 2, stop), scope, depth + 1)
      if (inner === null) return null
      out += inner
      rest = rest.slice(stop + 1)
    }
    return out
  }
  const sum = splitTopLevel(value, '+').parts
  if (sum.length > 1) {
    let out = ''
    for (const part of sum) {
      const piece = staticPath(part, scope, depth + 1)
      if (piece === null) return null
      out += piece
    }
    return out
  }
  if (IDENTIFIER.test(value)) {
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${value.replace(/\$/g, '\\$')}\\s*=`).exec(scope.code)
    if (!declaration) return null
    // The initializer runs to a top-level `,` or `;`, or (without semicolons) to the end of a line:
    // take the longest run of its first lines that is a path expression.
    const lines = splitTopLevel(scope.code, ',', declaration.index + declaration[0].length).parts[0].split('\n').slice(0, 6)
    for (let n = lines.length; n > 0; n--) {
      const found = staticPath(lines.slice(0, n).join('\n'), scope, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * The project file for a worker script path (absolute, or relative to the
 * project as Node's are to the working directory), trying the other
 * JavaScript / TypeScript extensions (`worker.js` → `worker.ts`), or null.
 */
function resolveWorkerScript(requested, root) {
  const absolute = path.resolve(root, requested)
  const relative = path.relative(root, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const toProject = (file) => '/' + path.relative(root, file).split(path.sep).join('/')
  const isFile = (file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }
  const ext = path.extname(absolute)
  const base = JS_EXTENSIONS.includes(ext) ? absolute.slice(0, -ext.length) : absolute
  const candidates = isFile(absolute) ? [absolute] : JS_EXTENSIONS.map((e) => base + e).filter(isFile)
  if (!candidates.length || !JS_EXTENSIONS.includes(path.extname(candidates[0]))) return null
  return { path: toProject(candidates[0]), file: candidates[0], requested: toProject(absolute) }
}

/** The worker scripts `new Worker(...)` calls of one source file start, into `result.workers`. */
function collectWorkers(code, file, root, result) {
  if (!mentionsWorkerThreads(code)) return
  result.workerThreads = true
  for (const found of workerScripts(code, file, root)) result.workers.push(found)
}

/** `[{ path, file, requested }]` for the `new Worker(<static path>)` calls in `code`. */
function workerScripts(code, file, root) {
  const found = []
  const names = [...workerNames(code)].map((n) => n.replace(/\$/g, '\\$')).join('|')
  const call = new RegExp(`\\bnew\\s+(?:[A-Za-z_$][\\w$]*\\.)*(?:${names})\\s*\\(`, 'g')
  const scope = { code, file, root }
  for (const match of code.matchAll(call)) {
    const { parts } = splitTopLevel(code, ',', match.index + match[0].length)
    const requested = staticPath(parts[0], scope)
    if (requested === null) continue
    const script = resolveWorkerScript(requested.replace(/^file:\/\//, ''), root)
    if (script) found.push(script)
  }
  return found
}

/**
 * Worker threads for the bundler plugins: null when the app does not use
 * them, else `{ entries: [{ path, file }], aliases }` (project path →
 * script; requested path → found path, `/src/w.js` → `/src/w.ts`).
 * `option`: the plugins' `workers` option: false (none), true (build the
 * worker runtime even if no source imports worker_threads), or extra
 * project-relative scripts (those started from dependencies or with
 * computed paths).
 */
function workerThreads(root, option, scan) {
  if (option === false) return null
  const result = sourceScan(root, scan)
  const entries = new Map()
  const aliases = {}
  const add = (script) => {
    entries.set(script.path, script.file)
    if (script.requested !== script.path) aliases[script.requested] = script.path
  }
  for (const script of result.workers ?? []) add(script)
  for (const extra of Array.isArray(option) ? option : []) {
    const script = resolveWorkerScript(String(extra), root)
    if (script) add(script)
    else console.warn(`[tauri-electron] workers: ${extra} is not a script in the project`)
  }
  if (!entries.size && !result.workerThreads && option !== true && !Array.isArray(option)) return null
  return { entries: [...entries].map(([p, f]) => ({ path: p, file: f })), aliases }
}

/** bundler/worker-entries.js for a build: each script as a lazy chunk of the worker bundle. */
function workerEntriesSource(entries) {
  const lines = entries.map(({ path: p, file }) => `  ${JSON.stringify(p)}: () => import(${JSON.stringify(file.split(path.sep).join('/'))}),`)
  return `const entries = {\n${lines.join('\n')}\n}\nexport default function loadEntry(path) {\n  const load = entries[path]\n  return load ? load() : undefined\n}\n`
}

/**
 * `new Worker(new URL('./w.js', import.meta.url))` in a file using
 * worker_threads → `new Worker(new URL("file:///src/w.js"))`: a project
 * path the worker runtime looks up, instead of a URL the bundler would turn
 * into a plain Web Worker or asset.
 */
function rewriteWorkerUrls(code, file, root) {
  if (!mentionsWorkerThreads(code)) return code
  const names = [...workerNames(code)].map((n) => n.replace(/\$/g, '\\$')).join('|')
  const constructor = `\\bnew\\s+(?:[A-Za-z_$][\\w$]*\\.)*(?:${names})\\s*\\(\\s*`
  const projectPath = (relative) => {
    const rel = path.relative(root, path.resolve(path.dirname(file), relative))
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : '/' + rel.split(path.sep).join('/')
  }
  const url = new RegExp(`(${constructor})new\\s+URL\\(\\s*(['"\`])([^'"\`$]+)\\2\\s*,\\s*import\\.meta\\.url\\s*\\)`, 'g')
  // require.resolve('./w') is resolved by the bundler's require() (the path relative to the project).
  const resolve = new RegExp(`(${constructor})require\\.resolve\\(\\s*(['"])(\\.{1,2}/[^'"]+)\\2\\s*\\)`, 'g')
  return code
    .replace(url, (match, head, _quote, relative) => {
      const target = projectPath(relative)
      return target ? `${head}new URL(${JSON.stringify('file://' + target)})` : match
    })
    .replace(resolve, (match, head, _quote, relative) => {
      const target = projectPath(relative)
      return target ? `${head}${JSON.stringify(target)}` : match
    })
}

module.exports = {
  scanSources,
  lazySourceScan,
  NODE_BUILTINS,
  NODE_SHIMS,
  PACKAGE_SHIMS,
  NATIVE_MODULE_SHIMS,
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
  SCHEMES_FILE,
  schemesInSource,
  collectSchemes,
  writeSchemes,
  workerThreads,
  workerScripts,
  workerEntriesSource,
  rewriteWorkerUrls,
  mentionsWorkerThreads,
}
