/**
 * Menu / MenuItem on top of @tauri-apps/api/menu.
 *
 * Electron builds menus synchronously; Tauri creates native menu resources
 * asynchronously. Menu keeps the Electron-side model and builds the native
 * menu lazily the first time it is used (setApplicationMenu, popup, Tray,
 * BrowserWindow#setMenu).
 */
import {
  Menu as TauriMenu,
  MenuItem as TauriMenuItem,
  Submenu as TauriSubmenu,
  PredefinedMenuItem,
  CheckMenuItem,
} from '@tauri-apps/api/menu'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { EventEmitter } from '../internal/emitter.js'
import { bus } from '../internal/bus.js'
import { toTauriAccelerator } from '../internal/accelerator.js'
import { report } from '../internal/runtime.js'
import { platform } from '../process.js'
import { BrowserWindow } from './browser-window.js'

let nextItemId = 1
let applicationMenu = null

const isMac = platform === 'darwin'

/** Roles Tauri implements natively on every platform. */
const NATIVE_ROLES = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectall: 'SelectAll' }
/** Roles Tauri implements natively on macOS only. */
const MAC_ROLES = {
  undo: 'Undo',
  redo: 'Redo',
  hide: 'Hide',
  hideothers: 'HideOthers',
  unhide: 'ShowAll',
  services: 'Services',
  front: 'BringAllToFront',
  quit: 'Quit',
  minimize: 'Minimize',
  close: 'CloseWindow',
}

const ROLE_LABELS = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteandmatchstyle: 'Paste and Match Style',
  delete: 'Delete', selectall: 'Select All', reload: 'Reload', forcereload: 'Force Reload',
  toggledevtools: 'Toggle Developer Tools', resetzoom: 'Actual Size', zoomin: 'Zoom In', zoomout: 'Zoom Out',
  togglefullscreen: 'Toggle Full Screen', minimize: 'Minimize', close: 'Close', quit: 'Quit', zoom: 'Zoom',
  about: 'About', hide: 'Hide', hideothers: 'Hide Others', unhide: 'Show All', front: 'Bring All to Front',
  window: 'Window', help: 'Help', filemenu: 'File', editmenu: 'Edit', viewmenu: 'View', windowmenu: 'Window',
  appmenu: '', services: 'Services',
}

const ROLE_ACCELERATORS = {
  undo: 'CmdOrCtrl+Z', redo: isMac ? 'Shift+CmdOrCtrl+Z' : 'Ctrl+Y', cut: 'CmdOrCtrl+X', copy: 'CmdOrCtrl+C',
  paste: 'CmdOrCtrl+V', selectall: 'CmdOrCtrl+A', reload: 'CmdOrCtrl+R', forcereload: 'Shift+CmdOrCtrl+R',
  toggledevtools: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I', resetzoom: 'CmdOrCtrl+0', zoomin: 'CmdOrCtrl+Plus',
  zoomout: 'CmdOrCtrl+-', togglefullscreen: isMac ? 'Control+Command+F' : 'F11', minimize: 'CmdOrCtrl+M',
  close: 'CmdOrCtrl+W', quit: isMac ? 'Command+Q' : 'Ctrl+Q',
}

/** Roles implemented in JavaScript against the focused BrowserWindow. */
function roleAction(role) {
  const focused = () => BrowserWindow.getFocusedWindow()
  switch (role) {
    case 'undo': case 'redo': case 'delete':
      return () => focused()?.webContents[role]()
    case 'pasteandmatchstyle':
      return () => focused()?.webContents.paste()
    case 'reload': case 'forcereload':
      return () => focused()?.webContents.reload()
    case 'toggledevtools':
      return () => focused()?.webContents.toggleDevTools()
    case 'resetzoom':
      return () => focused()?.webContents.setZoomFactor(1)
    case 'zoomin':
      return () => { const wc = focused()?.webContents; wc?.setZoomLevel(wc.getZoomLevel() + 0.5) }
    case 'zoomout':
      return () => { const wc = focused()?.webContents; wc?.setZoomLevel(wc.getZoomLevel() - 0.5) }
    case 'togglefullscreen':
      return () => { const win = focused(); win?.setFullScreen(!win.isFullScreen()) }
    case 'minimize':
      return () => focused()?.minimize()
    case 'zoom':
      return () => { const win = focused(); if (win) win.isMaximized() ? win.unmaximize() : win.maximize() }
    case 'close':
      return () => focused()?.close()
    case 'quit':
      return () => bus.emit('quit-requested')
    default:
      return null
  }
}

/** Expansion of Electron's menu roles (editMenu, windowMenu, ...). */
function roleSubmenu(role) {
  switch (role) {
    case 'appmenu':
      return [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }]
    case 'filemenu':
      return [isMac ? { role: 'close' } : { role: 'quit' }]
    case 'editmenu':
      return [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]
    case 'viewmenu':
      return [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    case 'windowmenu':
      return isMac ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
    default:
      return null
  }
}

export class MenuItem {
  constructor(options = {}) {
    const role = options.role ? String(options.role).toLowerCase() : undefined
    this.id = options.id ?? `menu-item-${nextItemId++}`
    this.role = options.role
    this._role = role
    let submenu = options.submenu ?? (role ? roleSubmenu(role) : null)
    if (submenu && !(submenu instanceof Menu)) submenu = Menu.buildFromTemplate(submenu)
    this.submenu = submenu ?? undefined
    this.type = options.type ?? (this.submenu ? 'submenu' : 'normal')
    this._label = options.label ?? (role ? ROLE_LABELS[role] ?? options.role : '')
    this.sublabel = options.sublabel ?? ''
    this.toolTip = options.toolTip ?? ''
    this.accelerator = options.accelerator ?? (role ? ROLE_ACCELERATORS[role] : undefined)
    this.icon = options.icon
    this._enabled = options.enabled !== false
    this.visible = options.visible !== false
    this._checked = Boolean(options.checked)
    this.registerAccelerator = options.registerAccelerator !== false
    this.commandId = nextItemId++
    this.menu = null
    this._userClick = typeof options.click === 'function' ? options.click : null
    this.click = (event, focusedWindow) => {
      if (this.type === 'checkbox') this.checked = !this.checked
      if (this.type === 'radio') this._selectRadio()
      if (this._userClick) return this._userClick(this, focusedWindow ?? BrowserWindow.getFocusedWindow(), event ?? {})
      const action = this._role && roleAction(this._role)
      if (action) action()
    }
    this._native = null
  }

  get label() { return this._label }
  set label(value) { this._label = value; this._native?.setText(value).catch(report('MenuItem.label')) }

  get enabled() { return this._enabled }
  set enabled(value) { this._enabled = Boolean(value); this._native?.setEnabled(Boolean(value)).catch(report('MenuItem.enabled')) }

  get checked() { return this._checked }
  set checked(value) { this._checked = Boolean(value); this._native?.setChecked?.(Boolean(value)).catch(report('MenuItem.checked')) }

  _selectRadio() {
    const items = this.menu?.items ?? []
    const index = items.indexOf(this)
    let start = index
    let end = index
    while (start > 0 && items[start - 1].type === 'radio') start--
    while (end < items.length - 1 && items[end + 1].type === 'radio') end++
    for (let i = start; i <= end; i++) items[i].checked = items[i] === this
  }

  async _build() {
    const role = this._role
    const text = this._label
    if (this.type === 'separator') return PredefinedMenuItem.new({ item: 'Separator' })
    if (this.submenu) {
      const items = await this.submenu._buildItems()
      this._native = await TauriSubmenu.new({ id: this.id, text, enabled: this._enabled, items })
      return this._native
    }
    if (role && !this._userClick) {
      const predefined = NATIVE_ROLES[role] ?? (isMac ? MAC_ROLES[role] : undefined)
      if (predefined) return PredefinedMenuItem.new({ item: predefined, text })
      if (role === 'about') return PredefinedMenuItem.new({ item: { About: null }, text })
    }
    const options = {
      id: this.id,
      text,
      enabled: this._enabled,
      accelerator: toTauriAccelerator(this.accelerator),
      action: () => this.click({ triggeredByAccelerator: false }),
    }
    if (this.type === 'checkbox' || this.type === 'radio') {
      this._native = await CheckMenuItem.new({ ...options, checked: this._checked })
    } else {
      this._native = await TauriMenuItem.new(options)
    }
    return this._native
  }

}

export class Menu extends EventEmitter {
  constructor() {
    super()
    this.items = []
    this._native = null
    this._dirty = true
  }

  static buildFromTemplate(template) {
    const menu = new Menu()
    for (const entry of template) menu.append(entry instanceof MenuItem ? entry : new MenuItem(entry))
    return menu
  }

  static setApplicationMenu(menu) {
    applicationMenu = menu
    const build = menu ? menu._build() : TauriMenu.new({ items: [] })
    build.then((native) => native.setAsAppMenu()).catch(report('Menu.setApplicationMenu'))
  }

  static getApplicationMenu() {
    return applicationMenu
  }

  static sendActionToFirstResponder() {}

  append(item) {
    item.menu = this
    this.items.push(item)
    this._dirty = true
  }

  insert(position, item) {
    item.menu = this
    this.items.splice(position, 0, item)
    this._dirty = true
  }

  getMenuItemById(id) {
    for (const item of this.items) {
      if (item.id === id) return item
      const found = item.submenu?.getMenuItemById(id)
      if (found) return found
    }
    return null
  }

  async _buildItems() {
    const visible = this.items.filter((item) => item.visible)
    return Promise.all(visible.map((item) => item._build()))
  }

  async _build() {
    if (this._native && !this._dirty) return this._native
    this._native = await TauriMenu.new({ items: await this._buildItems() })
    this._dirty = false
    return this._native
  }

  popup(options = {}) {
    const win = options.window ?? BrowserWindow.getFocusedWindow()
    const at = options.x !== undefined && options.y !== undefined ? new LogicalPosition(options.x, options.y) : undefined
    this.emit('menu-will-show', {})
    this._build()
      .then(async (native) => {
        const target = win ? await win._nativeReady.promise : undefined
        await native.popup(at, target)
        this.emit('menu-will-close', {})
        options.callback?.()
      })
      .catch(report('Menu.popup'))
  }

  closePopup() {}
}
