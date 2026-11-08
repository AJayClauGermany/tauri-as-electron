/**
 * tauri-electron: Electron's JavaScript API on top of Tauri v2.
 *
 * Alias `electron` to this module (the Vite plugin in `tauri-electron/vite`
 * does it for you). Main-process APIs are meant for the hidden
 * `electron-main` window; renderer APIs for every other window - but like
 * Electron, everything is exported from one module.
 */
import { installProcessShim } from './process.js'

installProcessShim()

// Main process
export { app } from './main/app.js'
export { BrowserWindow, BaseWindow, webContents, webFrameMain } from './main/browser-window.js'
export { ipcMain } from './main/ipc-main.js'
export { MessageChannelMain, MessagePortMain } from './main/message-ports.js'
export { dialog } from './main/dialog.js'
export { Menu, MenuItem } from './main/menu.js'
export { Tray } from './main/tray.js'
export { Notification } from './main/notification.js'
export { nativeTheme } from './main/native-theme.js'
export { screen } from './main/screen.js'
export { globalShortcut } from './main/global-shortcut.js'
export { nativeImage, NativeImage } from './main/native-image.js'
export { net } from './main/net.js'
export { protocol } from './main/protocol.js'
export { session } from './main/session.js'
export { autoUpdater } from './main/auto-updater.js'
export { powerMonitor, powerSaveBlocker } from './main/power.js'
export { systemPreferences } from './main/system-preferences.js'
export { safeStorage } from './main/safe-storage.js'
export { crashReporter } from './main/crash-reporter.js'

// Shared
export { shell } from './main/shell.js'
export { clipboard, ClipboardItem } from './main/clipboard.js'

// Renderer
export { ipcRenderer } from './renderer/ipc-renderer.js'
export { contextBridge } from './renderer/context-bridge.js'
export { webFrame } from './renderer/web-frame.js'
export { webUtils } from './renderer/web-utils.js'

// Not implemented (throw NotImplementedError on use) or accepted as no-ops
export {
  contentTracing,
  desktopCapturer,
  inAppPurchase,
  netLog,
  pushNotifications,
  utilityProcess,
  BrowserView,
  WebContentsView,
  ShareMenu,
  TouchBar,
  View,
  ImageView,
  IpcMainServiceWorker,
  sharedTexture,
} from './main/unsupported.js'

export { NotImplementedError } from './internal/runtime.js'

import * as electron from './index.js'
export default electron
