/**
 * Vite plugin that makes an Electron-style project run on tauri-electron.
 *
 *   import tauriElectron from 'tauri-electron/vite'
 *   export default defineConfig({ plugins: [tauriElectron({ preload: 'src/preload.js' })] })
 *
 * It
 *  - aliases `electron` (and `electron/main|renderer|common`) to tauri-electron,
 *    and `@electron/remote` (`/main`, `/renderer`) to its remote-module shim,
 *    `keytar`, `better-sqlite3`, `sqlite3` and `node-pty` to versions on
 *    tauri-plugin-electron's `keytar` / `sqlite` / `pty` features,
 *    and `path` / `node:path` to a browser-safe implementation,
 *  - aliases the Node built-ins it implements (`path`, `process`, `events`,
 *    `url`, `buffer`, `util`, `stream`, `crypto`, `http`, `zlib`, …, and `fs`,
 *    `os`, `child_process`, `net`, `dns`, `dgram`, `tls` backed by
 *    tauri-plugin-electron's `node-*` features) and turns the others (`vm`,
 *    `worker_threads`, …) into a clear runtime error instead of a build error,
 *  - tells `fs` where the app's own files are and, in a build, stages them
 *    in `src-tauri/electron-resources/app/` (Electron's `resources/app`
 *    layout) when that folder exists, so
 *    `fs.readFileSync(path.join(__dirname, 'data.json'))` works in both,
 *  - provides `require('electron')`, `require('path')` and friends for
 *    CommonJS main / preload scripts (`tauri-electron/require`), and the
 *    `Buffer` global in the main process,
 *  - rewrites `__dirname`, `__filename`, `import.meta.dirname`,
 *    `import.meta.filename` and `fileURLToPath(import.meta.url)` in your
 *    source to project-relative paths, so
 *    `win.loadFile(path.join(__dirname, 'index.html'))` keeps working,
 *  - loads the renderer bootstrap and your preload script at the top of
 *    every HTML page except the main-process page (`electron-main.html`), as
 *    an external module script so pages with a `script-src 'self'` CSP work,
 *  - gives classic `<script src="renderer.js">` tags `type="module"` so Vite
 *    bundles them (Electron pages rarely use module scripts),
 *  - makes `process.env` read the real environment (the main process gets it
 *    from tauri-plugin-electron) instead of Vite's empty object,
 *  - adds every root-level *.html file to the build inputs,
 *  - when the app trusts origins it does not serve (tauri.conf.json
 *    `plugins.electron.trustedOrigins`, e.g. a server it starts on loopback),
 *    builds the same renderer modules into one classic script that
 *    tauri-plugin-electron runs in those pages (`__tauri-electron/trusted-renderer.js`),
 *  - writes the custom schemes the app passes to `protocol.handle()` (and
 *    `registerSchemesAsPrivileged`) to `src-tauri/electron-schemes.json`,
 *    where `tauri_plugin_electron::bundled_schemes!()` reads them at build time,
 *  - bundles the modules the app starts with `utilityProcess.fork()` /
 *    `child_process.fork()` for Node.js (bundler/fork.cjs), with the child
 *    bootstrap, into `node_modules/.tauri-electron/fork` (dev, rebuilt on
 *    change) or `src-tauri/electron-resources/fork` (build),
 *  - in dev, forwards the hidden main window's console to the terminal (the
 *    window has no visible devtools; Electron devs expect main logs there),
 *  - bundles `worker_threads` worker scripts (those it finds in
 *    `new Worker(...)` calls and its `workers` option) into a Web Worker
 *    that loads the Node layer first (bundler/worker-entry.js).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import shared from './bundler/shared.cjs'
import forkShared from './bundler/fork.cjs'
import { buildForks } from './bundler/fork-vite.js'
import trusted from './bundler/trusted.cjs'
import { buildTrustedRenderer } from './bundler/trusted-vite.js'

// Shared with the webpack / rspack plugin (webpack.cjs).
const { TRUSTED_FILE, TRUSTED_URL, wantsTrustedRenderer, trustedPreloads } = trusted
const { LOG_ENDPOINT, NODE_BUILTINS, NODE_SHIMS, PACKAGE_SHIMS, rewritePathGlobals, mentionsPathGlobals, rewriteBuiltinRequires, mentionsRequire, appFilesConfig, stageAppFiles, sessionPreloads, writeSchemes, rendererNode, lazySourceScan, workerThreads, workerEntriesSource, rewriteWorkerUrls, mentionsWorkerThreads } = shared
export { NODE_BUILTINS, NODE_SHIMS, rewritePathGlobals, rewriteBuiltinRequires }

// Runs first in electron-main.html during dev. Kept dependency-free so it
// also reports errors thrown while the rest of the module graph loads.
const CONSOLE_FORWARDER = `
const send = (level, args) => {
  const text = args.map((a) => {
    if (a instanceof Error) return a.stack || String(a)
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ')
  fetch(${JSON.stringify(LOG_ENDPOINT)}, { method: 'POST', body: JSON.stringify({ level, text }) }).catch(() => {})
}
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console)
  console[level] = (...args) => { original(...args); send(level, args) }
}
addEventListener('error', (e) => send('error', [e.error || e.message]))
addEventListener('unhandledrejection', (e) => send('error', ['Unhandled rejection:', e.reason]))
`

/**
 * Virtual entry modules injected into pages. Virtual (rather than inline)
 * so that the page's own Content-Security-Policy (`script-src 'self'`, as in
 * electron-quick-start) does not block them, and so that their imports go
 * through Vite like everything else.
 */
const VIRTUAL = {
  console: 'virtual:tauri-electron/console', // dev only: main window console → terminal
  main: 'virtual:tauri-electron/main', // Node built-ins, app files and require() for the main process
  renderer: 'virtual:tauri-electron/renderer', // require(), bootstrap, preload(s)
  rendererNode: 'virtual:tauri-electron/renderer-node', // Node built-ins for nodeIntegration windows
  workers: 'virtual:tauri-electron/workers', // where worker_threads workers come from (bundler/worker-entry.js)
  trusted: 'virtual:tauri-electron/trusted-renderer', // the renderer modules for pages of trusted origins
}
const RESOLVED = '\0'

const NODE_BUILTIN_PREFIX = '\0tauri-electron:node:'

const SOURCE_FILE = /\.(m?[jt]sx?|cjs|cts)$/

// The worker_threads worker bundle and the module listing its scripts (see bundler/worker-entry.js).
const BUNDLER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundler')
const WORKER_ENTRY = path.join(BUNDLER_DIR, 'worker-entry.js')
const WORKER_ENTRIES = path.join(BUNDLER_DIR, 'worker-entries.js')

/** bundler/worker-entries.js in dev: the dev server serves every project file, so import it by URL. */
const DEV_WORKER_ENTRIES = `export default function loadEntry(path) {
  return import(/* @vite-ignore */ new URL(path, self.location.origin).href)
}
`

/**
 * Electron renderer pages load their scripts with plain `<script src>`; Vite
 * only bundles module scripts. Give classic external scripts `type="module"`
 * (inline classic scripts, `nomodule`, JSON and import maps are left alone).
 */
const CLASSIC_SCRIPT = /<script\b([^>]*)>/gi
const CLASSIC_TYPES = /^(?:text|application)\/(?:java|ecma)script$/i

export function moduleScripts(html) {
  return html.replace(CLASSIC_SCRIPT, (match, attrs) => {
    if (!/\bsrc\s*=/i.test(attrs) || /\bnomodule\b/i.test(attrs)) return match
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    if (!type) return `<script type="module"${attrs}>`
    const value = (type[1] ?? type[2] ?? type[3]).trim()
    if (!value || CLASSIC_TYPES.test(value)) return `<script${attrs.replace(type[0], 'type="module"')}>`
    return match
  })
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** The module id a page's injected `<script src>` points at, in dev and in build. */
function virtualSrc(id, isDev) {
  // Dev: Vite serves ids that are not paths under /@id/ (null byte escaped).
  return isDev ? `/@id/__x00__${id}` : id
}

/**
 * @param {object} [options]
 * @param {string|string[]|false} [options.preload] Preload script(s), relative to the Vite root.
 * @param {string} [options.mainHtml='electron-main.html'] Page that runs the Electron main-process code.
 * @param {boolean} [options.aliasPath=true] Alias `path`/`node:path` to tauri-electron/path.
 * @param {boolean} [options.require=true] Provide a global `require()` for CommonJS Electron code.
 * @param {boolean} [options.moduleScripts=true] Give classic `<script src>` tags `type="module"`.
 * @param {boolean} [options.forwardMainConsole=true] Print the main window's console in the terminal during dev.
 * @param {false|string[]} [options.sessionPreloads] Preloads that libraries register at runtime
 *   (`session.registerPreloadScript` / `setPreloads`), put in every renderer page. Those of
 *   electron-log and @sentry/electron are found when the app depends on them; list module
 *   specifiers or project-relative files for others, or `false` for none.
 * @param {false|string[]} [options.schemes] Custom schemes to register in Tauri besides the ones
 *   found in the app's source (`protocol.handle('x', …)`, `protocol.registerSchemesAsPrivileged`)
 *   and those of known libraries; written to src-tauri/electron-schemes.json for
 *   `tauri_plugin_electron::bundled_schemes!()`. `false`: write nothing.
 * @param {boolean|'auto'} [options.rendererNode='auto'] Load the Node layer in renderer pages, for
 *   windows created with `nodeIntegration: true` or `sandbox: false` (installed only in those).
 *   `'auto'`: when the app depends on Electron < 20 or its sources mention either option.
 * @param {boolean|string[]} [options.workers] worker_threads scripts to bundle besides those found
 *   in `new Worker(...)` calls of the app's sources (project-relative paths); `true` builds the worker
 *   runtime even when no source imports worker_threads (`eval: true` workers of dependencies);
 *   `false`: no worker threads.
 * @param {false|string[]} [options.fork] Modules started with `utilityProcess.fork()` /
 *   `child_process.fork()` that the source scan cannot find (project-relative files), or
 *   `false` to build none. Found: `fork(path.join(__dirname, 'worker.js'))` and similar static paths.
 * @param {boolean|'auto'} [options.trustedOrigins='auto'] Build the renderer script that
 *   tauri-plugin-electron runs in pages of the trusted origins (`plugins.electron.trustedOrigins`
 *   in src-tauri/tauri.conf.json): `require()`, the bootstrap and the preloads as one classic
 *   script. `'auto'`: when the Tauri configuration declares trusted origins.
 * @param {string|string[]|false} [options.trustedPreload] The preload(s) of pages of trusted
 *   origins, relative to the Vite root. Default: `preload`.
 * @param {false|string[]} [options.resources] App files `fs` can read in a build (staged in
 *   src-tauri/electron-resources/app/): `false` for none, or project-relative files and folders.
 *   Default: every project file except dependencies, src-tauri, build output, dot-files and
 *   the sources the bundler compiles.
 */
export default function tauriElectron(options = {}) {
  const mainHtml = options.mainHtml ?? 'electron-main.html'
  const preloads = [options.preload].flat().filter(Boolean)
  const withRequire = options.require !== false
  let root = process.cwd()
  let isDev = false
  let outDir = 'dist'
  let libraryPreloads = []
  let withRendererNode = false
  let workers = null // workerThreads(): { entries, aliases } when the app uses worker_threads
  let workerType = 'classic'
  let forkPlan = { entries: [], needed: false }
  let forkDir = null
  let forkWatcher = null
  // The trusted-origins renderer script: built here (`withTrusted`), or this
  // instance is the separate build of that script (`nested`).
  const nested = options.__trustedRenderer ?? null
  let withTrusted = false
  let resolvedConfig = null
  const trustedOptions = () => ({ plugin: tauriElectron, options: { ...options, rendererNode: withRendererNode }, entry: VIRTUAL.trusted, resolved: resolvedConfig, dev: isDev })

  /** The hooks worker bundles need (Vite builds them with their own plugin list). */
  function workerPlugin() {
    return { name: 'tauri-electron:worker', enforce: 'pre', resolveId: plugin.resolveId, load: plugin.load, transform: plugin.transform }
  }

  const plugin = {
    name: 'tauri-electron',
    enforce: 'pre',

    config(userConfig) {
      root = path.resolve(userConfig.root ?? process.cwd())
      const alias = [{ find: /^electron(\/(main|renderer|common))?$/, replacement: 'tauri-electron' }]
      // electron-builder's auto-update library, on tauri-plugin-updater.
      alias.push({ find: /^electron-updater$/, replacement: 'tauri-electron/electron-updater' })
      for (const [name, replacement] of Object.entries(PACKAGE_SHIMS)) alias.push({ find: new RegExp(`^${name.replace(/\//g, '\\/')}$`), replacement })
      for (const [name, replacement] of Object.entries(NODE_SHIMS)) {
        if (options.aliasPath === false && name.startsWith('path')) continue
        alias.push({ find: new RegExp(`^(node:)?${name}$`), replacement })
      }

      const config = {
        resolve: { alias },
        // Worker bundles run their own plugin pipeline: give them the hooks that resolve and load ours.
        worker: { plugins: () => [workerPlugin()] },
        // Vite replaces a bare `process.env` with `{}`; Electron code expects
        // the real environment (filled in by tauri-electron's process shim).
        define: userConfig.define?.['process.env'] ? {} : { 'process.env': '(globalThis.process?.env ?? {})' },
        clearScreen: false,
        envPrefix: ['VITE_', 'TAURI_ENV_'],
        server: { watch: { ignored: ['**/src-tauri/**'] } },
        build: {
          target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
          minify: !process.env.TAURI_ENV_DEBUG,
          // The trusted-origins script is one file: its map inline in development, none in a build.
          sourcemap: nested ? (nested.dev ? 'inline' : false) : Boolean(process.env.TAURI_ENV_DEBUG),
        },
      }

      const hasInput = userConfig.build?.rollupOptions?.input ?? userConfig.build?.rolldownOptions?.input
      if (!hasInput) {
        const input = Object.fromEntries(
          fs
            .readdirSync(root)
            .filter((file) => file.endsWith('.html'))
            .map((file) => [file.replace(/\.html$/, ''), path.join(root, file)]),
        )
        config.build.rollupOptions = { input }
      }
      return config
    },

    configResolved(resolved) {
      root = resolved.root
      libraryPreloads = sessionPreloads(root, options.sessionPreloads)
      // One walk over the project's sources for both the Node check and the schemes.
      const scan = lazySourceScan(root)
      withRendererNode = rendererNode(root, options.rendererNode, scan)
      isDev = resolved.command === 'serve'
      // Not in the trusted-origins script: its pages are not on the app's origin, which serves the worker bundle.
      workers = nested ? null : workerThreads(root, options.workers, scan)
      workerType = isDev || resolved.worker?.format === 'es' ? 'module' : 'classic'
      outDir = resolved.build?.outDir ?? 'dist'
      resolvedConfig = resolved
      if (nested) return
      withTrusted = wantsTrustedRenderer(root, options.trustedOrigins)
      // Custom schemes for tauri-plugin-electron, written before Cargo builds the app.
      const schemes = writeSchemes(root, options.schemes, scan)
      if (schemes?.length) resolved.logger?.info?.(`tauri-electron: custom schemes ${schemes.join(', ')} (src-tauri/electron-schemes.json)`)
      // Fork entry points, bundled for Node.
      forkPlan = forkShared.forkPlan(root, options.fork, scan)
      forkDir = forkPlan.needed ? forkShared.forkOutDir(root, isDev) : null
      if (forkPlan.needed && !forkDir) {
        resolved.logger?.warn?.('tauri-electron: the app forks Node.js children, but src-tauri/electron-resources/ (mapped in tauri.conf.json "bundle.resources") is missing, so their modules are not shipped')
      }
    },

    async buildStart() {
      if (isDev || nested) return
      const staged = stageAppFiles(root, { resources: options.resources, exclude: [outDir] })
      if (staged !== null) this.info?.(`staged ${staged} app file(s) for fs in src-tauri/electron-resources/app`)
      if (forkDir) {
        await buildForks({ root, plan: forkPlan, outDir: forkDir, dev: false })
        this.info?.(`built ${forkPlan.entries.length} fork entr${forkPlan.entries.length === 1 ? 'y' : 'ies'} for Node.js in ${path.relative(root, forkDir)}`)
      }
    },

    async configureServer(server) {
      // Fork entries are rebuilt on change; the first build is there before the app starts.
      if (forkDir && !forkWatcher) {
        forkWatcher = await buildForks({ root, plan: forkPlan, outDir: forkDir, dev: true, watch: true })
        server.httpServer?.once('close', () => forkWatcher?.close())
      }
      if (withTrusted) {
        // Built on request (the main process asks once it starts), again after a source change.
        let pending = null
        server.watcher?.on('change', (file) => {
          if (!file.includes('node_modules')) pending = null
        })
        server.middlewares.use(TRUSTED_URL, (req, res) => {
          pending ??= buildTrustedRenderer(trustedOptions())
          pending.then(
            (code) => {
              res.setHeader('Content-Type', 'text/javascript')
              res.setHeader('Cache-Control', 'no-store')
              res.end(code)
            },
            (error) => {
              pending = null
              server.config.logger.error(`tauri-electron: trusted-origins renderer script: ${error?.stack ?? error}`)
              res.statusCode = 500
              res.end(String(error?.message ?? error))
            },
          )
        })
      }
      if (options.forwardMainConsole === false) return
      const colors = { error: '\x1b[31m', warn: '\x1b[33m' }
      server.middlewares.use(LOG_ENDPOINT, (req, res) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          try {
            const { level, text } = JSON.parse(body)
            const color = colors[level] ?? ''
            console.log(`${color}[electron-main]${color ? '\x1b[0m' : ''} ${text}`)
          } catch {
            /* ignore malformed log lines */
          }
          res.statusCode = 204
          res.end()
        })
      })
    },

    resolveId(id) {
      if (Object.values(VIRTUAL).includes(id)) return RESOLVED + id
      // `import fs from 'fs'` in Electron code: resolve to a module that
      // explains the situation when used, rather than failing the build.
      const bare = id.replace(/^node:/, '')
      if (NODE_BUILTINS.includes(bare) || (options.aliasPath === false && /^path(\/(posix|win32))?$/.test(bare))) {
        return NODE_BUILTIN_PREFIX + bare
      }
      return null
    },

    load(id) {
      // The worker bundle's list of worker scripts (bundler/worker-entry.js imports it).
      if (toPosix(id.split('?')[0]) === toPosix(WORKER_ENTRIES)) return isDev ? DEV_WORKER_ENTRIES : workerEntriesSource(workers?.entries ?? [])
      if (id.startsWith(NODE_BUILTIN_PREFIX)) {
        const name = JSON.stringify(id.slice(NODE_BUILTIN_PREFIX.length))
        // Build: a CommonJS module, so `require('fs')`, `import fs from 'fs'`
        // and `import { readFileSync } from 'fs'` all reach the stub. Dev
        // serves native ES modules, where only the default import can be stubbed.
        return isDev
          ? `import { nodeBuiltin } from 'tauri-electron/require'\nexport default nodeBuiltin(${name})\n`
          : `module.exports = require('tauri-electron/require').nodeBuiltin(${name})\n`
      }
      if (!id.startsWith(RESOLVED)) return null
      const name = id.slice(RESOLVED.length)
      if (!Object.values(VIRTUAL).includes(name)) return null
      const lines = []
      if (name === VIRTUAL.console) lines.push(CONSOLE_FORWARDER)
      if (name === VIRTUAL.workers) {
        // Vite bundles bundler/worker-entry.js as a Web Worker and gives its URL.
        const entry = isDev ? `/@fs/${toPosix(WORKER_ENTRY).replace(/^\/+/, '')}` : toPosix(WORKER_ENTRY)
        const registry = { type: workerType, entries: isDev ? null : (workers?.entries ?? []).map((e) => e.path), aliases: workers?.aliases ?? {}, dev: isDev }
        lines.push(`import url from ${JSON.stringify(`${entry}?worker&url`)}`)
        lines.push(`const registry = ${JSON.stringify(registry)}`)
        lines.push(`if (!globalThis.__TAURI_ELECTRON_WORKERS__) globalThis.__TAURI_ELECTRON_WORKERS__ = { ...registry, url, create: (options) => new Worker(url, { ...options, type: registry.type }) }`)
      }
      if (name === VIRTUAL.main) {
        if (workers) lines.push(`import ${JSON.stringify(VIRTUAL.workers)}`)
        lines.push(`import 'tauri-electron/node'`)
        if (withRequire) lines.push(`import { installRequire } from 'tauri-electron/require'`, `installRequire({ moduleGlobals: true })`)
        const config = appFilesConfig(root, { dev: isDev, sessionPreloads: libraryPreloads })
        const fork = forkShared.forkManifest(forkPlan, { dev: isDev, outDir: forkDir })
        if (fork) config.fork = fork
        // Where the main process fetches the trusted-origins renderer script.
        if (withTrusted) config.trustedRenderer = TRUSTED_URL
        lines.push(`globalThis.__TAURI_ELECTRON_APP__ = ${JSON.stringify(config)}`)
      }
      if (name === VIRTUAL.rendererNode) {
        if (workers) lines.push(`import ${JSON.stringify(VIRTUAL.workers)}`)
        lines.push(`import { hasNode } from 'tauri-electron/renderer-node'`)
        lines.push(`if (hasNode && !globalThis.__TAURI_ELECTRON_APP__) globalThis.__TAURI_ELECTRON_APP__ = ${JSON.stringify(appFilesConfig(root, { dev: nested ? nested.dev : isDev, sessionPreloads: libraryPreloads }))}`)
      }
      if (name === VIRTUAL.renderer || name === VIRTUAL.trusted) {
        // The trusted-origins script starts like a renderer page, with its own preloads.
        const pagePreloads = name === VIRTUAL.trusted ? trustedPreloads(options.trustedPreload, preloads) : preloads
        if (withRequire) lines.push(`import 'tauri-electron/require'`)
        lines.push(`import 'tauri-electron/renderer-bootstrap'`)
        // Before the preloads, which may require('fs') at the top.
        if (withRendererNode) lines.push(`import ${JSON.stringify(VIRTUAL.rendererNode)}`)
        // Library preloads (electron-log, …) before the app's own, as Electron runs session preloads first.
        for (const preload of libraryPreloads) {
          const id = preload.file ? (isDev ? `/@fs/${toPosix(preload.id).replace(/^\/+/, '')}` : toPosix(preload.id)) : preload.id
          lines.push(`import ${JSON.stringify(id)}`)
        }
        for (const preload of pagePreloads) lines.push(`import ${JSON.stringify('/' + toPosix(preload).replace(/^\/+/, ''))}`)
      }
      return lines.join('\n') + '\n'
    },

    transform(code, id) {
      const file = id.split('?')[0]
      if (!SOURCE_FILE.test(file)) return null
      let result = code
      // Build: CommonJS require() of a shim gets the module, not its namespace
      // (dependencies included). Dev needs nothing: require() is tauri-electron's there.
      if (!isDev && mentionsRequire(result) && !file.includes('/tauri-electron/') && !file.includes('/packages/tauri-electron/')) {
        result = rewriteBuiltinRequires(result)
      }
      // new Worker(new URL('./w.js', import.meta.url)) → the script's project path (before Vite makes it a Web Worker).
      if (!file.includes('/node_modules/') && file.startsWith(root) && mentionsWorkerThreads(result)) {
        result = rewriteWorkerUrls(result, file, root)
      }
      if (!file.includes('/node_modules/') && file.startsWith(root) && mentionsPathGlobals(result)) {
        const relative = '/' + toPosix(path.relative(root, file))
        result = rewritePathGlobals(result, path.posix.dirname(relative), relative)
      }
      return result === code ? null : { code: result, map: null }
    },

    async generateBundle() {
      if (!withTrusted || isDev) return
      const code = await buildTrustedRenderer(trustedOptions())
      this.emitFile({ type: 'asset', fileName: TRUSTED_FILE, source: code })
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const page = toPosix(path.relative(root, ctx.filename))
        const script = (id) => ({ tag: 'script', attrs: { type: 'module', src: virtualSrc(id, isDev) }, injectTo: 'head-prepend' })
        const tags = []
        if (page === mainHtml) {
          tags.push(script(VIRTUAL.main))
          if (isDev && options.forwardMainConsole !== false) tags.unshift(script(VIRTUAL.console))
          return { html, tags }
        }
        tags.push(script(VIRTUAL.renderer))
        return { html: options.moduleScripts === false ? html : moduleScripts(html), tags }
      },
    },
  }
  return plugin
}
