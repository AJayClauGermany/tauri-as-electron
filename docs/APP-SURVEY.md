# Survey: how 30 open-source Electron apps use Electron

[TARGET-APPS.md](TARGET-APPS.md) drove the first rounds of work from two
apps, VS Code and GitHub Desktop. This survey widens that to 30 popular
open-source Electron apps, to rank what to build next by **how many apps a
gap blocks** and **how much work it is**. The ranked checklist that came
out of it is [ROADMAP.md](ROADMAP.md).

Method: shallow clones of each app's default branch (November 2026), then
a regex scan of every source file that imports `electron` (tests, builds and
vendored code excluded). The API catalogue is Electron 45.3's
`electron.d.ts`. Module calls (`app.getPath`) are matched exactly; instance
calls (`win.maximize()`, `webContents.on('did-finish-load')`) are matched by
method or event name, so treat numbers as "how many apps", not exact call
counts. Structural features (`<webview>`, `nodeIntegration`, helper
packages, native modules) were counted separately and checked by hand. The
scripts, the commit of every app, and the raw output are in
[`scripts/survey`](../scripts/survey).

## The apps

| App | Kind | Electron |
| --- | --- | --- |
| VS Code | Editor | (set by its build scripts) |
| GitHub Desktop | Git client | 44.9 |
| Signal Desktop | Messenger | 45.2 |
| Element | Matrix chat | 41.0 |
| Mattermost | Team chat | 45.2 |
| Rocket.Chat | Team chat | 43.8 |
| Zulip | Team chat | 45.1 |
| Wire | Messenger | 43.1 |
| Ferdium | Messaging aggregator | 44.2 |
| Bitwarden (`clients/apps/desktop`) | Password manager | 43.8 |
| Joplin | Notes | 42.11 |
| Logseq (ClojureScript) | Notes | 42.11 |
| Trilium | Notes | 45.3 |
| SiYuan | Notes | 44.10 |
| Standard Notes | Notes | 35.2 |
| AFFiNE | Notes / whiteboard | 43.8 |
| Zettlr | Markdown editor | 44.10 |
| MarkText | Markdown editor | 45.0 |
| draw.io | Diagrams | 44.9 |
| Super Productivity | To-do / time tracking | 44.10 |
| Insomnia | API client | 43.2 |
| Bruno | API client | 43.8 |
| Beekeeper Studio | Database client | 44.9 |
| Hyper | Terminal | 22.3 |
| Tabby | Terminal | 43 |
| Responsively | Web-dev browser | 44.5 |
| FreeTube | YouTube client | 44.10 |
| Heroic | Game launcher | 45.1 |
| Upscayl | Image upscaler | 33.2 |
| balenaEtcher | USB flasher | 44.9 |

## Findings

### 1. The common Electron API is covered

118 Electron APIs are used by at least 10 of the 30 apps (the full list, down to APIs a single app uses, is [`api-usage.tsv`](../scripts/survey/data/api-usage.tsv)). **106 of them
work today** (windows, IPC, menus, dialogs, lifecycle, shell, clipboard,
screen, single instance, deep links, `net.fetch`, `webUtils`, ...). The
other 12:

| API | Apps | Now | Effect |
| --- | --- | --- | --- |
| `safeStorage.encryptString` / `decryptString` / `isEncryptionAvailable` | 12 | 🟡 unavailable | Apps that store tokens or database keys fall back to plain text or fail. |
| `protocol.handle` | 15 | 🟡 | Each scheme must be declared in Rust, and handlers that answer with `net.fetch('file://…')` get nothing. |
| `BrowserWindow#setMenuBarVisibility` (+ `autoHideMenuBar`) | 14 | ⚪ | The menu bar stays visible on Windows and Linux. |
| `nativeImage.createFromPath` | 14 | 🟡 | Only files bundled with the app, not absolute paths on disk. |
| `webContents` `before-input-event` | 11 | 🟡 | `preventDefault()` has no effect. |
| `session` spell-checker languages / dictionary | 10 | 🟡 stored | No suggestions. |
| `app.requestSingleInstanceLock` | 24 | 🟡 opt-in feature | Works when the `single-instance` feature is on. |
| `render-process-gone`, `will-redirect` | 15, 10 | never emitted | Harmless: crash recovery and redirect logging never run. |
| `app.setAppUserModelId`, `disableHardwareAcceleration` | 14, 13 | ⚪ | Harmless. |

### 2. What blocks apps is structural, not the long tail of the API

| Feature | Apps | Now | Who depends on it |
| --- | --- | --- | --- |
| Node built-ins in the main process | 30 | 🟡 layers 1–4 | Everyone. Missing pieces that many apps use: `fs` streams (`createReadStream` / `createWriteStream`, 21 apps), `fs.watch` or chokidar (17), file descriptors (`fs.open` / `read` / `write` / `fsync`, 11), `vm` (10), `worker_threads` (8), `child_process.fork` (5), `http2` (3). |
| Main window with `nodeIntegration: true` / `contextIsolation: false` | 12 | ❌ no Node in renderers | GitHub Desktop, Hyper, Tabby, Joplin, Ferdium, Rocket.Chat, Heroic, Bruno, Etcher, SiYuan, Upscayl, Insomnia (hidden worker window). Signal, Beekeeper, Logseq and Insomnia also use Node in `sandbox: false` preloads. |
| `<webview>` tag (`webviewTag: true`) | 13 | ❌ not implemented, not documented | Core of Ferdium, Zulip, Wire, Rocket.Chat and Responsively (one webview per account or device); secondary in Bruno, Insomnia, Heroic, Trilium, SiYuan, VS Code, Etcher, Super Productivity. |
| `@electron/remote` | 10 | ❌ | Ferdium, Zulip, Wire, Joplin, Tabby, Hyper, Etcher, Beekeeper, SiYuan, Standard Notes. |
| `WebContentsView` / `BrowserView` | 6 | ❌ | Core of Mattermost (one view per server); VS Code's integrated browser, AFFiNE tabs, FreeTube, Responsively, Super Productivity. |
| `utilityProcess.fork` | 5 | 🚫 | VS Code, AFFiNE, Trilium, Beekeeper, Insomnia. |
| Native Node modules | 17 | 🚫 | `keytar` (6), `better-sqlite3` / `sqlite3` (5), `node-pty` (4: Hyper, Tabby, VS Code, Bruno), `sharp` (2), Signal's `libsignal` / `ringrtc`, Bitwarden's own Rust `desktop_native`, `dugite` (GitHub Desktop, a git binary, works through `child_process`), database drivers (Beekeeper). |

### 3. Helper packages decide more ports than the API does

These are imported from the main process by many apps, so they count like
Electron APIs:

| Package | Apps | What it needs | Works now? |
| --- | --- | --- | --- |
| `electron-updater` | 19 | `fs` streams and `fs.open`, `child_process` to run installers, `http(s)`, `app-update.yml` next to the app | ❌ A shim on `tauri-plugin-updater` is the realistic route (same idea as `autoUpdater`). |
| `electron-log` | 14 | `fs.writeFileSync` with `flag: 'a'` (works), `fs.openSync` / `readSync` to read the log tail, `session.registerPreloadScript` for renderer logging | 🟡 File logging works; reading the tail throws; renderer logs need the preload injected by the bundler. |
| `electron-store` (via `conf` → `atomically`) | 9 | `fs.open` / `write` / `fsync` / `close` for atomic writes; `fs.watch` with `watch: true` | ❌ Fails on the first write until file descriptors exist. |
| `electron-window-state` | 9 | `screen`, `app.getPath`, `fs` | ✅ expected (not yet run). |
| `@sentry/electron` | 8 | `protocol.handle('sentry-ipc')` on a scheme only it knows, `registerPreloadScript`, `crashReporter`, `powerMonitor` | 🟡 The scheme is not declared in Rust, so renderer events cannot reach the main process. |
| `electron-dl` | 6 | `session.on('will-download')`, `DownloadItem`, `downloadURL` | ❌ |
| `electron-context-menu` | 4 | `context-menu` event, `Menu`, spell-check suggestions | ✅ apart from suggestions. |
| `electron-devtools-installer` | 11 | `session.loadExtension` | Development only; rejects (no Chrome extensions). |

### 4. Gaps outside the top 118, by reach

| API | Apps | Now |
| --- | --- | --- |
| `session.webRequest.onBeforeSendHeaders` / `onHeadersReceived` / `onBeforeRequest` | 18 | ⚪ stored, never called |
| `setPermissionRequestHandler` / `setPermissionCheckHandler` | 14 | ⚪ stored |
| `certificate-error`, `setCertificateVerifyProc`, `select-client-certificate` | 12 | 🚫 never emitted |
| `nativeImage` `resize` / `crop` | 11 | ❌ |
| `login` (proxy and HTTP auth) | 7 | 🚫 never emitted |
| `titleBarOverlay` / `setTitleBarOverlay` | 8 | ⚪ no window buttons on frameless windows |
| `dialog.showMessageBox` `checkboxLabel` | 8 | 🟡 ignored |
| `session.cookies.get/set/remove` | 8 | ❌ |
| `session.on('will-download')` / `DownloadItem` | 8 | ❌ |
| `desktopCapturer` / `setDisplayMediaRequestHandler` | 8 | 🚫 |
| `powerMonitor` `suspend` / `resume` / `lock-screen` / `unlock-screen` | 8 | 🟡 only a heuristic `resume` |
| `Notification` `click` / `action` | 7 | 🟡 never emitted on desktop |
| `webContents.printToPDF` | 7 | 🚫 |
| `powerSaveBlocker.start` | 6 | 🟡 Screen Wake Lock |
| `screen.getCursorScreenPoint()` called synchronously | 5 | 🟡 returns a Promise (VS Code, Tabby, MarkText, SiYuan) |
| `capturePage` | 5 | 🚫 |
| `session.setProxy` | 4 | ⚪ |
| Synchronous `clipboard.readText` / `readHTML` / `readImage` (Electron < 45) | 3 | 🟡 Promises (Joplin, Insomnia, Tabby) |
| `getNativeWindowHandle`, `webContents.debugger`, `sendInputEvent` | 3 each | 🚫 / missing |

## Readiness per app

What each app needs from the [roadmap](ROADMAP.md), beyond what works
today. Items in **bold** are on the app's main path.

| App | Needs | Distance |
| --- | --- | --- |
| draw.io | **A1 fds**, **A2 streams** (electron-store, electron-log), **B2 electron-updater**, C8 `printToPDF` | Close |
| Upscayl | **B1 Node renderer**, A7 file protocol, B2 electron-updater | Close (spawns its binary with `child_process`, which works) |
| Element | **A7 file protocol** (`vector://`), **A1** (electron-store), B3 safeStorage, B6 downloads, C9 screen capture | Close |
| Super Productivity | **A1**, **A2**, B4 `fs.watch`, B6 downloads (electron-dl) | Close |
| Zettlr | **B4 chokidar**, **B8 title-bar overlay**, A2, C8 `printToPDF` | Medium |
| MarkText | **B4 chokidar**, **A1** (electron-store), C5 `keytar`, `native-keymap`, `font-list` | Medium |
| FreeTube | **C7 `webRequest`** (rewrites YouTube request headers), A7, A6 cookies | Blocked on C7 |
| GitHub Desktop | **B1 Node renderer**, C5 `keytar`, `dugite` (via `child_process`), C10 `certificate-error` | Medium |
| Heroic | **B1 Node renderer**, A2, B2 electron-updater, B8 overlay, C1 `<webview>` (store logins) | Medium |
| Etcher | **B1**, **B5 remote**, `drivelist` native module | Hard |
| Standard Notes | **B5 remote**, A1, A2, C5 `keytar` | Medium |
| Bitwarden | A6 cookies, A7, A1 (electron-store), B2, **own `desktop_native` Rust module** | Hard (but its native code is Rust: could become a Tauri plugin) |
| Responsively | **C1 `<webview>`** (core), B2, A1 | Blocked on C1 |
| Zulip | **C1 `<webview>`**, B5 remote, B6 downloads, B9 notification click | Blocked on C1 |
| Ferdium | **C1 `<webview>`**, **B1**, **B5**, `sqlite3` | Blocked on C1 |
| Wire | **C1 `<webview>`**, B5, A6, C9 | Blocked on C1 |
| Rocket.Chat | **C1 `<webview>`**, **B1**, C9 screen sharing, B4 | Blocked on C1 |
| Mattermost | **C1 `WebContentsView`**, A6, B6, `koffi` | Blocked on C1 |
| Insomnia | **B1** (hidden worker window), C3 `utilityProcess` / `fork`, `@grpc/grpc-js` (needs `http2`) | Hard |
| Bruno | **B1**, C1, C2 `worker_threads`, C5 `node-pty`, `http2` | Hard |
| Joplin | **B1**, **B5**, C5 `sqlite3` + `keytar`, `sharp` | Hard |
| SiYuan | **B1**, **B5**, main window loads its Go kernel's `http://127.0.0.1:6806` page (C6: no IPC for such pages today), C8 | Hard |
| Logseq | C3 `fork`, C5 `better-sqlite3`, `keytar`, C2 | Hard |
| AFFiNE | C3 `utilityProcess`, C1 views (tabs), A2 | Hard |
| Trilium | C5 `better-sqlite3`, C1 `<webview>`, C3 | Hard |
| Beekeeper Studio | B5, C3, C5 (`better-sqlite3`, `oracledb`; `pg` / `mysql2` are pure JS over `net`) | Hard |
| Hyper, Tabby | **B1**, **B5**, **C5 `node-pty`** | Hard |
| Signal | `libsignal` / `ringrtc` native modules, C2, Node in preload | Not realistic |
| VS Code | C3 `utilityProcess`, C5, C2 (see [TARGET-APPS.md](TARGET-APPS.md)) | Not realistic soon |

The fastest way to more running apps: the **A** items (small, and they
unlock the helper packages most apps load at startup), then **B1** (Node in
renderers) and **B2** (`electron-updater`), then **C1** (`<webview>` /
`WebContentsView`), which is the single feature behind five chat apps.
