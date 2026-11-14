import { describe, expect, it } from 'vitest'
import tauriElectron, { rewritePathGlobals, moduleScripts, NODE_BUILTINS } from '../vite.js'

describe('rewritePathGlobals', () => {
  const rewrite = (code) => rewritePathGlobals(code, '/src', '/src/main.js')

  it('rewrites identifiers and import.meta properties', () => {
    expect(rewrite("path.join(__dirname, 'a.html')")).toBe(`path.join("/src", 'a.html')`)
    expect(rewrite('const f = __filename')).toBe('const f = "/src/main.js"')
    expect(rewrite('import.meta.dirname + import.meta.filename')).toBe('"/src" + "/src/main.js"')
    expect(rewrite('`${__dirname}/x`')).toBe('`${"/src"}/x`')
    expect(rewrite('path.dirname(fileURLToPath(import.meta.url))')).toBe('path.dirname("/src/main.js")')
    expect(rewrite('new URL("./x", import.meta.url)')).toBe('new URL("./x", import.meta.url)')
    expect(rewrite("loadURL(`file://${path.resolve(__dirname, '../r/', 'a.html')}`) // __dirname")).toBe(
      "loadURL(`file://${path.resolve(\"/src\", '../r/', 'a.html')}`) // __dirname",
    )
  })

  it('leaves strings, comments and member accesses alone', () => {
    const code = `const a = "path.join(__dirname)"; // __dirname\nconst b = 'import.meta.dirname'; /* __filename */ obj.__dirname`
    expect(rewrite(code)).toBe(code)
  })
})

describe('moduleScripts', () => {
  it('gives classic external scripts type="module"', () => {
    expect(moduleScripts('<script src="./renderer.js"></script>')).toBe('<script type="module" src="./renderer.js"></script>')
    expect(moduleScripts(`<script type="text/javascript" src='a.js'></script>`)).toBe(`<script type="module" src='a.js'></script>`)
    expect(moduleScripts('<SCRIPT defer src=a.js></SCRIPT>')).toBe('<script type="module" defer src=a.js></SCRIPT>')
  })

  it('leaves module, nomodule, inline and data scripts alone', () => {
    for (const html of [
      '<script type="module" src="a.js"></script>',
      '<script nomodule src="a.js"></script>',
      '<script>inline()</script>',
      '<script type="application/json" src="x.json"></script>',
      '<script type="importmap">{}</script>',
    ]) {
      expect(moduleScripts(html)).toBe(html)
    }
  })
})

/** Drive the plugin's hooks the way Vite does, without a Vite build. */
function plugin(options, { dev = false } = {}) {
  const p = tauriElectron(options)
  p.config({})
  p.configResolved({ root: process.cwd(), command: dev ? 'serve' : 'build' })
  return p
}

describe('page injection', () => {
  const html = '<html><head></head><body><script src="renderer.js"></script></body></html>'

  it('loads require, the bootstrap and the preload(s) through one virtual module, in that order', () => {
    const p = plugin({ preload: ['src/preload.js', '/other/pre.js'] })
    const { tags, html: out } = p.transformIndexHtml.handler(html, { filename: `${process.cwd()}/index.html` })
    expect(tags).toEqual([{ tag: 'script', attrs: { type: 'module', src: 'virtual:tauri-electron/renderer' }, injectTo: 'head-prepend' }])
    expect(out).toContain('<script type="module" src="renderer.js">')
    const resolved = p.resolveId('virtual:tauri-electron/renderer')
    expect(p.load(resolved).trim().split('\n')).toEqual([
      "import 'tauri-electron/require'",
      "import 'tauri-electron/renderer-bootstrap'",
      'import "/src/preload.js"',
      'import "/other/pre.js"',
    ])
  })

  it('serves virtual modules under /@id/ in dev and leaves other null-byte ids to Vite', () => {
    const p = plugin({ preload: 'src/preload.js' }, { dev: true })
    const { tags } = p.transformIndexHtml.handler(html, { filename: `${process.cwd()}/index.html` })
    expect(tags[0].attrs.src).toBe('/@id/__x00__virtual:tauri-electron/renderer')
    expect(p.load('\0vite/preload-helper.js')).toBeNull()
    expect(p.resolveId('\0vite/preload-helper.js')).toBeNull()
  })

  /** The main entry's lines, with the app-files description parsed. */
  const mainEntry = (p) => {
    const lines = p.load(p.resolveId('virtual:tauri-electron/main')).trim().split('\n')
    const prefix = 'globalThis.__TAURI_ELECTRON_APP__ = '
    expect(lines.at(-1).startsWith(prefix)).toBe(true)
    return { lines: lines.slice(0, -1), app: JSON.parse(lines.at(-1).slice(prefix.length)) }
  }

  it('gives the main page the Node built-ins, require() and, in dev, the console forwarder first', () => {
    const dev = plugin({}, { dev: true })
    const { tags } = dev.transformIndexHtml.handler(html, { filename: `${process.cwd()}/electron-main.html` })
    expect(tags.map((t) => t.attrs.src)).toEqual(['/@id/__x00__virtual:tauri-electron/console', '/@id/__x00__virtual:tauri-electron/main'])
    expect(dev.load(dev.resolveId('virtual:tauri-electron/console'))).toContain('__tauri-electron/log')
    const { lines, app } = mainEntry(dev)
    expect(lines).toEqual([
      "import 'tauri-electron/node'",
      "import { installRequire } from 'tauri-electron/require'",
      'installRequire({ moduleGlobals: true })',
    ])
    // fs maps /<top-level entry>/… to the project folder in dev.
    expect(app.root).toBe(process.cwd())
    expect(app.entries).toEqual(expect.arrayContaining(['package.json', 'src', 'test']))
    expect(app.entries.some((name) => name.startsWith('.'))).toBe(false)
    expect(mainEntry(plugin({})).app.root).toBeNull() // a build reads <resources>/app

    const build = plugin({})
    expect(build.transformIndexHtml.handler(html, { filename: `${process.cwd()}/electron-main.html` }).tags.map((t) => t.attrs.src)).toEqual([
      'virtual:tauri-electron/main',
    ])
  })

  it('can be told not to touch scripts or provide require()', () => {
    const p = plugin({ require: false, moduleScripts: false })
    const { tags, html: out } = p.transformIndexHtml.handler(html, { filename: `${process.cwd()}/index.html` })
    expect(out).toBe(html)
    expect(p.load(p.resolveId('virtual:tauri-electron/renderer')).trim()).toBe("import 'tauri-electron/renderer-bootstrap'")
    expect(tags).toHaveLength(1)
    // The main page still gets fs & co. and the Buffer global, without require().
    const main = p.transformIndexHtml.handler(html, { filename: `${process.cwd()}/electron-main.html` }).tags
    expect(main.map((t) => t.attrs.src)).toEqual(['virtual:tauri-electron/main'])
    expect(mainEntry(p).lines).toEqual(["import 'tauri-electron/node'"])
  })
})

describe('Node built-ins', () => {
  it('resolve to a stub module instead of failing the build', () => {
    const build = plugin({})
    const dev = plugin({}, { dev: true })
    for (const id of ['zlib', 'node:zlib', 'net', 'node:timers/promises']) {
      const resolved = build.resolveId(id)
      expect(resolved).toContain(id.replace(/^node:/, ''))
      const stub = `nodeBuiltin(${JSON.stringify(id.replace(/^node:/, ''))})`
      expect(build.load(resolved)).toBe(`module.exports = require('tauri-electron/require').${stub}\n`)
      expect(dev.load(resolved)).toContain(`export default ${stub}`)
    }
    expect(NODE_BUILTINS).toContain('zlib')
    expect(NODE_BUILTINS).not.toContain('child_process')
  })

  it('leaves the shimmed built-ins to the aliases and unknown ids to Vite', () => {
    const p = plugin({})
    const shimmed = [
      'path', 'node:path', 'path/win32', 'process', 'node:events', 'url', 'fs', 'node:fs/promises', 'original-fs', 'buffer',
      'util', 'node:util/types', 'sys', 'stream', 'stream/promises', 'string_decoder', 'os', 'child_process', 'crypto', 'http', 'node:https',
    ]
    for (const id of [...shimmed, 'electron', './local.js']) expect(p.resolveId(id), id).toBeNull()
    expect(plugin({ aliasPath: false }).resolveId('node:path')).not.toBeNull()
    const { resolve } = plugin({ preload: 'p.js' }).config({})
    const aliased = (id) => resolve.alias.find((a) => a.find.test(id))?.replacement
    expect(aliased('node:process')).toBe('tauri-electron/process')
    expect(aliased('events')).toBe('tauri-electron/events')
    expect(aliased('node:fs')).toBe('tauri-electron/fs')
    expect(aliased('fs/promises')).toBe('tauri-electron/fs/promises')
    expect(aliased('original-fs')).toBe('tauri-electron/fs')
    expect(aliased('node:buffer')).toBe('tauri-electron/buffer')
    expect(aliased('path/win32')).toBe('tauri-electron/path/win32')
    expect(aliased('node:child_process')).toBe('tauri-electron/child_process')
    expect(aliased('sys')).toBe('tauri-electron/util')
    expect(aliased('string_decoder/')).toBeUndefined() // how readable-stream reaches the npm package
    expect(aliased('buffer/index.js')).toBeUndefined() // how buffer.js reaches the npm package
    expect(aliased('node:url')).toBe('tauri-electron/url')
    expect(aliased('electron/renderer')).toBe('tauri-electron')
  })
})

describe('app files for fs', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { stageAppFiles, appFilesConfig } = (await import('../bundler/shared.cjs')).default

  function project(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-electron-stage-'))
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), content)
    }
    return root
  }
  const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : [])

  it('stages data files in Electron\'s resources/app layout, not sources or dependencies', () => {
    const root = project({
      'src-tauri/electron-resources/.gitignore': '*',
      'src/main.js': '', 'src/data.json': '{}', 'src/styles.css': '', 'assets/logo.png': 'png', 'package.json': '{}',
      'package-lock.json': '{}', 'index.html': '', 'node_modules/x/index.js': '', 'dist/out.js': '', '.env': 'secret',
      'src/.hidden': '', 'tmp/cache.bin': 'x',
    })
    expect(stageAppFiles(root, { exclude: ['dist'] })).toBe(4)
    expect(listing(path.join(root, 'src-tauri/electron-resources/app'))).toEqual(['assets/logo.png', 'package.json', 'src/data.json', 'tmp/cache.bin'].map((f) => f.split('/').join(path.sep)))
    // Restaged from scratch each build; an explicit list stages exactly that.
    expect(stageAppFiles(root, { resources: ['assets', 'src/main.js'] })).toBe(2)
    expect(listing(path.join(root, 'src-tauri/electron-resources/app'))).toEqual(['assets/logo.png', 'src/main.js'].map((f) => f.split('/').join(path.sep)))
    expect(stageAppFiles(root, { resources: false })).toBeNull()
    // The fs mapping: top-level entries, minus dot-files, src-tauri and real system folders.
    expect(appFilesConfig(root, { dev: false })).toEqual({ root: null, entries: ['assets', 'dist', 'index.html', 'node_modules', 'package-lock.json', 'package.json', 'src'] })
  })

  it('does nothing for an app that has not opted in', () => {
    const root = project({ 'src/data.json': '{}', 'src-tauri/tauri.conf.json': '{}' })
    expect(stageAppFiles(root)).toBeNull()
    expect(fs.existsSync(path.join(root, 'src-tauri/electron-resources'))).toBe(false)
  })
})
