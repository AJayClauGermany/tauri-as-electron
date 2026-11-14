#!/usr/bin/env node
/**
 * create-tauri-electron-app: start a Tauri app from the Electron-shaped
 * template, or add Tauri to an existing Electron project.
 *
 *   npx github:AJayClauGermany/tauri-as-electron my-app
 *   npx github:AJayClauGermany/tauri-as-electron --into path/to/electron-project
 *
 * Dependency-free on purpose: it runs straight from the GitHub repository.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'AJayClauGermany/tauri-as-electron'
const REPO_URL = `https://github.com/${REPO}`
const here = path.dirname(fileURLToPath(import.meta.url))
const template = path.resolve(here, '../templates/tauri-electron-app')
const SKIP = new Set(['node_modules', 'dist', 'target', 'gen', 'Cargo.lock'])

const HELP = `
Usage:
  npx github:${REPO} <directory> [options]         new app from the template
  npx github:${REPO} --into <directory> [options]  add Tauri to an existing Electron project

Options:
  --name <name>           package and crate name           (default: the directory name)
  --product-name <name>   app / window title               (default: the name)
  --identifier <id>       reverse-DNS app id               (default: com.example.<name>)
  --ref <branch|tag|sha>  pin tauri-electron and tauri-plugin-electron to a git ref (default: main)
  --local <path>          use a local checkout of tauri-as-electron instead of GitHub
  --bundler <name>        with --into: vite, webpack or rspack  (default: detected from package.json)
  --force                 overwrite files that already exist
  -h, --help              this text

--into adds src-tauri/ and a bundler config next to your code, and the
tauri-electron dependency plus "tauri:dev" / "tauri:build" scripts to
package.json. Your main, preload and renderer files are not touched.
  vite (default):   electron-main.html + vite.config.mjs
  webpack / rspack: webpack.tauri.config.cjs / rspack.tauri.config.cjs; Electron Forge
                    projects using @electron-forge/plugin-webpack are read from forge.config.*
`.trim()

// --- arguments ------------------------------------------------------------------

function parseArgs(argv) {
  const options = { force: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) fail(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '-h': case '--help': options.help = true; break
      case '--into': options.into = value(); break
      case '--name': options.name = value(); break
      case '--product-name': options.productName = value(); break
      case '--identifier': options.identifier = value(); break
      case '--ref': options.ref = value(); break
      case '--local': options.local = path.resolve(value()); break
      case '--bundler': options.bundler = value(); break
      case '--force': options.force = true; break
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`)
        positional.push(arg)
    }
  }
  return { options, positional }
}

function fail(message) {
  console.error(`create-tauri-electron-app: ${message}\n\n${HELP}`)
  process.exit(1)
}

/** A valid npm / Cargo package name derived from a directory name. */
export function toPackageName(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '')
  return slug || 'tauri-electron-app'
}

export function toIdentifier(name) {
  const part = toPackageName(name).replace(/[^a-z0-9-]/g, '-')
  return `com.example.${part}`
}

// --- dependency specs ------------------------------------------------------------------

/** The `tauri-electron` npm dependency and the `tauri-plugin-electron` Cargo dependency. */
export function dependencySpecs({ ref, local }, appDir) {
  if (local) {
    const crate = path.join(local, 'crates/tauri-plugin-electron')
    if (!fs.existsSync(path.join(crate, 'Cargo.toml'))) fail(`${local} does not look like a tauri-as-electron checkout`)
    // Relative when the checkout is nearby (a sibling folder), absolute otherwise.
    const rel = (from, to) => {
      const relative = path.relative(from, to).split(path.sep).join('/') || '.'
      return relative.startsWith('../../..') ? to.split(path.sep).join('/') : relative
    }
    return {
      npm: `file:${rel(appDir, local)}`,
      cargo: `{ path = "${rel(path.join(appDir, 'src-tauri'), crate)}" }`,
    }
  }
  let cargoRef = ''
  if (ref) {
    if (/^[0-9a-f]{40}$/i.test(ref)) cargoRef = `, rev = "${ref}"`
    else if (/^v?\d+\.\d+/.test(ref)) cargoRef = `, tag = "${ref}"`
    else cargoRef = `, branch = "${ref}"`
  }
  return {
    npm: `github:${REPO}${ref ? `#${ref}` : ''}`,
    cargo: `{ git = "${REPO_URL}"${cargoRef} }`,
  }
}

// --- file helpers --------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function copyTree(from, to, { force, onCopy }) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true })
      copyTree(source, target, { force, onCopy })
    } else if (!fs.existsSync(target) || force) {
      fs.copyFileSync(source, target)
      onCopy?.(target)
    }
  }
}

function replaceInFile(file, replacements) {
  let text = fs.readFileSync(file, 'utf8')
  for (const [from, to] of replacements) text = text.replace(from, to)
  fs.writeFileSync(file, text)
}

/** Lines a Tauri + Vite project should ignore (appended if missing). */
const GITIGNORE = ['node_modules/', 'dist/', 'src-tauri/target/', 'src-tauri/gen/schemas/', 'src-tauri/electron-resources/app/']

function ensureGitignore(dir) {
  const file = path.join(dir, '.gitignore')
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const lines = new Set(existing.split('\n').map((l) => l.trim()))
  const missing = GITIGNORE.filter((l) => !lines.has(l) && !lines.has(l.replace(/\/$/, '')))
  if (!missing.length) return
  fs.writeFileSync(file, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
}

// --- the Tauri side (shared by both modes) -------------------------------------------------------

/** Rename the template's Rust crate and point it at tauri-plugin-electron. */
function configureTauri(appDir, { name, productName, identifier, version, specs }) {
  const crate = name.replace(/-/g, '_')
  const tauriDir = path.join(appDir, 'src-tauri')

  replaceInFile(path.join(tauriDir, 'Cargo.toml'), [
    [/^name = "tauri-electron-app"$/m, `name = "${name}"`],
    [/^name = "tauri_electron_app_lib"$/m, `name = "${crate}_lib"`],
    [/^description = .*$/m, `description = "${productName}"`],
    // Keeps the rest of the entry (the explicit `features = [...]` list).
    [/^tauri-plugin-electron = \{ path = "[^"]*"/m, `tauri-plugin-electron = { ${specs.cargo.slice(2, -2)}`],
    [/^# Until tauri-electron is published.*\n(#.*\n)*/m, ''],
  ])
  replaceInFile(path.join(tauriDir, 'src/main.rs'), [[/tauri_electron_app_lib::run\(\)/, `${crate}_lib::run()`]])

  // Where the bundler plugin stages the app files fs reads in a build
  // (tauri.conf.json ships it as resources). Written here too because npm
  // may drop a package's .gitignore files.
  const staging = path.join(tauriDir, 'electron-resources')
  fs.mkdirSync(staging, { recursive: true })
  const stagingIgnore = path.join(template, 'src-tauri/electron-resources/.gitignore')
  if (!fs.existsSync(path.join(staging, '.gitignore')) && fs.existsSync(stagingIgnore)) {
    fs.copyFileSync(stagingIgnore, path.join(staging, '.gitignore'))
  }

  const confFile = path.join(tauriDir, 'tauri.conf.json')
  const conf = readJson(confFile)
  conf.productName = productName
  conf.identifier = identifier
  if (version) conf.version = version
  writeJson(confFile, conf)
}

// --- mode 1: a new app from the template --------------------------------------------------------------

function createApp(dir, options) {
  const appDir = path.resolve(dir)
  if (fs.existsSync(appDir) && fs.readdirSync(appDir).length && !options.force) {
    fail(`${appDir} is not empty (use --force to write into it anyway)`)
  }
  const name = toPackageName(options.name ?? path.basename(appDir))
  const productName = options.productName ?? name
  const identifier = options.identifier ?? toIdentifier(name)
  const specs = dependencySpecs(options, appDir)

  fs.mkdirSync(appDir, { recursive: true })
  copyTree(template, appDir, { force: true })

  const pkgFile = path.join(appDir, 'package.json')
  const pkg = readJson(pkgFile)
  pkg.name = name
  pkg.dependencies['tauri-electron'] = specs.npm
  writeJson(pkgFile, pkg)

  // The template README links into this repository; make the links absolute.
  replaceInFile(path.join(appDir, 'README.md'), [[/\]\(\.\.\/\.\.\//g, `](${REPO_URL}/blob/main/`]])
  configureTauri(appDir, { name, productName, identifier, version: pkg.version, specs })
  ensureGitignore(appDir)

  const relative = path.relative(process.cwd(), appDir)
  console.log(`
Created ${productName} in ${appDir}

  cd ${relative && !relative.startsWith('..') ? relative : appDir}
  npm install
  npm run dev        # tauri dev
  npm run build      # tauri build

Your Electron code lives in src/main.js (main process), src/preload.js and
index.html + src/renderer.js. Rust is boilerplate; the Electron modules you
get are chosen by the Cargo features of tauri-plugin-electron in
src-tauri/Cargo.toml. Guide: ${REPO_URL}/blob/main/docs/MIGRATING.md
`)
}

// --- finding the sources of an existing project ---------------------------------------------------------

/** Guess the preload script from `webPreferences.preload` in the main file, or by name. */
export function findPreload(appDir, mainFile) {
  try {
    const source = fs.readFileSync(path.join(appDir, mainFile), 'utf8')
    const match = /preload\s*:\s*(?:path\.)?(?:join|resolve)\(\s*(?:__dirname|import\.meta\.dirname)\s*,\s*(['"`])([^'"`]+)\1/.exec(source)
    if (match) {
      const candidate = path.join(path.dirname(mainFile), match[2])
      if (fs.existsSync(path.join(appDir, candidate))) return candidate.split(path.sep).join('/')
    }
  } catch {
    /* no main file */
  }
  for (const dir of ['', 'src', 'src/preload', 'src/main']) {
    for (const ext of ['js', 'mjs', 'cjs', 'ts']) {
      const candidate = path.join(dir, `preload.${ext}`)
      if (fs.existsSync(path.join(appDir, candidate))) return candidate.split(path.sep).join('/')
    }
  }
  return null
}

// --- webpack / rspack ----------------------------------------------------------------------------------------------

/** Dev dependencies a webpack / rspack project needs for `tauri:dev` / `tauri:build` (added when missing). */
export const BUNDLER_DEV_DEPENDENCIES = {
  webpack: { webpack: '^5.101.0', 'webpack-cli': '^7.0.0', 'webpack-dev-server': '^5.2.0', 'html-webpack-plugin': '^5.6.0' },
  rspack: { '@rspack/core': '^2.0.0', '@rspack/cli': '^2.0.0', '@rspack/dev-server': '^2.0.0' },
}

const FORGE_CONFIGS = ['forge.config.ts', 'forge.config.mts', 'forge.config.cts', 'forge.config.js', 'forge.config.mjs', 'forge.config.cjs']

/**
 * Which bundler an existing Electron project builds with: Electron Forge's
 * webpack plugin, rspack, webpack, or (default, and for electron-vite) Vite.
 */
export function detectBundler(appDir, pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (deps['@electron-forge/plugin-webpack']) {
    const forgeConfig = FORGE_CONFIGS.find((f) => fs.existsSync(path.join(appDir, f)))
    if (forgeConfig || pkg.config?.forge) return { bundler: 'webpack', forge: true, forgeConfig, typescript: /\.[cm]?ts$/.test(forgeConfig ?? '') }
  }
  if (deps['@rspack/core'] || deps['@rspack/cli']) return { bundler: 'rspack' }
  if (deps.vite || deps['electron-vite']) return { bundler: 'vite' }
  if (deps.webpack || deps['webpack-cli']) return { bundler: 'webpack' }
  return { bundler: 'vite' }
}

const exists = (appDir, file) => fs.existsSync(path.join(appDir, file))
const firstExisting = (appDir, candidates) => candidates.find((c) => exists(appDir, c)) ?? null
const BUILD_OUTPUT = /^(\.webpack|\.vite|dist|build|out|release|app\/dist)\//
const SCRIPT_EXTS = ['ts', 'js', 'mjs', 'cjs', 'tsx', 'jsx']
const withExts = (bases) => bases.flatMap((b) => SCRIPT_EXTS.map((e) => `${b}.${e}`))

/** Best guesses at the source files of a webpack Electron project (null when not found). */
export function guessSources(appDir, pkg) {
  const declared = (pkg.main ?? '').replace(/^\.\//, '')
  const main =
    declared && !BUILD_OUTPUT.test(declared) && exists(appDir, declared)
      ? declared
      : firstExisting(appDir, withExts(['src/main/main', 'src/main/index', 'src/main', 'src/electron/main', 'electron/main', 'main', 'src/index']))
  const html = firstExisting(appDir, ['src/renderer/index.html', 'src/renderer/index.ejs', 'src/index.html', 'src/index.ejs', 'public/index.html', 'index.html'])
  const renderer = firstExisting(appDir, withExts(['src/renderer/index', 'src/renderer/renderer', 'src/renderer/main', 'src/renderer', 'src/app', 'renderer']))
  const preload = main ? findPreload(appDir, main) : null
  return { main, html, renderer, preload: preload ?? firstExisting(appDir, withExts(['src/main/preload', 'src/preload/index', 'src/preload'])) }
}

/** Loader rules for the loaders the project already has. */
function loaderRules(deps, bundler) {
  const rules = []
  const react = Boolean(deps.react)
  if (deps['ts-loader']) {
    rules.push(`{ test: /\\.tsx?$/, exclude: /node_modules/, loader: 'ts-loader', options: { transpileOnly: true } }`)
    if (deps['babel-loader']) rules.push(`{ test: /\\.jsx?$/, exclude: /node_modules/, loader: 'babel-loader' }`)
  } else if (deps['babel-loader']) {
    rules.push(`{ test: /\\.[jt]sx?$/, exclude: /node_modules/, loader: 'babel-loader' }`)
  } else if (bundler === 'rspack') {
    const transform = react ? `, transform: { react: { runtime: 'automatic' } }` : ''
    rules.push(`{
        test: /\\.[jt]sx?$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript', tsx: true }${transform} } },
        type: 'javascript/auto',
      }`)
  }
  const css = deps['style-loader'] && deps['css-loader'] ? `'style-loader', 'css-loader'` : null
  if (css) rules.push(`{ test: /\\.css$/, use: [${css}] }`)
  else if (bundler === 'rspack') rules.push(`{ test: /\\.css$/, type: 'css/auto' }`)
  if (css && deps['sass-loader']) rules.push(`{ test: /\\.s[ac]ss$/, use: [${css}, 'sass-loader'] }`)
  rules.push(`{ test: /\\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot)$/, type: 'asset/resource' }`)
  return rules
}

/** `webpack.tauri.config.cjs` / `rspack.tauri.config.cjs` for a project. */
export function bundlerConfig({ bundler, forge, forgeConfig, sources, deps }) {
  if (forge) {
    return `// Tauri build of this Electron Forge project (tauri-electron).
// Reads the @electron-forge/plugin-webpack options from ${forgeConfig ?? 'the Forge config'}: the main
// entry, the renderer config's loaders and plugins, and the entry points
// (pages + preloads). Builds them as one web app into dist/, served on port
// 1420 in development, which is what src-tauri/tauri.conf.json expects.
// Electron Forge itself keeps working as before.
const { fromForge } = require('tauri-electron/${bundler}')

module.exports = (env, argv) => fromForge(${forgeConfig ? `'./${forgeConfig}'` : 'undefined'}, { mode: argv.mode })
`
  }
  const quote = (value, what) => (value ? `'./${value}'` : `'./TODO' /* ${what} */`)
  const typescript = [sources.main, sources.renderer, sources.preload].some((f) => /\.tsx?$/.test(f ?? '')) || Boolean(deps.typescript)
  const extensions = typescript ? `['.ts', '.tsx', '.js', '.jsx', '.json']` : `['.js', '.jsx', '.json']`
  const page = [`name: 'index'`]
  if (sources.html) page.push(`html: ${quote(sources.html)}`, `filename: '${sources.html.replace(/\.\w+$/, '.html')}'`)
  else page.push(`html: './TODO' /* your renderer's HTML page (template) */`, `filename: 'index.html'`)
  page.push(`js: ${quote(sources.renderer, "your renderer's entry script")}`)
  if (sources.preload) page.push(`preload: ${quote(sources.preload)}`)
  return `// Tauri build of this Electron app (tauri-electron). One web build for
// the main process (a hidden page, electron-main.html), the preload and the
// renderer pages; output in dist/, dev server on port 1420, as
// src-tauri/tauri.conf.json expects. Your Electron build is not affected.
//
// Check the paths below and copy anything else your renderer config needs
// (loaders, aliases, DefinePlugin values). Docs:
// https://github.com/${REPO}/blob/main/docs/MIGRATING.md#webpack-and-rspack
const path = require('node:path')
const { TauriElectronPlugin } = require('tauri-electron/${bundler}')

module.exports = {
  entry: {},
  module: {
    rules: [
      ${loaderRules(deps, bundler).join(',\n      ')},
    ],
  },
  resolve: { extensions: ${extensions} },
  output: { path: path.resolve(__dirname, 'dist'), publicPath: '/', clean: true },
  plugins: [
    new TauriElectronPlugin({
      // Electron main-process entry (runs in the hidden electron-main window).
      main: ${quote(sources.main, 'your Electron main script')},
      // Renderer pages: an entry and an HTML page each, the preload loaded
      // first. A page is served at \`filename\`, its project-relative source
      // path, which is what win.loadFile(path.join(__dirname, ...)) and
      // loadURL(\`file://\${__dirname}/...\`) resolve to here.
      pages: [{ ${page.join(', ')} }],
    }),
  ],
  devServer: { port: 1420 },
}
`
}

// --- mode 2: add Tauri to an existing Electron project -----------------------------------------------------

function addToProject(dir, options) {
  const appDir = path.resolve(dir)
  const pkgFile = path.join(appDir, 'package.json')
  if (!fs.existsSync(pkgFile)) fail(`${appDir} has no package.json`)
  const pkg = readJson(pkgFile)
  const name = toPackageName(options.name ?? pkg.name ?? path.basename(appDir))
  const productName = options.productName ?? pkg.productName ?? pkg.build?.productName ?? name
  const identifier = options.identifier ?? pkg.build?.appId ?? toIdentifier(name)
  const specs = dependencySpecs(options, appDir)
  const detected = detectBundler(appDir, pkg)
  if (options.bundler && !['vite', 'webpack', 'rspack'].includes(options.bundler)) fail(`--bundler must be vite, webpack or rspack`)
  const bundler = options.bundler ?? detected.bundler
  const forge = detected.forge && bundler !== 'vite' ? detected : null
  const templatePkg = readJson(path.join(template, 'package.json'))
  const written = []
  const skipped = []
  const write = (relative, content) => {
    const file = path.join(appDir, relative)
    if (fs.existsSync(file) && !options.force) return skipped.push(relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    written.push(relative)
  }

  // src-tauri/ from the template, renamed.
  const tauriDir = path.join(appDir, 'src-tauri')
  if (fs.existsSync(tauriDir) && !options.force) {
    skipped.push('src-tauri/')
  } else {
    fs.mkdirSync(tauriDir, { recursive: true })
    copyTree(path.join(template, 'src-tauri'), tauriDir, { force: true, onCopy: (f) => written.push(path.relative(appDir, f)) })
    configureTauri(appDir, { name, productName, identifier, version: pkg.version, specs })
  }

  pkg.dependencies = { ...(pkg.dependencies ?? {}), 'tauri-electron': specs.npm }
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}) }
  pkg.devDependencies['@tauri-apps/cli'] ??= templatePkg.devDependencies['@tauri-apps/cli']
  pkg.scripts = { ...(pkg.scripts ?? {}) }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  let summary

  if (bundler === 'vite') {
    const mainFile = (pkg.main ?? 'main.js').replace(/^\.\//, '')
    const preload = findPreload(appDir, mainFile)
    // The hidden window that runs the Electron main process.
    write(
      'electron-main.html',
      fs
        .readFileSync(path.join(template, 'electron-main.html'), 'utf8')
        .replace('src="/src/main.js"', `src="/${mainFile.split(path.sep).join('/')}"`),
    )

    // Vite config (.mjs so it is ESM whatever package.json#type says).
    write(
      'vite.config.mjs',
      `import { defineConfig } from 'vite'
import tauriElectron from 'tauri-electron/vite'

export default defineConfig({
  plugins: [
    // Aliases \`electron\` to tauri-electron, provides require('electron') and
    // injects the preload script into every page except electron-main.html.
    tauriElectron({ preload: ${preload ? `'${preload}'` : `false /* set this to your preload script */`} }),
  ],
  server: { port: 1420, strictPort: true },
})
`,
    )
    pkg.devDependencies.vite ??= templatePkg.devDependencies.vite
    const scripts = { 'tauri:dev': 'tauri dev', 'tauri:build': 'tauri build', 'dev:web': 'vite', 'build:web': 'vite build', tauri: 'tauri' }
    for (const [key, value] of Object.entries(scripts)) pkg.scripts[key] ??= value
    summary = `Bundler:      Vite (vite.config.mjs)
Main process: ${mainFile} (loaded by electron-main.html)
Preload:      ${preload ?? 'not found - set `preload` in vite.config.mjs'}`
  } else {
    const configFile = `${bundler}.tauri.config.cjs`
    const sources = forge ? null : guessSources(appDir, pkg)
    write(configFile, bundlerConfig({ bundler, forge: Boolean(forge), forgeConfig: forge?.forgeConfig, sources, deps }))
    for (const [dep, version] of Object.entries(BUNDLER_DEV_DEPENDENCIES[bundler])) pkg.devDependencies[dep] ??= version
    // Forge 8 loads its (TypeScript / ES module) configs with jiti; so does fromForge().
    if (forge) pkg.devDependencies.jiti ??= '^2.4.0'
    const cli = bundler === 'rspack' ? 'rspack' : 'webpack'
    const scripts = {
      'tauri:dev': 'tauri dev',
      'tauri:build': 'tauri build',
      'dev:web': `${cli} serve --config ${configFile} --mode development`,
      'build:web': `${cli} ${bundler === 'rspack' ? 'build ' : ''}--config ${configFile} --mode production`,
      tauri: 'tauri',
    }
    for (const [key, value] of Object.entries(scripts)) pkg.scripts[key] ??= value
    // Forge's templates pin css-loader 6 / style-loader 3, whose peer ranges stop at rspack 1.
    const outdated = bundler === 'rspack' ? Object.entries({ 'css-loader': 7, 'style-loader': 4 }).filter(([dep, major]) => deps[dep] && Number(/\d+/.exec(deps[dep])?.[0]) < major) : []
    const peerNote = outdated.length
      ? `\nNote:         ${outdated.map(([dep]) => dep).join(' and ')} predate rspack 2 (npm reports a peer conflict):\n              npm install -D ${outdated.map(([dep, major]) => `${dep}@${major}`).join(' ')}`
      : ''
    const missing = sources ? Object.entries(sources).filter(([key, value]) => !value && key !== 'preload').map(([key]) => key) : []
    summary = forge
      ? `Bundler:      ${bundler} (${configFile}), from ${forge.forgeConfig ?? 'the Forge config'}
              main, preloads and pages come from @electron-forge/plugin-webpack's options${peerNote}`
      : `Bundler:      ${bundler} (${configFile})
Main process: ${sources.main ?? 'not found - set `main` in ' + configFile}
Preload:      ${sources.preload ?? 'not found - set `preload` on the page in ' + configFile + ' if you have one'}
Page:         ${sources.html ?? '?'} + ${sources.renderer ?? '?'}${missing.length ? `\n              fill in the TODOs in ${configFile}` : ''}${peerNote}`
  }

  writeJson(pkgFile, pkg)
  ensureGitignore(appDir)

  const list = (items) => items.map((i) => `  ${i}`).join('\n')
  const pageNote =
    bundler === 'vite'
      ? `  - Pages: every root-level *.html is built. <script src> tags without
    type="module" are bundled as modules; add type="module" yourself if you
    prefer to be explicit.`
      : forge
        ? `  - Pages: each Forge entry point is served at <name>/index.html, where
    MAIN_WINDOW_WEBPACK_ENTRY & co. point.`
        : `  - Pages: served at their project-relative source path (\`filename\` in
    ${bundler}.tauri.config.cjs): win.loadFile(path.join(__dirname, '../renderer/index.html'))
    finds them. A dev-server URL (http://localhost:<port>/...) does not: use
    loadFile, or the path relative to the project.`
  console.log(`
Added Tauri to ${appDir}
${written.length ? `\nWritten:\n${list(written)}` : ''}${skipped.length ? `\nKept (already there; --force overwrites):\n${list(skipped)}` : ''}

${summary}

Next:
  npm install
  npm run tauri:dev      # tauri dev
  npm run tauri:build    # tauri build

Check:
${pageNote}
  - require('electron'), require('path') work in main and preload scripts.
    fs, os and child_process work in the main process (the "node-*"
    features in src-tauri/Cargo.toml), as do util, stream, crypto, http;
    app files fs reads through __dirname are staged in src-tauri/electron-resources/.
    Other Node built-ins (zlib, net, ...) do not exist yet:
    see ${REPO_URL}/blob/main/docs/MIGRATING.md
  - src-tauri/Cargo.toml: enable "single-instance" if you call
    app.requestSingleInstanceLock(), "updater" for autoUpdater.
`)
}

// --- main ------------------------------------------------------------------------------------------------------------------------

// Also true when run through the npm bin symlink (npx).
const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()
if (isMain) {
  const { options, positional } = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
  } else if (options.into) {
    if (positional.length) fail('--into takes the project directory as its value')
    addToProject(options.into, options)
  } else if (positional.length === 1) {
    createApp(positional[0], options)
  } else {
    fail(positional.length ? 'expected exactly one directory' : 'missing directory')
  }
}
