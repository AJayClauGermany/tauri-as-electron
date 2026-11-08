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
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  session,
  systemPreferences,
  desktopCapturer,
  net,
  protocol,
  autoUpdater,
  crashReporter,
} from 'electron'
import path from 'node:path'

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
  try {
    const loaded = waitFor(win.webContents, 'did-finish-load', 10000)
    win.loadFile(path.join(dirname, '../child.html'))
    await loaded
    return await fn(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

let tray = null

export const checks = [
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

  // --- Not implemented in tauri-electron yet (expect "unsupported") -------------------------------
  { id: 'powerMonitor.getSystemIdleState', run: () => powerMonitor.getSystemIdleState(60) },
  { id: 'powerSaveBlocker.start', run: () => { const id = powerSaveBlocker.start('prevent-app-suspension'); powerSaveBlocker.stop(id); return id } },
  { id: 'safeStorage.isEncryptionAvailable', run: () => safeStorage.isEncryptionAvailable() },
  { id: 'session.fromPartition', run: () => typeof session.fromPartition('persist:kitchen').getUserAgent() },
  { id: 'systemPreferences.getAnimationSettings', run: () => JSON.stringify(systemPreferences.getAnimationSettings()) },
  { id: 'desktopCapturer.getSources', run: async () => (await desktopCapturer.getSources({ types: ['screen'] })).length },
  { id: 'net.isOnline', run: () => net.isOnline() },
  { id: 'protocol.isProtocolHandled', run: async () => String(await protocol.isProtocolHandled('https')) },
  { id: 'autoUpdater.getFeedURL', run: () => autoUpdater.getFeedURL() || '(empty)' },
  { id: 'crashReporter.getUploadedReports', run: () => crashReporter.getUploadedReports().length },
]

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
