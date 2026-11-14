/**
 * Node's `module`, partly: `createRequire` (tauri-electron's `require()`,
 * which serves electron and the Node built-ins), `builtinModules`,
 * `isBuiltin`, and the `Module` constructor itself. There is no file
 * system module loader: code is bundled.
 */
import { requireShim } from '../require.js'

export const builtinModules = [
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream',
  'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls',
  'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]

export function isBuiltin(name) {
  const bare = String(name).replace(/^node:/, '')
  return builtinModules.includes(bare)
}

/** `module.createRequire(filename)`: a require() for bundled code (the path is not used). */
export function createRequire(filename) {
  const require = (id) => requireShim(id)
  require.resolve = (id) => requireShim.resolve(id)
  require.resolve.paths = () => null
  require.cache = requireShim.cache
  require.main = undefined
  require.filename = String(filename)
  return require
}

export function Module(id = '', parent) {
  this.id = id
  this.path = '.'
  this.exports = {}
  this.filename = null
  this.loaded = false
  this.children = []
  this.paths = []
  this.parent = parent
}

Module.prototype.require = function require(id) {
  return requireShim(id)
}

Module.builtinModules = builtinModules
Module.isBuiltin = isBuiltin
Module.createRequire = createRequire
Module.Module = Module
Module.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});']
Module.wrap = (script) => Module.wrapper[0] + script + Module.wrapper[1]
Module.syncBuiltinESMExports = () => {}
Module.findSourceMap = () => undefined
Module._cache = requireShim.cache
Module._extensions = {}
Module.globalPaths = []

export const { wrap, wrapper, syncBuiltinESMExports, findSourceMap } = Module

export default Module
