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
  --force                 overwrite files that already exist
  -h, --help              this text

--into adds electron-main.html, vite.config.mjs and src-tauri/ next to your code,
and the tauri-electron dependency plus "tauri:dev" / "tauri:build" scripts to
package.json. Your main, preload and renderer files are not touched.
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
const GITIGNORE = ['node_modules/', 'dist/', 'src-tauri/target/', 'src-tauri/gen/schemas/']

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
    [/^tauri-plugin-electron = .*$/m, `tauri-plugin-electron = ${specs.cargo}`],
    [/^# Until tauri-electron is published.*\n(#.*\n)*/m, ''],
  ])
  replaceInFile(path.join(tauriDir, 'src/main.rs'), [[/tauri_electron_app_lib::run\(\)/, `${crate}_lib::run()`]])

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

// --- mode 2: add Tauri to an existing Electron project -----------------------------------------------------

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

function addToProject(dir, options) {
  const appDir = path.resolve(dir)
  const pkgFile = path.join(appDir, 'package.json')
  if (!fs.existsSync(pkgFile)) fail(`${appDir} has no package.json`)
  const pkg = readJson(pkgFile)
  const name = toPackageName(options.name ?? pkg.name ?? path.basename(appDir))
  const productName = options.productName ?? pkg.productName ?? pkg.build?.productName ?? name
  const identifier = options.identifier ?? pkg.build?.appId ?? toIdentifier(name)
  const specs = dependencySpecs(options, appDir)
  const mainFile = (pkg.main ?? 'main.js').replace(/^\.\//, '')
  const preload = findPreload(appDir, mainFile)
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

  // package.json: dependencies and scripts, nothing removed.
  pkg.dependencies = { ...(pkg.dependencies ?? {}), 'tauri-electron': specs.npm }
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}) }
  for (const dep of ['@tauri-apps/cli', 'vite']) pkg.devDependencies[dep] ??= templatePkg.devDependencies[dep]
  pkg.scripts = { ...(pkg.scripts ?? {}) }
  const scripts = { 'tauri:dev': 'tauri dev', 'tauri:build': 'tauri build', 'dev:web': 'vite', 'build:web': 'vite build', tauri: 'tauri' }
  for (const [key, value] of Object.entries(scripts)) pkg.scripts[key] ??= value
  writeJson(pkgFile, pkg)
  ensureGitignore(appDir)

  const list = (items) => items.map((i) => `  ${i}`).join('\n')
  console.log(`
Added Tauri to ${appDir}
${written.length ? `\nWritten:\n${list(written)}` : ''}${skipped.length ? `\nKept (already there; --force overwrites):\n${list(skipped)}` : ''}

Main process: ${mainFile} (loaded by electron-main.html)
Preload:      ${preload ?? 'not found - set `preload` in vite.config.mjs'}

Next:
  npm install
  npm run tauri:dev      # tauri dev
  npm run tauri:build    # tauri build

Check:
  - Pages: every root-level *.html is built. <script src> tags without
    type="module" are bundled as modules; add type="module" yourself if you
    prefer to be explicit.
  - require('electron'), require('path') work in main and preload scripts.
    Other Node built-ins (fs, child_process, ...) do not exist in a webview:
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
