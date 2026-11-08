# API coverage

Legend: ✅ implemented · 🟡 partial / behaves differently · ⚪ accepted as a
no-op (so boilerplate keeps running) · ❌ not implemented (throws
`NotImplementedError`, or warns once for `on`/`once`).

Tauri building block in brackets. "Cached" means a synchronous Electron
getter is served from state tauri-electron keeps up to date, because the
Tauri equivalent is async.

## Main process

### `app` [`@tauri-apps/api/app`, `/path`, `plugin-os`, `plugin-process`]

| API | | Notes |
| --- | --- | --- |
| `whenReady`, `isReady`, events `ready`, `will-finish-launching` | ✅ | `ready` fires after the sync caches below are filled. |
| `getName`, `setName`, `name`, `getVersion` | ✅ | From `tauri.conf.json`. |
| `getLocale`, `getSystemLocale`, `getPreferredSystemLanguages`, `getLocaleCountryCode` | ✅ | Cached. |
| `getPath(name)`, `setPath` | ✅ | Cached. `home`, `appData`, `userData`, `sessionData`, `temp`, `exe`, `module`, `desktop`, `documents`, `downloads`, `music`, `pictures`, `videos`, `logs`, `crashDumps`. `userData` is `<appData>/<identifier>`, not `<appData>/<productName>`. |
| `getAppPath` | 🟡 | Tauri's resource directory. |
| `isPackaged` | 🟡 | `true` when served from the bundled frontend (also in `tauri build --debug`). |
| `quit`, events `before-quit`, `will-quit`, `quit` | ✅ | Windows get `close` (cancelable) first, like Electron. |
| `exit`, `relaunch` | ✅ | `relaunch()` takes effect on the next `quit`/`exit`. |
| `window-all-closed` | ✅ | Without a listener the app quits, like Electron. |
| `browser-window-created`, `browser-window-focus`, `browser-window-blur` | ✅ | |
| `activate` | ✅ | macOS dock click, forwarded by the template's `lib.rs`. |
| `hide`, `show`, `dock.hide/show` | ✅ | macOS only (Tauri limitation). |
| `focus` | 🟡 | Focuses the first window. |
| `setBadgeCount`, `getBadgeCount` | ✅ | Not supported by Tauri on every Linux desktop. |
| `requestSingleInstanceLock` | ⚪ | Always `true`. Add `tauri-plugin-single-instance` for real locking. |
| `setLoginItemSettings`, `setAsDefaultProtocolClient` | ⚪ | Need `plugin-autostart` / `plugin-deep-link`. |
| `commandLine.*`, `disableHardwareAcceleration`, `setAppUserModelId`, `setAboutPanelOptions`, recent documents, jump lists | ⚪ | |
| `open-file`, `open-url`, `second-instance`, `certificate-error`, `login`, … | ❌ | Never emitted. |
| `getFileIcon`, `importCertificate`, `getAppMetrics` (empty) | ❌ | |

### `BrowserWindow` [`WebviewWindow`]

| API | | Notes |
| --- | --- | --- |
| `new BrowserWindow(options)` | ✅ | `width`, `height`, `x`, `y`, `center`, `min*/max*`, `resizable`, `minimizable`, `maximizable`, `closable`, `focusable`, `alwaysOnTop`, `fullscreen`, `kiosk`, `skipTaskbar`, `show`, `frame`, `transparent`, `backgroundColor`, `parent`, `titleBarStyle: 'hidden'`, `trafficLightPosition`, `icon`, `title`, `webPreferences.devTools`, `webPreferences.zoomFactor`, `contentProtection`. The native window is created on the first `loadURL`/`loadFile` (or a blank one on the next tick). `webPreferences.preload` is ignored — the Vite plugin injects the preload. |
| `loadURL`, `loadFile(path, { query, search, hash })`, `reload` | ✅ | Resolve on `did-finish-load`. Remote pages work but have no IPC. |
| `show`, `showInactive`, `hide`, `focus`, `close`, `destroy`, `isVisible`, `isFocused`, `isDestroyed` | ✅ | |
| `minimize`, `maximize`, `unmaximize`, `restore`, `setFullScreen`, `setKiosk` + `is*` | ✅ | Cached; refreshed on resize. |
| `setTitle`, `getTitle`, title follows `<title>` | ✅ | `page-title-updated` is cancelable. |
| `getBounds`, `setBounds`, `getSize`, `setSize`, `getContentSize`, `setContentSize`, `getPosition`, `setPosition`, `center`, `setMinimumSize`, `setMaximumSize` | ✅ | Logical (DIP) units. Cached from window events. |
| `setResizable`, `setMinimizable`, `setMaximizable`, `setClosable`, `setFocusable`, `setAlwaysOnTop`, `setSkipTaskbar`, `setVisibleOnAllWorkspaces`, `setContentProtection`, `setIgnoreMouseEvents`, `setBackgroundColor`, `setHasShadow`, `setProgressBar`, `flashFrame`, `setIcon` | ✅ | |
| `setMenu`, `removeMenu` | ✅ | `removeMenu` sets an empty menu. |
| events `close` (cancelable), `closed`, `focus`, `blur`, `show`, `hide`, `resize`, `move`, `maximize`, `unmaximize`, `minimize`, `restore`, `enter/leave-full-screen`, `ready-to-show` | ✅ | `ready-to-show` fires on the first `did-finish-load`. |
| `getAllWindows`, `getFocusedWindow`, `fromId`, `fromWebContents` | ✅ | |
| `getParentWindow`, `getChildWindows` | ✅ | `setParentWindow` only affects windows created later. |
| `setMovable`, `setOpacity`, `setAspectRatio`, `blur`, menu-bar visibility | ⚪ | State is cached; no native effect. |
| `getNativeWindowHandle`, `capturePage` | ❌ | |
| `BaseWindow` | 🟡 | Alias of `BrowserWindow`. |
| `BrowserView`, `WebContentsView`, `View`, `ImageView` | ❌ | |

### `webContents`

| API | | Notes |
| --- | --- | --- |
| `send`, `postMessage` | ✅ | Queued until the page has loaded. JSON payloads. |
| `executeJavaScript` | ✅ | Result must be JSON-serializable. |
| `insertCSS`, `removeInsertedCSS` | ✅ | |
| `setZoomFactor`, `getZoomFactor`, `setZoomLevel`, `getZoomLevel` | ✅ | |
| `loadURL`, `loadFile`, `reload`, `getURL`, `getTitle`, `isLoading`, `isDestroyed`, `focus`, `isFocused` | ✅ | |
| `undo`, `redo`, `cut`, `copy`, `paste`, `delete`, `selectAll`, `unselect`, `print` | ✅ | Via `document.execCommand` / `window.print`. |
| events `did-finish-load`, `dom-ready`, `page-title-updated`, `destroyed` | ✅ | |
| `webContents.getAllWebContents`, `getFocusedWebContents`, `fromId` | ✅ | |
| `openDevTools`, `closeDevTools`, `toggleDevTools`, `isDevToolsOpened` | ⚪ | Not exposed to JS by Tauri. Right-click → Inspect in debug builds. |
| `setWindowOpenHandler` | ⚪ | Stored, `window.open` not intercepted yet. |
| `capturePage`, `printToPDF`, `session`, navigation events, `console-message`, … | ❌ | |

### IPC

| API | | Notes |
| --- | --- | --- |
| `ipcMain.on/once/removeListener/removeAllListeners` | ✅ | `event.sender`, `event.reply`. |
| `ipcMain.handle/handleOnce/removeHandler` | ✅ | Errors reject the renderer's `invoke` with Electron's message format. |
| `ipcRenderer.send/invoke/on/once/off/removeAllListeners/postMessage` | ✅ | |
| `ipcRenderer.sendSync`, `event.returnValue` | ❌ | Tauri events are async; use `invoke`. |
| `MessageChannelMain`, `MessagePort` transfer | ❌ | |
| `contextBridge.exposeInMainWorld` | 🟡 | Assigns a frozen object to `window`; there is no isolated world. |

### Other modules

| Module | | Notes |
| --- | --- | --- |
| `dialog.showOpenDialog`, `showSaveDialog` | ✅ | [`plugin-dialog`] `properties`: `openFile`, `openDirectory`, `multiSelections`, `createDirectory`; `filters`, `defaultPath`, `title`. |
| `dialog.showMessageBox` | 🟡 | Up to 3 buttons (Tauri limit). `checkboxLabel`, `defaultId`, `cancelId` ignored. |
| `dialog.showErrorBox` | ✅ | |
| `dialog.show*Sync` | ❌ | Use the async versions. |
| `shell.openExternal`, `openPath`, `showItemInFolder` | ✅ | [`plugin-opener`] |
| `shell.beep` | 🟡 | Short WebAudio tone. |
| `shell.trashItem`, `*ShortcutLink` | ❌ | |
| `clipboard.readText`, `writeText`, `write([ClipboardItem])`, `read`, `has`, `clear`, `ClipboardItem` | ✅ | [`plugin-clipboard-manager`] Async, matching Electron 45+. `read()` returns text only. |
| `clipboard.writeHTML`, `writeImage`, `write({ text, html, image })` | ✅ | Pre-45 API, kept for older apps. |
| `clipboard.readHTML/readImage/readRTF/writeRTF/*Bookmark`, `selection` | ❌ | |
| `Menu.buildFromTemplate`, `setApplicationMenu`, `getApplicationMenu`, `popup`, `append`, `insert`, `getMenuItemById` | ✅ | [`@tauri-apps/api/menu`] Built lazily. |
| `MenuItem` (`normal`, `separator`, `submenu`, `checkbox`, `radio`, `click`, `accelerator`, `enabled`, `visible`, `checked`, `label`, `id`) | ✅ | `enabled`/`checked`/`label` changes update the native item. |
| Menu `role`s | 🟡 | Native on all platforms: `cut`, `copy`, `paste`, `selectAll`, `about`. Native on macOS, emulated elsewhere: `undo`, `redo`, `minimize`, `close`, `quit`. Emulated: `reload`, `forceReload`, `zoomIn/Out`, `resetZoom`, `togglefullscreen`, `zoom`, `delete`. Submenu roles `appMenu`, `fileMenu`, `editMenu`, `viewMenu`, `windowMenu` expand to defaults. |
| `Tray` | ✅ | [`TrayIcon`] `setImage`, `setToolTip`, `setTitle`, `setContextMenu`, `destroy`, events `click`, `right-click`, `middle-click`, `double-click`, `mouse-enter/leave/move`. Click events are not delivered on Linux (Tauri limitation). |
| `Notification` | 🟡 | [`plugin-notification`] `title`, `subtitle`, `body`, `silent`, `icon`; events `show`, `failed`. `click`/`action`/`reply` not supported on desktop. |
| `nativeTheme` | ✅ | `shouldUseDarkColors`, `themeSource`, `updated`. |
| `screen` | 🟡 | Cached `getPrimaryDisplay`, `getAllDisplays`, `getDisplayNearestPoint`, `getDisplayMatching`; `getCursorScreenPoint` returns a Promise. No display events. |
| `globalShortcut` | ✅ | [`plugin-global-shortcut`] `register` returns `true` optimistically; failures are logged and unregister the key. |
| `nativeImage` | 🟡 | `createFromPath` (fetched from the app; `public/x.png` → `/x.png`), `createFromDataURL`, `createFromBuffer`, `createEmpty`, `toDataURL`, `toPNG`, `isEmpty`. No resizing or size info. |
| `process` | 🟡 | `platform`, `arch`, `versions`, `env` (empty), `cwd`, `exit`, `nextTick`, `getSystemVersion`. |
| `path` / `node:path` | ✅ | POSIX implementation. |
| `webFrame` | 🟡 | Zoom, `insertCSS`, `executeJavaScript`. |
| `webUtils.getPathForFile` | 🟡 | Returns `file.path` if present. |
| `autoUpdater`, `crashReporter`, `contentTracing`, `desktopCapturer`, `inAppPurchase`, `net`, `netLog`, `powerMonitor`, `powerSaveBlocker`, `protocol`, `pushNotifications`, `safeStorage`, `session`, `sharedTexture`, `systemPreferences`, `utilityProcess`, `webFrameMain`, `ShareMenu`, `TouchBar`, `IpcMainServiceWorker` | ❌ | Present so imports resolve. Good next candidates: `autoUpdater` → `plugin-updater`, `net` → `fetch`/`plugin-http`, `powerMonitor` idle → a small Rust command, `safeStorage` → keyring. |

## Node.js built-ins

The main process runs in a webview, so `fs`, `child_process`, `os`,
`crypto` (Node flavour) and friends are not available. Only `path` is
shimmed. Use Tauri plugins (`plugin-fs`, `plugin-shell`, `plugin-http`,
`plugin-store`) or Rust commands instead.
