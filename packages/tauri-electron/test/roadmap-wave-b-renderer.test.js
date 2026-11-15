import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

// Roadmap wave B: B1 (Node built-ins in nodeIntegration / sandbox: false
// windows) and B5 (@electron/remote). The remote module's two halves run in
// one process here, joined by a fake IPC that encodes every message as the
// real transport does.
const state = vi.hoisted(() => ({ windowConfig: null, ipcRenderer: null, sender: null }))

vi.mock('../src/renderer/window-config.js', () => ({ windowConfig: () => state.windowConfig }))

vi.mock('../src/renderer/ipc-renderer.js', async () => {
  const { EventEmitter } = await import('../src/internal/emitter.js')
  const { ipcMain } = await import('../src/main/ipc-main.js')
  const { encode, decode } = await import('../src/internal/serialize.js')
  const wire = (value) => decode(JSON.parse(JSON.stringify(encode(value))))
  class FakeIpcRenderer extends EventEmitter {
    send(channel, ...args) {
      ipcMain.emit(channel, { sender: state.sender }, ...wire(args))
    }
    sendSync(channel, ...args) {
      if (!ipcMain.listenerCount(channel)) return undefined
      const event = { sender: state.sender, returnValue: undefined }
      ipcMain.emit(channel, event, ...wire(args))
      return wire(event.returnValue)
    }
  }
  state.ipcRenderer = new FakeIpcRenderer()
  return { ipcRenderer: state.ipcRenderer }
})

const { EventEmitter } = await import('../src/internal/emitter.js')

/** The main process's view of a renderer: messages it sends arrive on the fake ipcRenderer, later. */
class FakeWebContents extends EventEmitter {
  constructor(id) {
    super()
    this.id = id
  }
  isDestroyed() { return false }
  send(channel, ...args) {
    const { encode, decode } = imports
    const wired = decode(JSON.parse(JSON.stringify(encode(args))))
    setTimeout(() => state.ipcRenderer.emit(channel, {}, ...wired), 0)
  }
}

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.id = FakeWindow.next++
    this.title = options.title ?? ''
    this.webContents = new FakeWebContents(this.id)
    FakeWindow.all.set(this.id, this)
  }
  setTitle(title) { this.title = title }
  getTitle() { return this.title }
  get bounds() { return { width: 10, height: 20 } }
  static fromId(id) { return FakeWindow.all.get(id) ?? null }
  static fromWebContents(contents) { return [...FakeWindow.all.values()].find((w) => w.webContents === contents) ?? null }
}
FakeWindow.next = 1
FakeWindow.all = new Map()

vi.mock('../src/main/browser-window.js', () => ({ BrowserWindow: FakeWindow }))
vi.mock('../src/index.js', () => ({
  app: { getName: () => 'fake-app', getPath: (name) => `/paths/${name}` },
  dialog: { showOpenDialog: async (_win, options) => ({ canceled: false, filePaths: [options.title] }) },
  BrowserWindow: FakeWindow,
  Menu: class Menu {
    constructor() { this.items = [] }
    append(item) { this.items.push(item) }
  },
  MenuItem: class MenuItem {
    constructor(options) { Object.assign(this, options) }
  },
}))

const imports = await import('../src/internal/serialize.js')
const remoteMain = await import('../src/remote/main.js')
const remote = await import('../src/remote/renderer.js')
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('@electron/remote', () => {
  // One renderer page (one webContents) throughout, as in an app.
  const win = new FakeWindow({ title: 'first' })
  state.sender = win.webContents

  it('explains what is missing: initialize() in main, enable(webContents)', () => {
    expect(() => remote.getCurrentWindow()).toThrow(/initialize\(\) in the main process/)
    remoteMain.initialize()
    expect(remoteMain.isInitialized()).toBe(true)
    expect(() => remote.getCurrentWindow()).toThrow(/disabled for this WebContents/)
  })

  it('reaches main-process objects: methods, properties, assignments, modules', () => {
    remoteMain.initialize()
    remoteMain.enable(win.webContents)
    const current = remote.getCurrentWindow()
    expect(current.id).toBe(win.id)
    expect(current.getTitle()).toBe('first')
    current.setTitle('second')
    expect(win.title).toBe('second')
    current.title = 'third'
    expect(win.getTitle()).toBe('third')
    expect(current.bounds).toEqual({ width: 10, height: 20 }) // plain data is copied
    expect(remote.getCurrentWebContents().id).toBe(win.id)
    expect(remote.app.getName()).toBe('fake-app')
    expect(remote.app.getPath('userData')).toBe('/paths/userData')
    // Same main object, same proxy.
    expect(remote.getCurrentWindow()).toBe(current)
    expect(remote.BrowserWindow.fromId(win.id)).toBe(current)
  })

  it('constructs classes and passes remote objects and callbacks back', async () => {
    remoteMain.initialize()
    remoteMain.enable(win.webContents)
    const other = new remote.BrowserWindow({ title: 'made remotely' })
    expect(other.getTitle()).toBe('made remotely')
    expect(FakeWindow.fromId(other.id).title).toBe('made remotely')
    const clicked = vi.fn()
    const menu = new remote.Menu()
    menu.append(new remote.MenuItem({ label: 'Item', click: clicked }))
    expect(menu.items.length).toBe(1)
    expect(menu.items[0].label).toBe('Item')
    // The click handler is a function in the main process that calls back here.
    menu.items[0].click('arg')
    await tick()
    expect(clicked).toHaveBeenCalledWith('arg')
    // Event listeners: main emits, the renderer listener runs (asynchronously).
    const listener = vi.fn()
    const current = remote.getCurrentWindow()
    expect(current.on('custom', listener)).toBe(current)
    win.emit('custom', { reason: 'test' }, 5)
    await tick()
    expect(listener).toHaveBeenCalledWith({ reason: 'test' }, 5)
    // The same renderer function is the same main function (removeListener works).
    current.removeListener('custom', listener)
    expect(win.listenerCount('custom')).toBe(0)
  })

  it('resolves promises, throws errors, serves globals and require()', async () => {
    remoteMain.initialize()
    remoteMain.enable(win.webContents)
    const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), { title: '/picked' })
    expect(result).toEqual({ canceled: false, filePaths: ['/picked'] })
    globalThis.remoteTestGlobal = { answer: 42, fail: () => { throw new TypeError('remote boom') }, later: async () => { throw new Error('later boom') } }
    globalThis.require = (name) => ({ path: { join: (...p) => p.join('/') } })[name]
    try {
      expect(remote.getGlobal('remoteTestGlobal').answer).toBe(42)
      expect(() => remote.getGlobal('remoteTestGlobal').fail()).toThrow(TypeError)
      await expect(remote.getGlobal('remoteTestGlobal').later()).rejects.toThrow('later boom')
      expect(remote.require('path').join('a', 'b')).toBe('a/b')
      expect(remote.require('electron').app.getName()).toBe('fake-app')
    } finally {
      delete globalThis.remoteTestGlobal
      delete globalThis.require
    }
  })

  it('ignores releases from another page', () => {
    remoteMain.initialize()
    remoteMain.enable(win.webContents)
    remote.getCurrentWindow()
    // What FinalizationRegistry sends for a collected proxy, from a page that is gone.
    state.ipcRenderer.send('tauri-electron:remote-release', { contextId: 'other-page', id: 1, count: 1 })
    expect(() => remote.getCurrentWindow().getTitle()).not.toThrow()
  })
})

describe('Node built-ins in renderer windows (B1)', () => {
  it('installs the Node layer only in windows the main process granted', async () => {
    vi.resetModules()
    state.windowConfig = { node: false }
    const denied = await import('../src/renderer/node.js')
    expect(denied.hasNode).toBe(false)
    vi.resetModules()
    state.windowConfig = { node: true }
    const granted = await import('../src/renderer/node.js')
    expect(granted.hasNode).toBe(true)
    const { requireShim } = await import('../src/require.js')
    expect(typeof requireShim('fs').readFileSync).toBe('function')
    expect(requireShim('node:os')).toBeTruthy()
    expect(typeof globalThis.setImmediate).toBe('function')
  })

  it('computes the grant from webPreferences like Electron', async () => {
    vi.resetModules()
    vi.doUnmock('../src/main/browser-window.js')
    vi.doMock('../src/internal/native.js', async (importOriginal) => ({ ...(await importOriginal()), processInfo: () => ({ execPath: '/x', pid: 1, env: { A: '1' } }) }))
    const { BrowserWindow } = await import('../src/main/browser-window.js')
    const config = (webPreferences) => {
      const win = Object.create(BrowserWindow.prototype)
      win._options = { webPreferences }
      win.webContents = { id: 1, _zoomFactor: 1 }
      return win._rendererConfig()
    }
    expect(config({}).node).toBe(false)
    expect(config({}).env).toEqual({})
    expect(config({ nodeIntegration: true }).node).toBe(true)
    expect(config({ nodeIntegration: true }).env).toEqual({ A: '1' })
    expect(config({ sandbox: false }).node).toBe(true)
    expect(config({ nodeIntegration: true, sandbox: true }).node).toBe(false)
    expect(config({ contextIsolation: false }).node).toBe(false)
    // Before Electron 20, preloads were not sandboxed by default.
    globalThis.__TAURI_ELECTRON_APP__ = { electron: 19 }
    try {
      expect(config({}).node).toBe(true)
    } finally {
      delete globalThis.__TAURI_ELECTRON_APP__
    }
    vi.doUnmock('../src/internal/native.js')
  })
})

describe('bundler plugins (B1, B5)', () => {
  const require = createRequire(import.meta.url)
  const shared = require('../bundler/shared.cjs')

  it('detects apps that ask for Node in a window', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-node-'))
    try {
      fs.mkdirSync(path.join(root, 'src'))
      fs.writeFileSync(path.join(root, 'src', 'main.js'), 'new BrowserWindow({ webPreferences: { contextIsolation: true } })')
      expect(shared.rendererNode(root)).toBe(false)
      expect(shared.rendererNode(root, true)).toBe(true)
      fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true })
      fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'nodeIntegration: true')
      expect(shared.rendererNode(root)).toBe(false) // dependencies do not count
      fs.writeFileSync(path.join(root, 'src', 'window.ts'), 'const prefs = { sandbox: false }')
      expect(shared.rendererNode(root)).toBe(true)
      expect(shared.rendererNode(root, false)).toBe(false)
      fs.rmSync(path.join(root, 'src', 'window.ts'))
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '^13.0.0' } }))
      expect(shared.rendererNode(root)).toBe(true) // unsandboxed preloads by default
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('Vite: loads the Node layer before the preloads, aliases @electron/remote', async () => {
    const { default: tauriElectron } = await import('../vite.js')
    const p = tauriElectron({ preload: 'src/preload.js', rendererNode: true })
    const config = p.config({})
    p.configResolved({ root: process.cwd(), command: 'build' })
    const lines = p.load(p.resolveId('virtual:tauri-electron/renderer')).trim().split('\n')
    expect(lines).toEqual([
      "import 'tauri-electron/require'",
      "import 'tauri-electron/renderer-bootstrap'",
      'import "virtual:tauri-electron/renderer-node"',
      'import "/src/preload.js"',
    ])
    const nodeEntry = p.load(p.resolveId('virtual:tauri-electron/renderer-node'))
    expect(nodeEntry).toContain("import { hasNode } from 'tauri-electron/renderer-node'")
    expect(nodeEntry).toContain('globalThis.__TAURI_ELECTRON_APP__ = {')
    const alias = (id) => config.resolve.alias.find((a) => a.find.test(id))?.replacement
    expect(alias('@electron/remote')).toBe('tauri-electron/remote')
    expect(alias('@electron/remote/main')).toBe('tauri-electron/remote/main')
    expect(alias('@electron/remote/renderer')).toBe('tauri-electron/remote/renderer')
    expect(alias('@electron/remotely')).toBeUndefined()
  })

  it('leaves remote.require() alone when rewriting require() of built-ins', () => {
    expect(shared.rewriteBuiltinRequires("remote.require('path').join('a')")).toBe("remote.require('path').join('a')")
    expect(shared.rewriteBuiltinRequires("require('path')")).toContain('m.default')
  })

  it('require() serves @electron/remote', async () => {
    const { requireShim } = await import('../src/require.js')
    expect(typeof requireShim('@electron/remote/main').enable).toBe('function')
    expect(typeof requireShim('@electron/remote').getCurrentWindow).toBe('function')
  })
})
