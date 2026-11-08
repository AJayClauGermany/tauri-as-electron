/**
 * Vite plugin that makes an Electron-style project run on tauri-electron.
 *
 *   import tauriElectron from 'tauri-electron/vite'
 *   export default defineConfig({ plugins: [tauriElectron({ preload: 'src/preload.js' })] })
 *
 * It
 *  - aliases `electron` (and `electron/main|renderer|common`) to tauri-electron
 *    and `path` / `node:path` to a browser-safe implementation,
 *  - rewrites `__dirname`, `__filename`, `import.meta.dirname` and
 *    `import.meta.filename` in your source to project-relative paths, so
 *    `win.loadFile(path.join(__dirname, 'index.html'))` keeps working,
 *  - injects the renderer bootstrap and your preload script at the top of
 *    every HTML page except the main-process page (`electron-main.html`),
 *  - makes `process.env` read the real environment (the main process gets it
 *    from tauri-plugin-electron) instead of Vite's empty object,
 *  - adds every root-level *.html file to the build inputs,
 *  - in dev, forwards the hidden main window's console to the terminal (the
 *    window has no visible devtools; Electron devs expect main logs there).
 */
import fs from 'node:fs'
import path from 'node:path'

const LOG_ENDPOINT = '/__tauri-electron/log'

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

const SOURCE_FILE = /\.(m?[jt]sx?|cjs|cts)$/
// Comments and quoted strings are matched (and kept) so that only real
// identifiers are rewritten. Template literals are scanned as code so
// `${__dirname}` inside them still works.
const PATH_GLOBALS =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(?<![.$\w])__(dirname|filename)(?![$\w])|\bimport\.meta\.(dirname|filename)\b/g

export function rewritePathGlobals(code, dirname, filename) {
  return code.replace(PATH_GLOBALS, (match, skipped, legacy, meta) => {
    if (skipped) return match
    return JSON.stringify((legacy ?? meta) === 'dirname' ? dirname : filename)
  })
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * @param {object} [options]
 * @param {string|string[]|false} [options.preload] Preload script(s), relative to the Vite root.
 * @param {string} [options.mainHtml='electron-main.html'] Page that runs the Electron main-process code.
 * @param {boolean} [options.aliasPath=true] Alias `path`/`node:path` to tauri-electron/path.
 * @param {boolean} [options.forwardMainConsole=true] Print the main window's console in the terminal during dev.
 */
export default function tauriElectron(options = {}) {
  const mainHtml = options.mainHtml ?? 'electron-main.html'
  const preloads = [options.preload].flat().filter(Boolean)
  let root = process.cwd()
  let isDev = false

  return {
    name: 'tauri-electron',
    enforce: 'pre',

    config(userConfig) {
      root = path.resolve(userConfig.root ?? process.cwd())
      const alias = [
        { find: /^electron(\/(main|renderer|common))?$/, replacement: 'tauri-electron' },
      ]
      if (options.aliasPath !== false) alias.push({ find: /^(node:)?path(\/posix)?$/, replacement: 'tauri-electron/path' })

      const config = {
        resolve: { alias },
        // Vite replaces a bare `process.env` with `{}`; Electron code expects
        // the real environment (filled in by tauri-electron's process shim).
        define: userConfig.define?.['process.env'] ? {} : { 'process.env': '(globalThis.process?.env ?? {})' },
        clearScreen: false,
        envPrefix: ['VITE_', 'TAURI_ENV_'],
        server: { watch: { ignored: ['**/src-tauri/**'] } },
        build: {
          target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
          minify: !process.env.TAURI_ENV_DEBUG,
          sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
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
      isDev = resolved.command === 'serve'
    },

    configureServer(server) {
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

    transform(code, id) {
      const file = id.split('?')[0]
      if (!SOURCE_FILE.test(file) || file.includes('/node_modules/') || !file.startsWith(root)) return null
      if (!code.includes('__dirname') && !code.includes('__filename') && !code.includes('import.meta.')) return null
      const relative = '/' + toPosix(path.relative(root, file))
      const dirname = path.posix.dirname(relative)
      const replaced = rewritePathGlobals(code, dirname, relative)
      return replaced === code ? null : { code: replaced, map: null }
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const page = toPosix(path.relative(root, ctx.filename))
        if (page === mainHtml) {
          if (!isDev || options.forwardMainConsole === false) return html
          return [{ tag: 'script', attrs: { type: 'module' }, children: CONSOLE_FORWARDER, injectTo: 'head-prepend' }]
        }
        const imports = ['tauri-electron/renderer-bootstrap', ...preloads.map((p) => '/' + toPosix(p).replace(/^\/+/, ''))]
        const script = imports.map((p) => `import ${JSON.stringify(p)};`).join(' ')
        return [{ tag: 'script', attrs: { type: 'module' }, children: script, injectTo: 'head-prepend' }]
      },
    },
  }
}
