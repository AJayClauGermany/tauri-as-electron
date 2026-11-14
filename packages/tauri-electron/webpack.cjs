/**
 * webpack 5 / rspack plugin that makes an Electron project run on
 * tauri-electron: the counterpart of `tauri-electron/vite` for projects that
 * already build with webpack (Electron Forge's webpack plugin,
 * electron-react-boilerplate, hand-written configs) or rspack.
 *
 *   const { TauriElectronPlugin } = require('tauri-electron/webpack')
 *   module.exports = {
 *     entry: { index: './src/renderer.js' },
 *     plugins: [
 *       new HtmlWebpackPlugin({ template: './src/index.html', chunks: ['index'] }),
 *       new TauriElectronPlugin({ main: './src/main.js', preload: './src/preload.js' }),
 *     ],
 *   }
 *
 * Electron builds main, preload and renderer separately (targets
 * `electron-main`, `electron-preload`, `electron-renderer`). Tauri runs all
 * of them in webviews, so this plugin turns one web build into the whole app:
 *  - adds an `electron-main` entry for your main script and emits
 *    `electron-main.html`, the hidden page Tauri opens first,
 *  - prepends the renderer bootstrap and your preload script(s) to every
 *    other entry,
 *  - optionally creates the renderer entries and their HTML pages from
 *    Electron Forge style `pages` (and defines Forge's
 *    `MAIN_WINDOW_WEBPACK_ENTRY` / `..._PRELOAD_WEBPACK_ENTRY` globals),
 *  - switches `electron-*` / `node` targets to `web`,
 *  - redirects `electron` (and `electron/main|renderer|common`) to
 *    tauri-electron, `path` / `process` / `events` / `url` / `buffer` / `fs`
 *    to its shims (`fs` needs tauri-plugin-electron's `node-fs` feature) and
 *    other Node built-ins to stubs that throw a NotImplementedError naming the
 *    Tauri replacement when used (with or without `node:`),
 *  - tells `fs` where the app's own files are and, in production builds,
 *    stages them in `src-tauri/electron-resources/app/` when that folder
 *    exists (see the Vite plugin),
 *  - rewrites `__dirname`, `__filename`, `import.meta.dirname|filename` and
 *    `fileURLToPath(import.meta.url)` in your source to project-relative paths,
 *  - in development (watch mode), prints the hidden main window's console in
 *    the terminal running the dev server.
 *
 * `fromForge()` builds the complete config from an Electron Forge config
 * that uses `@electron-forge/plugin-webpack`.
 */
'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { NODE_BUILTINS, NODE_SHIMS, LOG_ENDPOINT, appFilesConfig, stageAppFiles } = require('./bundler/shared.cjs')

const NAME = 'TauriElectronPlugin'
const SRC = path.join(__dirname, 'src')
const BUNDLER = path.join(__dirname, 'bundler')

const MODULES = {
  electron: path.join(SRC, 'index.js'),
  require: path.join(SRC, 'require.js'),
  bootstrap: path.join(SRC, 'renderer', 'bootstrap.js'),
  mainEntry: path.join(BUNDLER, 'main-entry.js'),
  mainNode: path.join(BUNDLER, 'main-node.js'),
  consoleForwarder: path.join(BUNDLER, 'console-forwarder.js'),
  nodeBuiltin: path.join(BUNDLER, 'node-builtin.cjs'),
  pathGlobalsLoader: path.join(BUNDLER, 'path-globals-loader.cjs'),
}
const SHIM_FILES = {
  'tauri-electron/path': path.join(SRC, 'path.js'),
  // Node's require('process') / require('events') are the object / class itself.
  'tauri-electron/process': path.join(BUNDLER, 'process.cjs'),
  'tauri-electron/events': path.join(BUNDLER, 'events.cjs'),
  'tauri-electron/url': path.join(SRC, 'url.js'),
  'tauri-electron/path/win32': path.join(SRC, 'node', 'path-win32.js'),
  'tauri-electron/buffer': path.join(SRC, 'node', 'buffer.js'),
  'tauri-electron/fs': path.join(SRC, 'node', 'fs.js'),
  'tauri-electron/fs/promises': path.join(SRC, 'node', 'fs-promises.js'),
}

const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s)$/
const ELECTRON_REQUEST = /^electron(\/(main|renderer|common))?$/

/** `electron-main` / `node` / `['web', 'electron-renderer']` → a target a webview can run. */
function webTarget(target) {
  const isNative = (t) => typeof t === 'string' && /^(electron|node|async-node)/.test(t)
  if (target === undefined || target === false) return target
  if (Array.isArray(target)) {
    const kept = target.filter((t) => !isNative(t))
    return kept.length ? kept : 'web'
  }
  return isNative(target) ? 'web' : target
}

/** `MAIN_WINDOW_WEBPACK_ENTRY` for an entry named `main_window`, as Electron Forge names it. */
function forgeDefineName(name, preload = false) {
  return `${name.toUpperCase().replace(/ /g, '_')}${preload ? '_PRELOAD' : ''}_WEBPACK_ENTRY`
}

function toArray(value) {
  return [value].flat().filter(Boolean)
}

/** Load a CommonJS module from the project (html-webpack-plugin), or null. */
function requireFromProject(id, context) {
  try {
    return require(require.resolve(id, { paths: [context] }))
  } catch {
    return null
  }
}

/** Where a request of the app's code should go instead, or null to leave it alone. */
function redirect(request, { aliasPath, userResolved }) {
  if (ELECTRON_REQUEST.test(request)) return MODULES.electron
  const bare = request.replace(/^node:/, '')
  if (userResolved.has(bare) || userResolved.has(request)) return null
  if (aliasPath !== false || !bare.startsWith('path')) {
    const shim = NODE_SHIMS[bare]
    if (shim) return SHIM_FILES[shim]
  }
  if (NODE_BUILTINS.includes(bare) || /^path(\/(posix|win32))?$/.test(bare)) return `${MODULES.nodeBuiltin}?${bare}`
  return null
}

/** Names the user already mapped with resolve.alias / resolve.fallback (e.g. `buffer` → the npm polyfill). */
function userResolvedNames(resolve = {}) {
  const names = new Set()
  for (const option of [resolve.alias, resolve.fallback]) {
    if (Array.isArray(option)) for (const { name } of option) names.add(String(name).replace(/\$$/, ''))
    else if (option) for (const name of Object.keys(option)) names.add(name.replace(/\$$/, ''))
  }
  return names
}

/** The emitted `electron-main.html`: loads the main entry's files. */
function mainHtmlSource(files, { publicPath, isModule, logUrl }) {
  const tags = logUrl ? [`<meta name="tauri-electron-log" content="${logUrl}" />`] : []
  for (const file of files) {
    const url = publicPath + file
    if (file.endsWith('.css')) tags.push(`<link rel="stylesheet" href="${url}" />`)
    else if (/\.m?js$/.test(file)) tags.push(isModule ? `<script type="module" src="${url}"></script>` : `<script defer src="${url}"></script>`)
  }
  return `<!doctype html>
<!-- Hidden window that plays the role of Electron's main process (generated by tauri-electron). -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>electron-main</title>
    ${tags.join('\n    ')}
  </head>
  <body></body>
</html>
`
}

class TauriElectronPlugin {
  /**
   * @param {object} options
   * @param {string|string[]} options.main Electron main-process script(s), relative to the webpack context.
   * @param {string|string[]|Record<string, string|string[]>|false} [options.preload]
   *   Preload script(s) for every renderer entry, or per entry name.
   * @param {Array<{name: string, js?: string, html?: string, filename?: string, preload?: string|string[], title?: string, additionalChunks?: string[]}>} [options.pages]
   *   Renderer pages to create (Electron Forge's `entryPoints`): an entry per page and, with
   *   `html`, an HTML page at `filename` (default `<name>/index.html`, as in Forge) built by
   *   html-webpack-plugin, or rspack's HtmlRspackPlugin.
   * @param {string} [options.mainEntry='electron-main'] Entry name of the main process.
   * @param {string} [options.mainHtml='electron-main.html'] Page Tauri opens first (tauri.conf.json `app.windows[0].url`).
   * @param {boolean} [options.aliasPath=true] Use tauri-electron's `path` (`false`: `path` throws like `fs`).
   * @param {boolean} [options.require=true] Install a global `require()` for CommonJS Electron code.
   * @param {boolean} [options.forwardMainConsole=true] Print the main window's console in the dev-server terminal.
   * @param {boolean} [options.forgeGlobals=true] Define Forge's `<NAME>_WEBPACK_ENTRY` globals for `pages`.
   * @param {false|string[]} [options.resources] App files `fs` can read in a build (see the Vite plugin).
   */
  constructor(options = {}) {
    if (!options.main) throw new Error(`${NAME}: the \`main\` option (your Electron main script) is required`)
    this.options = options
  }

  apply(compiler) {
    const options = this.options
    const bundler = compiler.webpack ?? compiler.rspack ?? requireFromProject('webpack', compiler.context)
    const context = compiler.context
    const config = compiler.options
    const mainEntry = options.mainEntry ?? 'electron-main'
    const mainHtml = options.mainHtml ?? 'electron-main.html'
    const withRequire = options.require !== false
    const pages = options.pages ?? []
    const dev = config.mode === 'development'
    let logUrl = null
    const fromContext = (file) => (path.isAbsolute(file) ? file : path.resolve(context, file))

    // --- targets: everything runs in a webview ------------------------------------------------
    config.target = webTarget(config.target)
    if (config.externalsPresets) {
      for (const preset of ['electron', 'electronMain', 'electronPreload', 'electronRenderer', 'node']) {
        if (config.externalsPresets[preset]) config.externalsPresets[preset] = false
      }
    }

    // --- electron, Node shims and Node built-in stubs ---------------------------------------
    // A replacement plugin rather than resolve.alias: it runs before webpack
    // rejects `node:` requests on web targets.
    const userResolved = userResolvedNames(config.resolve)
    const aliasPath = options.aliasPath
    new bundler.NormalModuleReplacementPlugin(/^(node:)?[a-z_/-]+$/, (resource) => {
      if (typeof resource.request !== 'string') return
      const target = redirect(resource.request, { aliasPath, userResolved })
      if (target) resource.request = target
    }).apply(compiler)

    // --- __dirname & co. in project source ------------------------------------------------------
    config.module ??= {}
    config.module.rules ??= []
    config.module.rules.unshift({
      test: SOURCE_FILE,
      include: context,
      exclude: /[\\/]node_modules[\\/]/,
      enforce: 'pre',
      loader: MODULES.pathGlobalsLoader,
      options: { root: context },
    })

    // --- entries -----------------------------------------------------------------------------------------
    const preloadsFor = (name, page) => {
      const own = toArray(page?.preload)
      const shared = options.preload
      const common = shared && typeof shared === 'object' && !Array.isArray(shared) ? toArray(shared[name]) : toArray(shared)
      return [...common, ...own].map(fromContext)
    }
    const rendererPrefix = (name, page) => [
      ...(withRequire ? [MODULES.require] : []),
      MODULES.bootstrap,
      ...preloadsFor(name, page),
    ]
    const mainImports = [
      ...(dev && options.forwardMainConsole !== false ? [MODULES.consoleForwarder] : []),
      MODULES.mainNode,
      ...(withRequire ? [MODULES.mainEntry] : []),
      ...toArray(options.main).map(fromContext),
    ]
    const pageEntries = Object.fromEntries(
      pages.filter((page) => page.js || page.html).map((page) => [page.name, { import: page.js ? [fromContext(page.js)] : [] }]),
    )

    const rewriteEntries = (entries) => {
      const result = {}
      for (const [name, description] of Object.entries(entries)) {
        // `entry` left out of the config: webpack's default `./src` entry is not a renderer.
        if (!description.import) continue
        if (name === mainEntry) continue
        result[name] = { ...description, import: [...rendererPrefix(name), ...description.import] }
      }
      for (const page of pages) {
        if (!pageEntries[page.name]) continue
        result[page.name] = { ...pageEntries[page.name], import: [...rendererPrefix(page.name, page), ...pageEntries[page.name].import] }
      }
      result[mainEntry] = { import: mainImports }
      return result
    }
    const entry = config.entry
    config.entry = typeof entry === 'function' ? async () => rewriteEntries(await entry()) : rewriteEntries(entry ?? {})

    // --- renderer pages from `pages` (Electron Forge entry points) ---------------------------
    // Where the app's own files are, for fs (read by bundler/main-node.js).
    const definitions = { __TAURI_ELECTRON_APP__: JSON.stringify(appFilesConfig(context, { dev })) }
    const pageFile = (page) => page.filename ?? `${page.name}/index.html`
    for (const page of pages) {
      if (options.forgeGlobals !== false) {
        const url = JSON.stringify(page.html ? pageFile(page) : `${page.name}/index.js`)
        const preload = toArray(page.preload).length || options.preload ? JSON.stringify(`${page.name}/preload.js`) : 'undefined'
        for (const [key, value] of [[forgeDefineName(page.name), url], [forgeDefineName(page.name, true), preload]]) {
          definitions[key] = value
          definitions[`process.env.${key}`] = value
        }
      }
      if (!page.html) continue
      const HtmlWebpackPlugin = requireFromProject('html-webpack-plugin', context)
      const HtmlPlugin = HtmlWebpackPlugin ?? bundler.HtmlRspackPlugin
      if (!HtmlPlugin) {
        throw new Error(`${NAME}: \`pages\` with \`html\` need html-webpack-plugin: npm install --save-dev html-webpack-plugin`)
      }
      new HtmlPlugin({
        // Forge's value for templates that use htmlWebpackPlugin.options.title;
        // HtmlRspackPlugin would overwrite the page's own <title> with it.
        ...(HtmlWebpackPlugin ? { title: page.title ?? page.name } : page.title ? { title: page.title } : {}),
        template: fromContext(page.html),
        filename: pageFile(page),
        chunks: [page.name, ...(page.additionalChunks ?? [])],
      }).apply(compiler)
    }
    new bundler.DefinePlugin(definitions).apply(compiler)

    // --- app files for fs, in production builds -------------------------------------------------
    if (!dev) {
      compiler.hooks.beforeRun.tap(NAME, () => {
        stageAppFiles(context, { resources: options.resources, exclude: [config.output?.path ?? 'dist'] })
      })
    }

    // --- electron-main.html ---------------------------------------------------------------------------
    compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: NAME, stage: bundler.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE },
        () => {
          const entrypoint = compilation.entrypoints.get(mainEntry)
          if (!entrypoint) return
          let publicPath = compilation.outputOptions.publicPath
          if (publicPath === undefined || publicPath === 'auto') {
            publicPath = '../'.repeat(mainHtml.split('/').length - 1)
          } else {
            publicPath = compilation.getPath(publicPath, { hash: compilation.hash })
            if (publicPath && !publicPath.endsWith('/')) publicPath += '/'
          }
          const files = entrypoint.getFiles().filter((file) => !file.endsWith('.map') && !file.includes('.hot-update.'))
          const html = mainHtmlSource(files, { publicPath, isModule: Boolean(compilation.outputOptions.module), logUrl })
          compilation.emitAsset(mainHtml, new bundler.sources.RawSource(html))
        },
      )
    })

    // --- dev: main window console → terminal -----------------------------------------------------
    // A small listener of its own rather than dev-server middleware: webpack-cli
    // copies `devServer` before plugins run, so a plugin cannot add middleware.
    // electron-main.html tells the forwarder where it listens.
    if (dev && options.forwardMainConsole !== false) {
      let server
      compiler.hooks.watchRun.tapPromise(NAME, async () => {
        if (server) return
        server = http.createServer(logRequest)
        await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
        server.unref()
        logUrl = `http://127.0.0.1:${server.address().port}${LOG_ENDPOINT}`
      })
      compiler.hooks.watchClose.tap(NAME, () => server?.close())
    }
  }
}

/** Prints what the main window's console forwarder posts. */
function logRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method !== 'POST') {
    res.statusCode = 204
    return res.end()
  }
  const colors = { error: '\x1b[31m', warn: '\x1b[33m' }
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
}

// --- Electron Forge -------------------------------------------------------------------------------------------

/**
 * Load a config module the way Electron Forge does: jiti (TypeScript,
 * extensionless imports; Forge 8 depends on it) when the project has it,
 * otherwise Node's own import().
 */
async function loadModule(file, context) {
  const jiti = requireFromProject('jiti', context)
  let loaded
  if (jiti?.createJiti) {
    loaded = await jiti.createJiti(path.join(context, 'noop.js'), { interopDefault: true }).import(file, { default: true })
  } else {
    loaded = await import(pathToFileURL(file).href)
    loaded = loaded.default ?? loaded
  }
  return loaded?.default ?? loaded
}

const FORGE_CONFIG_FILES = ['forge.config.ts', 'forge.config.mts', 'forge.config.cts', 'forge.config.js', 'forge.config.mjs', 'forge.config.cjs']

/** Forge's config: a path, the config object, or (default) forge.config.* / package.json#config.forge. */
async function loadForgeConfig(forgeConfig, context) {
  if (forgeConfig && typeof forgeConfig === 'object') return forgeConfig
  const file = forgeConfig ? path.resolve(context, forgeConfig) : FORGE_CONFIG_FILES.map((f) => path.join(context, f)).find((f) => fs.existsSync(f))
  if (file) return loadModule(file, context)
  const pkg = JSON.parse(fs.readFileSync(path.join(context, 'package.json'), 'utf8'))
  const inPackage = pkg.config?.forge
  if (typeof inPackage === 'string') return loadModule(path.resolve(context, inPackage), context)
  if (inPackage) return inPackage
  throw new Error(`fromForge: no forge.config.* in ${context}`)
}

/** `@electron-forge/plugin-webpack`'s options, from `new WebpackPlugin({...})` or `{ name, config }`. */
function findWebpackPlugin(forge) {
  for (const plugin of forge.plugins ?? []) {
    const name = String(plugin?.name ?? '')
    const config = plugin?.config ?? (Array.isArray(plugin) ? plugin[1] : undefined)
    const isWebpack = Array.isArray(plugin) ? /plugin-webpack/.test(plugin[0]) : /webpack/.test(name)
    if (config?.renderer && (isWebpack || config.mainConfig)) return config
  }
  return null
}

/** A webpack config value (object, path, or `(env, argv) => config`) → the object. */
async function resolveWebpackConfig(value, context, mode) {
  let config = typeof value === 'string' ? await loadModule(path.resolve(context, value), context) : value
  if (typeof config === 'function') config = await config({}, { mode })
  return config ?? {}
}

/** Loaders that only make sense in Node (native `.node` addons); dropped from Forge's rules. */
const NODE_ONLY_LOADERS = /(^|[\\/])(node-loader|@vercel[\\/]webpack-asset-relocator-loader)([\\/]|$)/

function usesNodeOnlyLoader(rule) {
  const loaders = [rule.loader, ...toArray(rule.use)].map((u) => (typeof u === 'string' ? u : u?.loader)).filter(Boolean)
  return loaders.some((loader) => NODE_ONLY_LOADERS.test(loader))
}

/**
 * The whole Tauri build from an Electron Forge project using
 * `@electron-forge/plugin-webpack`: the renderer config (loaders, plugins,
 * resolve) with Forge's entry points as `pages`, the main config's entry as
 * `main`, output in `dist/` and the dev server on port 1420, where
 * `src-tauri/tauri.conf.json` expects them.
 *
 *   // webpack.tauri.config.cjs
 *   module.exports = require('tauri-electron/webpack').fromForge()
 *
 * @param {string|object} [forgeConfig] Forge config (path or object); default: forge.config.* in `context`.
 * @param {object} [options] TauriElectronPlugin options, plus:
 * @param {string} [options.context=process.cwd()] Project directory.
 * @param {'development'|'production'} [options.mode] Default: from NODE_ENV / the CLI's --mode.
 * @param {string} [options.outDir='dist'] Where the build goes (tauri.conf.json `build.frontendDist`).
 * @param {number} [options.port=1420] Dev-server port (tauri.conf.json `build.devUrl`).
 * @returns {Promise<object>} A webpack / rspack config.
 */
async function fromForge(forgeConfig, options = {}) {
  const { context = process.cwd(), outDir = 'dist', port = 1420, ...pluginOptions } = options
  const mode = options.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development')
  const forge = await loadForgeConfig(forgeConfig, context)
  const webpackPlugin = findWebpackPlugin(forge)
  if (!webpackPlugin) throw new Error('fromForge: the Forge config has no @electron-forge/plugin-webpack plugin')

  const mainConfig = await resolveWebpackConfig(webpackPlugin.mainConfig, context, mode)
  const renderers = toArray(webpackPlugin.renderer)
  const rendererConfig = await resolveWebpackConfig(renderers[0].config, context, mode)
  const pages = renderers.flatMap((renderer) =>
    (renderer.entryPoints ?? []).map((entry) => ({
      name: entry.name,
      html: entry.html,
      js: entry.js,
      preload: entry.preload?.js,
      additionalChunks: entry.additionalChunks,
    })),
  )
  const main = typeof mainConfig.entry === 'string' || Array.isArray(mainConfig.entry) ? mainConfig.entry : Object.values(mainConfig.entry ?? {})[0]
  if (!main) throw new Error('fromForge: mainConfig has no entry')

  const rules = (rendererConfig.module?.rules ?? []).filter((rule) => !rule || typeof rule !== 'object' || !usesNodeOnlyLoader(rule))
  const extensions = [...new Set([...(mainConfig.resolve?.extensions ?? []), ...(rendererConfig.resolve?.extensions ?? [])])]
  return {
    ...rendererConfig,
    context: rendererConfig.context ?? context,
    mode,
    target: 'web',
    devtool: rendererConfig.devtool ?? (mode === 'production' ? false : 'eval-source-map'),
    entry: {},
    module: { ...rendererConfig.module, rules },
    resolve: { ...rendererConfig.resolve, ...(extensions.length ? { extensions } : {}) },
    output: { ...rendererConfig.output, path: path.resolve(context, outDir), publicPath: '/', clean: true },
    plugins: [
      ...(rendererConfig.plugins ?? []),
      new TauriElectronPlugin({ main: toArray(main), pages, ...pluginOptions }),
    ],
    devServer: { ...rendererConfig.devServer, ...(webpackPlugin.devServer ?? {}), port },
  }
}

module.exports = TauriElectronPlugin
module.exports.default = TauriElectronPlugin
module.exports.TauriElectronPlugin = TauriElectronPlugin
module.exports.fromForge = fromForge
module.exports.webTarget = webTarget
module.exports.redirect = redirect
