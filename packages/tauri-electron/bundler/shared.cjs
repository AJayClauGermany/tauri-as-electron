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
  'assert', 'async_hooks', 'cluster', 'constants', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'http2', 'inspector', 'module', 'net', 'perf_hooks', 'punycode', 'querystring', 'readline',
  'repl', 'stream/web', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib',
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
function appFilesConfig(root, { dev }) {
  let entries = []
  try {
    entries = fs.readdirSync(root).filter((name) => !name.startsWith('.') && name !== 'src-tauri' && !SYSTEM_ROOTS.has(name))
  } catch {
    /* no project folder: nothing is app-relative */
  }
  return { root: dev ? root : null, entries }
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
  LOG_ENDPOINT,
  STAGING_DIR,
  rewritePathGlobals,
  mentionsPathGlobals,
  appFilesConfig,
  stageAppFiles,
}
