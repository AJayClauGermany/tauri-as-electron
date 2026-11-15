/**
 * Wire format of the @electron/remote shim (./main.js and ./renderer.js).
 *
 * The renderer asks over `ipcRenderer.sendSync` on `REQUEST` (synchronous,
 * like Electron's remote module). Values travel as trees that the IPC
 * encoding (src/internal/serialize.js) can carry, with markers
 * `{ [MARK]: kind, ... }` for what cannot be copied:
 *
 * - main → renderer: `object` / `function` (a main-process object or
 *   function, with the names of its methods), `promise` (settled later over
 *   `PROMISE`).
 * - renderer → main: `ref` (a remote object sent back), `callback` (a
 *   renderer function; main calls it over `CALLBACK`, asynchronously).
 *
 * Every page load is a new `contextId`, so the main process drops the
 * references of a page that is gone.
 */
export const MARK = '__tauriRemote'
export const REQUEST = 'tauri-electron:remote'
export const RELEASE = 'tauri-electron:remote-release'
export const CALLBACK = 'tauri-electron:remote-callback'
export const PROMISE = 'tauri-electron:remote-promise'

/** Electron modules that are classes (constructed with `new`). */
export const CLASSES = new Set([
  'BrowserWindow', 'BaseWindow', 'BrowserView', 'WebContentsView', 'Menu', 'MenuItem', 'Notification',
  'Tray', 'TouchBar', 'MessageChannelMain', 'ShareMenu',
])

/** Main-process modules `remote.<name>` exposes. */
export const MODULES = [
  'app', 'autoUpdater', 'BaseWindow', 'BrowserView', 'BrowserWindow', 'clipboard', 'contentTracing',
  'crashReporter', 'desktopCapturer', 'dialog', 'globalShortcut', 'inAppPurchase', 'ipcMain', 'Menu',
  'MenuItem', 'MessageChannelMain', 'nativeImage', 'nativeTheme', 'net', 'netLog', 'Notification',
  'powerMonitor', 'powerSaveBlocker', 'protocol', 'pushNotifications', 'safeStorage', 'screen', 'session',
  'ShareMenu', 'shell', 'systemPreferences', 'TouchBar', 'Tray', 'utilityProcess', 'webContents',
  'WebContentsView', 'webFrameMain',
]
