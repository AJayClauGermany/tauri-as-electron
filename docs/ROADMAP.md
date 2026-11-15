# Roadmap: what to build next

A ranked checklist for the next work sessions, built from the
[survey of 30 open-source Electron apps](APP-SURVEY.md). Order follows
**apps unblocked ÷ effort**: wave A first (small items that unlock the
helper packages most apps load at startup), then wave B (one session each,
broad reach), then wave C (structural, several sessions each). Tick items
off here when they land, and update [API-COVERAGE.md](API-COVERAGE.md) and
the kitchen sink in the same change.

**Apps** is how many of the 30 surveyed apps use the API (see the survey for
names). **Effort**: S = part of a session, M = about one session, L =
several sessions or depends on unstable Tauri features. The Tauri building
block was checked against tauri 2.12 / wry 0.57 (the versions in
`Cargo.lock`).

## Wave A: quick wins

- [x] **A1. `fs` file descriptors.** `open`, `close`, `read`, `write`,
  `fstat`, `fsync`, `fdatasync`, `ftruncate` (sync, callback and
  `fs.promises` `FileHandle`). A descriptor table in `node_fs.rs`.
  *Apps 11 directly; also unblocks `electron-store` (9 apps: `conf` →
  `atomically` opens, writes and fsyncs a temp file), `write-file-atomic`
  and `electron-log`'s tail read (14).* Effort S–M.
  *Done: numbers from 3 up in a process-wide table in `node_fs.rs`; 1 and 2 write to stdout / stderr.*
- [x] **A2. `fs.createReadStream` / `createWriteStream`** on top of A1 and
  readable-stream (`start` / `end`, `highWaterMark`, `fd` option).
  *Apps 21; `electron-updater` and `builder-util-runtime` need them.*
  Effort S after A1.
  *Done: readable-stream `ReadStream` / `WriteStream`, also from a `FileHandle`.*
- [x] **A3. `screen.getCursorScreenPoint()` synchronous.** Answer over the
  synchronous bridge from `Window::cursor_position` instead of returning a
  Promise. *Apps 5 call it synchronously (VS Code's window placement,
  Tabby, MarkText, SiYuan).* Effort S.
  *Done.*
- [x] **A4. Menu-bar visibility.** `setMenuBarVisibility`,
  `isMenuBarVisible`, `autoHideMenuBar` / `setAutoHideMenuBar` through
  `Window::hide_menu` / `show_menu` / `is_menu_visible`; with auto-hide,
  Alt shows the bar (renderer bootstrap). *Apps 14.* Effort S.
  *Done (Windows and Linux; macOS has no per-window menu bar, as in Electron).*
- [x] **A5. `nativeImage` editing and disk paths.** `resize`, `crop`,
  `createThumbnailFromPath` with `OffscreenCanvas`; `createFromPath` for
  absolute paths read through the `node-fs` bridge (today only files
  bundled with the app). *Apps 11 resize / crop, 14 `createFromPath`.*
  Effort S.
  *Done with a JavaScript PNG codec (fflate), so `resize` / `crop` stay synchronous for PNGs; other formats decode through `createImageBitmap` / `OffscreenCanvas` when used.*
- [x] **A6. `session.cookies`.** `get` / `set` / `remove` / `flushStore`
  and the `changed` event (emitted for our own changes) through
  `Webview::cookies_for_url` / `cookies` / `set_cookie` / `delete_cookie`.
  *Apps 8 (Bruno, Mattermost, Wire, Joplin, Insomnia, FreeTube, SiYuan,
  Bitwarden).* Effort S.
  *Done; `hostOnly` is not reported (the `cookie` crate drops the leading dot).*
- [x] **A7. File-backed protocols.** `net.fetch('file://…')` reads through
  the `node-fs` bridge and returns a `Response` (with a MIME type from the
  extension); `protocol.registerFileProtocol` / `registerBufferProtocol` /
  `registerStringProtocol` callback forms become `handle()` adapters. This
  is the usual body of a `protocol.handle` handler. *Apps 10 serve files
  this way (Element's `vector://`, VS Code's `vscode-file://`, Signal,
  Mattermost, Upscayl, ...).* Effort S–M.
  *Done.*
- [x] **A8. Synchronous clipboard for Electron < 45.** Electron 45 made
  `clipboard.readText` & co. async; apps pinned to older versions call them
  synchronously. When the app's `electron` dependency is below 45 (the
  bundler plugin reads `package.json`), serve `readText`, `readHTML`,
  `readImage`, `availableFormats` and `has` over the synchronous bridge.
  Add `readHTML` (a Rust command; `plugin-clipboard-manager` reads only
  text and images). *Apps 3 (Joplin, Insomnia, Tabby); `readHTML` 2.*
  Effort S.
  *Done (`electron` major version in `__TAURI_ELECTRON_APP__`; reads with arboard).*
- [x] **A9. `powerSaveBlocker` with an OS assertion** (for example the
  `keepawake` crate: IOPMAssertion, `SetThreadExecutionState`, logind
  inhibitors) instead of a Screen Wake Lock that only holds while a window
  is visible. *Apps 6.* Effort S.
  *Done: feature `power-save-blocker`, on by default; the wake lock remains the fallback.*
- [x] **A10. `electron-log` renderer preload.** Inject scripts registered
  with `session.registerPreloadScript` / `setPreloads` when the bundler can
  resolve them at build time (`electron-log`, `@sentry/electron`).
  *Apps 14 + 8.* Effort S–M.
  *Done: the bundler plugins put electron-log's and @sentry/electron's preloads in every renderer page when the app depends on them (option `sessionPreloads` for others); other registered paths warn. @sentry/electron still needs its `sentry-ipc` scheme declared in Rust.*

## Wave B: one session each, broad reach

- [ ] **B1. Node built-ins in renderers.** Windows created with
  `nodeIntegration: true` (or `contextIsolation: false`) and preloads with
  `sandbox: false` get the main page's Node layer (`fs`, `os`,
  `child_process`, `net`, ...) and a global `require`. Needs: the bridge's
  caller check (`node_refusal`) to accept those windows, a capability
  granted per window at creation, and the bundler to treat those pages
  like the main page. *Apps 12 open their main window this way (GitHub
  Desktop, Hyper, Tabby, Joplin, Ferdium, Rocket.Chat, Heroic, Bruno,
  Etcher, SiYuan, Upscayl, Insomnia's worker window); 4 more use Node in
  preloads (Signal, Beekeeper, Logseq, Insomnia). The highest-leverage item
  here.* Effort M.
- [x] **B2. `electron-updater` shim.** Alias `electron-updater` (like
  `electron`) to a module on `tauri-plugin-updater` that exposes its
  `autoUpdater`: `checkForUpdates`, `checkForUpdatesAndNotify`,
  `downloadUpdate`, `quitAndInstall`, `autoDownload`,
  `autoInstallOnAppQuit`, `logger`, `channel`, and the events
  (`checking-for-update`, `update-available`, `update-not-available`,
  `download-progress`, `update-downloaded`, `error`). The feed stays in
  `tauri.conf.json`; `setFeedURL` is recorded. *Apps 19, the most-used
  helper package.* Effort M.
  *Done: `tauri-electron/electron-updater`, aliased by both bundler plugins; Tauri's update format and endpoints (channel and feed URL go to the endpoint as headers), cancelling stops waiting, not the transfer.*
- [ ] **B3. `safeStorage` with a real key.** A random key kept in the OS
  keychain (`keyring` crate: Keychain, Credential Manager, Secret Service),
  AES-256-GCM in Rust, `encryptString` / `decryptString` synchronous over
  the bridge plus the async variants, `getSelectedStorageBackend`
  reporting `gnome_libsecret` / `kwallet*` / `basic_text`,
  `setUsePlainTextEncryption`. Ciphertext is not compatible with
  Electron's. *Apps 12 (Signal, Element, Mattermost, Bruno, Joplin, Wire,
  VS Code, ...).* The same crate backs a `keytar` shim (C5). Effort M.
- [ ] **B4. `fs.watch` / `fs.watchFile` / `fs.promises.watch`** on the
  `notify` crate, events over a Channel; then check chokidar (v3 and v4)
  on top. *Apps 17 watch files; chokidar is a dependency of 9.* Effort M.
- [ ] **B5. `@electron/remote` shim.** Alias `@electron/remote` (and
  `/main`, `/renderer`) to renderer-side proxies over the synchronous
  bridge for the subset apps use: `getCurrentWindow`,
  `getCurrentWebContents`, `app`, `dialog`, `shell`, `Menu` / `MenuItem`
  (`popup`), `BrowserWindow`, `screen`, `nativeTheme`, `getGlobal`;
  `initialize` / `enable` on the main side. Callbacks and returned objects
  become remote references. *Apps 10.* Most of them also need B1.
  Effort M–L.
- [ ] **B6. Downloads.** `session.on('will-download')`, `DownloadItem`
  (`setSavePath`, `getFilename`, `getURL`, `getTotalBytes`,
  `getReceivedBytes`, `cancel`, `updated`, `done`),
  `webContents.downloadURL`, `session.downloadURL`, so `electron-dl` works.
  Tauri's `on_download` hook exists only on the webview builder, so
  windows have to be created from Rust (a plugin command) instead of
  JavaScript `WebviewWindow`; that also enables B7 per window and B12.
  Progress is coarse (Tauri reports requested and finished). *Apps 8,
  plus `electron-dl` in 6.* Effort M.
- [ ] **B7. Permission handlers applied.** `setPermissionRequestHandler` /
  `setPermissionCheckHandler` through Tauri's `on_permission_request`
  (camera, microphone, geolocation, notifications; per platform as wry
  supports them). The Rust hook is synchronous, so answer from decisions
  the main page pushed ahead (or block on a bridge round trip, off the
  main thread). *Apps 14.* Effort M.
- [x] **B8. Window controls for `titleBarOverlay`.** On Windows and Linux,
  `titleBarStyle: 'hidden'` + `titleBarOverlay` gives Electron apps native
  minimize / maximize / close buttons; here frameless windows have none.
  Draw them in the renderer bootstrap (colour, symbol colour and height
  from the options; `setTitleBarOverlay` updates them) and keep
  `navigator.windowControlsOverlay` geometry consistent. *Apps 8 (VS Code,
  SiYuan, Zettlr, Heroic, Trilium, Tabby, Mattermost, Super
  Productivity).* Effort M.
  *Done: buttons in a shadow root, maximize icon follows the window; `navigator.windowControlsOverlay` and `--titlebar-area-*` custom properties (WebKit has no `env(titlebar-area-*)`).*
- [ ] **B9. `Notification` click and actions on desktop.** `click`,
  `action`, `close`, `reply` need a backend that reports activation
  (notify-rust actions on Linux, toast activation on Windows,
  UNUserNotificationCenter on macOS); `plugin-notification` does not on
  desktop. *Apps 7 (Signal, VS Code, Mattermost, Heroic, Zettlr, SiYuan,
  Bitwarden).* Effort M–L.
- [x] **B10. Custom schemes without editing Rust.** The bundler plugins
  collect scheme names from `protocol.registerSchemesAsPrivileged` and
  `protocol.handle` calls and write them where
  `tauri_plugin_electron::Builder` reads them (a generated file or the
  plugin's section of `tauri.conf.json`). Covers schemes that libraries
  add on their own (`@sentry/electron`'s `sentry-ipc`). *Apps 15.*
  Effort S–M.
  *Done: `src-tauri/electron-schemes.json`, passed on by the app's build.rs to `Builder::protocols(bundled_schemes!())` (template and kitchen sink); found by scanning the app's source, so schemes built from variables need the `schemes` option.*
- [ ] **B11. `powerMonitor` system events.** `suspend`, `resume`,
  `lock-screen`, `unlock-screen`, `shutdown`, plus
  `getSystemIdleTime` / `getSystemIdleState` (logind and the screensaver
  D-Bus API on Linux, `NSWorkspace` notifications and `CGEventSource` on
  macOS, `WM_POWERBROADCAST` / WTS and `GetLastInputInfo` on Windows).
  *Apps 8 events, 5 idle time.* Effort M.
- [x] **B12. `dialog.showMessageBox` beyond three buttons.**
  `checkboxLabel` / `checkboxChecked`, more than three buttons, `defaultId`,
  `cancelId`: fall back to a small modal `BrowserWindow` when the native
  dialog cannot express the options. *Apps 8 use `checkboxLabel`.*
  Effort M.
  *Done: a window served by the bridge scheme (no IPC permission), parented and disabling its parent; also for `showMessageBoxSync` (blocks on the bridge). The native dialog stays for three buttons or fewer without a checkbox.*
- [ ] **B13. `session.setProxy` / `app.setProxy`** through
  `proxy_url` when windows are created (with B6's Rust-side creation);
  `resolveProxy` then reports the configured proxy. *Apps 4.* Effort S
  after B6.

## Wave C: structural, several sessions each

- [ ] **C1. `<webview>` and `WebContentsView` / `BrowserView`** on Tauri
  child webviews (`Window::add_child`, behind tauri's `unstable` feature):
  a `<webview>` custom element that keeps a child webview positioned over
  its box, a `webContents` for each child (IPC, `executeJavaScript`,
  navigation events, `will-attach-webview` / `did-attach-webview`,
  `partition`), and `BaseWindow.contentView.addChildView`. *Apps 13 use
  `<webview>` (the core of Ferdium, Zulip, Wire, Rocket.Chat,
  Responsively) and 6 use views (the core of Mattermost). One feature
  behind five chat apps.* Effort L.
- [ ] **C2. `worker_threads`** on Web Workers that load the Node layer
  (`Worker`, `parentPort`, `workerData`, `MessageChannel`, `isMainThread`).
  Needs the bridge to accept workers. *Apps 8.* Effort L.
- [ ] **C3. `utilityProcess.fork` and `child_process.fork`.** A Node
  sidecar (bundled runtime via `plugin-shell`), `MessagePortMain` bridged
  over stdio, `'ipc'` stdio for `fork`. *Apps 5 + 5 (VS Code, AFFiNE,
  Trilium, Beekeeper, Insomnia, Joplin, Logseq).* Effort L.
- [ ] **C4. `vm`** contexts on iframe realms (feasibility verified in
  [NODE-COMPAT-PLAN.md](NODE-COMPAT-PLAN.md)): `runInNewContext`,
  `createContext`, `Script`. *Apps 10.* Effort M–L.
- [ ] **C5. Shims for common native modules** through the bundler's
  module aliases: `keytar` (on B3's keyring code; 6 apps), `better-sqlite3`
  / `sqlite3` (rusqlite; 5 apps), `node-pty` (portable-pty; 4 apps:
  Hyper, Tabby, VS Code, Bruno). Each M–L; `keytar` is S once B3 exists.
- [ ] **C6. IPC and preloads for local-server pages.** Apps that start a
  server and load `http://127.0.0.1:<port>` in their main window (SiYuan's
  kernel) get no IPC today ("remote pages have no IPC"). Allow an
  app-declared list of origins to receive the preload and the renderer
  capability. Effort M.
- [ ] **C7. `session.webRequest` applied.** Header and request rewriting
  for http(s) has no hook on WKWebView or WebKitGTK; WebView2 has
  `WebResourceRequested`. Options: Windows-only support, or rewriting only
  for custom schemes and `net.fetch`. Mostly used to relax CSP / CORS or
  set headers for remote pages. *Apps 18 (FreeTube depends on it to talk
  to YouTube).* Effort L, partial at best.
- [ ] **C8. `printToPDF` and `capturePage`** per platform through
  `with_webview` (WKWebView `createPDF` / `takeSnapshot`, WebView2
  `PrintToPdf` / `CapturePreview`, WebKitGTK print operation to a file /
  `get_snapshot`). *Apps 7 and 5 (draw.io, Joplin, Zettlr, MarkText,
  SiYuan export PDFs).* Effort M–L.
- [ ] **C9. Screen capture.** `desktopCapturer.getSources` and
  `setDisplayMediaRequestHandler` for screen sharing; depends on each
  webview's `getDisplayMedia` support. *Apps 8 (the chat apps).* Effort L.
- [ ] **C10. TLS and auth events.** `certificate-error`,
  `setCertificateVerifyProc`, `select-client-certificate`, `login`
  (WebView2 `ServerCertificateErrorDetected` / `BasicAuthenticationRequested`,
  WebKitGTK `load-failed-with-tls-errors` / `authenticate`; WKWebView's
  navigation delegate belongs to wry). Mostly used to accept self-signed
  servers. *Apps 12 and 7.* Effort L.

## Leave as they are

Used by several apps, but a no-op or a never-emitted event does no harm,
or there is no Tauri equivalent:

- Never emitted, harmless: `render-process-gone` (15 apps), `will-redirect`
  (10), `child-process-gone` (5), `unresponsive` / `responsive` (4),
  `crashReporter.start` (3).
- Accepted no-ops: `app.setAppUserModelId` (14),
  `disableHardwareAcceleration` (13), `setWindowButtonPosition` (6),
  `setVibrancy` / `backgroundMaterial` (4), `TouchBar` (4),
  `Session.clearCache` (9).
- Not possible: `getNativeWindowHandle` (3), `webContents.debugger` (3),
  Chrome extensions (`electron-devtools-installer`, 11 apps, development
  only), `contentTracing` (1).

## Already done

Everything [TARGET-APPS.md](TARGET-APPS.md) lists as ✅, and Node layers 1–4
([NODE-COMPAT-PLAN.md](NODE-COMPAT-PLAN.md)). Of the 118 Electron APIs that
at least 10 of the 30 apps use, 106 work today.
