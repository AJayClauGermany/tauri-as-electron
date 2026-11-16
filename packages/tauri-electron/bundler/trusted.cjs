/**
 * The renderer script for trusted origins, shared by the Vite and the
 * webpack / rspack plugins.
 *
 * Pages of a trusted origin (`tauri.conf.json` > `plugins.electron.trustedOrigins`,
 * typically a server the app starts on loopback) are not the bundler's HTML,
 * so the renderer bootstrap and the preloads cannot be put in them. The
 * plugins build the same modules a renderer page starts with (`require()`,
 * the bootstrap, the Node layer, the session and app preloads) into one
 * classic script, emitted at `TRUSTED_FILE`. The main process fetches it
 * (`__TAURI_ELECTRON_APP__.trustedRenderer`) and hands it to
 * tauri-plugin-electron, which runs it as an initialization script in pages
 * of the trusted origins only.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Where the script is emitted, under the output root, and served in development. */
const TRUSTED_FILE = '__tauri-electron/trusted-renderer.js'
/** Where the main process fetches it (the app is served at the root of its origin). */
const TRUSTED_URL = `/${TRUSTED_FILE}`

/** Tauri configuration files that may declare `plugins.electron.trustedOrigins`. */
const CONFIG_FILES = ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml'].flatMap((name) => [
  name,
  ...['linux', 'windows', 'macos'].map((platform) => (name === 'Tauri.toml' ? `Tauri.${platform}.toml` : name.replace('.conf.', `.${platform}.conf.`))),
])

/** Whether the app's Tauri configuration (in `src-tauri/`) declares trusted origins. */
function declaresTrustedOrigins(root) {
  for (const name of CONFIG_FILES) {
    let text
    try {
      text = fs.readFileSync(path.join(root, 'src-tauri', name), 'utf8')
    } catch {
      continue
    }
    if (name.endsWith('.json')) {
      try {
        const list = JSON.parse(text)?.plugins?.electron?.trustedOrigins
        if (Array.isArray(list) && list.length) return true
        continue
      } catch {
        /* not plain JSON: look at the text */
      }
    }
    if (/\btrustedOrigins\b/.test(text)) return true
  }
  return false
}

/**
 * Whether to build the trusted-origins renderer script. `option` is the
 * plugins' `trustedOrigins` option: true, false, or `'auto'` (default):
 * when the Tauri configuration declares trusted origins.
 */
function wantsTrustedRenderer(root, option = 'auto') {
  if (option === true || option === false) return option
  return declaresTrustedOrigins(root)
}

/** The preloads of the script: the plugins' `trustedPreload` option, else `fallback` (their `preload`). */
function trustedPreloads(option, fallback) {
  if (option === false) return []
  const list = [option ?? fallback].flat().filter(Boolean)
  return list.filter((preload) => typeof preload === 'string')
}

const CHILD_NAME = 'tauri-electron-trusted-renderer'

/**
 * webpack / rspack: build `imports` (absolute module paths, in order) into
 * one classic script at `TRUSTED_FILE`, in a child compilation of every
 * build. The child shares the build's loaders, resolution, module
 * replacements and definitions, but not its code splitting or runtime chunk
 * (one self-contained file), its hot module replacement or eval source maps
 * (an initialization script runs under the page's Content-Security-Policy).
 * `plugins()`: more plugins for the child (those it does not inherit).
 */
function addWebpackTrustedRenderer(compiler, bundler, imports, plugins = () => []) {
  compiler.hooks.make.tapAsync(CHILD_NAME, (compilation, callback) => {
    const child = compilation.createChildCompiler(
      CHILD_NAME,
      {
        filename: TRUSTED_FILE,
        chunkFilename: '__tauri-electron/trusted-[id].js',
        iife: true,
        module: false,
        library: undefined,
      },
      [
        ...imports.map((request) => new bundler.EntryPlugin(compiler.context, request, { name: CHILD_NAME })),
        new bundler.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
        ...plugins(),
      ],
    )
    for (const hook of [child.hooks.compilation, child.hooks.thisCompilation]) {
      if (Array.isArray(hook?.taps)) hook.taps = hook.taps.filter((tap) => !/^Eval.*DevTool|HotModuleReplacement/.test(tap.name))
    }
    child.runAsChild((error) => callback(error))
  })
}

module.exports = { TRUSTED_FILE, TRUSTED_URL, declaresTrustedOrigins, wantsTrustedRenderer, trustedPreloads, addWebpackTrustedRenderer }
