# API coverage

Legend: ✅ implemented · 🟡 partial / behaves differently · ⚪ accepted as a
no-op (so boilerplate keeps running; warns once) · ❌ not implemented yet,
but Tauri could support it (throws `NotImplementedError` with
`reason: 'unimplemented'`, or warns once for `on`/`once`) · 🚫 not possible
on Tauri and not planned (`reason: 'unsupported'`: Node.js built-ins,
Chromium-only features, Electron's view hierarchy).

Every `NotImplementedError` carries a `reason` (`unimplemented`,
`unsupported`, `feature`, `plugin`, `permission`) and a hint; see
[Reading errors](MIGRATING.md#6-reading-errors) for what each one asks you
to do.

The Tauri building block is in brackets. **Cached** means a synchronous
Electron getter is served from state that tauri-electron keeps up to date,
because the Tauri equivalent is async. **[native]** means
[`tauri-plugin-electron`](../crates/tauri-plugin-electron), the small Rust
plugin in this repository that covers what Tauri's JS API and official
plugins cannot. Without it, those APIs fall back or report themselves as
unsupported.

Modules backed by an official plugin are switched on or off with
[`tauri-plugin-electron`'s Cargo features](../crates/tauri-plugin-electron/README.md#features)
(for example `features = ["single-instance", "updater"]`); a module whose
feature is off fails with an error naming the feature or the plugin.

To see which of these APIs VS Code and GitHub Desktop rely on, read
[TARGET-APPS.md](TARGET-APPS.md).

## Security defaults

tauri-electron follows Electron's defaults. `tauri-plugin-electron` grants
the matching capabilities at startup (add files in `src-tauri/capabilities/`
for more):

| Electron | Default | tauri-electron |
| --- | --- | --- |
| Main process | full access | `electron-main` capability: every API listed here, unrestricted `net` (`http:default` scoped to `http(s)://**`) |
| `contextIsolation` | `true` | Renderer capability allows only IPC, zoom, `window.close()` and window dragging. The preload shares the page's world (there is no isolated world), so with isolation on, `process.env` is **not** exposed to renderers. |
| `nodeIntegration` | `false` | No Node.js in webviews. With `nodeIntegration: true` or `contextIsolation: false`, the renderer's `process.env` is filled in, like Electron. Node modules are still unavailable. |
| `sandbox` | `true` | Reported as `process.sandboxed`. |
| `webPreferences.devTools` | `true` | Tauri `devtools` (debug builds, or the `devtools` feature of `tauri-plugin-electron`). |
| `webPreferences.javascript` | `true` | `javascriptDisabled` |
| `webPreferences.backgroundThrottling` | `true` | `backgroundThrottling: 'disabled'` when `false` |
| Built-in context menu | none | The webview's default menu is suppressed; use `webContents.on('context-menu')`. |
| `window.open` | opens a `BrowserWindow` | Same: it goes through `setWindowOpenHandler` (default: allow) |
| Single instance | off (opt-in with `requestSingleInstanceLock()`) | Off. Opt in at build time with the `single-instance` feature of `tauri-plugin-electron`. |

## Main process

### `app` [`@tauri-apps/api/app`, `/path`, `plugin-os`, `plugin-process`, `plugin-deep-link`, `plugin-autostart`, `plugin-single-instance` (opt-in), native]

| API | | Notes |
| --- | --- | --- |
| `whenReady`, `isReady`, events `ready`, `will-finish-launching` | ✅ | `ready` fires after the sync caches below are filled. |
| `getName`, `setName`, `name`, `getVersion` | ✅ | From `tauri.conf.json`. |
| `getLocale`, `getSystemLocale`, `getPreferredSystemLanguages`, `getLocaleCountryCode` | ✅ | Cached. |
| `getPath(name)`, `setPath`, `setAppLogsPath` | ✅ | Cached. `home`, `appData`, `userData`, `sessionData`, `temp`, `exe` (real executable, [native]), `module`, `desktop`, `documents`, `downloads`, `music`, `pictures`, `videos`, `logs`, `crashDumps`. `userData` is `<appData>/<identifier>`, not `<appData>/<productName>`. |
| `getAppPath` | 🟡 | Tauri's resource directory. |
| `isPackaged` | 🟡 | `true` when served from the bundled frontend (also in `tauri build --debug`). |
| `quit`, events `before-quit`, `will-quit`, `quit` | ✅ | Windows get `close` (cancelable) first, like Electron. |
| `exit`, `relaunch` | ✅ | `relaunch()` takes effect on the next `quit`/`exit`. |
| `window-all-closed` | ✅ | Without a listener the app quits, like Electron. |
| `browser-window-created`, `browser-window-focus`, `browser-window-blur`, `web-contents-created` | ✅ | |
| `activate` | ✅ | macOS dock click [native]. |
| `requestSingleInstanceLock`, `hasSingleInstanceLock`, `releaseSingleInstanceLock`, `second-instance` | 🟡 | Opt-in [native `single-instance` feature → `plugin-single-instance`]. The lock is taken at startup, so a second launch exits before its main process runs instead of `requestSingleInstanceLock()` returning `false`. `second-instance` gets `(event, argv, workingDirectory)`; `additionalData` is `{}`. Without the feature, `requestSingleInstanceLock()` warns and returns `true`. |
| `open-file`, `open-url` | ✅ | macOS [native `RunEvent::Opened`]. On Windows/Linux the URL is in `process.argv` / `second-instance`, like Electron. |
| `setAsDefaultProtocolClient`, `isDefaultProtocolClient`, `removeAsDefaultProtocolClient` | ✅ | [`plugin-deep-link`] Async registration; on macOS declare schemes in `plugins.deep-link.desktop.schemes`. |
| `setLoginItemSettings`, `getLoginItemSettings` | 🟡 | [`plugin-autostart`] `openAtLogin` only; cached. |
| `commandLine.hasSwitch`, `getSwitchValue`, `appendSwitch`, `appendArgument`, `removeSwitch` | ✅ | Reads the real `process.argv` [native]. Appended switches do not reach the webview engine. |
| `hide`, `show`, `dock.hide/show` | ✅ | macOS only (Tauri limitation). |
| `focus` | 🟡 | Focuses the first window. |
| `setBadgeCount`, `getBadgeCount`, `badgeCount` | ✅ | Not supported by Tauri on every Linux desktop. |
| `applicationMenu`, `accessibilitySupportEnabled`, `userAgentFallback`, `runningUnderARM64Translation` | ✅ | Properties. |
| `getAppMetrics`, `getGPUFeatureStatus`, `getGPUInfo` | 🟡 | One process entry with the real pid; placeholder values. |
| `resolveProxy` | 🟡 | Always `DIRECT`. |
| `disableHardwareAcceleration`, `setAppUserModelId`, `setAboutPanelOptions`, `setProxy`, recent documents, jump lists, user activities, `isInApplicationsFolder` (`false`) | ⚪ | |
| `certificate-error`, `login`, `render-process-gone`, `child-process-gone`, … | 🚫 | Never emitted: Chromium process and network events. |
| `getFileIcon`, `getApplicationInfoForProtocol` | ❌ | Need a Rust command. |
| `importCertificate` | 🚫 | The webview uses the OS certificate store. |

### `BrowserWindow` [`WebviewWindow`]

| API | | Notes |
| --- | --- | --- |
| `new BrowserWindow(options)` | ✅ | `width`, `height`, `x`, `y`, `center`, `min*/max*`, `resizable`, `minimizable`, `maximizable`, `closable`, `focusable`, `alwaysOnTop`, `fullscreen`, `kiosk`, `skipTaskbar`, `show`, `frame`, `transparent`, `backgroundColor`, `parent`, `modal` (disables the parent off macOS), `hasShadow`, `titleBarStyle` (`hidden*` → overlay on macOS, frameless elsewhere, like Electron), `trafficLightPosition`, `tabbingIdentifier`, `icon`, `title`, `contentProtection`, `autoHideMenuBar`. The native window is created on the first `loadURL`/`loadFile` (or a blank one on the next tick). `tauri: { … }` passes extra `WebviewWindow` options. |
| `webPreferences` | 🟡 | `preload` (the Vite plugin injects it; this path is ignored), `additionalArguments` (→ renderer `process.argv` [native]), `devTools`, `zoomFactor`, `javascript`, `backgroundThrottling`, `partition` / `session`, `contextIsolation` / `nodeIntegration` / `sandbox` (see Security defaults). `spellcheck`, `webSecurity`, `enableBlinkFeatures` are ignored. |
| `loadURL`, `loadFile(path, { query, search, hash })`, `reload` | ✅ | Resolve on `did-finish-load`. Remote pages work but have no IPC. Custom schemes served by `protocol.handle` load too. `file://` URLs load the app page at that path (like `loadFile`). |
| `show`, `showInactive`, `hide`, `focus`, `close`, `destroy`, `isVisible`, `isFocused`, `isDestroyed`, `setEnabled`, `isEnabled` | ✅ | |
| `minimize`, `maximize`, `unmaximize`, `restore`, `setFullScreen`, `setSimpleFullScreen`, `setKiosk` + `is*` | ✅ | Cached; refreshed on resize. |
| `setTitle`, `getTitle`, title follows `<title>` | ✅ | `page-title-updated` is cancelable. |
| `getBounds`, `setBounds`, `getSize`, `setSize`, `getContentSize`, `setContentSize`, `getPosition`, `setPosition`, `center`, `setMinimumSize`, `setMaximumSize`, `getNormalBounds` | ✅ | Logical (DIP) units. Cached from window events. |
| `setResizable`, `setMinimizable`, `setMaximizable`, `setClosable`, `setFocusable`, `setAlwaysOnTop`, `setSkipTaskbar`, `setVisibleOnAllWorkspaces`, `setContentProtection`, `setIgnoreMouseEvents`, `setBackgroundColor`, `setHasShadow`, `setProgressBar`, `flashFrame`, `setIcon`, `setOverlayIcon` | ✅ | |
| `setMenu`, `removeMenu` | ✅ | `removeMenu` sets an empty menu. |
| events `close` (cancelable), `closed`, `focus`, `blur`, `show`, `hide`, `resize`, `move`, `maximize`, `unmaximize`, `minimize`, `restore`, `enter/leave-full-screen`, `ready-to-show` | ✅ | `ready-to-show` fires on the first `did-finish-load`. |
| `getAllWindows`, `getFocusedWindow`, `fromId`, `fromWebContents` | ✅ | |
| `getParentWindow`, `getChildWindows` | ✅ | `setParentWindow` only affects windows created later. |
| `-webkit-app-region: drag / no-drag` | ✅ | Implemented by the renderer bootstrap (inline styles, `<style>` and same-origin style sheets). Double-click toggles maximize. |
| `setMovable`, `setOpacity`, `setAspectRatio`, `blur`, menu-bar visibility, `setTitleBarOverlay`, `setWindowButtonPosition/Visibility`, `setTouchBar`, tabs, `setVibrancy`, thumbar buttons, `setRepresentedFilename`, `setDocumentEdited` | ⚪ | State is cached; no native effect. |
| `getNativeWindowHandle`, `capturePage`, `getMediaSourceId` | 🚫 | Handles exist only in Rust; no page capture or screen capture in Tauri. |
| `BaseWindow` | 🟡 | Alias of `BrowserWindow`. |
| `BrowserView`, `View`, `ImageView` | 🚫 | A Tauri window holds one webview. |
| `WebContentsView` | ❌ | Tauri's multi-webview windows (unstable) could back it. |

### `webContents`

| API | | Notes |
| --- | --- | --- |
| `send`, `postMessage(channel, message, [MessagePortMain])` | ✅ | Queued until the page has loaded. Structured-clone payloads. |
| `ipc` (per-window `IpcMain`) | ✅ | Listeners run before `ipcMain`'s; `invoke` prefers its handlers. |
| `executeJavaScript`, `executeJavaScriptInIsolatedWorld` | ✅ | Result must be structured-cloneable. There is a single world. |
| `insertCSS`, `removeInsertedCSS` | ✅ | |
| `setZoomFactor`, `getZoomFactor`, `setZoomLevel`, `getZoomLevel`, `zoomFactor`, `zoomLevel`, `setVisualZoomLevelLimits` (no-op) | ✅ | |
| `loadURL`, `loadFile`, `reload`, `stop`, `getURL`, `getTitle`, `isLoading`, `isDestroyed`, `focus`, `isFocused`, `getOSProcessId` (app pid), `getProcessId` | ✅ | |
| `navigationHistory` (`canGoBack`, `goBack`, `goToIndex`, `getActiveIndex`, `length`, `getAllEntries`, `clear`, …) and the deprecated `canGoBack`/`goBack`/… | 🟡 | Tracked from navigation events; navigates with `history.go()`. |
| `undo`, `redo`, `cut`, `copy`, `paste`, `delete`, `selectAll`, `unselect`, `insertText`, `replaceMisspelling`, `print` | ✅ | Via `document.execCommand` / `window.print`. |
| `findInPage`, `stopFindInPage`, `found-in-page` | 🟡 | `window.find()`; one final update per request. |
| `openDevTools`, `closeDevTools`, `toggleDevTools`, `isDevToolsOpened`, `devtools-opened/closed` | ✅ | [native] Debug builds, or the plugin's `devtools` feature. |
| `setWindowOpenHandler`, `did-create-window` | ✅ | `window.open()` and `target=_blank` / middle / modifier clicks are routed through it. `window.open()` returns `null` (Electron returns a proxy). Allowed windows inherit the opener's `webPreferences`. |
| events `did-start-loading`, `did-stop-loading`, `did-start-navigation`, `did-navigate`, `did-navigate-in-page`, `dom-ready`, `did-finish-load`, `page-title-updated`, `destroyed`, `focus`, `blur` | ✅ | Navigation events come from Tauri's page-load hook [native], including for remote pages. |
| `will-navigate`, `will-frame-navigate` | 🟡 | Cancelable for link clicks; navigations started by script (`location.href = …`) are not intercepted. |
| `context-menu` | ✅ | Electron-shaped params (`x`, `y`, `linkURL`, `selectionText`, `isEditable`, `editFlags`, …). No spell-check suggestions. |
| `console-message` | ✅ | Both the event-object and positional signatures. |
| `before-input-event` | 🟡 | Reported after the page sees the key; `preventDefault()` has no effect. |
| `did-fail-load` | 🟡 | Only when the window cannot be created. |
| `zoom-changed` | ✅ | Ctrl + mouse wheel. |
| `mainFrame` (`url`, `origin`, `routingId`, `processId`, `send`, `postMessage`, `executeJavaScript`, …), `webFrameMain.fromId` | 🟡 | One frame per page; iframes are not modelled. |
| `session` | 🟡 | See `session`. |
| `setUserAgent`, `getUserAgent`, `setAudioMuted`, `setBackgroundThrottling`, `setWebRTCIPHandlingPolicy`, … | 🟡 | User agent applies to windows created afterwards. |
| `webContents.getAllWebContents`, `getFocusedWebContents`, `fromId`, `fromFrame` | ✅ | |
| `capturePage`, `printToPDF`, `savePage`, `debugger`, frame subscriptions | 🚫 | Chromium-only. `print()` opens the system dialog, which can save a PDF. |
| `downloadURL` | ❌ | `net.fetch()` + `@tauri-apps/plugin-fs` meanwhile. |

### IPC

| API | | Notes |
| --- | --- | --- |
| Payloads | ✅ | Structured-clone-like: `Uint8Array` and other typed arrays, `ArrayBuffer`, `Date`, `Map`, `Set`, `RegExp`, `BigInt`, `Error`, `undefined`, `NaN`/`±Infinity`. Functions throw `An object could not be cloned.` Cycles are not supported. |
| `ipcMain.on/once/removeListener/removeAllListeners` | ✅ | `event.sender`, `event.senderFrame`, `event.processId`, `event.frameId`, `event.ports`, `event.reply`. |
| `ipcMain.handle/handleOnce/removeHandler` | ✅ | Errors reject the renderer's `invoke` with Electron's message format. |
| `ipcRenderer.send/invoke/on/once/off/removeAllListeners/sendToHost` | ✅ | |
| `ipcRenderer.sendSync`, `event.returnValue` | ✅ | [native] A blocking request to the plugin's URI scheme, answered when a listener sets `returnValue` (also after an `await`). Times out after 25 s. Without the plugin: async send, returns `undefined`. |
| `ipcRenderer.postMessage(channel, message, [MessagePort])` | ✅ | Main receives `MessagePortMain`s in `event.ports`. |
| `MessageChannelMain`, `MessagePortMain` | ✅ | Main ↔ main, main ↔ renderer and renderer ↔ renderer (a port received from one window can be posted to another). Ports cannot be transferred *through* a port. |
| `contextBridge.exposeInMainWorld` | 🟡 | Assigns a frozen object to `window`; there is no isolated world. |

### Other modules

| Module | | Notes |
| --- | --- | --- |
| `dialog.showOpenDialog`, `showSaveDialog` | ✅ | [`plugin-dialog`] `properties`: `openFile`, `openDirectory`, `multiSelections`, `createDirectory`; `filters`, `defaultPath`, `title`. |
| `dialog.showMessageBox` | 🟡 | Up to 3 buttons (Tauri limit). `checkboxLabel`, `defaultId`, `cancelId` ignored. |
| `dialog.showErrorBox` | ✅ | |
| `dialog.showOpenDialogSync`, `showSaveDialogSync`, `showMessageBoxSync` | ✅ | [native + `plugin-dialog`] Blocking dialogs through the synchronous bridge. |
| `dialog.showCertificateTrustDialog` | 🚫 | |
| `shell.openExternal`, `openPath`, `showItemInFolder` | ✅ | [`plugin-opener`] |
| `shell.trashItem` | ✅ | [native, `trash` crate] |
| `shell.beep` | 🟡 | Short WebAudio tone. |
| `shell.*ShortcutLink` | ❌ | Windows `.lnk` files need a Rust command. |
| `clipboard.readText`, `writeText`, `write([ClipboardItem])`, `read`, `has`, `clear`, `ClipboardItem` | ✅ | [`plugin-clipboard-manager`] Async, matching Electron 45+. `read()` returns text only. |
| `clipboard.readImage` | 🟡 | Async (Promise of `NativeImage`). |
| `clipboard.writeHTML`, `writeImage`, `write({ text, html, image })` | ✅ | Pre-45 API, kept for older apps. |
| `clipboard.writeBuffer/readBuffer`, `readFindText/writeFindText` | 🟡 | Kept in memory inside the app, not on the OS clipboard. |
| `clipboard.readHTML` | ❌ | `plugin-clipboard-manager` reads text and images only. |
| `clipboard.readRTF/writeRTF/*Bookmark`, `selection` | 🚫 | |
| `Menu.buildFromTemplate`, `setApplicationMenu`, `getApplicationMenu`, `popup({ callback })`, `append`, `insert`, `getMenuItemById`, `menu-will-show/close` | ✅ | [`@tauri-apps/api/menu`] Built lazily. |
| `MenuItem` (`normal`, `separator`, `submenu`, `checkbox`, `radio`, `click`, `accelerator`, `enabled`, `visible`, `checked`, `label`, `id`) | ✅ | `enabled`/`checked`/`label` changes update the native item. |
| Menu `role`s | 🟡 | Native on all platforms: `cut`, `copy`, `paste`, `selectAll`, `about`. Native on macOS, emulated elsewhere: `undo`, `redo`, `minimize`, `close`, `quit`. Emulated: `reload`, `forceReload`, `toggleDevTools`, `zoomIn/Out`, `resetZoom`, `togglefullscreen`, `zoom`, `delete`. Submenu roles `appMenu`, `fileMenu`, `editMenu`, `viewMenu`, `windowMenu` expand to defaults. |
| `Menu.sendActionToFirstResponder` | ⚪ | |
| `Tray` | ✅ | [`TrayIcon`] `setImage`, `setToolTip`, `setTitle`, `setContextMenu`, `destroy`, events `click`, `right-click`, `middle-click`, `double-click`, `mouse-enter/leave/move`. Click events are not delivered on Linux (Tauri limitation). |
| `Notification` | 🟡 | [`plugin-notification`] `title`, `subtitle`, `body`, `silent`, `icon`; events `show`, `failed`. `click`/`action`/`reply` not supported on desktop. |
| `nativeTheme` | ✅ | `shouldUseDarkColors`, `themeSource`, `updated`. |
| `screen` | 🟡 | Cached `getPrimaryDisplay`, `getAllDisplays`, `getDisplayNearestPoint`, `getDisplayMatching`; `display-added/removed/metrics-changed` by polling every 2 s while listened to; `getCursorScreenPoint` returns a Promise. |
| `globalShortcut` | ✅ | [`plugin-global-shortcut`] `register` returns `true` optimistically; failures are logged and unregister the key. |
| `nativeImage` | 🟡 | `createFromPath` (fetched from the app; `public/x.png` → `/x.png`), `createFromDataURL`, `createFromBuffer`, `createFromBitmap`, `createEmpty`, `toDataURL`, `toPNG`, `toJPEG`/`toBitmap` (bitmaps only), `getSize`/`getAspectRatio` (PNG, JPEG, GIF, BMP headers), `isEmpty`. `resize`/`crop`/`createThumbnailFromPath` ❌. |
| `net.fetch`, `net.request` (`ClientRequest` / `IncomingMessage`), `net.isOnline`, `net.online` | ✅ | [`plugin-http`] Not subject to CORS, like Electron's main process. `data:`/`blob:` use the webview's `fetch`. `resolveHost` ❌ (needs a Rust command). |
| `protocol.handle`, `unhandle`, `isProtocolHandled`, `registerSchemesAsPrivileged`, `register{String,Buffer,Http}Protocol` | 🟡 | [native] Each scheme must also be declared in Rust: `tauri_plugin_electron::Builder::new().protocol("app")`. Handlers receive a `Request` and return a `Response`. Privileges are recorded only. `registerFileProtocol`, `registerStreamProtocol`, `intercept*` 🚫 (no `fs`, and Tauri cannot intercept built-in schemes; use `handle()`). |
| `session.defaultSession`, `fromPartition`, `fromPath` | 🟡 | `getUserAgent`/`setUserAgent` (new windows), spell-checker settings (stored), `resolveProxy` (`DIRECT`), `clearStorageData`/`clearData` (Tauri `clearAllBrowsingData`, whole store), permission/certificate handlers (stored), `webRequest` listeners (stored, **not applied**), `fetch`. In-memory partitions → incognito webviews; `persist:` partitions get their own store on macOS 14+ only. `cookies.get/set/remove`, downloads ❌ (Tauri has cookie APIs in Rust; not exposed yet). Extensions, `netLog`, `getBlobData` 🚫. |
| `autoUpdater` | 🟡 | [`plugin-updater`] `checkForUpdates` emits `checking-for-update`, `update-available` / `update-not-available`, downloads, then `update-downloaded`; `quitAndInstall` installs and relaunches. The feed comes from `plugins.updater` in `tauri.conf.json` (`setFeedURL` only records it), and the `updater` feature of `tauri-plugin-electron` must be enabled. |
| `powerMonitor` | 🟡 | `getSystemIdleState` → `'unknown'`, `getSystemIdleTime` → `0`, `getCurrentThermalState` → `'unknown'`, `isOnBatteryPower`/`on-ac`/`on-battery` from `navigator.getBattery()` where available, `resume` detected heuristically from timer drift. No `suspend`, `lock-screen`, `unlock-screen`. |
| `powerSaveBlocker` | 🟡 | IDs as in Electron; holds a Screen Wake Lock in a visible window where the webview supports it. |
| `systemPreferences` | 🟡 | `getAnimationSettings`, `getAccentColor` and `getColor` (CSS system colours), `getEffectiveAppearance`, `getMediaAccessStatus` (`granted`), `getUserDefault` (empty defaults), notification subscriptions (never fire). |
| `safeStorage` | 🟡 | `isEncryptionAvailable()` is `false` (no OS keychain in the official plugins); `encryptString`/`decryptString` throw Electron's "not available" errors. |
| `crashReporter` | ⚪ | `start` and parameter APIs accepted; crashes are not collected. |
| `process` | 🟡 | `platform`, `arch`, `versions`, `type`, `argv`, `env`, `execPath`, `pid`, `cwd()` ([native]), `exit`, `nextTick`, `getSystemVersion`, `getProcessMemoryInfo` & co. (zeros). |
| `path` / `node:path` | ✅ | POSIX implementation. |
| `webFrame` | 🟡 | Zoom, `insertCSS`, `executeJavaScript`. |
| `webUtils.getPathForFile` | ✅ | Files dropped on a window come from Tauri's native drop event and are re-dispatched as HTML5 drag events; their `File` objects have names and paths but no contents. |
| `TouchBar` | ⚪ | Constructible, ignored. |
| `utilityProcess`, `desktopCapturer`, `contentTracing`, `inAppPurchase`, `netLog`, `pushNotifications`, `sharedTexture`, `IpcMainServiceWorker` | 🚫 | Present so imports resolve; every member throws with `reason: 'unsupported'` and a hint. `utilityProcess` → a Node sidecar via `plugin-shell` is the closest equivalent. |
| `ShareMenu` | ❌ | macOS share sheet; needs a Rust command. |

## CommonJS and Node.js built-ins

| | | |
| --- | --- | --- |
| `require('electron')`, `require('electron/main')`, … | ✅ | A global `require()` is installed in the main page and every renderer page by the Vite plugin (`tauri-electron/require`). In production builds Vite turns `require()` into imports anyway. |
| `require('path')`, `require('node:path')`, `require('process')`, `require('events')`, `require('url')` (and the `import` forms) | ✅ | Aliased to tauri-electron's shims: POSIX `path`, the `process` shim, the `EventEmitter` tauri-electron's own objects use (`events.once` too), and `url.fileURLToPath` / `pathToFileURL` / `parse` / `format` on top of `URL`. |
| `fileURLToPath(import.meta.url)`, `import.meta.dirname`, `__dirname` | ✅ | Rewritten at build time to the source file's project-relative path, so `path.join(__dirname, 'index.html')` names the page rather than the bundled chunk. |
| `module.exports`, `exports` | ⚪ | Exist so a main script that exports something does not throw; nothing reads them. |
| `require('fs')`, `import fs from 'fs'`, `fs/promises`, `original-fs` | 🟡 | [native] Main process, with the `node-fs` feature of tauri-plugin-electron. Sync functions over the synchronous bridge, `fs.promises` and callbacks over a command; Node-shaped errors. Paths built from `__dirname` / `app.getAppPath()` read the app's own files (project folder in dev, `<resources>/app` in a build). No file descriptors, streams, `watch`, `cp`, `opendir` yet. See [MIGRATING.md](MIGRATING.md#fs). |
| `require('buffer')`, global `Buffer` | ✅ | The `buffer` npm package (a `Uint8Array` subclass); the global is installed in the main process. |
| `path.win32` | ✅ | A real Windows implementation (`path` itself stays POSIX). |
| `child_process`, `os`, `crypto`, `http`, `util`, `stream`, … | 🚫 | Not yet (see [NODE-COMPAT-PLAN.md](NODE-COMPAT-PLAN.md)). The import does not fail the build; using the module throws `NotImplementedError` (`reason: 'unsupported'`) naming the replacement: `plugin-shell`, `plugin-http`, Web Crypto, or a Rust command. The error names the member (`child_process.exec is not supported on Tauri …`). |
| Native Node modules, `asar` | 🚫 | |
