// Main-process checks. Each check exercises one Electron API exactly the way
// an Electron app would, so this file runs unchanged on Electron and on
// Tauri (through tauri-electron). `auto` checks run without user input;
// `manual` ones open dialogs, notifications, etc. and are run on click.
import {
  app,
  BrowserWindow,
  webContents,
  ipcMain,
  dialog,
  shell,
  clipboard,
  ClipboardItem,
  Menu,
  MenuItem,
  Tray,
  Notification,
  nativeTheme,
  nativeImage,
  screen,
  globalShortcut,
  desktopCapturer,
  contentTracing,
  utilityProcess,
  MessageChannelMain,
  session,
  protocol,
} from 'electron'
import path from 'node:path'
import { moduleChecks } from './checks-modules.js'
import { nodeChecks } from './checks-node.js'
import { layer2Checks } from './checks-node-layer2.js'

const isElectron = Boolean(process.versions.electron)

const dirname = import.meta.dirname

// 1x1 transparent PNG
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function waitFor(emitter, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeout)
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Opens child.html in a hidden window, runs `fn`, always closes it. */
async function withChildWindow(fn, options = {}) {
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 320,
    webPreferences: { preload: path.join(dirname, 'preload.mjs'), sandbox: false },
    ...options,
  })
  // Smoke runs print how long each phase of opening the window took.
  const start = Date.now()
  const phases = []
  for (const name of ['did-start-loading', 'dom-ready', 'did-finish-load']) {
    win.webContents.once(name, () => phases.push(`${name} +${Date.now() - start}ms`))
  }
  try {
    const loaded = waitFor(win.webContents, 'did-finish-load', 10000)
    win.loadFile(path.join(dirname, '../child.html'))
    await loaded
    const result = await fn(win)
    globalThis.kitchenTrace?.(`window ${win.id}: ${phases.join(', ')}, done +${Date.now() - start}ms`)
    return result
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

let tray = null

const coreChecks = [
  // --- app -------------------------------------------------------------------
  { id: 'app.isReady', run: () => { assert(app.isReady() === true, 'ready'); return true } },
  { id: 'app.whenReady', run: async () => { await app.whenReady(); return 'resolved' } },
  { id: 'app.getName', run: () => { const v = app.getName(); assert(v, 'non-empty'); return v } },
  { id: 'app.getVersion', run: () => { const v = app.getVersion(); assert(/^\d+\.\d+/.test(v), 'semver'); return v } },
  { id: 'app.getLocale', run: () => { const v = app.getLocale(); assert(v, 'non-empty'); return v } },
  { id: 'app.getAppPath', run: () => app.getAppPath() },
  ...['home', 'appData', 'userData', 'temp', 'desktop', 'documents', 'downloads', 'logs'].map((name) => ({
    id: `app.getPath('${name}')`,
    run: () => { const v = app.getPath(name); assert(v, 'non-empty'); return v },
  })),
  { id: 'app.isPackaged', run: () => { assert(typeof app.isPackaged === 'boolean', 'boolean'); return app.isPackaged } },
  { id: 'app.setBadgeCount', run: () => { app.setBadgeCount(3); const v = app.getBadgeCount(); app.setBadgeCount(0); assert(v === 3, 'badge 3'); return v } },
  { id: 'app.requestSingleInstanceLock', run: () => app.requestSingleInstanceLock() },
  { id: 'app.on(browser-window-created)', run: async () => {
    const created = waitFor(app, 'browser-window-created')
    await withChildWindow(async () => { await created })
    return 'emitted'
  } },
  { id: 'app.quit', manual: true, run: () => { app.quit(); return 'quitting' } },
  { id: 'app.relaunch + app.exit', manual: true, run: () => { app.relaunch(); app.exit(0); return 'relaunching' } },
  { id: 'app.hide / app.show (macOS)', manual: true, run: async () => { app.hide(); await sleep(1000); app.show(); return 'done' } },

  // --- process ---------------------------------------------------------------
  { id: 'process.platform', run: () => { assert(['darwin', 'win32', 'linux'].includes(process.platform), 'known platform'); return process.platform } },
  { id: 'process.arch', run: () => process.arch },
  { id: 'process.versions', run: () => JSON.stringify(process.versions).slice(0, 120) },
  // CommonJS Electron code: tauri-electron provides require() for electron, path and process.
  // (This file is an ES module, so on Electron itself `require` is not defined.)
  { id: "require('electron') / require('node:path')", run: () => {
    if (typeof require !== 'function') return isElectron ? 'n/a: ESM main process on Electron' : 'no require()'
    assert(require('electron').app === app, "require('electron').app is app")
    assert(require('node:path').join === path.join, "require('node:path') is the path module")
    assert(require('process').platform === process.platform, "require('process')")
    assert(typeof require('events').EventEmitter === 'function', "require('events')")
    assert(require('url').fileURLToPath('file:///a/b%20c') === '/a/b c', "require('url')")
    return 'same modules as import'
  } },
  { id: "require('fs') works, require('zlib') explains itself", run: () => {
    if (typeof require !== 'function') return isElectron ? 'n/a: ESM main process on Electron' : 'no require()'
    // fs is implemented (tauri-plugin-electron's "node-fs" feature).
    assert(require('fs').existsSync(app.getPath('temp')) === true, "require('fs').existsSync")
    try {
      // Other built-ins load; their members throw when called (the same in dev
      // and in production builds, which turn require() into imports).
      require('zlib').gzipSync('x')
    } catch (error) {
      if (isElectron) return 'n/a: Node is available on Electron'
      assert(error.name === 'NotImplementedError' && error.reason === 'unsupported', `${error.name} ${error.reason}`)
      assert(/CompressionStream/.test(error.message), error.message)
      return error.message
    }
    if (isElectron) return 'n/a: Node is available on Electron'
    throw new Error('did not throw')
  } },
  { id: 'NotImplementedError carries a reason', run: async () => {
    const error = await desktopCapturer.getSources({ types: ['screen'] }).then(() => null, (e) => e)
    if (!error) return isElectron ? 'n/a: implemented on Electron' : 'desktopCapturer worked?'
    assert(error.name === 'NotImplementedError', error.name)
    assert(['unimplemented', 'unsupported', 'feature', 'plugin', 'permission'].includes(error.reason), `reason ${error.reason}`)
    return `${error.reason}: ${error.message}`
  } },

  // --- BrowserWindow / webContents ----------------------------------------------
  { id: 'BrowserWindow + loadFile + did-finish-load', run: () => withChildWindow((win) => win.webContents.getURL()) },
  { id: 'BrowserWindow ready-to-show', run: async () => {
    const win = new BrowserWindow({ show: false, width: 300, height: 200 })
    try {
      const ready = waitFor(win, 'ready-to-show', 10000)
      win.loadFile(path.join(dirname, '../child.html'))
      await ready
      return 'emitted'
    } finally {
      win.destroy()
    }
  } },
  { id: 'BrowserWindow title follows <title>', run: () => withChildWindow(async (win) => {
    await sleep(300)
    assert(win.getTitle() === 'Kitchen Sink Child', `title was "${win.getTitle()}"`)
    return win.getTitle()
  }) },
  { id: 'BrowserWindow.setTitle/getTitle', run: () => withChildWindow((win) => { win.setTitle('Renamed'); assert(win.getTitle() === 'Renamed', 'title'); return win.getTitle() }) },
  { id: 'BrowserWindow.setSize/getSize', run: () => withChildWindow((win) => { win.setSize(500, 360); const [w, h] = win.getSize(); assert(w === 500 && h === 360, `size ${w}x${h}`); return `${w}x${h}` }) },
  { id: 'BrowserWindow.setPosition/getPosition', run: () => withChildWindow((win) => { win.setPosition(40, 50); const [x, y] = win.getPosition(); assert(x === 40 && y === 50, `pos ${x},${y}`); return `${x},${y}` }) },
  { id: 'BrowserWindow.getBounds', run: () => withChildWindow((win) => JSON.stringify(win.getBounds())) },
  { id: 'BrowserWindow.show/isVisible/hide', run: () => withChildWindow(async (win) => {
    assert(!win.isVisible(), 'initially hidden')
    win.show()
    assert(win.isVisible(), 'visible after show')
    await sleep(300)
    win.hide()
    assert(!win.isVisible(), 'hidden after hide')
    return 'ok'
  }) },
  { id: 'BrowserWindow.setResizable/isResizable', run: () => withChildWindow((win) => { win.setResizable(false); assert(!win.isResizable(), 'not resizable'); return 'ok' }) },
  { id: 'BrowserWindow.setAlwaysOnTop/isAlwaysOnTop', run: () => withChildWindow((win) => { win.setAlwaysOnTop(true); assert(win.isAlwaysOnTop(), 'on top'); return 'ok' }) },
  { id: 'BrowserWindow.getAllWindows/fromId', run: () => withChildWindow((win) => {
    assert(BrowserWindow.getAllWindows().includes(win), 'listed')
    assert(BrowserWindow.fromId(win.id) === win, 'fromId')
    return BrowserWindow.getAllWindows().length
  }) },
  { id: 'BrowserWindow close event + closed', run: async () => {
    const win = new BrowserWindow({ show: false })
    const loaded = waitFor(win.webContents, 'did-finish-load', 10000)
    win.loadFile(path.join(dirname, '../child.html'))
    await loaded
    let prevented = false
    win.once('close', (event) => { if (!prevented) { prevented = true; event.preventDefault() } })
    win.close()
    await sleep(500)
    assert(!win.isDestroyed(), 'close was prevented')
    const closed = waitFor(win, 'closed')
    win.close()
    await closed
    assert(win.isDestroyed(), 'destroyed')
    return 'prevented once, then closed'
  } },
  { id: 'webContents.send ↔ ipcMain.on', run: () => withChildWindow(async (win) => {
    const pong = new Promise((resolve) => ipcMain.once('kitchen:child-pong', (event, value) => resolve({ event, value })))
    win.webContents.send('kitchen:child-ping', { n: 42 })
    const { event, value } = await pong
    assert(value?.n === 42, 'payload round-trip')
    assert(BrowserWindow.fromWebContents(event.sender) === win, 'fromWebContents(event.sender)')
    return 'round-trip ok'
  }) },
  { id: 'webContents.executeJavaScript', run: () => withChildWindow(async (win) => {
    const v = await win.webContents.executeJavaScript('document.title + " / " + (6 * 7)')
    assert(v === 'Kitchen Sink Child / 42', `got ${v}`)
    return v
  }) },
  { id: 'webContents.insertCSS', run: () => withChildWindow(async (win) => {
    await win.webContents.insertCSS('body { background: rgb(1, 2, 3) }')
    const bg = await win.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor')
    assert(bg === 'rgb(1, 2, 3)', `background ${bg}`)
    return bg
  }) },
  { id: 'webContents.setZoomFactor/getZoomFactor', run: () => withChildWindow((win) => { win.webContents.setZoomFactor(1.5); assert(win.webContents.getZoomFactor() === 1.5, 'zoom'); return 1.5 }) },
  { id: 'webContents.getAllWebContents/fromId', run: () => withChildWindow((win) => {
    assert(webContents.getAllWebContents().includes(win.webContents), 'listed')
    assert(webContents.fromId(win.webContents.id) === win.webContents, 'fromId')
    return 'ok'
  }) },
  { id: 'webContents.openDevTools', manual: true, run: () => { BrowserWindow.getFocusedWindow()?.webContents.openDevTools(); return 'requested' } },
  { id: 'BrowserWindow: open visible child', manual: true, run: async () => {
    const win = new BrowserWindow({ width: 480, height: 360, webPreferences: { preload: path.join(dirname, 'preload.mjs'), sandbox: false } })
    await win.loadFile(path.join(dirname, '../child.html'))
    return `window ${win.id}`
  } },
  { id: 'BrowserWindow.maximize/unmaximize (focused)', manual: true, run: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    win.maximize()
    await sleep(800)
    const maximized = win.isMaximized()
    win.unmaximize()
    return `isMaximized() after maximize: ${maximized}`
  } },
  { id: 'BrowserWindow.minimize/restore (focused)', manual: true, run: async () => {
    const win = BrowserWindow.getAllWindows()[0]
    win.minimize()
    await sleep(1000)
    win.restore()
    return 'done'
  } },
  { id: 'BrowserWindow.setFullScreen (focused, 2s)', manual: true, run: async () => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setFullScreen(true)
    await sleep(2000)
    win.setFullScreen(false)
    return 'done'
  } },
  { id: 'BrowserWindow.setProgressBar(0.5)', manual: true, run: () => { BrowserWindow.getAllWindows()[0].setProgressBar(0.5); return 'set' } },
  { id: 'BrowserWindow.flashFrame', manual: true, run: () => { BrowserWindow.getAllWindows()[0].flashFrame(true); return 'flashing' } },

  // --- ipcMain ------------------------------------------------------------------------
  { id: 'ipcMain.handle (duplicate throws)', run: () => {
    ipcMain.handle('kitchen:dup', () => 1)
    try {
      ipcMain.handle('kitchen:dup', () => 2)
      throw new Error('second handle() did not throw')
    } catch (error) {
      assert(/second handler/.test(error.message), error.message)
      return 'throws'
    } finally {
      ipcMain.removeHandler('kitchen:dup')
    }
  } },

  // --- dialog ---------------------------------------------------------------------------
  { id: 'dialog.showOpenDialog', manual: true, run: async () => JSON.stringify(await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'All files', extensions: ['*'] }] })) },
  { id: 'dialog.showOpenDialog (directory)', manual: true, run: async () => JSON.stringify(await dialog.showOpenDialog({ properties: ['openDirectory'] })) },
  { id: 'dialog.showSaveDialog', manual: true, run: async () => JSON.stringify(await dialog.showSaveDialog({ defaultPath: 'untitled.txt' })) },
  { id: 'dialog.showMessageBox', manual: true, run: async () => JSON.stringify(await dialog.showMessageBox({ type: 'question', message: 'Save changes?', detail: 'Pick one.', buttons: ['Save', "Don't Save", 'Cancel'] })) },
  { id: 'dialog.showErrorBox', manual: true, run: () => { dialog.showErrorBox('Kitchen sink', 'This is an error box.'); return 'shown' } },
  { id: 'dialog.showMessageBoxSync', manual: true, run: () => dialog.showMessageBoxSync({ message: 'A synchronous message box', buttons: ['OK'] }) },
  { id: 'dialog.showOpenDialogSync', manual: true, run: () => JSON.stringify(dialog.showOpenDialogSync({ properties: ['openFile'] })) },

  // --- shell -------------------------------------------------------------------------------
  { id: 'shell.openExternal', manual: true, run: async () => { await shell.openExternal('https://tauri.app'); return 'opened' } },
  { id: 'shell.openPath(home)', manual: true, run: async () => { const error = await shell.openPath(app.getPath('home')); return error || 'opened' } },
  { id: 'shell.showItemInFolder(downloads)', manual: true, run: () => { shell.showItemInFolder(app.getPath('downloads')); return 'requested' } },
  { id: 'shell.beep', run: () => { shell.beep(); return 'beeped' } },
  { id: 'shell.trashItem', manual: true, run: async () => { await shell.trashItem(path.join(app.getPath('temp'), 'kitchen-sink-does-not-exist')); return 'ok' } },

  // --- clipboard ------------------------------------------------------------------------------
  { id: 'clipboard.writeText/readText', run: async () => {
    const text = `kitchen-sink-${Math.random().toString(36).slice(2)}`
    await clipboard.writeText(text) // Promise since Electron 45; fire-and-forget before
    const read = await clipboard.readText() // Promise since Electron 45; sync before
    assert(read === text, `read "${read}"`)
    return read
  } },
  { id: 'clipboard.write([ClipboardItem])', run: async () => {
    await clipboard.write([new ClipboardItem({ 'text/html': '<b>kitchen sink</b>', 'text/plain': 'kitchen sink' })])
    return 'written'
  } },
  { id: 'clipboard.has/read', run: async () => {
    await clipboard.writeText('has-read')
    assert(await clipboard.has('text/plain'), 'has text/plain')
    const [item] = await clipboard.read()
    const text = await (await item.getType('text/plain')).text()
    assert(text === 'has-read', `read ${text}`)
    return item.types.join(',')
  } },
  { id: 'clipboard.writeHTML (removed in Electron 45)', run: () => {
    if (typeof clipboard.writeHTML !== 'function') return 'not in this Electron version'
    clipboard.writeHTML('<b>kitchen sink</b>')
    return 'written'
  } },

  // --- nativeTheme ---------------------------------------------------------------------------
  { id: 'nativeTheme.shouldUseDarkColors', run: () => { assert(typeof nativeTheme.shouldUseDarkColors === 'boolean', 'boolean'); return nativeTheme.shouldUseDarkColors } },
  { id: 'nativeTheme.themeSource', run: () => {
    nativeTheme.themeSource = 'dark'
    const dark = nativeTheme.shouldUseDarkColors
    nativeTheme.themeSource = 'system'
    assert(dark === true, 'dark when forced')
    return 'dark → system'
  } },

  // --- screen -------------------------------------------------------------------------------
  { id: 'screen.getPrimaryDisplay', run: () => { const d = screen.getPrimaryDisplay(); assert(d?.bounds?.width > 0, 'has bounds'); return JSON.stringify(d.bounds) } },
  { id: 'screen.getAllDisplays', run: () => { const all = screen.getAllDisplays(); assert(all.length >= 1, 'at least one'); return all.length } },
  { id: 'screen.getDisplayNearestPoint', run: () => { const d = screen.getDisplayNearestPoint({ x: 0, y: 0 }); assert(d, 'found'); return d.id } },
  { id: 'screen.getCursorScreenPoint', run: async () => { const p = await screen.getCursorScreenPoint(); assert(typeof p.x === 'number', 'point'); return JSON.stringify(p) } },

  // --- globalShortcut ------------------------------------------------------------------------
  { id: 'globalShortcut.register/isRegistered/unregister', run: async () => {
    const accelerator = 'CommandOrControl+Alt+Shift+K'
    const ok = globalShortcut.register(accelerator, () => console.log('shortcut pressed'))
    assert(ok, 'register returned true')
    await sleep(200)
    assert(globalShortcut.isRegistered(accelerator), 'isRegistered')
    globalShortcut.unregister(accelerator)
    assert(!globalShortcut.isRegistered(accelerator), 'unregistered')
    return 'ok'
  } },

  // --- Menu --------------------------------------------------------------------------------
  { id: 'Menu.buildFromTemplate/getMenuItemById', run: () => {
    const menu = Menu.buildFromTemplate([{ label: 'File', submenu: [{ id: 'ks-open', label: 'Open', accelerator: 'CmdOrCtrl+O' }, { type: 'separator' }, { role: 'quit' }] }])
    const item = menu.getMenuItemById('ks-open')
    assert(item?.label === 'Open', 'found item')
    return menu.items.length
  } },
  { id: 'MenuItem checkbox click toggles', run: () => {
    let clicked = false
    const item = new MenuItem({ type: 'checkbox', label: 'Check', checked: false, click: () => (clicked = true) })
    const menu = new Menu()
    menu.append(item)
    item.click()
    assert(clicked && item.checked, 'clicked + checked')
    return 'ok'
  } },
  { id: 'Menu radio group', run: () => {
    const menu = Menu.buildFromTemplate([{ id: 'a', type: 'radio', label: 'A', checked: true }, { id: 'b', type: 'radio', label: 'B' }])
    menu.getMenuItemById('b').click()
    assert(!menu.getMenuItemById('a').checked && menu.getMenuItemById('b').checked, 'exclusive')
    return 'ok'
  } },
  { id: 'Menu.setApplicationMenu', run: () => {
    Menu.setApplicationMenu(applicationMenu())
    assert(Menu.getApplicationMenu(), 'set')
    return 'set'
  } },

  // --- Tray ----------------------------------------------------------------------------------
  { id: 'new Tray + setContextMenu', manual: true, run: () => {
    tray?.destroy()
    tray = new Tray(nativeImage.createFromPath(path.join(dirname, '../public/tray.png') /* served at /tray.png by Vite */))
    tray.setToolTip('Kitchen sink tray')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Say hi', click: () => new Notification({ title: 'Tray', body: 'Hi from the tray menu' }).show() }, { type: 'separator' }, { label: 'Destroy tray', click: () => tray.destroy() }]))
    tray.on('click', () => console.log('tray clicked'))
    return 'created'
  } },

  // --- Notification -------------------------------------------------------------------------
  { id: 'Notification.isSupported', run: () => Notification.isSupported() },
  { id: 'new Notification().show()', manual: true, run: async () => {
    const n = new Notification({ title: 'Kitchen sink', body: 'Hello from the main process' })
    const shown = waitFor(n, 'show', 10000)
    n.show()
    await shown
    return 'shown'
  } },

  // --- nativeImage --------------------------------------------------------------------------
  { id: 'nativeImage.createFromDataURL', run: () => { const img = nativeImage.createFromDataURL(PNG_DATA_URL); assert(!img.isEmpty(), 'not empty'); return img.toDataURL().slice(0, 30) + '…' } },
  { id: 'nativeImage.createEmpty', run: () => { assert(nativeImage.createEmpty().isEmpty(), 'empty'); return 'ok' } },

  // --- path (Node built-in) ------------------------------------------------------------------
  { id: "path.join(__dirname, '..', 'index.html')", run: () => path.join(dirname, '..', 'index.html') },

  // --- APIs on the main code path of VS Code / GitHub Desktop ---------------------------
  { id: 'process.argv / execPath', run: () => {
    assert(process.argv.length >= 1 && process.execPath, `argv ${JSON.stringify(process.argv)}`)
    return `${process.argv.length} args, ${process.execPath}`
  } },
  { id: 'process.env', run: () => { assert(Object.keys(process.env).some((k) => k.toUpperCase() === 'PATH'), 'PATH set'); return `${Object.keys(process.env).length} vars` } },
  { id: 'app.commandLine.appendSwitch/hasSwitch', run: () => {
    app.commandLine.appendSwitch('kitchen-switch', '7')
    assert(app.commandLine.hasSwitch('kitchen-switch') && app.commandLine.getSwitchValue('kitchen-switch') === '7', 'switch')
    return 'ok'
  } },
  { id: 'app.getLoginItemSettings', run: () => JSON.stringify(app.getLoginItemSettings().openAtLogin) },
  { id: 'app.on(web-contents-created)', run: async () => {
    const created = waitFor(app, 'web-contents-created')
    await withChildWindow(async () => { await created })
    return 'emitted'
  } },
  { id: 'MessageChannelMain (in-process)', run: async () => {
    const { port1, port2 } = new MessageChannelMain()
    const received = new Promise((resolve) => port2.once('message', (event) => resolve(event.data)))
    port2.start()
    port1.postMessage({ bytes: new Uint8Array([1, 2, 3]) })
    const data = await received
    assert(data.bytes instanceof Uint8Array && data.bytes[2] === 3, 'structured clone')
    return 'ok'
  } },
  { id: 'webContents.postMessage(MessagePortMain) ↔ renderer', run: () => withChildWindow(async (win) => {
    const { port1, port2 } = new MessageChannelMain()
    const echoed = new Promise((resolve) => port1.once('message', (event) => resolve(event.data)))
    port1.start()
    win.webContents.postMessage('kitchen:port-echo', null, [port2])
    port1.postMessage('hello')
    const data = await Promise.race([echoed, sleep(5000).then(() => 'timeout')])
    assert(data === 'hello!', `got ${data}`)
    return data
  }) },
  { id: 'IpcMainEvent.senderFrame.url', run: () => withChildWindow(async (win) => {
    const pong = new Promise((resolve) => ipcMain.once('kitchen:child-pong', (event) => resolve(event)))
    win.webContents.send('kitchen:child-ping', 1)
    const event = await pong
    assert(event.senderFrame?.url?.includes('child.html'), `url ${event.senderFrame?.url}`)
    assert(event.processId === win.webContents.getProcessId(), 'processId')
    return event.senderFrame.url
  }) },
  { id: 'webContents.ipc.handle (per-window handler)', run: () => withChildWindow(async (win) => {
    win.webContents.ipc.handle('kitchen:scoped', () => 'scoped')
    const value = await win.webContents.executeJavaScript("window.kitchen.invoke('kitchen:scoped')")
    assert(value === 'scoped', `got ${value}`)
    return value
  }) },
  { id: 'webContents events did-start-loading / did-navigate', run: async () => {
    const win = new BrowserWindow({ show: false })
    try {
      const started = waitFor(win.webContents, 'did-start-loading', 10000)
      const navigated = waitFor(win.webContents, 'did-navigate', 10000)
      win.loadFile(path.join(dirname, '../child.html'))
      await started
      const [, url] = await navigated
      assert(url.includes('child.html'), url)
      return url
    } finally {
      win.destroy()
    }
  } },
  { id: 'setWindowOpenHandler (deny)', run: () => withChildWindow(async (win) => {
    const before = BrowserWindow.getAllWindows().length
    const details = new Promise((resolve) => win.webContents.setWindowOpenHandler((d) => { resolve(d); return { action: 'deny' } }))
    await win.webContents.executeJavaScript("window.open('https://example.com/opened', '_blank'); 1")
    const d = await Promise.race([details, sleep(5000).then(() => null)])
    assert(d?.url === 'https://example.com/opened', `details ${JSON.stringify(d)}`)
    await sleep(300)
    assert(BrowserWindow.getAllWindows().length === before, 'no window created')
    return d.disposition
  }) },
  { id: 'setWindowOpenHandler (allow) + did-create-window', run: () => withChildWindow(async (win) => {
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 300, height: 200 } }))
    const created = waitFor(win.webContents, 'did-create-window', 5000)
    await win.webContents.executeJavaScript("window.open('child.html?opened=1'); 1")
    const [child] = await created
    try {
      assert(child instanceof BrowserWindow, 'BrowserWindow')
      return `window ${child.id}`
    } finally {
      child.destroy()
    }
  }) },
  { id: 'will-navigate (preventDefault)', run: () => withChildWindow(async (win) => {
    const url = new Promise((resolve) => win.webContents.on('will-navigate', (event, u) => { event.preventDefault(); resolve(u) }))
    await sleep(100)
    await win.webContents.executeJavaScript("const a = document.createElement('a'); a.href = 'https://example.com/nav'; document.body.append(a); a.click(); 1")
    const u = await Promise.race([url, sleep(5000).then(() => 'timeout')])
    assert(u === 'https://example.com/nav', u)
    await sleep(300)
    assert(win.webContents.getURL().includes('child.html'), 'navigation prevented')
    return u
  }) },
  { id: "webContents.on('console-message')", run: () => withChildWindow(async (win) => {
    const message = new Promise((resolve) => win.webContents.on('console-message', (event, _level, text) => (event.message ?? text) === 'kitchen-console' && resolve(event.message ?? text)))
    await sleep(100)
    await win.webContents.executeJavaScript("console.log('kitchen-console'); 1")
    return Promise.race([message, sleep(5000).then(() => { throw new Error('no console-message') })])
  }) },
  { id: "webContents.on('context-menu')", run: () => withChildWindow(async (win) => {
    if (isElectron) return 'Electron only reports native right-clicks (not synthetic events)'
    const params = new Promise((resolve) => win.webContents.on('context-menu', (_event, p) => resolve(p)))
    await sleep(100)
    await win.webContents.executeJavaScript("document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34, button: 2 })); 1")
    const p = await Promise.race([params, sleep(5000).then(() => null)])
    assert(p?.x === 12 && p?.y === 34 && p.editFlags, `params ${p && Object.keys(p).join(',')}`)
    return `x=${p.x} y=${p.y}`
  }) },
  { id: 'webContents.findInPage → found-in-page', run: () => withChildWindow(async (win) => {
    const result = new Promise((resolve) => win.webContents.on('found-in-page', (_event, r) => r.finalUpdate && resolve(r)))
    win.webContents.findInPage('window')
    const r = await Promise.race([result, sleep(5000).then(() => null)])
    win.webContents.stopFindInPage('clearSelection')
    assert(r, 'no found-in-page event')
    // Chromium finds nothing in a hidden window; tauri-electron searches the DOM.
    if (!isElectron) assert(r.matches >= 1, JSON.stringify(r))
    return `${r.matches} matches`
  }) },
  { id: 'webContents.navigationHistory', run: () => withChildWindow(async (win) => {
    const history = win.webContents.navigationHistory
    assert(!history.canGoBack(), 'cannot go back initially')
    await win.loadFile(path.join(dirname, '../child.html'), { query: { page: '2' } })
    await sleep(300)
    assert(history.canGoBack(), `can go back (${history.length()} entries)`)
    const back = waitFor(win.webContents, 'did-navigate', 10000)
    history.goBack()
    await back
    assert(history.getActiveIndex() === 0 && history.canGoForward(), `index ${history.getActiveIndex()}`)
    return `${history.length()} entries`
  }) },
  { id: 'webContents.zoomFactor property', run: () => withChildWindow((win) => { win.webContents.zoomFactor = 1.25; assert(win.webContents.getZoomFactor() === 1.25, 'zoom'); return win.webContents.zoomLevel.toFixed(2) }) },
  { id: 'webContents.getOSProcessId', run: () => withChildWindow((win) => { const pid = win.webContents.getOSProcessId(); assert(pid > 0, `pid ${pid}`); return pid }) },
  { id: 'webContents.session === session.defaultSession', run: () => withChildWindow((win) => { assert(win.webContents.session === session.defaultSession, 'default session'); return 'ok' }) },
  { id: 'webPreferences.additionalArguments → process.argv', run: () => withChildWindow(async (win) => {
    const argv = await win.webContents.executeJavaScript('window.kitchen.argv')
    assert(argv.includes('--kitchen-arg=42'), JSON.stringify(argv))
    return '--kitchen-arg=42'
  }, { webPreferences: { preload: path.join(dirname, 'preload.mjs'), sandbox: false, additionalArguments: ['--kitchen-arg=42'] } }) },
  { id: 'protocol.handle → BrowserWindow.loadURL(kitchen://)', run: async () => {
    if (!(await protocol.isProtocolHandled('kitchen'))) await moduleChecks.find((c) => c.id === "protocol.handle('kitchen')").run()
    const win = new BrowserWindow({ show: false })
    try {
      const loaded = waitFor(win.webContents, 'did-finish-load', 10000)
      win.loadURL('kitchen://localhost/hello')
      await loaded
      await sleep(200)
      assert(win.webContents.getURL().includes('hello'), win.webContents.getURL())
      return win.webContents.getURL()
    } finally {
      win.destroy()
    }
  } },
  { id: 'BrowserWindow.setEnabled/isEnabled', run: () => withChildWindow((win) => { win.setEnabled(false); const disabled = !win.isEnabled(); win.setEnabled(true); assert(disabled && win.isEnabled(), 'toggled'); return 'ok' }) },
  { id: 'BrowserWindow.getNormalBounds', run: () => withChildWindow((win) => JSON.stringify(win.getNormalBounds())) },
  { id: 'webContents.toggleDevTools', manual: true, run: () => { BrowserWindow.getAllWindows()[0].webContents.toggleDevTools(); return 'toggled' } },
  { id: 'Frameless window: -webkit-app-region drag + file drop', manual: true, run: async () => {
    const win = new BrowserWindow({ width: 520, height: 360, frame: false, webPreferences: { preload: path.join(dirname, 'preload.mjs'), sandbox: false } })
    await win.loadFile(path.join(dirname, '../child.html'), { query: { frameless: '1' } })
    return 'drag the header; drop files on the window'
  } },

  // --- Not implemented in tauri-electron (expect "unsupported") ---------------------------
  { id: 'desktopCapturer.getSources', run: async () => (await desktopCapturer.getSources({ types: ['screen'] })).length },
  { id: 'utilityProcess.fork', run: () => { const child = utilityProcess.fork(path.join(dirname, 'no-such-module.js')); child.kill(); return 'forked' } },
  { id: 'contentTracing.getCategories', run: async () => (await contentTracing.getCategories()).length },
]

// Module checks override same-named core checks.
const moduleIds = new Set(moduleChecks.map((c) => c.id))
export const checks = [...coreChecks.filter((c) => !moduleIds.has(c.id)), ...moduleChecks, ...nodeChecks, ...layer2Checks]

export function applicationMenu() {
  const isMac = process.platform === 'darwin'
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Child Window', accelerator: 'CmdOrCtrl+N', click: () => checks.find((c) => c.id === 'BrowserWindow: open visible child').run() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Electron docs', click: () => shell.openExternal('https://www.electronjs.org/docs/latest/api/app') }],
    },
  ])
}
