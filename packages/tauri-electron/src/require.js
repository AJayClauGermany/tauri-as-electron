/**
 * `require()` for CommonJS Electron code.
 *
 * Most Electron main-process and preload scripts are written as
 * `const { app, BrowserWindow } = require('electron')`. Vite leaves those
 * calls alone (it only follows `import`), so the Vite plugin loads this
 * module first on every page: it installs a global `require` that serves the
 * modules a webview can provide and explains the ones it cannot.
 *
 * The main-process page also gets `module` / `exports`, so a main script
 * ending in `module.exports = …` does not throw.
 */
import * as electron from './index.js'
import * as nodePath from './path.js'
import * as nodeEvents from './events.js'
import * as nodeUrl from './url.js'
import processShim from './process.js'
import { NotImplementedError } from './internal/runtime.js'

const ELECTRON_IDS = new Set(['electron', 'electron/main', 'electron/renderer', 'electron/common'])

/** Built-ins tauri-electron implements for the main process only (registered by ./node/index.js). */
const MAIN_ONLY_FS = 'main-process-only'

/** Node built-ins that cannot exist in a webview, with the nearest replacement. */
export const NODE_BUILTINS = {
  fs: MAIN_ONLY_FS,
  'fs/promises': MAIN_ONLY_FS,
  'original-fs': MAIN_ONLY_FS,
  child_process: '@tauri-apps/plugin-shell (sidecars) or a Rust command',
  os: '@tauri-apps/plugin-os',
  crypto: 'the Web Crypto API (globalThis.crypto)',
  http: 'net.fetch / net.request from electron, or the fetch API',
  https: 'net.fetch / net.request from electron, or the fetch API',
  net: '@tauri-apps/plugin-http or a Rust command',
  util: 'plain JavaScript',
  stream: 'Web Streams (ReadableStream)',
  buffer: 'Uint8Array / TextEncoder, or Buffer in the main process',
  worker_threads: 'Web Workers',
  readline: 'nothing (no terminal in a webview)',
  module: 'nothing',
  assert: 'plain JavaScript',
  zlib: 'CompressionStream',
  tty: 'nothing',
  v8: 'nothing',
  vm: 'nothing',
  perf_hooks: 'globalThis.performance',
  timers: 'globalThis.setTimeout & co.',
  'timers/promises': 'a Promise around setTimeout',
  querystring: 'URLSearchParams',
  string_decoder: 'TextDecoder',
  dns: '@tauri-apps/plugin-http or a Rust command',
  dgram: 'a Rust command',
  cluster: 'nothing',
}

function unavailable(api, replacement) {
  return new NotImplementedError(api, {
    reason: 'unsupported',
    hint:
      replacement === MAIN_ONLY_FS
        ? 'Node fs is available in the main process only (tauri-plugin-electron\'s "node-fs" feature): reach it from renderer windows over ipcMain.handle, as with a sandboxed Electron renderer.'
        : `Node.js built-ins are not available: Electron's main process is a webview here. Use ${replacement}.`,
  })
}

/**
 * What `require('fs')` / `import fs from 'fs'` evaluate to: an object whose
 * members throw the explanation when *called*, so loading a module that
 * imports `fs` succeeds and the error appears where the Node API is used.
 * (Production builds turn `require()` into imports, so throwing at the
 * `require()` call would behave differently in dev and in a build.)
 */
export function nodeBuiltin(name) {
  const replacement = NODE_BUILTINS[name] ?? 'a Tauri plugin or a Rust command'
  const fail = (api) => {
    throw unavailable(api, replacement)
  }
  const target = function nodeBuiltinStub() {}
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop in t || prop === 'then' || prop === '__esModule') return t[prop]
      if (prop === 'default') return proxy
      return function unavailableMember() {
        fail(`${name}.${String(prop)}`)
      }
    },
    apply: () => fail(`${name}()`),
    construct: () => fail(`new ${name}()`),
  })
  return proxy
}

/**
 * Node built-ins implemented by tauri-electron that are too large to load in
 * every page: the main page registers them (./node/index.js), and require()
 * serves them from here.
 */
const registered = new Map()

export function registerNodeModule(name, exports) {
  registered.set(name, exports)
}

export function requireShim(id) {
  const name = String(id)
  if (ELECTRON_IDS.has(name)) return electron
  const bare = name.replace(/^node:/, '')
  if (registered.has(bare)) return registered.get(bare)
  if (bare === 'path' || bare === 'path/posix') return nodePath
  if (bare === 'path/win32') return nodePath.win32
  if (bare === 'process') return processShim
  if (bare === 'events') return nodeEvents.default
  if (bare === 'url') return nodeUrl
  if (bare in NODE_BUILTINS) return nodeBuiltin(bare)
  throw new NotImplementedError(`require('${name}')`, {
    reason: 'unsupported',
    hint: 'tauri-electron provides require() only for electron and the Node built-ins it shims (path, process, events, url, and in the main process fs, fs/promises and buffer). Use import for other modules (Vite bundles them).',
  })
}

requireShim.resolve = (id) => String(id)
requireShim.cache = {}
requireShim.main = undefined

/**
 * Install `require` unless a bundler already did. With `moduleGlobals`, also
 * `module` and `exports`, so a main script ending in `module.exports = …`
 * does not throw. Only the main-process page gets those: in renderer pages a
 * global `module` would make UMD bundles (jQuery, …) skip `window.X`.
 */
export function installRequire({ moduleGlobals = false } = {}) {
  const g = globalThis
  if (typeof g.require !== 'function') g.require = requireShim
  if (moduleGlobals && typeof g.module === 'undefined') {
    const module = { exports: {}, id: '.', filename: '', loaded: false, children: [], paths: [] }
    g.module = module
    g.exports = module.exports
  }
  return g.require
}

installRequire()

export default requireShim
