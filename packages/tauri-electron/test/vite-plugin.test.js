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

  it('gives the main page require() and, in dev, the console forwarder first', () => {
    const dev = plugin({}, { dev: true })
    const { tags } = dev.transformIndexHtml.handler(html, { filename: `${process.cwd()}/electron-main.html` })
    expect(tags.map((t) => t.attrs.src)).toEqual(['/@id/__x00__virtual:tauri-electron/console', '/@id/__x00__virtual:tauri-electron/main'])
    expect(dev.load(dev.resolveId('virtual:tauri-electron/console'))).toContain('__tauri-electron/log')
    expect(dev.load(dev.resolveId('virtual:tauri-electron/main')).trim().split('\n')).toEqual([
      "import { installRequire } from 'tauri-electron/require'",
      'installRequire({ moduleGlobals: true })',
    ])

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
    expect(p.transformIndexHtml.handler(html, { filename: `${process.cwd()}/electron-main.html` }).tags).toEqual([])
  })
})

describe('Node built-ins', () => {
  it('resolve to a stub module instead of failing the build', () => {
    const build = plugin({})
    const dev = plugin({}, { dev: true })
    for (const id of ['fs', 'node:fs', 'child_process', 'node:fs/promises']) {
      const resolved = build.resolveId(id)
      expect(resolved).toContain(id.replace(/^node:/, ''))
      const stub = `nodeBuiltin(${JSON.stringify(id.replace(/^node:/, ''))})`
      expect(build.load(resolved)).toBe(`module.exports = require('tauri-electron/require').${stub}\n`)
      expect(dev.load(resolved)).toContain(`export default ${stub}`)
    }
    expect(NODE_BUILTINS).toContain('os')
  })

  it('leaves the shimmed built-ins to the aliases and unknown ids to Vite', () => {
    const p = plugin({})
    for (const id of ['path', 'node:path', 'process', 'node:events', 'url', 'electron', './local.js']) expect(p.resolveId(id), id).toBeNull()
    expect(plugin({ aliasPath: false }).resolveId('node:path')).not.toBeNull()
    const { resolve } = plugin({ preload: 'p.js' }).config({})
    const aliased = (id) => resolve.alias.find((a) => a.find.test(id))?.replacement
    expect(aliased('node:process')).toBe('tauri-electron/process')
    expect(aliased('events')).toBe('tauri-electron/events')
    expect(aliased('node:url')).toBe('tauri-electron/url')
    expect(aliased('electron/renderer')).toBe('tauri-electron')
  })
})
