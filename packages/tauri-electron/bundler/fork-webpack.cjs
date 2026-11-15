/**
 * The webpack / rspack plugin's build of fork entry points (see fork.cjs):
 * a second compiler targeting Node (CommonJS output, dependencies bundled,
 * Node built-ins external), with `electron` aliased to the child's module,
 * `__dirname` & co. pointing at the app's files, and the app's own loader
 * rules (TypeScript, Babel, …) and resolve aliases / extensions.
 */
'use strict'

const path = require('node:path')
const { FORK_ELECTRON, forkInputs } = require('./fork.cjs')

const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s)$/
const FORK_PATH_LOADER = path.join(__dirname, 'fork-path-loader.cjs')
const ELECTRON_NAMES = ['electron', 'electron/main', 'electron/common', 'electron/utility', 'electron/renderer']

function loadersOf(rule) {
  return [rule.loader, ...[rule.use].flat()].map((use) => (typeof use === 'string' ? use : use?.loader)).filter(Boolean)
}

/** The app's rules, without tauri-electron's own loaders (`skipLoaders`). */
function userRules(rules = [], skipLoaders = []) {
  return rules.filter((rule) => !rule || typeof rule !== 'object' || !loadersOf(rule).some((loader) => skipLoaders.includes(loader)))
}

/**
 * The config of the fork compiler.
 * @param {object} options
 * @param {string} options.context project root
 * @param {{ entries: Array<{ name: string, file: string }> }} options.plan fork.cjs `forkPlan()`
 * @param {string} options.outDir
 * @param {boolean} options.dev
 * @param {object} [options.config] the app's webpack config (rules, resolve)
 * @param {string[]} [options.skipLoaders] loaders of the app's config not to copy
 */
function forkWebpackConfig({ context, plan, outDir, dev, config = {}, skipLoaders = [] }) {
  const resolve = config.resolve ?? {}
  const alias = resolve.alias && !Array.isArray(resolve.alias) ? { ...resolve.alias } : {}
  for (const name of ELECTRON_NAMES) alias[`${name}$`] = FORK_ELECTRON
  return {
    mode: dev ? 'development' : 'production',
    context,
    target: 'node',
    devtool: false,
    entry: Object.fromEntries(Object.entries(forkInputs(plan)).map(([name, file]) => [name, { import: [file] }])),
    output: {
      path: outDir,
      filename: '[name].cjs',
      chunkFilename: 'chunks/[id].cjs',
      library: { type: 'commonjs2' },
      clean: true,
      publicPath: '',
    },
    resolve: {
      ...(resolve.extensions ? { extensions: resolve.extensions } : {}),
      ...(resolve.extensionAlias ? { extensionAlias: resolve.extensionAlias } : {}),
      ...(resolve.modules ? { modules: resolve.modules } : {}),
      alias,
    },
    module: {
      rules: [
        { test: SOURCE_FILE, include: context, exclude: /[\\/]node_modules[\\/]/, enforce: 'pre', loader: FORK_PATH_LOADER, options: { root: context } },
        ...userRules(config.module?.rules, skipLoaders),
      ],
    },
    externalsPresets: { node: true },
    optimization: { minimize: false, splitChunks: false, runtimeChunk: false },
    node: { __dirname: false, __filename: false, global: false },
    infrastructureLogging: { level: 'error' },
    stats: 'errors-warnings',
  }
}

function failureOf(error, stats) {
  if (error) return error
  if (stats?.hasErrors()) return new Error(`tauri-electron: fork entry build failed\n${stats.toString({ all: false, errors: true, colors: false })}`)
  return null
}

/**
 * Run the fork compiler of `bundler` (webpack or rspack). With `watch`,
 * resolves with the Watching once the first build is written.
 */
function runForkBuild(bundler, config, { watch = false } = {}) {
  return new Promise((resolve, reject) => {
    const compiler = bundler(config)
    if (!watch) {
      compiler.run((error, stats) => {
        compiler.close(() => {})
        const failure = failureOf(error, stats)
        if (failure) reject(failure)
        else resolve(null)
      })
      return
    }
    let first = true
    const watching = compiler.watch({}, (error, stats) => {
      const failure = failureOf(error, stats)
      if (first) {
        first = false
        if (failure) reject(failure)
        else resolve(watching)
      } else if (failure) {
        console.error(failure.message)
      }
    })
  })
}

module.exports = { forkWebpackConfig, runForkBuild }
