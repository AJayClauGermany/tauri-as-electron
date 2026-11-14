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

/**
 * Built-ins tauri-electron implements, registered on the main page only
 * (./node/index.js), with the Cargo feature the native ones need.
 */
const MAIN_ONLY = {
  fs: 'node-fs',
  'fs/promises': 'node-fs',
  'original-fs': 'node-fs',
  os: 'node-os',
  child_process: 'node-child-process',
  buffer: null,
  util: null,
  'util/types': null,
  sys: null,
  stream: null,
  'stream/promises': null,
  string_decoder: null,
  crypto: null,
  http: null,
  https: null,
  assert: null,
  'assert/strict': null,
  querystring: null,
  punycode: null,
  timers: null,
  'timers/promises': null,
  perf_hooks: null,
  'stream/web': null,
  'stream/consumers': null,
  zlib: null,
  constants: null,
  console: null,
  module: null,
  readline: null,
  'readline/promises': null,
  async_hooks: null,
  diagnostics_channel: null,
  tty: null,
  domain: null,
}

/** Node built-ins that cannot exist in a webview, with the nearest replacement. */
export const NODE_BUILTINS = {
  ...Object.fromEntries(Object.keys(MAIN_ONLY).map((name) => [name, null])),
  net: '@tauri-apps/plugin-http or a Rust command',
  worker_threads: 'Web Workers',
  v8: 'nothing',
  vm: 'nothing',
  dns: '@tauri-apps/plugin-http or a Rust command',
  dgram: 'a Rust command',
  tls: 'net.fetch / https, or a Rust command',
  http2: 'net.fetch / https, or a Rust command',
  cluster: 'nothing (there is one webview process)',
}

function unavailable(api, name, replacement) {
  if (name in MAIN_ONLY) {
    const feature = MAIN_ONLY[name] ? ` (tauri-plugin-electron's "${MAIN_ONLY[name]}" feature)` : ''
    return new NotImplementedError(api, {
      reason: 'unsupported',
      hint: `Node ${name} is available in the main process only${feature}: reach it from renderer windows over ipcMain.handle, as with a sandboxed Electron renderer.`,
    })
  }
  return new NotImplementedError(api, {
    reason: 'unsupported',
    hint: `Node.js built-ins are not available: Electron's main process is a webview here. Use ${replacement}.`,
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
    throw unavailable(api, name, replacement)
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
    hint: `tauri-electron provides require() only for electron and the Node built-ins it shims (path, process, events, url, and in the main process ${Object.keys(MAIN_ONLY).join(', ')}). Use import for other modules (Vite bundles them).`,
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
