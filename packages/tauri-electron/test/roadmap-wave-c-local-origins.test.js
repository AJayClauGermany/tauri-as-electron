import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Roadmap wave C, C6: IPC and preloads for pages of trusted origins (a local
// server the app starts). tauri-plugin-electron is replaced by a scripted
// fake that reports the declared origins in process_info.
const state = vi.hoisted(() => ({ commands: [], created: [], origins: [], onCommand: null, posted: [] }))

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async (label, event, payload) => state.posted.push({ label, event, payload })),
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    constructor(label, options) {
      this.label = label
      this.options = options
      this.listeners = {}
      state.created.push({ label, options })
    }
    once(event, handler) { (this.listeners[event] ??= []).push(handler) }
    listen() { return Promise.resolve(() => {}) }
    emit(event, payload) { for (const handler of this.listeners[event] ?? []) handler({ event, payload }) }
    // What a created window is asked for (geometry, listeners, replacement).
    onResized() { return Promise.resolve(() => {}) }
    onMoved() { return Promise.resolve(() => {}) }
    onScaleChanged() { return Promise.resolve(() => {}) }
    onFocusChanged() { return Promise.resolve(() => {}) }
    onCloseRequested() { return Promise.resolve(() => {}) }
    destroy() { return Promise.resolve() }
    scaleFactor() { return Promise.resolve(1) }
    outerPosition() { return Promise.resolve({ x: 0, y: 0 }) }
    outerSize() { return Promise.resolve({ width: 420, height: 320 }) }
    innerSize() { return Promise.resolve({ width: 420, height: 320 }) }
    isMaximized() { return Promise.resolve(false) }
    isMinimized() { return Promise.resolve(false) }
    isFullscreen() { return Promise.resolve(false) }
    isVisible() { return Promise.resolve(false) }
  },
  getCurrentWebviewWindow: () => ({ listen: () => Promise.resolve(() => {}) }),
}))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    hasNativePlugin: () => true,
    processInfo: () => ({ execPath: '/x', pid: 1, env: {}, features: [], trustedOrigins: state.origins }),
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand ? state.onCommand(command, args) : true
    },
  }
})

const require = createRequire(import.meta.url)
const trusted = require('../bundler/trusted.cjs')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const KERNEL = { origin: 'http://127.0.0.1:*', scheme: 'http', host: '127.0.0.1', port: null, node: true }
const FIXED = { origin: 'http://localhost:6806', scheme: 'http', host: 'localhost', port: 6806, node: false }

/** A fresh copy of the main-process modules (the registration is once per process). */
async function freshModules() {
  vi.resetModules()
  const origins = await import('../src/main/trusted-origins.js')
  const { BrowserWindow } = await import('../src/main/browser-window.js')
  return { ...origins, BrowserWindow }
}

let fetchMock
beforeEach(() => {
  state.commands = []
  state.created = []
  state.origins = [KERNEL, FIXED]
  state.onCommand = null
  state.posted = []
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'RENDERER_SCRIPT' }))
  vi.stubGlobal('fetch', fetchMock)
  globalThis.__TAURI_ELECTRON_APP__ = { trustedRenderer: '/__tauri-electron/trusted-renderer.js' }
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete globalThis.__TAURI_ELECTRON_APP__
})

describe('trusted origins in the main process', () => {
  it('matches URLs against the declared origins (scheme, host, port or any port)', async () => {
    const { trustedOriginOf } = await freshModules()
    expect(trustedOriginOf('http://127.0.0.1:6806/stage/index.html')).toEqual(KERNEL)
    expect(trustedOriginOf('http://127.0.0.1/')).toEqual(KERNEL)
    expect(trustedOriginOf('http://localhost:6806/a?b#c')).toEqual(FIXED)
    expect(trustedOriginOf('http://localhost:6807/')).toBeNull()
    expect(trustedOriginOf('https://127.0.0.1:6806/')).toBeNull()
    expect(trustedOriginOf('http://127.0.0.2:6806/')).toBeNull()
    expect(trustedOriginOf('index.html')).toBeNull()
    expect(trustedOriginOf('tauri://localhost/index.html')).toBeNull()
    state.origins = []
    expect(trustedOriginOf('http://127.0.0.1:6806/')).toBeNull()
  })

  it('hands the bundled renderer script to tauri-plugin-electron once', async () => {
    const { registerTrustedRenderer, trustedRendererRegistered } = await freshModules()
    const [first, second] = await Promise.all([registerTrustedRenderer(), registerTrustedRenderer()])
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(trustedRendererRegistered()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/__tauri-electron\/trusted-renderer\.js$/)
    expect(state.commands).toEqual([{ command: 'set_trusted_renderer', args: { script: 'RENDERER_SCRIPT' } }])
  })

  it('does nothing without trusted origins, and warns when the bundler built no script', async () => {
    state.origins = []
    let modules = await freshModules()
    expect(await modules.registerTrustedRenderer()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    state.origins = [KERNEL]
    delete globalThis.__TAURI_ELECTRON_APP__
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    modules = await freshModules()
    expect(await modules.registerTrustedRenderer()).toBe(false)
    expect(warn.mock.calls[0][0]).toMatch(/trusted origins.*did not build/)
    expect(state.commands).toEqual([])
    warn.mockRestore()
  })

  it('reports a script that cannot be fetched instead of throwing', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, text: async () => '' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { registerTrustedRenderer, trustedRendererRegistered } = await freshModules()
    expect(await registerTrustedRenderer()).toBe(false)
    expect(trustedRendererRegistered()).toBe(false)
    expect(String(error.mock.calls[0][1])).toContain('404')
    error.mockRestore()
  })
})

describe('BrowserWindow on a trusted origin', () => {
  it('registers the script before the first window is created', async () => {
    const { BrowserWindow } = await freshModules()
    const win = new BrowserWindow({ show: false })
    win.loadURL('http://127.0.0.1:6806/stage/index.html')
    await flush()
    await flush()
    const names = state.commands.map((c) => c.command)
    expect(names).toEqual(['set_window_config', 'set_trusted_renderer', 'create_window'])
    expect(state.commands[2].args.options.url).toBe('http://127.0.0.1:6806/stage/index.html')
    expect(win._trustedRenderer).toBe(true)
  })

  it('treats trusted pages like the app\'s own once the window runs the script', async () => {
    const { BrowserWindow } = await freshModules()
    const win = Object.create(BrowserWindow.prototype)
    win._trustedRenderer = true
    expect(win._hasBootstrap('http://127.0.0.1:6806/')).toBe(true)
    expect(win._hasBootstrap('http://localhost:6806/x')).toBe(true)
    expect(win._hasBootstrap('http://localhost:9999/x')).toBe(false)
    expect(win._hasBootstrap('https://example.com/')).toBe(false)
    expect(win._hasBootstrap('about:blank')).toBe(false)
    expect(win._hasBootstrap('index.html')).toBe(true)
    win._trustedRenderer = false
    expect(win._hasBootstrap('http://127.0.0.1:6806/')).toBe(false)
  })

  it('waits for the bootstrap on trusted pages and synthesizes the load elsewhere', async () => {
    const { BrowserWindow } = await freshModules()
    const win = new BrowserWindow({ show: false })
    win.loadURL('http://127.0.0.1:6806/')
    await flush()
    await flush()
    const loads = []
    win.webContents.on('did-finish-load', () => loads.push(win.webContents.getURL()))
    win.webContents._onPageLoad('started', 'http://127.0.0.1:6806/')
    win.webContents._onPageLoad('finished', 'http://127.0.0.1:6806/')
    expect(loads).toEqual([]) // the bootstrap reports it
    win.webContents._onLifecycle('did-finish-load', { url: 'http://127.0.0.1:6806/', title: 'Kernel' })
    expect(loads).toEqual(['http://127.0.0.1:6806/'])
    win.webContents._onPageLoad('started', 'https://example.com/')
    win.webContents._onPageLoad('finished', 'https://example.com/')
    expect(loads).toEqual(['http://127.0.0.1:6806/', 'https://example.com/'])
  })

  it('navigates in place from a live page to a trusted one', async () => {
    const { BrowserWindow } = await freshModules()
    const win = new BrowserWindow({ show: false })
    win.loadURL('http://127.0.0.1:6806/a')
    await flush()
    await flush()
    win.webContents._onLifecycle('did-finish-load', { url: 'http://127.0.0.1:6806/a' })
    state.commands = []
    win.loadURL('http://127.0.0.1:6806/b')
    await flush()
    expect(state.commands).toEqual([]) // no new native window
    expect(state.posted.at(-1).payload).toMatchObject({ type: 'command', name: 'navigate', url: 'http://127.0.0.1:6806/b' })
    expect(win.webContents._alive).toBe(false)
    // Navigating away to a page off the list (its `unload` lost on the way)
    // leaves nothing to command: loading the trusted page again replaces the window.
    win.webContents._onLifecycle('did-finish-load', { url: 'http://127.0.0.1:6806/b' })
    win.webContents._onPageLoad('started', 'http://localhost:9/elsewhere')
    win.webContents._onPageLoad('finished', 'http://localhost:9/elsewhere')
    expect(win.webContents._alive).toBe(false)
    state.commands = []
    win.loadURL('http://127.0.0.1:6806/c')
    await flush()
    await flush()
    expect(state.commands.map((c) => c.command)).toEqual(['set_window_config', 'create_window'])
    state.commands = []
    // A page off the list cannot be told to navigate: the window is replaced.
    win.webContents._onLifecycle('did-finish-load', { url: 'http://127.0.0.1:6806/b' })
    win.loadURL('https://example.com/')
    await flush()
    await flush()
    expect(state.commands.map((c) => c.command)).toEqual(['set_window_config', 'create_window'])
  })
})

describe('bundler plugins', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-electron-trusted-'))
  const writeConf = (root, name, text) => {
    fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src-tauri', name), text)
  }

  it('build the script when the Tauri configuration declares trusted origins', () => {
    const root = tmp()
    expect(trusted.wantsTrustedRenderer(root)).toBe(false)
    writeConf(root, 'tauri.conf.json', JSON.stringify({ plugins: { electron: { trustedOrigins: [] } } }))
    expect(trusted.wantsTrustedRenderer(root)).toBe(false)
    writeConf(root, 'tauri.conf.json', JSON.stringify({ plugins: { electron: { trustedOrigins: ['http://127.0.0.1:*'] } } }))
    expect(trusted.wantsTrustedRenderer(root)).toBe(true)
    expect(trusted.wantsTrustedRenderer(root, false)).toBe(false)
    expect(trusted.wantsTrustedRenderer(tmp(), true)).toBe(true)
    const other = tmp()
    writeConf(other, 'Tauri.toml', '[plugins.electron]\ntrustedOrigins = ["http://127.0.0.1:*"]\n')
    expect(trusted.wantsTrustedRenderer(other)).toBe(true)
    const platform = tmp()
    writeConf(platform, 'tauri.linux.conf.json', '{ "plugins": { "electron": { "trustedOrigins": ["http://localhost:6806"] } } }')
    expect(trusted.wantsTrustedRenderer(platform)).toBe(true)
  })

  it('Vite: the script starts like a renderer page, with the trusted preload', async () => {
    const root = tmp()
    writeConf(root, 'tauri.conf.json', JSON.stringify({ plugins: { electron: { trustedOrigins: ['http://127.0.0.1:*'] } } }))
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    const tauriElectron = (await import('../vite.js')).default
    const p = tauriElectron({ preload: 'src/preload.js', trustedPreload: 'src/kernel-preload.js', rendererNode: true })
    p.config({ root })
    p.configResolved({ root, command: 'build', build: { outDir: 'dist' } })
    const load = (id) => p.load(p.resolveId(id)).trim().split('\n')
    expect(load('virtual:tauri-electron/trusted-renderer')).toEqual([
      "import 'tauri-electron/require'",
      "import 'tauri-electron/renderer-bootstrap'",
      'import "virtual:tauri-electron/renderer-node"',
      'import "/src/kernel-preload.js"',
    ])
    // Pages keep their own preload; the main process learns where the script is.
    expect(load('virtual:tauri-electron/renderer').at(-1)).toBe('import "/src/preload.js"')
    expect(load('virtual:tauri-electron/main').at(-1)).toContain('"trustedRenderer":"/__tauri-electron/trusted-renderer.js"')
  })

  it('Vite: nothing extra for apps without trusted origins', async () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    const tauriElectron = (await import('../vite.js')).default
    const p = tauriElectron({ preload: 'src/preload.js' })
    p.config({ root })
    p.configResolved({ root, command: 'build', build: { outDir: 'dist' } })
    expect(p.load(p.resolveId('virtual:tauri-electron/main'))).not.toContain('trustedRenderer')
    const emitted = []
    await p.generateBundle.call({ emitFile: (file) => emitted.push(file) })
    expect(emitted).toEqual([])
  })

  it('Vite: builds one classic script with the bootstrap and the preload', async () => {
    const root = tmp()
    writeConf(root, 'tauri.conf.json', JSON.stringify({ plugins: { electron: { trustedOrigins: ['http://127.0.0.1:*'] } } }))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'trusted-fixture', type: 'module' }))
    // `electron` is aliased to tauri-electron, resolved from the project.
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), path.join(root, 'node_modules/tauri-electron'), 'junction')
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src/preload.js'), "const { contextBridge, ipcRenderer } = require('electron')\ncontextBridge.exposeInMainWorld('KERNEL_PRELOAD', { ping: () => ipcRenderer.invoke('ping') })\n")
    const { buildTrustedRenderer } = await import('../bundler/trusted-vite.js')
    const tauriElectron = (await import('../vite.js')).default
    const resolved = { root, mode: 'production', define: {}, resolve: { alias: [] }, build: { target: 'safari13', minify: false } }
    const code = await buildTrustedRenderer({ plugin: tauriElectron, options: { preload: 'src/preload.js' }, entry: 'virtual:tauri-electron/trusted-renderer', resolved, dev: false })
    expect(code).toContain('KERNEL_PRELOAD')
    expect(code).toContain('file drop listener') // the renderer bootstrap
    expect(code).not.toMatch(/^\s*(import|export)\s/m) // a classic script
    expect(code.indexOf('file drop listener')).toBeLessThan(code.indexOf('KERNEL_PRELOAD'))
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false) // nothing written
  }, 60000)
})

describe.each([
  ['webpack', () => require('webpack')],
  ['rspack', () => require('@rspack/core').rspack],
])('TauriElectronPlugin with %s', (name, load) => {
  const { TauriElectronPlugin } = require('../webpack.cjs')
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/webpack-app')

  it('emits the trusted-origins script as one classic file and tells the main process', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `tauri-electron-trusted-${name}-`))
    const bundler = load()
    const stats = await new Promise((resolve, reject) => {
      bundler(
        {
          mode: 'development',
          devtool: 'eval-source-map',
          context: fixture,
          target: 'electron-renderer',
          output: { path: outDir, publicPath: '/' },
          optimization: { runtimeChunk: 'single', splitChunks: { chunks: 'all', minSize: 0 } },
          plugins: [new TauriElectronPlugin({ main: './src/main.js', preload: './src/preload.js', trustedOrigins: true, pages: [{ name: 'main_window', html: './src/index.html', js: './src/renderer.js' }] })],
          infrastructureLogging: { level: 'error' },
        },
        (error, result) => (error ? reject(error) : result.hasErrors() ? reject(new Error(result.toString({ all: false, errors: true }))) : resolve(result)),
      )
    })
    expect(stats).toBeTruthy()
    const script = fs.readFileSync(path.join(outDir, '__tauri-electron/trusted-renderer.js'), 'utf8')
    expect(script).toContain('trackFileDrops()') // the renderer bootstrap
    expect(script).toContain("exposeInMainWorld('api'") // the preload
    expect(script).not.toContain('RENDERER_MARKER') // not the page's own code
    // Run in that order: webpack inlines the entry modules in order; rspack
    // (eval source maps) requires them in order at the end of the file.
    const at = (text, id) => Math.max(script.lastIndexOf(text), script.lastIndexOf(id))
    const order = [at('requireShim.resolve =', 'src/require.js"'), at('trackFileDrops()', 'src/renderer/bootstrap.js"'), at("exposeInMainWorld('api'", 'src/preload.js"')]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(fs.readdirSync(path.join(outDir, '__tauri-electron'))).toEqual(['trusted-renderer.js'])
    if (name === 'webpack') expect(script).not.toContain('webpack-internal:///') // no eval source maps in an initialization script
    expect(fs.readFileSync(path.join(outDir, 'electron-main.js'), 'utf8')).toMatch(/trustedRenderer.{1,6}\/__tauri-electron\/trusted-renderer\.js/)
  }, 60000)
})
