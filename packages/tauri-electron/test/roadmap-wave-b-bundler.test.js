import { beforeEach, describe, expect, it, vi } from 'vitest'
import nodeFs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { createRequire } from 'node:module'

// Roadmap wave B: electron-updater (B2), schemes from the bundler (B10),
// titleBarOverlay window controls (B8) and message boxes beyond the native
// dialog (B12). tauri-plugin-electron and the Tauri plugins are faked.
const state = vi.hoisted(() => ({ commands: [], sync: [], onCommand: null, onSync: null, features: ['updater'], update: null, packaged: true, notifications: [] }))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => state.update) }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => state.commands.push({ command: 'relaunch' })), exit: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn(), message: vi.fn(async () => 'Cancel') }))
vi.mock('../src/main/notification.js', () => ({
  Notification: class {
    static isSupported() { return true }
    constructor(options) { this.options = options }
    show() { state.notifications.push(this.options) }
  },
}))
vi.mock('../src/main/app.js', async () => {
  const { EventEmitter } = await import('../src/internal/emitter.js')
  const app = new EventEmitter()
  Object.defineProperty(app, 'isPackaged', { get: () => state.packaged })
  app.getVersion = () => '1.2.3'
  app.getName = () => 'Kitchen'
  app.exit = vi.fn()
  return { app }
})
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    hasNativePlugin: () => true,
    hasFeature: (name) => state.features.includes(name),
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand?.(command, args)
    },
    syncRequest(path, body) {
      state.sync.push({ path, body: body && JSON.parse(body) })
      const { status = 200, value } = state.onSync?.(path) ?? {}
      return { status, text: JSON.stringify(value ?? null) }
    },
  }
})

const updater = await import('../src/main/electron-updater.js')
const { dialog, needsMessageWindow, toMessageWindowOptions, defaultCancelId, messageResultToIndex } = await import('../src/main/dialog.js')
const { normalizeOverlay, titlebarAreaRect } = await import('../src/renderer/window-controls.js')
const shared = createRequire(import.meta.url)('../bundler/shared.cjs')
const { redirect } = createRequire(import.meta.url)('../webpack.cjs')
const tauriElectron = (await import('../vite.js')).default

beforeEach(() => {
  state.commands = []
  state.sync = []
  state.onCommand = null
  state.onSync = null
  state.features = ['updater']
  state.update = null
  state.packaged = true
  state.notifications = []
})

/** A fake Tauri Update whose download reports `chunks`. */
function fakeUpdate(chunks = [40, 60]) {
  return {
    version: '2.0.0',
    currentVersion: '1.2.3',
    date: '2026-11-01T10:00:00Z',
    body: 'notes',
    rawJson: {},
    installed: 0,
    async download(onEvent) {
      onEvent({ event: 'Started', data: { contentLength: 100 } })
      for (const chunkLength of chunks) onEvent({ event: 'Progress', data: { chunkLength } })
      onEvent({ event: 'Finished' })
    },
    async install() {
      this.installed++
    },
    async close() {},
  }
}

// --- B2: electron-updater ------------------------------------------------------------------------------

describe('electron-updater', () => {
  it('checks, downloads with progress and reports the update', async () => {
    const autoUpdater = new updater.AppUpdater()
    state.update = fakeUpdate()
    const events = []
    for (const name of ['checking-for-update', 'update-available', 'download-progress', 'update-downloaded']) {
      autoUpdater.on(name, (arg) => events.push([name, arg]))
    }
    const result = await autoUpdater.checkForUpdates()
    expect(result.isUpdateAvailable).toBe(true)
    expect(result.updateInfo).toMatchObject({ version: '2.0.0', releaseNotes: 'notes', releaseDate: '2026-11-01T10:00:00.000Z' })
    expect(await result.downloadPromise).toEqual([])
    expect(events.map(([name]) => name)).toEqual(['checking-for-update', 'update-available', 'download-progress', 'download-progress', 'update-downloaded'])
    expect(events[3][1]).toMatchObject({ total: 100, transferred: 100, percent: 100, delta: 60 })
    expect(events[4][1].version).toBe('2.0.0')
    expect(autoUpdater.currentVersion.version).toBe('1.2.3')
    expect(autoUpdater.currentVersion.compare('1.10.0')).toBe(-1)
  })

  it('reports no update, honours autoDownload and does nothing unpackaged', async () => {
    const autoUpdater = new updater.AppUpdater()
    const notAvailable = vi.fn()
    autoUpdater.on('update-not-available', notAvailable)
    expect((await autoUpdater.checkForUpdates()).isUpdateAvailable).toBe(false)
    expect(notAvailable).toHaveBeenCalledWith(expect.objectContaining({ version: '1.2.3' }))

    autoUpdater.autoDownload = false
    state.update = fakeUpdate()
    const result = await autoUpdater.checkForUpdates()
    expect(result.downloadPromise).toBeUndefined()
    await autoUpdater.downloadUpdate()

    state.packaged = false
    autoUpdater.logger = null
    expect(await autoUpdater.checkForUpdates()).toBeNull()
    autoUpdater.forceDevUpdateConfig = true
    expect(await autoUpdater.checkForUpdates()).not.toBeNull()
  })

  it('rejects a failed download without an error listener instead of hanging', async () => {
    const autoUpdater = new updater.AppUpdater()
    autoUpdater.logger = null
    autoUpdater.autoDownload = false
    state.update = { ...fakeUpdate(), download: async () => { throw new Error('signature mismatch') } }
    await autoUpdater.checkForUpdates()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(autoUpdater.downloadUpdate()).rejects.toThrow('signature mismatch')
    await expect(new updater.AppUpdater().downloadUpdate()).rejects.toThrow('Please check update first')
    spy.mockRestore()
  })

  it('emits error when the updater feature is off', async () => {
    state.features = []
    const autoUpdater = new updater.AppUpdater()
    const onError = vi.fn()
    autoUpdater.on('error', onError)
    await expect(autoUpdater.checkForUpdates()).rejects.toThrow(/updater/)
    expect(onError).toHaveBeenCalled()
  })

  it('notifies, installs on quit and on quitAndInstall', async () => {
    const { app } = await import('../src/main/app.js')
    const autoUpdater = new updater.AppUpdater()
    const update = (state.update = fakeUpdate())
    const result = await autoUpdater.checkForUpdatesAndNotify()
    await result.downloadPromise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.notifications[0].body).toBe('Kitchen version 2.0.0 has been downloaded and will be automatically installed on exit')

    const willQuit = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    app.emit('will-quit', willQuit)
    expect(willQuit.defaultPrevented).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(update.installed).toBe(1)
    expect(app.exit).toHaveBeenCalledWith(0)

    await autoUpdater.quitAndInstall()
    expect(update.installed).toBe(2)
    expect(state.commands.some((c) => c.command === 'relaunch')).toBe(true)
  })

  it('sends the channel and records the feed', async () => {
    const { check } = await import('@tauri-apps/plugin-updater')
    const autoUpdater = new updater.AppUpdater()
    autoUpdater.logger = null
    autoUpdater.channel = 'beta'
    autoUpdater.setFeedURL({ provider: 'generic', url: 'https://example.com/updates' })
    expect(autoUpdater.allowDowngrade).toBe(true)
    expect(autoUpdater.getFeedURL()).toBe('https://example.com/updates')
    await autoUpdater.checkForUpdates()
    expect(check).toHaveBeenLastCalledWith({ headers: { 'X-Electron-Updater-Channel': 'beta', 'X-Electron-Updater-Feed': 'https://example.com/updates' } })
  })

  it('cancels waiting for a download', async () => {
    const autoUpdater = new updater.AppUpdater()
    autoUpdater.autoDownload = false
    state.update = fakeUpdate()
    await autoUpdater.checkForUpdates()
    const token = new updater.CancellationToken()
    const cancelled = vi.fn()
    autoUpdater.on('update-cancelled', cancelled)
    const download = autoUpdater.downloadUpdate(token)
    token.cancel()
    await expect(download).rejects.toBeInstanceOf(updater.CancellationError)
    expect(cancelled).toHaveBeenCalled()
  })

  it('exports electron-updater\'s names', () => {
    for (const name of ['autoUpdater', 'AppUpdater', 'NsisUpdater', 'MacUpdater', 'AppImageUpdater', 'CancellationToken', 'DOWNLOAD_PROGRESS', 'UPDATE_DOWNLOADED']) {
      expect(updater[name], name).toBeDefined()
      expect(updater.default[name], name).toBeDefined()
    }
    expect(updater.autoUpdater).toBeInstanceOf(updater.AppUpdater)
  })

  it('is aliased by the Vite and webpack plugins', () => {
    const config = tauriElectron().config({ root: nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b2-')) })
    const alias = config.resolve.alias.find((a) => a.find.test?.('electron-updater'))
    expect(alias.replacement).toBe('tauri-electron/electron-updater')
    expect(redirect('electron-updater', { userResolved: new Set() })).toMatch(/electron-updater\.js$/)
  })
})

// --- B10: schemes from the bundler --------------------------------------------------------------------

describe('custom schemes', () => {
  it('finds schemes in source', () => {
    const code = `
      protocol.registerSchemesAsPrivileged([{ scheme: 'App', privileges: { standard: true } }, { scheme: "vscode-file" }])
      session.defaultSession.protocol.handle('media', handler)
      protocol.registerFileProtocol(\`atom\`, cb)
      ipcMain.handle('not-a-scheme', fn)`
    expect([...shared.schemesInSource(code)].sort()).toEqual(['app', 'atom', 'media', 'vscode-file'])
  })

  it('collects the app\'s, libraries\' and extra schemes into src-tauri/electron-schemes.json', () => {
    const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b10-'))
    nodeFs.mkdirSync(nodePath.join(root, 'src'))
    nodeFs.mkdirSync(nodePath.join(root, 'node_modules', 'lib'), { recursive: true })
    nodeFs.writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ dependencies: { '@sentry/electron': '^5' } }))
    nodeFs.writeFileSync(nodePath.join(root, 'src', 'main.js'), "protocol.handle('app', h); protocol.handle('https', h)")
    nodeFs.writeFileSync(nodePath.join(root, 'node_modules', 'lib', 'index.js'), "protocol.handle('ignored', h)")
    expect(shared.writeSchemes(root)).toBeNull() // no src-tauri: nothing written
    nodeFs.mkdirSync(nodePath.join(root, 'src-tauri'))
    expect(shared.writeSchemes(root, ['Extra'])).toEqual(['app', 'extra', 'sentry-ipc'])
    const file = nodePath.join(root, 'src-tauri', 'electron-schemes.json')
    expect(JSON.parse(nodeFs.readFileSync(file, 'utf8'))).toEqual(['app', 'extra', 'sentry-ipc'])
    nodeFs.utimesSync(file, new Date(0), new Date(0))
    shared.writeSchemes(root, ['extra'])
    expect(nodeFs.statSync(file).mtimeMs).toBe(0) // same schemes: not rewritten
    expect(shared.writeSchemes(root, false)).toBeNull()
  })

  it('is written by the Vite plugin when the config is resolved', () => {
    const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b10-vite-'))
    nodeFs.mkdirSync(nodePath.join(root, 'src-tauri'))
    nodeFs.writeFileSync(nodePath.join(root, 'main.js'), "protocol.handle('kitchen', h)")
    tauriElectron().configResolved({ root, command: 'serve', build: {} })
    expect(JSON.parse(nodeFs.readFileSync(nodePath.join(root, 'src-tauri', 'electron-schemes.json'), 'utf8'))).toEqual(['kitchen'])
  })
})

// --- B8: titleBarOverlay ----------------------------------------------------------------------------------

describe('titleBarOverlay window controls', () => {
  it('normalizes the overlay and computes the title-bar area', () => {
    expect(normalizeOverlay(false)).toBeNull()
    expect(normalizeOverlay(true)).toMatchObject({ color: 'transparent', height: 32, maximizable: true })
    const overlay = normalizeOverlay({ height: 40 }, { color: '#222', symbolColor: '#fff' })
    expect(overlay).toMatchObject({ color: '#222', symbolColor: '#fff', height: 40 })
    expect(titlebarAreaRect(overlay, 800)).toEqual({ x: 0, y: 0, width: 800 - 3 * 46, height: 40 })
    expect(titlebarAreaRect({ ...overlay, maximizable: false }, 800).width).toBe(800 - 2 * 46)
  })
})

// --- B12: message boxes --------------------------------------------------------------------------------

describe('dialog.showMessageBox beyond the native dialog', () => {
  it('decides when a window is needed and fills in Electron\'s defaults', () => {
    expect(needsMessageWindow({ buttons: ['a', 'b', 'c'] })).toBe(false)
    expect(needsMessageWindow({ buttons: ['a', 'b', 'c', 'd'] })).toBe(true)
    expect(needsMessageWindow({ message: 'x', checkboxLabel: 'Remember' })).toBe(true)
    expect(defaultCancelId(['Save', "Don't Save", '&Cancel'])).toBe(2)
    expect(defaultCancelId(['Yes', 'No'])).toBe(1)
    expect(defaultCancelId(['A', 'B'])).toBe(0)
    const parent = { _label: 'electron-window-1', webContents: {} }
    expect(toMessageWindowOptions({ message: 'm', buttons: ['a', 'b', 'c', 'Cancel'], defaultId: 1 }, parent)).toMatchObject({
      parent: 'electron-window-1', message: 'm', defaultId: 1, cancelId: 3, checkboxChecked: false, type: 'none',
    })
    expect(messageResultToIndex('Cancel', ['A', 'B'], 0)).toBe(0)
    expect(messageResultToIndex('B', ['A', 'B'], 0)).toBe(1)
  })

  it('opens the message-box window with a checkbox, async and sync', async () => {
    state.onCommand = (command) => (command === 'message_box' ? { response: 3, checkboxChecked: true } : undefined)
    const parent = { _label: 'electron-window-7', webContents: {} }
    const result = await dialog.showMessageBox(parent, { message: 'Quit?', buttons: ['a', 'b', 'c', 'd'], checkboxLabel: 'Remember' })
    expect(result).toEqual({ response: 3, checkboxChecked: true })
    expect(state.commands[0].args.options).toMatchObject({ parent: 'electron-window-7', buttons: ['a', 'b', 'c', 'd'], checkboxLabel: 'Remember' })

    state.onSync = (path) => (path === 'dialog/message-window' ? { value: { response: 2, checkboxChecked: false } } : {})
    expect(dialog.showMessageBoxSync({ message: 'x', buttons: ['1', '2', '3', '4'] })).toBe(2)
    expect(state.sync[0].path).toBe('dialog/message-window')
  })

  it('closes the window when the signal aborts', async () => {
    let finish
    state.onCommand = (command) => (command === 'message_box' ? new Promise((resolve) => (finish = resolve)) : undefined)
    const controller = new AbortController()
    const pending = dialog.showMessageBox({ message: 'x', checkboxLabel: 'c', signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    const close = state.commands.find((c) => c.command === 'message_box_close')
    expect(close.args.id).toBe(state.commands[0].args.options.id)
    finish({ response: 0, checkboxChecked: false })
    expect((await pending).response).toBe(0)
  })

  it('maps a dismissed native dialog to cancelId', async () => {
    expect((await dialog.showMessageBox({ message: 'x', buttons: ['A', 'B'], cancelId: 0 })).response).toBe(0)
  })
})
