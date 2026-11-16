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
[TARGET-APPS.md](TARGET-APPS.md); for how 30 open-source apps use them and
what is planned next, [APP-SURVEY.md](APP-SURVEY.md) and
[ROADMAP.md](ROADMAP.md).

## Security defaults

tauri-electron follows Electron's defaults. `tauri-plugin-electron` grants
the matching capabilities at startup (add files in `src-tauri/capabilities/`
for more):

| Electron | Default | tauri-electron |
| --- | --- | --- |
| Main process | full access | `electron-main` capability: every API listed here, unrestricted `net` (`http:default` scoped to `http(s)://**`) |
| `contextIsolation` | `true` | Renderer capability allows only IPC, zoom, `window.close()` and window dragging. The preload shares the page's world (there is no isolated world), so with isolation on, `process.env` is **not** exposed to renderers. |
| Remote pages | preload and IPC everywhere | Pages not served by the app have no preload and no IPC, except those of **trusted origins** (`plugins.electron.trustedOrigins` in tauri.conf.json, e.g. `"http://127.0.0.1:*"` for a server the app starts): they get the renderer bootstrap and the preloads (an initialization script, run only on those origins, checked on every page load), IPC (the renderer capability through `remote.urls`) and the synchronous bridge. `http` and port wildcards are accepted on loopback hosts only, `https` on any host; `{ "origin": …, "node": true }` (loopback only) keeps a `nodeIntegration` window's Node built-ins there. Everything such a server serves is trusted: prefer exact ports. [native] |
| `nodeIntegration` | `false` | With `nodeIntegration: true`, the window's page and preload get tauri-electron's Node layer (`require('fs')`, `os`, `child_process`, `net`, …, `Buffer`, `setImmediate`, the real `process.env`): the main process grants that window label when it creates it, and tauri-plugin-electron adds a capability with the `node-*` permissions for it [native]. The bundler plugins load the layer in renderer pages when `rendererNode` is on (default `'auto'`: the app's sources mention `nodeIntegration: true` / `sandbox: false`, or it depends on Electron < 20). `contextIsolation: false` alone fills in `process.env` only. |
| `sandbox` | `true` (`false` with `nodeIntegration`, or before Electron 20) | Reported as `process.sandboxed`. `sandbox: false` gives the preload Node built-ins, as above; the preload shares the page's world here, so the page has them too. |
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
| `setProxy`, `resolveProxy` | 🟡 | The default session's proxy: windows created afterwards and `net.fetch` use it (see `session.setProxy`). |
| `disableHardwareAcceleration`, `setAppUserModelId`, `setAboutPanelOptions`, recent documents, jump lists, user activities, `isInApplicationsFolder` (`false`) | ⚪ | |
| `certificate-error`, `login`, `select-client-certificate` | 🟡 | [native] Emitted after the window's `webContents` event (see `webContents`): Linux and Windows; `select-client-certificate` Windows only; none on macOS. |
| `render-process-gone`, `child-process-gone`, … | 🚫 | Never emitted: Chromium process events. |
| `getFileIcon`, `getApplicationInfoForProtocol` | ❌ | Need a Rust command. |
| `importCertificate` | 🚫 | The webview uses the OS certificate store. |

### `BrowserWindow` [`WebviewWindow`]

| API | | Notes |
| --- | --- | --- |
| `new BrowserWindow(options)` | ✅ | `width`, `height`, `x`, `y`, `center`, `min*/max*`, `resizable`, `minimizable`, `maximizable`, `closable`, `focusable`, `alwaysOnTop`, `fullscreen`, `kiosk`, `skipTaskbar`, `show`, `frame`, `transparent`, `backgroundColor`, `parent`, `modal` (disables the parent off macOS), `hasShadow`, `titleBarStyle` (`hidden*` → overlay on macOS, frameless elsewhere, like Electron), `titleBarOverlay` (Windows, Linux: the renderer bootstrap draws minimize / maximize / close buttons with its `color`, `symbolColor` and `height`; `navigator.windowControlsOverlay` and the `--titlebar-area-*` CSS variables, not `env(titlebar-area-*)`), `trafficLightPosition`, `tabbingIdentifier`, `icon`, `title`, `contentProtection`, `autoHideMenuBar`. The native window is created on the first `loadURL`/`loadFile` (or a blank one on the next tick). `tauri: { … }` passes extra `WebviewWindow` options. |
| `webPreferences` | 🟡 | `preload` (the bundler plugins inject it in the app's pages, and in pages of trusted origins as an initialization script; this path is ignored), `additionalArguments` (→ renderer `process.argv` [native]), `devTools`, `zoomFactor`, `javascript`, `backgroundThrottling`, `partition` / `session`, `contextIsolation` / `nodeIntegration` / `sandbox` (see Security defaults). `spellcheck`, `webSecurity`, `enableBlinkFeatures` are ignored. |
| `loadURL`, `loadFile(path, { query, search, hash })`, `reload` | ✅ | Resolve on `did-finish-load`. Remote pages work but have no IPC, except pages of trusted origins (see Security defaults), which get the preload and IPC like the app's own. Custom schemes served by `protocol.handle` load too. `file://` URLs load the app page at that path (like `loadFile`). |
| `show`, `showInactive`, `hide`, `focus`, `close`, `destroy`, `isVisible`, `isFocused`, `isDestroyed`, `setEnabled`, `isEnabled` | ✅ | |
| `minimize`, `maximize`, `unmaximize`, `restore`, `setFullScreen`, `setSimpleFullScreen`, `setKiosk` + `is*` | ✅ | Cached; refreshed on resize. |
| `setTitle`, `getTitle`, title follows `<title>` | ✅ | `page-title-updated` is cancelable. |
| `getBounds`, `setBounds`, `getSize`, `setSize`, `getContentSize`, `setContentSize`, `getPosition`, `setPosition`, `center`, `setMinimumSize`, `setMaximumSize`, `getNormalBounds` | ✅ | Logical (DIP) units. Cached from window events. |
| `setResizable`, `setMinimizable`, `setMaximizable`, `setClosable`, `setFocusable`, `setAlwaysOnTop`, `setSkipTaskbar`, `setVisibleOnAllWorkspaces`, `setContentProtection`, `setIgnoreMouseEvents`, `setBackgroundColor`, `setHasShadow`, `setProgressBar`, `flashFrame`, `setIcon`, `setOverlayIcon` | ✅ | |
| `setMenu`, `removeMenu` | ✅ | `removeMenu` sets an empty menu. |
| `setMenuBarVisibility`, `isMenuBarVisible`, `setAutoHideMenuBar`, `isMenuBarAutoHide`, `autoHideMenuBar` | ✅ | [native] Windows and Linux (macOS has no per-window menu bar, as in Electron). With auto-hide, Alt pressed and released alone toggles the bar (renderer bootstrap). |
| events `close` (cancelable), `closed`, `focus`, `blur`, `show`, `hide`, `resize`, `move`, `maximize`, `unmaximize`, `minimize`, `restore`, `enter/leave-full-screen`, `ready-to-show` | ✅ | `ready-to-show` fires on the first `did-finish-load`. |
| `getAllWindows`, `getFocusedWindow`, `fromId`, `fromWebContents` | ✅ | |
| `getParentWindow`, `getChildWindows` | ✅ | `setParentWindow` only affects windows created later. |
| `-webkit-app-region: drag / no-drag` | ✅ | Implemented by the renderer bootstrap (inline styles, `<style>` and same-origin style sheets). Double-click toggles maximize. |
| `setTitleBarOverlay` | ✅ | Restyles the window controls drawn for `titleBarOverlay` (Windows, Linux). |
| `setMovable`, `setOpacity`, `setAspectRatio`, `blur`, `setWindowButtonPosition/Visibility`, `setTouchBar`, tabs, `setVibrancy`, thumbar buttons, `setRepresentedFilename`, `setDocumentEdited` | ⚪ | State is cached; no native effect. |
| `capturePage` | 🟡 | Same as `webContents.capturePage`. |
| `getNativeWindowHandle`, `getMediaSourceId` | 🚫 | Handles exist only in Rust; no webview lets the app choose the captured source (see `desktopCapturer`). |
| `BaseWindow` | 🟡 | Alias of `BrowserWindow`. |
| `BrowserView`, `View`, `ImageView` | 🚫 | A Tauri window holds one webview. |
| `WebContentsView` | ❌ | Tauri's multi-webview windows (unstable) could back it ([ROADMAP](ROADMAP.md) C1). |
| `<webview>` tag (`webPreferences.webviewTag`) | ❌ | Not defined: the tag is an unknown HTML element and loads nothing. Same backing as `WebContentsView` ([ROADMAP](ROADMAP.md) C1). |

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
| `did-fail-load` | 🟡 | When the window cannot be created, and when a server certificate is not trusted (`-202` `ERR_CERT_AUTHORITY_INVALID` & co.; `loadURL()` rejects). |
| `certificate-error`, `login`, `select-client-certificate` (and the same `app` events) | 🟡 | [native] `certificate-error` `(event, url, error, certificate, callback, isMainFrame)` when the webview rejects a server certificate, after the session's `setCertificateVerifyProc`; `callback(true)` after `preventDefault()` trusts it (Linux: allowed for that host for the session, and the page is loaded again), otherwise the load fails. `certificate` has `data` (PEM), `issuer` / `subject` principals and names, `serialNumber`, `validStart` / `validExpiry`, `fingerprint` (`sha256/…`), `issuerCert`. `login` `(event, { url }, authInfo, callback)` for HTTP authentication (Basic, Digest, NTLM, Negotiate); without `preventDefault()` it is cancelled and the page shows the 401 response, as in Electron. `select-client-certificate` Windows only (the mutually trusted certificates; the first one without `preventDefault()`). Linux: WebKitGTK, main-frame certificate errors only; Windows: WebView2 (not verified); macOS: never emitted (wry owns the navigation delegate). |
| `zoom-changed` | ✅ | Ctrl + mouse wheel. |
| `mainFrame` (`url`, `origin`, `routingId`, `processId`, `send`, `postMessage`, `executeJavaScript`, …), `webFrameMain.fromId` | 🟡 | One frame per page; iframes are not modelled. |
| `session` | 🟡 | See `session`. |
| `setUserAgent`, `getUserAgent`, `setAudioMuted`, `setBackgroundThrottling`, `setWebRTCIPHandlingPolicy`, … | 🟡 | User agent applies to windows created afterwards. |
| `webContents.getAllWebContents`, `getFocusedWebContents`, `fromId`, `fromFrame` | ✅ | |
| `printToPDF` | 🟡 | [native] Resolves with the PDF's bytes. Linux: WebKitGTK prints to GTK's "Print to File" printer (`pageSize` named or in inches, `landscape`, `margins`, `scale`, `pageRanges`, `printBackground`); Windows: WebView2 `PrintToPdf` (the same options, and WebView2's own header and footer for `displayHeaderFooter`); macOS: WKWebView `createPDF`, one page as tall as the content (no paper size, margins, orientation, scale or page ranges). `headerTemplate` / `footerTemplate`, `preferCSSPageSize`, `generateTaggedPDF`, `generateDocumentOutline` are ignored. Electron < 21's microns, `marginsType` and `{ from, to }` are accepted. |
| `capturePage(rect?)` | 🟡 | [native] A PNG `NativeImage` of the visible page (WebKitGTK `get_snapshot`, WebView2 `CapturePreview`, WKWebView `takeSnapshot`), cropped to `rect`. A hidden window gives an empty image on Linux (WebKitGTK takes no snapshot of a window that is not shown). `stayHidden` / `stayAwake` have no effect. |
| `savePage`, `debugger`, frame subscriptions | 🚫 | Chromium-only. |
| `downloadURL` | ✅ | [native] An HTTP transfer in Rust with the window's cookies (`net` feature): emits the session's `will-download`; sizes, `pause` / `resume` / `cancel` work. |

### IPC

| API | | Notes |
| --- | --- | --- |
| Payloads | ✅ | Structured-clone-like: `Uint8Array` and other typed arrays, `ArrayBuffer`, `Date`, `Map`, `Set`, `RegExp`, `BigInt`, `Error`, `undefined`, `NaN`/`±Infinity`. Functions throw `An object could not be cloned.` Cycles are not supported. |
| `ipcMain.on/once/removeListener/removeAllListeners` | ✅ | `event.sender`, `event.senderFrame`, `event.processId`, `event.frameId`, `event.ports`, `event.reply`. |
| `ipcMain.handle/handleOnce/removeHandler` | ✅ | Errors reject the renderer's `invoke` with Electron's message format. |
| `ipcRenderer.send/invoke/on/once/off/removeAllListeners/sendToHost` | ✅ | |
| `ipcRenderer.sendSync`, `event.returnValue` | ✅ | [native] A blocking request to the plugin's URI scheme, answered when a listener sets `returnValue` (also after an `await`). Times out after 25 s. Without the plugin: async send, returns `undefined`. |
| `ipcRenderer.postMessage(channel, message, [MessagePort])` | ✅ | Main receives `MessagePortMain`s in `event.ports`. |
| `MessageChannelMain`, `MessagePortMain` | ✅ | Main ↔ main, main ↔ renderer and renderer ↔ renderer (a port received from one window can be posted to another), and main / renderer → utility process (`utilityProcess`'s `postMessage`). Ports cannot be transferred *through* a port. |
| `contextBridge.exposeInMainWorld` | 🟡 | Assigns a frozen object to `window`; there is no isolated world. |

### Other modules

| Module | | Notes |
| --- | --- | --- |
| `dialog.showOpenDialog`, `showSaveDialog` | ✅ | [`plugin-dialog`] `properties`: `openFile`, `openDirectory`, `multiSelections`, `createDirectory`; `filters`, `defaultPath`, `title`. |
| `dialog.showMessageBox` | ✅ | Up to 3 buttons: the native dialog (`cancelId` is the answer when it is dismissed). More buttons or `checkboxLabel`: [native] a small window with every button, the checkbox, `defaultId` (Enter), `cancelId` (Escape / closing it) and `signal`. `icon`, `textWidth`, `noLink` ignored. |
| `dialog.showErrorBox` | ✅ | |
| `dialog.showOpenDialogSync`, `showSaveDialogSync`, `showMessageBoxSync` | ✅ | [native + `plugin-dialog`] Blocking dialogs through the synchronous bridge. |
| `dialog.showCertificateTrustDialog` | 🚫 | |
| `shell.openExternal`, `openPath`, `showItemInFolder` | ✅ | [`plugin-opener`] |
| `shell.trashItem` | ✅ | [native, `trash` crate] |
| `shell.beep` | 🟡 | Short WebAudio tone. |
| `shell.*ShortcutLink` | ❌ | Windows `.lnk` files need a Rust command. |
| `clipboard.readText`, `writeText`, `write([ClipboardItem])`, `read`, `has`, `clear`, `ClipboardItem` | ✅ | [`plugin-clipboard-manager`] Async, matching Electron 45+. `read()` returns text only. Apps whose `electron` dependency is below 45 (read from `package.json` by the bundler plugins) get synchronous `readText`, `readHTML`, `readImage`, `availableFormats` and `has` instead, over the synchronous bridge [native]. |
| `clipboard.readImage` | 🟡 | Async (Promise of `NativeImage`); synchronous for Electron < 45. |
| `clipboard.writeHTML`, `writeImage`, `write({ text, html, image })` | ✅ | Pre-45 API, kept for older apps. |
| `clipboard.writeBuffer/readBuffer`, `readFindText/writeFindText` | 🟡 | Kept in memory inside the app, not on the OS clipboard. |
| `clipboard.readHTML` | ✅ | [native, arboard] Async (synchronous for Electron < 45). |
| `clipboard.readRTF/writeRTF/*Bookmark`, `selection` | 🚫 | |
| `Menu.buildFromTemplate`, `setApplicationMenu`, `getApplicationMenu`, `popup({ callback })`, `append`, `insert`, `getMenuItemById`, `menu-will-show/close` | ✅ | [`@tauri-apps/api/menu`] Built lazily. |
| `MenuItem` (`normal`, `separator`, `submenu`, `checkbox`, `radio`, `click`, `accelerator`, `enabled`, `visible`, `checked`, `label`, `id`) | ✅ | `enabled`/`checked`/`label` changes update the native item. |
| Menu `role`s | 🟡 | Native on all platforms: `cut`, `copy`, `paste`, `selectAll`, `about`. Native on macOS, emulated elsewhere: `undo`, `redo`, `minimize`, `close`, `quit`. Emulated: `reload`, `forceReload`, `toggleDevTools`, `zoomIn/Out`, `resetZoom`, `togglefullscreen`, `zoom`, `delete`. Submenu roles `appMenu`, `fileMenu`, `editMenu`, `viewMenu`, `windowMenu` expand to defaults. |
| `Menu.sendActionToFirstResponder` | ⚪ | |
| `Tray` | ✅ | [`TrayIcon`] `setImage`, `setToolTip`, `setTitle`, `setContextMenu`, `destroy`, events `click`, `right-click`, `middle-click`, `double-click`, `mouse-enter/leave/move`. Click events are not delivered on Linux (Tauri limitation). |
| `Notification` | 🟡 | [`plugin-notification`, native] `title`, `subtitle` (prepended to the body), `body`, `silent`, `icon` (a path or icon name), `actions` (buttons); events `show`, `failed`, `click`, `action` (button index) on Linux, Windows and macOS, `close` on Linux (and when `close()` is called). `close()` removes it from the screen on Linux only. `reply` is never emitted (`hasReply` is accepted). Windows reports clicks only while the toast is on screen; macOS shows several buttons in an "Options" menu. Without tauri-plugin-electron: `show` / `failed` only. |
| `nativeTheme` | ✅ | `shouldUseDarkColors`, `themeSource`, `updated`. |
| `screen` | 🟡 | Cached `getPrimaryDisplay`, `getAllDisplays`, `getDisplayNearestPoint`, `getDisplayMatching`; `display-added/removed/metrics-changed` by polling every 2 s while listened to; `getCursorScreenPoint` is synchronous [native, over the bridge]. |
| `globalShortcut` | ✅ | [`plugin-global-shortcut`] `register` returns `true` optimistically; failures are logged and unregister the key. |
| `nativeImage` | 🟡 | `createFromPath` (absolute paths read through `fs` with the `node-fs` feature, `@2x` names as scale factor 2; the app's own files fetched from the app, `public/x.png` → `/x.png`; a missing file gives an empty image), `createFromDataURL`, `createFromBuffer`, `createFromBitmap`, `createEmpty`, `toDataURL`, `toPNG`, `toJPEG`/`toBitmap` (PNGs and bitmaps), `getSize`/`getAspectRatio` (PNG, JPEG, GIF, BMP headers), `isEmpty`, `resize`, `crop`, `createThumbnailFromPath` (images only). PNGs are decoded in JavaScript, so `resize`/`crop` are synchronous; copies of JPEG/GIF images report their size at once and get their pixels when used (icon, `toPNG` after a `resolveImage`). |
| `net.fetch`, `net.request` (`ClientRequest` / `IncomingMessage`), `net.isOnline`, `net.online` | ✅ | [`plugin-http`] Not subject to CORS, like Electron's main process. `data:`/`blob:` use the webview's `fetch`; `file://` URLs are read through `fs` (feature `node-fs`) with a content type from the extension, and fail with `net::ERR_FILE_NOT_FOUND` / `net::ERR_ACCESS_DENIED`. The default session's `webRequest` listeners apply (`net.request({ session })` / `{ partition }` and `session.fetch` use that session's); with listeners, redirects are followed in JavaScript. `ClientRequest` emits `login` for HTTP Basic challenges and retries with the credentials. Headers the fetch spec forbids (`Cookie`, `Origin`, `Referer`, …) are dropped by plugin-http unless its `unsafe-headers` feature is on. `setCertificateVerifyProc` does not apply. `resolveHost` ❌ (needs a Rust command). |
| `protocol.handle`, `unhandle`, `isProtocolHandled`, `registerSchemesAsPrivileged`, `register{File,String,Buffer,Http}Protocol` | 🟡 | [native] Tauri registers schemes at build time: the bundler plugins find them in the app's source (and `@sentry/electron`'s `sentry-ipc`) and write `src-tauri/electron-schemes.json`, registered by `Builder::protocols(bundled_schemes!())` (or declare one with `.protocol("app")`). Handlers receive a `Request` and return a `Response`; `net.fetch('file://…')` serves files (see `net`). The requesting page's `session.webRequest` listeners apply around the handler (a `redirectURL` is served in place, a cancelled request gets an empty 403). Privileges are recorded only. `registerFileProtocol` reads the path its callback returns through `fs` (feature `node-fs`). `registerStreamProtocol`, `intercept*` 🚫 (Tauri cannot intercept built-in schemes; use `handle()`). |
| `session.defaultSession`, `fromPartition`, `fromPath` | 🟡 | `getUserAgent`/`setUserAgent` (new windows), spell-checker settings (stored), `setProxy` / `resolveProxy` (one http:// or socks5:// proxy from `proxyRules`, applied to windows created afterwards and to `fetch`; `pac_script`, `auto_detect` and `proxyBypassRules` are not supported; macOS needs the `macos-proxy` feature and macOS 14), `clearStorageData`/`clearData` (Tauri `clearAllBrowsingData`, whole store), `setPermissionRequestHandler` [native] applied (Linux: each request waits for the callback; Windows / macOS: the first request of a permission per window and origin gets the platform default while the handler runs, its answer applies afterwards; without a handler everything is granted, as in Electron), `setDisplayMediaRequestHandler(handler, { useSystemPicker })` [native] called for a page's `getDisplayMedia()` on Linux and Windows (WebView2 runtimes with `ScreenCaptureStarting`; macOS asks the user itself): without a handler the request is denied, as in Electron; `callback({ video })` grants it but the webview's picker chooses the source; `useSystemPicker` grants without calling the handler. Linux BrowserWindows have WebKitGTK's media-stream and WebRTC settings on (getUserMedia, getDisplayMedia, RTCPeerConnection). `setPermissionCheckHandler` (stored), `setCertificateVerifyProc` [native] (asked before `certificate-error`, only about certificates the webview rejected: `0` trusts, `-3` lets `certificate-error` decide, anything else rejects; Linux and Windows), `webRequest` (see below), `fetch`. In-memory partitions → incognito webviews; `persist:` partitions get their own store on macOS 14+ only. `cookies.get/set/remove/flushStore` [native] on the webview cookie store (the default session through the main window, a partition through one of its windows; `changed` is emitted for changes made through this API only; `hostOnly` is not reported). `setPreloads` / `registerPreloadScript`: the bundler plugins put the preloads of electron-log and @sentry/electron in every renderer page when the app depends on them (option `sessionPreloads` for others); other paths warn. Downloads [native]: `will-download` with a `DownloadItem` (`setSavePath`, a save dialog without one, `getFilename` / `getURL` / `getMimeType` / `getTotalBytes` / `getReceivedBytes` / `getState`, `updated`, `done`; files are written to a temporary file and moved to the save path when complete) for page downloads and `downloadURL`; page downloads cannot pause, and on Windows / macOS report no total size and keep transferring after `cancel()` (the file is discarded). Extensions, `netLog`, `getBlobData` 🚫. |
| `session.webRequest` (`onBeforeRequest`, `onBeforeSendHeaders`, `onSendHeaders`, `onHeadersReceived`, `onResponseStarted`, `onBeforeRedirect`, `onCompleted`, `onErrorOccurred`) | 🟡 | One listener per event, filters with Chrome match patterns (`urls`, `excludeUrls`, `types`; invalid patterns throw). Applied where tauri-electron sees the request: **`net.fetch` / `net.request` / `session.fetch`**: every event (cancel → `net::ERR_BLOCKED_BY_CLIENT`, `redirectURL`, `requestHeaders`, `responseHeaders` / `statusLine`; `uploadData` for byte bodies). **`protocol.handle()` schemes**: every event around the handler; `resourceType` is guessed (`Sec-Fetch-Dest`, `Accept`, extension). **http(s) requests of pages** [native]: Windows: WebView2 `WebResourceRequested` holds each request for onBeforeRequest (cancel → empty 403, redirect), onBeforeSendHeaders and onSendHeaders, and `WebResourceResponseReceived` reports onResponseStarted / onCompleted; onHeadersReceived does not apply (not verified). Linux: reported only (onSendHeaders, onBeforeRedirect, onResponseStarted, onCompleted, onErrorOccurred; WebKitGTK cannot change requests from the UI process). macOS: nothing. Listeners that could change a request (onBeforeRequest, onBeforeSendHeaders, onHeadersReceived) are not called for page requests where their answer cannot apply. |
| `electron-updater` | 🟡 | [`plugin-updater`] The bundler plugins alias it: `autoUpdater` (`AppUpdater`; `NsisUpdater`, `MacUpdater`, `AppImageUpdater` are the same) with `checkForUpdates` (an `UpdateCheckResult`; null when unpackaged unless `forceDevUpdateConfig`), `checkForUpdatesAndNotify`, `downloadUpdate` (+ `CancellationToken`), `quitAndInstall`, `autoDownload`, `autoInstallOnAppQuit`, `currentVersion`, `logger`, `signals`, and the events `checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `update-cancelled`, `error`. Tauri's update format and `plugins.updater` endpoints; `channel` / `setFeedURL` are sent as headers, `allowPrerelease` / `allowDowngrade` recorded. |
| `autoUpdater` | 🟡 | [`plugin-updater`] `checkForUpdates` emits `checking-for-update`, `update-available` / `update-not-available`, downloads, then `update-downloaded`; `quitAndInstall` installs and relaunches. The feed comes from `plugins.updater` in `tauri.conf.json` (`setFeedURL` only records it), and the `updater` feature of `tauri-plugin-electron` must be enabled. |
| `powerMonitor` | 🟡 | [native, feature `power-monitor`] Linux: `suspend` / `resume` / `shutdown` from logind, `lock-screen` / `unlock-screen` from the logind session (`Lock` / `Unlock` / `LockedHint`) and the screen saver (`ActiveChanged`). `getSystemIdleTime` / `getSystemIdleState` (synchronous): Mutter's IdleMonitor or `org.freedesktop.ScreenSaver` on Linux (`locked` from the lock state), `CGEventSource` on macOS, `GetLastInputInfo` on Windows; `'unknown'` / `0` when the system does not say. macOS and Windows report no system events yet: `resume` is detected from timer drift there (and without D-Bus). `shutdown` cannot be delayed. `getCurrentThermalState` → `'unknown'`; `isOnBatteryPower` / `on-ac` / `on-battery` from `navigator.getBattery()` where available. |
| `powerSaveBlocker` | ✅ | [native, `keepawake` crate, feature `power-save-blocker` (default)] An operating-system assertion per blocker: IOPMAssertion on macOS, `SetThreadExecutionState` on Windows, logind / ScreenSaver inhibitors on Linux. Falls back to a Screen Wake Lock in a visible window when the assertion cannot be taken. |
| `systemPreferences` | 🟡 | `getAnimationSettings`, `getAccentColor` and `getColor` (CSS system colours), `getEffectiveAppearance`, `getMediaAccessStatus` (`granted`), `getUserDefault` (empty defaults), notification subscriptions (never fire). |
| `safeStorage` | ✅ | [native] `safe-storage` feature (on by default). AES-256-GCM with a random key kept in the OS keychain (Keychain, Credential Manager, Secret Service). `encryptString` / `decryptString` synchronous, `encryptStringAsync` / `decryptStringAsync` / `isAsyncEncryptionAvailable`; `getSelectedStorageBackend()` is `gnome_libsecret` or, with no Secret Service, `basic_text` (encryption then unavailable until `setUsePlainTextEncryption(true)`), as in Electron. Main process only. Ciphertext is not compatible with Electron's. |
| `utilityProcess.fork` | 🟡 | [native, feature `node-child-process`] The module runs in a real Node.js: a sidecar the app bundles (`<crate>-node` / `node` next to the executable; `npx github:AJayClauGermany/tauri-as-electron --node-sidecar`), `$TAURI_ELECTRON_NODE`, or `node` on PATH in debug builds. `postMessage(message, [MessagePortMain])` (structured-clone-like; ports relayed by the main process, so a port whose other end is in a window works), `kill()`, `pid`, `stdout` / `stderr` (`stdio: 'pipe'`), `'spawn'`, `'exit'`, `'message'`; `env`, `execArgv`, `cwd`, `serviceName` (process title). In the child: `process.parentPort` (`'message'` with `{ data, ports }`, `postMessage`, `start` / `pause`), `MessagePortMain`, `process.type === 'utility'`, `require('electron').net` (Node's `fetch`); main-process modules throw. The bundler plugins bundle entries with static paths for Node (option `fork` for others) into `<resources>/fork`. Not supported: the `'error'` event (V8 fatal errors), `respondToAuthRequestsFromMainProcess`, ports from the child to the main process, native addons in bundled entries. Windows (loopback channel) and macOS not verified. See [MIGRATING.md](MIGRATING.md#utilityprocessfork-and-child_processfork). |
| `crashReporter` | ⚪ | `start` and parameter APIs accepted; crashes are not collected. |
| `process` | 🟡 | `platform`, `arch`, `versions`, `type`, `argv`, `env`, `execPath`, `pid`, `cwd()` ([native]), `exit`, `nextTick`, `getSystemVersion`, `getProcessMemoryInfo` & co. (zeros). |
| `path` / `node:path` | ✅ | POSIX implementation. |
| `webFrame` | 🟡 | Zoom, `insertCSS`, `executeJavaScript`. |
| `webUtils.getPathForFile` | ✅ | Files dropped on a window come from Tauri's native drop event and are re-dispatched as HTML5 drag events; their `File` objects have names and paths but no contents. |
| `TouchBar` | ⚪ | Constructible, ignored. |
| `desktopCapturer.getSources` | 🟡 | [native] `desktop-capturer` feature (on by default). Screens (`display_id` matches `screen.getAllDisplays()`) and windows with PNG thumbnails fitting `thumbnailSize`, and window icons with `fetchWindowIcons`: X11 on Linux (under Wayland: screens only, without thumbnails), GDI on Windows, CoreGraphics on macOS (needs the Screen Recording permission; no window icons). Main process only, as since Electron 17. The ids cannot preselect a capture: see `getUserMedia` below. |
| `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })` in pages | 🟡 | Becomes `getDisplayMedia()` (the renderer bootstrap wraps `navigator.mediaDevices.getUserMedia`, so app pages only): the webview's picker appears (desktop portal with PipeWire on Linux, WebView2's picker, macOS's), whatever source the app chose. `max/minWidth`, `Height`, `FrameRate` are kept; desktop audio only keeps the capture's audio tracks. The request goes to the permission request handler as `'media'`, not to the display media handler. |
| `contentTracing`, `inAppPurchase`, `netLog`, `pushNotifications`, `sharedTexture`, `IpcMainServiceWorker` | 🚫 | Present so imports resolve; every member throws with `reason: 'unsupported'` and a hint. |
| `ShareMenu` | ❌ | macOS share sheet; needs a Rust command. |

## CommonJS and Node.js built-ins

| | | |
| --- | --- | --- |
| `require('electron')`, `require('electron/main')`, … | ✅ | A global `require()` is installed in the main page and every renderer page by the Vite plugin (`tauri-electron/require`). In production builds Vite turns `require()` into imports anyway. |
| `require('path')`, `require('node:path')`, `require('process')`, `require('events')`, `require('url')` (and the `import` forms) | ✅ | Aliased to tauri-electron's shims: POSIX `path`, the `process` shim, the `EventEmitter` tauri-electron's own objects use (`events.once` too), and `url.fileURLToPath` / `pathToFileURL` / `parse` / `format` on top of `URL`. |
| `fileURLToPath(import.meta.url)`, `import.meta.dirname`, `__dirname` | ✅ | Rewritten at build time to the source file's project-relative path, so `path.join(__dirname, 'index.html')` names the page rather than the bundled chunk. |
| `module.exports`, `exports` | ⚪ | Exist so a main script that exports something does not throw; nothing reads them. |
| `require('fs')`, `import fs from 'fs'`, `fs/promises`, `original-fs` | 🟡 | [native] Main process, with the `node-fs` feature of tauri-plugin-electron. Sync functions over the synchronous bridge, `fs.promises` and callbacks over a command; Node-shaped errors. Paths built from `__dirname` / `app.getAppPath()` read the app's own files (project folder in dev, `<resources>/app` in a build). File descriptors (`open`, `read`, `write`, `fstat`, `fsync`, `ftruncate`, `close`, `fs.promises.open`'s `FileHandle`) and streams (`createReadStream`, `createWriteStream`). `fs.watch` / `fs.promises.watch` (notify: inotify, FSEvents, ReadDirectoryChangesW; `recursive`, `encoding`, `signal`) and `fs.watchFile` (polling); chokidar 3 and 4 run on them. No `cp`, `opendir` yet. See [MIGRATING.md](MIGRATING.md#fs). |
| `require('buffer')`, global `Buffer` | ✅ | The `buffer` npm package (a `Uint8Array` subclass); the global is installed in the main process. |
| `path.win32` | ✅ | A real Windows implementation (`path` itself stays POSIX). |
| `require('os')` | ✅ | [native] Main process, feature `node-os`. Every `os` function; CPU `times` are zeros outside Linux. |
| `require('child_process')` | 🟡 | [native] Main process, feature `node-child-process`. `spawn`, `exec`, `execFile` and their `*Sync` forms, with Node's errors and shells. `fork()` runs a real Node.js (see `utilityProcess.fork`) with Node's own IPC channel (`NODE_CHANNEL_FD`, `json` serialization): `send`, `'message'`, `disconnect`, `connected`, `silent`, `execPath`; so does `spawn` with `'ipc'` in `stdio` and `spawn(process.execPath)` with `ELECTRON_RUN_AS_NODE`. No `serialization: 'advanced'`, no handles over `send()`. |
| `require('util')`, `util/types`, `events` | ✅ | Pure JavaScript; `util.inspect` / `format` print like Node's. `EventEmitter` can be called the pre-class way. |
| `require('stream')`, `stream/promises`, `string_decoder` | ✅ | readable-stream (Node's streams), `string_decoder` npm package. |
| `require('crypto')` | 🟡 | Hashes, HMAC, PBKDF2, HKDF, scrypt, random values, `webcrypto` / `subtle`. No ciphers, signatures or key pairs yet. |
| `require('http')`, `require('https')` | 🟡 | Client (`request`, `get`) over plugin-http; redirects not followed, like Node. Servers (`createServer`, HTTP/1.1 with keep-alive, chunked bodies, `'upgrade'`) on `net` / `tls`, with their features. |
| `require('net')`, `dgram`, `dns`, `dns/promises` | 🟡 | [native] Main process, feature `node-net`. TCP and IPC sockets and servers with back-pressure, UDP (broadcast, multicast), `lookup` from the OS, `resolve*` / `reverse` / `Resolver` against DNS servers; Node's errors. No `BlockList`, no `lookupService`. |
| `require('tls')` | 🟡 | [native] Main process, feature `node-tls` (rustls). Clients and servers, SNI, ALPN, client certificates, `ca`, OpenSSL's error codes. `checkServerIdentity` callbacks run (pinning). No STARTTLS (`{ socket }`), no session resumption, TLS 1.2+ only; `rootCertificates` is empty; `requestCert` needs `ca`. |
| `require('assert')`, `assert/strict`, `querystring`, `punycode`, `timers`, `timers/promises`, `perf_hooks`, `stream/web`, `stream/consumers`, `constants`, `console`, `diagnostics_channel` | ✅ | Pure JavaScript; `assert` messages match Node's. |
| `require('zlib')` | 🟡 | gzip / deflate / raw deflate (fflate), sync, callbacks and streams; no Brotli. |
| `require('readline')`, `readline/promises`, `module`, `async_hooks`, `tty`, `domain` | 🟡 | Partial: no terminal; no module loader (`createRequire`, `builtinModules` only); `AsyncLocalStorage` is lost after `await`; `domain` catches synchronous errors only. |
| `http2`, `vm`, `v8`, `worker_threads`, `wasi`, `cluster`, `repl`, `inspector` | 🚫 | Not yet (see [NODE-COMPAT-PLAN.md](NODE-COMPAT-PLAN.md)). The import does not fail the build; using the module throws `NotImplementedError` (`reason: 'unsupported'`) naming the replacement. The error names the member (`vm.runInNewContext is not supported on Tauri …`). |
| Node built-ins in renderer windows | 🟡 | [native] Windows created with `nodeIntegration: true` or `sandbox: false` (and every window of an app on Electron < 20, whose preloads were unsandboxed) get the same modules and `Buffer` as the main process, with the same Cargo features; only while they show the app's own page (or a trusted origin declared with `node: true`). Sandboxed windows are refused in Rust too. Not in Web Workers (no `nodeIntegrationInWorker`); no `module` / `exports` globals in pages (they would break UMD scripts); open file descriptors are not closed when such a page reloads. |
| `@electron/remote` (`/main`, `/renderer`) | 🟡 | Aliased by the bundler plugins (and `require()`). `initialize()`, `enable(webContents)`, `isInitialized()`; in renderers `getCurrentWindow`, `getCurrentWebContents`, `getGlobal`, `require` (electron and the main process's Node built-ins), `process` and every module (`app`, `dialog`, `BrowserWindow`, `Menu` / `MenuItem`, `screen`, `shell`, `nativeTheme`, …). Synchronous requests over the bridge; main-process objects are proxies (methods known up front, properties read live), renderer callbacks are called back asynchronously, returned promises resolve in the renderer, dropped proxies are released. `instanceof` against remote classes and enumerating a proxy's keys do not work. |
| `keytar` | 🟡 | [native] Aliased by the bundler plugins (and `require()`); feature `keytar`, main process and `nodeIntegration` windows. `getPassword`, `setPassword`, `deletePassword`, `findCredentials`, `findPassword`, Promise-based, stored where keytar stores them (macOS: generic password per service and account; Windows: credential `<service>/<account>`, UTF-8; Linux: Secret Service item with keytar's `service` / `account` attributes in the default collection), so the Electron build's entries are found. Without a Secret Service every call rejects, as keytar's does (nothing in plain text). Verified on Linux without a Secret Service only; the Secret Service, Keychain and Credential Manager paths are compile-checked. |
| `better-sqlite3` | 🟡 | [native] Aliased; feature `sqlite` (rusqlite, SQLite 3.54 compiled in: FTS5, JSON, R*Tree; foreign keys on and double-quoted strings off, as in better-sqlite3's build). Synchronous over the bridge, one request per call. `new Database(file \| Buffer, { readonly, fileMustExist, timeout, verbose })`, `prepare` → `run` / `get` / `all` / `iterate`, `pluck` / `expand` / `raw` / `safeIntegers`, `bind`, `columns`; named (`@x`, `:x`, `$x`) and anonymous parameters with better-sqlite3's errors; BigInt and Buffer values; `exec`, `pragma` (`simple`), `transaction` (`deferred` / `immediate` / `exclusive`, savepoints when nested), `backup`, `serialize`, `function`, `defaultSafeIntegers`, `close`, `SqliteError` with extended codes. `iterate()` reads every row first; `function()` is answered between runs of the statement (once per distinct arguments, writes rolled back until all results are in), so only deterministic functions behave as in better-sqlite3; `aggregate`, `table`, `loadExtension` throw. |
| `sqlite3` | 🟡 | [native] Aliased; feature `sqlite`. The callback API: `Database` (`open` / `error` / `close` events, `OPEN_*` modes), `run` (`this.lastID`, `this.changes`), `get`, `all`, `each`, `map`, `exec`, `prepare` → `Statement` (`bind`, `reset`, `finalize`, …), `serialize` / `parallelize`, `configure('busyTimeout')`, `interrupt`, `wait`, `close`, `verbose()`, `cached`, `VERSION`; errors like `SQLITE_CONSTRAINT: …` with `errno` / `code`. Operations run off the main thread, one after another per database. No `'change'` event, `loadExtension`, `Backup`. |
| `node-pty` | 🟡 | [native] Aliased; feature `pty` (portable-pty: Unix ptys, ConPTY). `spawn(file, args, { name, cols, rows, cwd, env, encoding, handleFlowControl })` with `pid` at once, `process` (foreground program), `onData` / `onExit` and `'data'` / `'exit'`, `write`, `resize`, `kill(signal)`, `pause` / `resume`, `clear`, `destroy`; output decoded as a stream, `exit` after the last output, controls kept in order. Spawn failures throw (node-pty's Unix child prints and exits 1); no `uid` / `gid`, no `open()`. Terminals and databases a page opened end when it reloads or its window closes. Verified on Linux; ConPTY compile-checked. |
| Other native Node modules (`.node` addons), `asar` | 🚫 | A webview cannot load them: replace them with a Rust command. Forks of the packages above under other names are not aliased automatically (alias them to `tauri-electron/<name>` in the bundler config). |
