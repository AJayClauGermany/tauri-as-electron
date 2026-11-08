# Target apps: VS Code and GitHub Desktop

To decide which parts of Electron's API matter most, we read the Electron
usage of two large, popular Electron apps and listed every API on their
**main code path**: startup, windows, IPC, menus, dialogs, quitting and
updating. Some APIs are only reached in edge cases (crash reporting, the
process explorer, screen capture, the Touch Bar). Those are listed separately.

Sources: `microsoft/vscode` (`src/vs/**/electron-main`, `electron-utility`,
`electron-browser`, about 22k lines across 54 files that import `electron`)
and `desktop/desktop` (`app/src/main-process`, `app/src/lib`, `app/src/ui`,
25 files, Electron 44). Both were read in November 2026.

Legend: ✅ works · 🟡 works with documented differences · ⚪ accepted, no
effect · ❌ throws `NotImplementedError`. **Before** is the status before this
round of work; **now** is the current status. See
[API-COVERAGE.md](API-COVERAGE.md) for the details of each API.

## What each app needs from Electron

### Shared by both apps

| API | How they use it | Before | Now |
| --- | --- | --- | --- |
| `app` lifecycle: `ready`, `before-quit`, `will-quit`, `window-all-closed`, `activate`, `quit`, `exit`, `relaunch` | Startup and shutdown | ✅ | ✅ |
| `app.requestSingleInstanceLock` + `second-instance` | A second launch hands its arguments to the running app | ⚪ | ✅ `tauri-plugin-single-instance` |
| `app.on('open-url' / 'open-file')` | macOS deep links and file associations | ❌ | ✅ `RunEvent::Opened` |
| `app.setAsDefaultProtocolClient` | `x-github-client://`, `vscode://` | ⚪ | ✅ `tauri-plugin-deep-link` (macOS: declared in config) |
| `app.getPath`, `getAppPath`, `getVersion`, `getLocale`, `getLocaleCountryCode`, `setAppLogsPath` | Paths and locale | ✅ | ✅ |
| `process.argv`, `process.env`, `process.execPath`, `app.commandLine` | CLI arguments, environment, switches | 🟡 empty | ✅ `tauri-plugin-electron` |
| `app.on('web-contents-created')` | Installs `setWindowOpenHandler` / `will-navigate` guards on every page | ❌ | ✅ |
| `BrowserWindow` options: `x/y/width/height`, `minWidth/minHeight`, `show: false`, `backgroundColor`, `title`, `icon`, `frame: false`, `titleBarStyle: 'hidden'` | Main window from saved window state | 🟡 | ✅ `hidden` is frameless off macOS, like Electron |
| `BrowserWindow` state: `isMaximized/Minimized/FullScreen/Visible/Focused`, `maximize`, `unmaximize`, `restore`, `minimize`, `setFullScreen`, `getBounds/getPosition/getSize/getNormalBounds/setBounds`, `focus`, `show`, `close`, `destroy`, `flashFrame`, `setBackgroundColor` | Window state handling and custom title-bar buttons | ✅ (`getNormalBounds` approximate) | ✅ |
| `BrowserWindow` events: `close`, `closed`, `focus`, `blur`, `maximize`, `unmaximize`, `minimize`, `restore`, `enter/leave-full-screen`, `show`, `hide`, `ready-to-show` | Sync the window state to the renderer | ✅ | ✅ |
| `-webkit-app-region: drag` | Custom title bars (VS Code everywhere it uses a custom title bar, Desktop on Windows) | ❌ | ✅ dragging, double-click to maximize |
| `webContents` events `did-finish-load`, `did-fail-load`, `did-start-loading`, `destroyed`, `will-navigate`, `context-menu`, `page-title-updated` | Splash timing, navigation guards, spell-check menu | 🟡 (load events only) | ✅ (`did-fail-load` only for creation errors) |
| `webContents.setWindowOpenHandler` | Open links in the system browser and deny the popup | ⚪ stored | ✅ `window.open` and `target=_blank` intercepted |
| `webContents.send`, `isDestroyed`, `getURL`, `getTitle`, `focus`, `reload`, `selectAll`, `zoomFactor`, `setZoomFactor`, `setVisualZoomLevelLimits` | Main → renderer messages and View menu actions | 🟡 (no `zoomFactor` property) | ✅ |
| `webContents.openDevTools` / `toggleDevTools` | The Help / View menus, and on load errors | ⚪ | ✅ debug builds, or the plugin's `devtools` feature |
| `ipcMain.on/once/handle/removeHandler`, `event.reply`, `event.sender` | All renderer ↔ main traffic | ✅ | ✅ |
| Structured-clone IPC payloads (`Uint8Array`, `Error`, `Date`, `undefined`) | VS Code sends `VSBuffer`s; Desktop sends errors | 🟡 JSON only | ✅ |
| `Menu.buildFromTemplate`, `setApplicationMenu`, `getApplicationMenu`, `getMenuItemById`, `popup({ callback })`, `append`, roles, accelerators | App menu and context menus | ✅ | ✅ |
| `dialog.showOpenDialog`, `showSaveDialog`, `showMessageBox` (with a window) | File pickers and confirmations | ✅ | ✅ |
| `shell.openExternal`, `showItemInFolder`, `openPath` | Links, “Reveal in Finder” | ✅ | ✅ |
| `shell.trashItem` | Desktop: discarding files; VS Code: delete to trash | ❌ | ✅ `trash` crate |
| `nativeTheme.themeSource`, `shouldUseDarkColors`, `updated` | Theme sync | ✅ | ✅ |
| `clipboard.writeText` / `readText` | Copy actions | ✅ | ✅ |
| `screen.getAllDisplays`, `getDisplayMatching`, `getDisplayNearestPoint`, `getPrimaryDisplay` | Restoring window state onto a visible display | ✅ | ✅ (+ `display-*` events) |
| `session.defaultSession.resolveProxy` | Proxy detection for git and HTTP | ❌ | 🟡 always `DIRECT` |
| `session` spell-checker languages / dictionary | Spell-check context menu | ❌ | 🟡 stored; no native spell checker |
| `net.request` / `net.fetch` | Desktop: error reports; VS Code: request service | ❌ | ✅ `tauri-plugin-http` |
| `autoUpdater` (`setFeedURL`, `checkForUpdates`, `quitAndInstall`, events) | Updates | ❌ | 🟡 `tauri-plugin-updater`; feed comes from `tauri.conf.json` |
| `crashReporter.start` | Startup | ❌ (throws at startup) | ⚪ |
| `app.disableHardwareAcceleration`, `setAppUserModelId` | Startup tweaks | ⚪ | ⚪ |

### GitHub Desktop only

| API | How Desktop uses it | Before | Now |
| --- | --- | --- | --- |
| `ipcRenderer.sendSync` + `event.returnValue` | `will-quit`, `cancel-quitting` handshake | ❌ | ✅ synchronous bridge |
| `webPreferences.nodeIntegration: true`, `contextIsolation: false` | The renderer uses Node directly | ❌ | ❌ no Node in webviews, see [below](#beyond-the-electron-api) |
| `systemPreferences.getUserDefault('AppleActionOnDoubleClick')` | Title-bar double-click | ❌ | 🟡 type-appropriate empty default |
| `app.isInApplicationsFolder` / `moveToApplicationsFolder` | macOS “move to Applications” | ⚪ | ⚪ returns `false` |
| `webUtils.getPathForFile` | Drag a repository folder onto the window | 🟡 | ✅ paths from Tauri's native file drop |
| `dialog.showCertificateTrustDialog` | Untrusted certificates (Windows/macOS) | ❌ | ❌ |
| `app.on('certificate-error')` | Same | ❌ never emitted | ❌ never emitted |
| `shell.beep`, `app.dock.bounce` | Notify when the window is not focused | 🟡 | 🟡 |

### VS Code only

| API | How VS Code uses it | Before | Now |
| --- | --- | --- | --- |
| `MessageChannelMain`, `MessagePortMain`, `event.ports`, `webContents.postMessage(…, [port])`, `ipcRenderer.postMessage(…, [port])` | Renderer ↔ shared process / extension host channels | ❌ | ✅ main ↔ renderer and renderer ↔ renderer |
| `event.senderFrame.url` (validated on every IPC message), `webContents.mainFrame`, `webFrameMain` | IPC sender validation | ❌ `senderFrame` was `null` | ✅ |
| `webContents.ipc` | Per-window IPC handlers | ❌ | ✅ |
| `webPreferences.additionalArguments` → renderer `process.argv` | The window configuration is passed in `--vscode-window-config=…` | ❌ | ✅ |
| `webPreferences.zoomFactor`, `sandbox`, `spellcheck`, `backgroundThrottling` | Window creation | 🟡 | ✅ `spellcheck` ignored |
| `protocol.registerSchemesAsPrivileged`, `protocol.handle`, `unhandle`, `registerFileProtocol` | `vscode-file://` and `vscode-webview://` | ❌ | 🟡 `handle` works for schemes declared in Rust; no file access without `fs` |
| `utilityProcess.fork` | Extension host, shared process, pty host, file watcher | ❌ | ❌ biggest blocker, see below |
| `safeStorage.encryptString/decryptString`, `isEncryptionAvailable`, `getSelectedStorageBackend` | Secret storage | ❌ | 🟡 reports encryption unavailable (VS Code has a fallback for this) |
| `powerMonitor` events and `getSystemIdleState`, `isOnBatteryPower` | Telemetry, idle detection | ❌ | 🟡 `unknown`, battery from `navigator.getBattery` |
| `powerSaveBlocker.start/stop` | Keep the display awake during debugging | ❌ | 🟡 Screen Wake Lock, best effort |
| `systemPreferences.getMediaAccessStatus`, `subscribeNotification`, `getUserDefault` | Permissions, accent/scroller notifications | ❌ | 🟡 |
| `webContents.findInPage` / `stopFindInPage` / `found-in-page` | Find in webviews | ❌ | 🟡 `window.find()` |
| `webContents.navigationHistory` | Integrated browser | ❌ | 🟡 tracked from navigation events |
| `webContents.on('console-message')`, `before-input-event` | Logging; shortcuts in the integrated browser | ❌ | 🟡 `before-input-event` cannot be prevented |
| `Menu.sendActionToFirstResponder`, `app.dock.setMenu`, `setJumpList`, `addRecentDocument` | Platform integration | ⚪ | ⚪ |
| `BrowserWindow.setTitleBarOverlay`, `setWindowButtonPosition`, `setTouchBar`, `addTabbedWindow`, `setRepresentedFilename`, `setDocumentEdited` | Platform chrome | ⚪ / ❌ (`TouchBar` threw) | ⚪ (accepted, cached) |
| `BrowserWindow.getNativeWindowHandle` | Native window integration on Windows | ❌ | ❌ |
| `webContents.session.webRequest` (CSP and header rewrites) | Webviews and the integrated browser | ❌ | ⚪ listeners stored, not applied |
| `session.fromPartition`, `clearStorageData` | Integrated-browser sessions | ❌ | 🟡 in-memory partitions → `incognito`; persistent ones share the default store except on macOS 14+ |
| `desktopCapturer`, `contentTracing`, `webContents.capturePage`, `debugger`, `WebContentsView` | Screenshots, profiling, the integrated browser | ❌ | ❌ |
| `app.getGPUFeatureStatus`, `getGPUInfo`, `getAppMetrics` | Diagnostics, process explorer | 🟡 | 🟡 placeholder values |

## Beyond the Electron API

Matching Electron's API is necessary, but it is not enough to port either
app unchanged. These gaps are outside `electron`'s exports:

- **Node.js in the main process.** Both apps use `fs`, `child_process`, `os`,
  `crypto`, `net` and native Node modules (`node-pty`, `@vscode/sqlite3`,
  `keytar`, Desktop's `dugite` git bindings) from the main process. The
  main process is a webview here, so this code has to move to Tauri
  plugins (`plugin-fs`, `plugin-shell`, ...), Rust commands, or a Node
  sidecar.
- **`utilityProcess`.** VS Code runs its extension host and shared process
  as `utilityProcess.fork()` children that talk over `MessagePort`s. The
  closest Tauri equivalent is a Node sidecar (`plugin-shell`) with a
  message protocol over stdio. That needs a bundled Node runtime, so it is
  left to the app.
- **`nodeIntegration` renderers.** Desktop's renderer imports Node modules
  directly. A Tauri webview cannot do that.
- **The `asar` archive and `__dirname`-relative file access.** The Vite
  plugin rewrites `__dirname` for page URLs, but code that reads files
  next to itself needs `plugin-fs` with resource paths.

The main path of the Electron API is now covered: windows, IPC (including
ports and sync IPC), menus, dialogs, lifecycle, single instance, deep links
and updates. The remaining work for a real port of these apps is mostly
replacing Node, not filling in Electron.
