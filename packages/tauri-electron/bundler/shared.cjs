/**
 * What the Vite and webpack/rspack plugins share: which Node built-ins are
 * shimmed or stubbed, and the `__dirname` / `import.meta.dirname` rewrite.
 * CommonJS so the webpack plugin (often loaded from a CommonJS config) can
 * require it on every Node version; vite.js imports it as ES module.
 */
'use strict'

/** Node built-ins that a webview cannot provide: `import fs from 'fs'` must not be a build error. */
const NODE_BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'fs', 'fs/promises', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'perf_hooks', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers',
  'timers/promises', 'tls', 'trace_events', 'tty', 'util', 'util/types', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib',
]

/** Node built-ins tauri-electron implements (aliased, like `electron` itself). */
const NODE_SHIMS = {
  path: 'tauri-electron/path',
  'path/posix': 'tauri-electron/path',
  process: 'tauri-electron/process',
  events: 'tauri-electron/events',
  url: 'tauri-electron/url',
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

module.exports = { NODE_BUILTINS, NODE_SHIMS, LOG_ENDPOINT, rewritePathGlobals, mentionsPathGlobals }
