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

- [x] **B1. Node built-ins in renderers.** Windows created with
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
  *Done: `set_window_config` (main window only) records the grant and adds an `electron-node-<label>` capability; `node_refusal` accepts granted windows showing the app's page. The bundler plugins load `tauri-electron/renderer-node` before the preloads (`rendererNode`, default `'auto'`), which installs the Node layer only in granted windows. Electron < 20's unsandboxed default is honoured. Not in workers; no `module` global in pages.*
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
- [x] **B3. `safeStorage` with a real key.** A random key kept in the OS
  keychain (`keyring` crate: Keychain, Credential Manager, Secret Service),
  AES-256-GCM in Rust, `encryptString` / `decryptString` synchronous over
  the bridge plus the async variants, `getSelectedStorageBackend`
  reporting `gnome_libsecret` / `kwallet*` / `basic_text`,
  `setUsePlainTextEncryption`. Ciphertext is not compatible with
  Electron's. *Apps 12 (Signal, Element, Mattermost, Bruno, Joplin, Wire,
  VS Code, ...).* The same crate backs a `keytar` shim (C5). Effort M.
  *Done: feature `safe-storage`, on by default; the key is read on a worker thread (at most 10 s); `getSelectedStorageBackend` reports `gnome_libsecret` for any Secret Service (KWallet included), never `kwallet*`. Linux verified (no Secret Service: `basic_text`, plain-text mode); macOS / Windows keychains compile-checked only.*
- [x] **B4. `fs.watch` / `fs.watchFile` / `fs.promises.watch`** on the
  `notify` crate, events over a Channel; then check chokidar (v3 and v4)
  on top. *Apps 17 watch files; chokidar is a dependency of 9.* Effort M.
  *Done: the watcher is created synchronously over the bridge and its events kept until the Channel attaches, so nothing after `fs.watch()` is missed; `fs.watchFile` polls with `stat`. chokidar 3 and 4 pass the kitchen sink (add / change / unlink / addDir) on Linux; `process.versions.node` (`22.0.0`) was added for readdirp 3.*
- [x] **B5. `@electron/remote` shim.** Alias `@electron/remote` (and
  `/main`, `/renderer`) to renderer-side proxies over the synchronous
  bridge for the subset apps use: `getCurrentWindow`,
  `getCurrentWebContents`, `app`, `dialog`, `shell`, `Menu` / `MenuItem`
  (`popup`), `BrowserWindow`, `screen`, `nativeTheme`, `getGlobal`;
  `initialize` / `enable` on the main side. Callbacks and returned objects
  become remote references. *Apps 10.* Most of them also need B1.
  Effort M–L.
  *Done: `tauri-electron/remote` (`/main`, `/renderer`), aliased by both bundler plugins and `require()`. Synchronous requests over `sendSync`; per-page reference tables with release on garbage collection; callbacks async, promises resolved in the renderer, errors rethrown. No `instanceof` against remote classes, no key enumeration of proxies.*
- [x] **B6. Downloads.** `session.on('will-download')`, `DownloadItem`
  (`setSavePath`, `getFilename`, `getURL`, `getTotalBytes`,
  `getReceivedBytes`, `cancel`, `updated`, `done`),
  `webContents.downloadURL`, `session.downloadURL`, so `electron-dl` works.
  Tauri's `on_download` hook exists only on the webview builder, so
  windows have to be created from Rust (a plugin command) instead of
  JavaScript `WebviewWindow`; that also enables B7 per window and B12.
  Progress is coarse (Tauri reports requested and finished). *Apps 8,
  plus `electron-dl` in 6.* Effort M.
  *Done: windows are created by a plugin command (`create_window`, Rust's `WebviewWindowBuilder` from the same `WindowConfig` as JavaScript's); every download goes to a temporary file that the main process moves to the save path when it is complete, so `setSavePath` works although the Rust hook decides synchronously (a save dialog asks without one). Linux uses WebKitGTK's download signals directly (sizes, progress, cancel); Windows / macOS use `on_download` (no total size, `cancel()` discards the file after the transfer). `downloadURL` is a reqwest transfer with the window's cookies (`net` feature): sizes, pause, resume, cancel. Not verified on Windows / macOS.*
- [x] **B7. Permission handlers applied.** `setPermissionRequestHandler` /
  `setPermissionCheckHandler` through Tauri's `on_permission_request`
  (camera, microphone, geolocation, notifications; per platform as wry
  supports them). The Rust hook is synchronous, so answer from decisions
  the main page pushed ahead (or block on a bridge round trip, off the
  main thread). *Apps 14.* Effort M.
  *Done for `setPermissionRequestHandler`: Linux answers asynchronously from the handler's callback (WebKitGTK `permission-request`); Windows / macOS answer from earlier decisions per window, origin and permission (the first request gets the platform default while the handler runs). No handler: granted, as in Electron. `setPermissionCheckHandler` stays stored (no hook for permission checks). Not verified on Windows / macOS.*
- [x] **B8. Window controls for `titleBarOverlay`.** On Windows and Linux,
  `titleBarStyle: 'hidden'` + `titleBarOverlay` gives Electron apps native
  minimize / maximize / close buttons; here frameless windows have none.
  Draw them in the renderer bootstrap (colour, symbol colour and height
  from the options; `setTitleBarOverlay` updates them) and keep
  `navigator.windowControlsOverlay` geometry consistent. *Apps 8 (VS Code,
  SiYuan, Zettlr, Heroic, Trilium, Tabby, Mattermost, Super
  Productivity).* Effort M.
  *Done: buttons in a shadow root, maximize icon follows the window; `navigator.windowControlsOverlay` and `--titlebar-area-*` custom properties (WebKit has no `env(titlebar-area-*)`).*
- [x] **B9. `Notification` click and actions on desktop.** `click`,
  `action`, `close`, `reply` need a backend that reports activation
  (notify-rust actions on Linux, toast activation on Windows,
  UNUserNotificationCenter on macOS); `plugin-notification` does not on
  desktop. *Apps 7 (Signal, VS Code, Mattermost, Heroic, Zettlr, SiYuan,
  Bitwarden).* Effort M–L.
  *Done: shown from Rust through tauri-plugin-notification 2.8's desktop action tracking (its `on_action` handler forwards to the main process): `click` and `action` on Linux, Windows and macOS, `close` on Linux. `reply` is not emitted (no desktop backend reports inline replies); Windows reports clicks only while the toast is on screen.*
- [x] **B10. Custom schemes without editing Rust.** The bundler plugins
  collect scheme names from `protocol.registerSchemesAsPrivileged` and
  `protocol.handle` calls and write them where
  `tauri_plugin_electron::Builder` reads them (a generated file or the
  plugin's section of `tauri.conf.json`). Covers schemes that libraries
  add on their own (`@sentry/electron`'s `sentry-ipc`). *Apps 15.*
  Effort S–M.
  *Done: `src-tauri/electron-schemes.json`, passed on by the app's build.rs to `Builder::protocols(bundled_schemes!())` (template and kitchen sink); found by scanning the app's source, so schemes built from variables need the `schemes` option.*
- [x] **B11. `powerMonitor` system events.** `suspend`, `resume`,
  `lock-screen`, `unlock-screen`, `shutdown`, plus
  `getSystemIdleTime` / `getSystemIdleState` (logind and the screensaver
  D-Bus API on Linux, `NSWorkspace` notifications and `CGEventSource` on
  macOS, `WM_POWERBROADCAST` / WTS and `GetLastInputInfo` on Windows).
  *Apps 8 events, 5 idle time.* Effort M.
  *Done for Linux (logind and screen-saver signals over D-Bus, feature `power-monitor`) and idle time everywhere (Mutter / ScreenSaver, `CGEventSource`, `GetLastInputInfo`). macOS and Windows events are still open (they need a native window or run-loop observer); `resume` falls back to the timer heuristic there.*
- [x] **B12. `dialog.showMessageBox` beyond three buttons.**
  `checkboxLabel` / `checkboxChecked`, more than three buttons, `defaultId`,
  `cancelId`: fall back to a small modal `BrowserWindow` when the native
  dialog cannot express the options. *Apps 8 use `checkboxLabel`.*
  Effort M.
  *Done: a window served by the bridge scheme (no IPC permission), parented and disabling its parent; also for `showMessageBoxSync` (blocks on the bridge). The native dialog stays for three buttons or fewer without a checkbox.*
- [x] **B13. `session.setProxy` / `app.setProxy`** through
  `proxy_url` when windows are created (with B6's Rust-side creation);
  `resolveProxy` then reports the configured proxy. *Apps 4.* Effort S
  after B6.
  *Done: one http:// or socks5:// proxy from `proxyRules` (`proxyUrl` at window creation) for windows created afterwards and `net.fetch` / `session.fetch`; `resolveProxy` reports it. No PAC / auto-detect / bypass rules; macOS needs the new `macos-proxy` feature (macOS 14+). On Linux the default session and `persist:` partitions share one WebKit data store, hence one proxy.*

## Wave C: structural, several sessions each

- [x] **C1. `<webview>` and `WebContentsView` / `BrowserView`** on Tauri
  child webviews (`Window::add_child`, behind tauri's `unstable` feature):
  a `<webview>` custom element that keeps a child webview positioned over
  its box, a `webContents` for each child (IPC, `executeJavaScript`,
  navigation events, `will-attach-webview` / `did-attach-webview`,
  `partition`), and `BaseWindow.contentView.addChildView`. *Apps 13 use
  `<webview>` (the core of Ferdium, Zulip, Wire, Rocket.Chat,
  Responsively) and 6 use views (the core of Mattermost). One feature
  behind five chat apps.* Effort L.
  *Done (Linux verified; Windows / macOS compile-checked only): feature `child-webviews`, opt-in because it turns on Tauri's `unstable` (every window then uses Tauri's multi-webview mode). `View`, `WebContentsView`, `BrowserView`, `contentView` / `setContentView`, `setBrowserView` & co. are child webviews with a full webContents each (IPC, `executeJavaScript`, navigation events, partitions, downloads, permissions, `fromId` / `getAllWebContents`), created when a view joins a window's tree; Linux lays them in a `GtkOverlay` over the window's webview, as WebKitGTK multi-webview windows ignore bounds. `<webview>` (with `webviewTag`): an element upgraded by hand (`webview` is not a valid custom element name) whose guest the main process attaches (`will-attach-webview` with Electron's webPreferences rules, `did-attach-webview`) and the page keeps over the element's box through the bridge; methods, events, `ipc-message` from `sendToHost`. Remote pages are driven from Rust (`executeJavaScript` with JSON results, `reload`, history). Limits: views are native webviews over the page (page content cannot cover them, scrolling containers do not clip them, the embedder's zoom is ignored); stacking order changes apply on Linux only; `preload` attributes are ignored; remote guests get the preload and IPC only on trusted origins (C6, applied to views as to windows), so Ferdium's recipes, which run on any service's site, still lack them; no `did-fail-load` for network errors.*
- [x] **C2. `worker_threads`** on Web Workers that load the Node layer
  (`Worker`, `parentPort`, `workerData`, `MessageChannel`, `isMainThread`).
  Needs the bridge to accept workers. *Apps 8.* Effort L.
  *Done: a worker is a dedicated Web Worker of its window (main process or a nodeIntegration window) running one worker bundle per app (`bundler/worker-entry.js`): a dependency-free bootstrap receives the window's init message (`workerData`, env, argv, environment data, transferred ports), then the Node layer and the script load as lazy chunks. The bridge needed no change: WebKitGTK attributes a worker's synchronous requests to its window, so Rust's checks apply as for the window (a sandboxed window's worker gets 403); Tauri commands and their Channels are relayed by the window. The bundler plugins bundle the scripts found in `new Worker(...)` calls (static `__dirname` / `import.meta.url` / `require.resolve` paths) plus option `workers`; `eval: true` works. Node's `MessagePort` semantics, `process.exit`, uncaught errors, and an automatic exit once nothing tracked is pending. No SharedArrayBuffer / `Atomics.wait`, `resourceLimits` or `stdin`. Verified on Linux; Windows / macOS routing of worker requests unverified.*
- [x] **C3. `utilityProcess.fork` and `child_process.fork`.** A Node
  sidecar (bundled runtime via `plugin-shell`), `MessagePortMain` bridged
  over stdio, `'ipc'` stdio for `fork`. *Apps 5 + 5 (VS Code, AFFiNE,
  Trilium, Beekeeper, Insomnia, Joplin, Logseq).* Effort L.
  *Done: the child is a real Node.js started through `child_process`'s spawn path (`node-child-process` feature) rather than `plugin-shell`, whose sidecar API cannot hand a child a socket: the `execPath` option, `$TAURI_ELECTRON_NODE`, a `<crate>-node` / `node` sidecar next to the executable (`bundle.externalBin`; `npx github:AJayClauGermany/tauri-as-electron --node-sidecar` sets it up) or, in debug builds, `node` on PATH. `child_process.fork` (also `spawn` with `'ipc'`, and `spawn(process.execPath)` with `ELECTRON_RUN_AS_NODE`) gets Node's own channel (`NODE_CHANNEL_FD` on a socketpair, `json` serialization); `utilityProcess` gets `process.parentPort` and `MessagePortMain`s (relayed by the main process, so main- and renderer-held ports both work) from a bootstrap loaded with `--require`, over a socket of the same kind. The bundler plugins find fork entries with static paths (option `fork` for others), bundle them for Node with `electron` mapped to a child module (`net`) and ship them in `<resources>/fork`. Not supported: `serialization: 'advanced'`, handles over `send()`, ports from the child back to the main process, native addons in bundled entries. Windows connects the child back over loopback TCP with a token (written, tested on Linux only); macOS not verified.*
- [x] **C4. `vm`** contexts on iframe realms (feasibility verified in
  [NODE-COMPAT-PLAN.md](NODE-COMPAT-PLAN.md)): `runInNewContext`,
  `createContext`, `Script`. *Apps 10.* Effort M–L.
  *Done: each context is a hidden same-origin iframe; the object's properties are live accessors on its global and created globals are copied back after each run; top-level `let` / `const` / `class` persist between runs like a Script's. `Script`, `runInThisContext`, `compileFunction` (`contextExtensions`, `parsingContext`), `isContext`, `DONT_CONTEXTIFY`. `timeout` / `breakOnSigint` are ignored (synchronous code cannot be interrupted), contexts also have the browser's globals, no contexts in worker threads, needs `'unsafe-eval'` under a CSP; vm modules unsupported.*
- [x] **C5. Shims for common native modules** through the bundler's
  module aliases: `keytar` (on B3's keyring code; 6 apps), `better-sqlite3`
  / `sqlite3` (rusqlite; 5 apps), `node-pty` (portable-pty; 4 apps:
  Hyper, Tabby, VS Code, Bruno). Each M–L; `keytar` is S once B3 exists.
  *Done: `tauri-electron/keytar`, `/better-sqlite3`, `/sqlite3`, `/node-pty`, aliased by both bundler plugins and `require()`, each behind an opt-in Cargo feature (`keytar`, `sqlite`, `pty`; listed commented out by the template, enabled by `--into` for the app's dependencies), for the main process and `nodeIntegration` windows. keytar stores entries where keytar does (Keychain generic passwords, Windows credentials `<service>/<account>`, Secret Service items with keytar's attributes, read through dbus-secret-service), so existing ones are found; `findCredentials` searches the keychain on each platform; without a Secret Service it rejects like keytar. better-sqlite3 is synchronous over the bridge on a rusqlite handle table (statements re-run through the statement cache, `iterate()` reads all rows first); `db.function()` is answered from a memo between runs of the statement (deterministic functions only), `aggregate` / `table` / `loadExtension` throw. sqlite3's callback API runs on the same table through a command, one operation at a time per database (no `'change'` event). node-pty spawns over the bridge (`pid` at once) and streams over a Channel; spawn failures throw. Databases and terminals close with the page that opened them. Verified on Linux (keytar only without a Secret Service); keytar and pty compile-checked for Windows, keytar for macOS (SQLite's C build was not cross-compiled).*
- [x] **C6. IPC and preloads for local-server pages.** Apps that start a
  server and load `http://127.0.0.1:<port>` in their main window (SiYuan's
  kernel) get no IPC today ("remote pages have no IPC"). Allow an
  app-declared list of origins to receive the preload and the renderer
  capability. Effort M.
  *Done: `plugins.electron.trustedOrigins` in tauri.conf.json (or `Builder::trusted_origin`), checked at startup: `http` and `*` ports on loopback hosts only, `https` on any host; `node: true` (loopback only) keeps a `nodeIntegration` window's Node built-ins there. The bundler plugins build the renderer modules and preloads as one classic script (`trustedOrigins` / `trustedPreload` options), which every window runs as an initialization script on those origins only, checked on every page load; Tauri grants them the renderer capability (`remote.urls`) and the synchronous bridge now answers only the app's own pages, its custom schemes and the trusted origins. The app's `src-tauri/Cargo.toml` needs `serde_json` once tauri.conf.json has a `plugins` section. Main frame only; Linux verified (Windows / macOS initialization scripts unverified); rspack development builds keep `eval` source maps in the script.*
- [ ] **C7. `session.webRequest` applied.** Header and request rewriting
  for http(s) has no hook on WKWebView or WebKitGTK; WebView2 has
  `WebResourceRequested`. Options: Windows-only support, or rewriting only
  for custom schemes and `net.fetch`. Mostly used to relax CSP / CORS or
  set headers for remote pages. *Apps 18 (FreeTube depends on it to talk
  to YouTube).* Effort L, partial at best.
  *Partly done: listeners apply wherever tauri-electron sees the request. `net.fetch` / `net.request` / `session.fetch`: every event (cancel, redirect, request and response header and `statusLine` rewrites; redirects are followed in JavaScript so onBeforeRedirect fires and each hop goes through onBeforeRequest; onCompleted when the body has been read). `protocol.handle()` schemes: every event around the handler (a redirect is served in place, a cancelled request gets an empty 403). http(s) requests of pages: Windows holds them in WebView2's `WebResourceRequested` (cancel, redirect, request headers; onResponseStarted / onCompleted reported; onHeadersReceived cannot apply); Linux only reports them (onSendHeaders, onBeforeRedirect, onResponseStarted, onCompleted, onErrorOccurred: WebKitGTK cannot change a request from the UI process); macOS reports nothing. A listener that could change a request is only called where its answer applies. So FreeTube's header rewrites of page requests work on Windows only (not verified there).*
- [x] **C8. `printToPDF` and `capturePage`** per platform through
  `with_webview` (WKWebView `createPDF` / `takeSnapshot`, WebView2
  `PrintToPdf` / `CapturePreview`, WebKitGTK print operation to a file /
  `get_snapshot`). *Apps 7 and 5 (draw.io, Joplin, Zettlr, MarkText,
  SiYuan export PDFs).* Effort M–L.
  *Done: `print_to_pdf` / `capture_page` commands (`src/capture.rs`), started on the main thread and finished in the webview's completion callback. Linux: a WebKitGTK print operation without a dialog to GTK's "Print to File" printer (paper size, `landscape`, margins, `scale`, `pageRanges`, `printBackground`) and a snapshot of the visible page (empty for a hidden window); Windows: `PrintToPdf` with `ICoreWebView2PrintSettings` (every option; `displayHeaderFooter` prints WebView2's own header and footer) and `CapturePreview`; macOS: `createPDF`, one page as tall as the content (no paper size, margins, orientation, scale or page ranges), and `takeSnapshot`. `headerTemplate` / `footerTemplate`, `preferCSSPageSize`, tagged PDFs and outlines are ignored (warned once); Electron < 21's microns, `marginsType` and `{ from, to }` page ranges are accepted. No new crates (the gtk, cairo, png, webview2-com, windows and objc2 versions Tauri already builds). Linux verified; Windows / macOS compile-checked only.*
- [x] **C9. Screen capture.** `desktopCapturer.getSources` and
  `setDisplayMediaRequestHandler` for screen sharing; depends on each
  webview's `getDisplayMedia` support. *Apps 8 (the chat apps).* Effort L.
  *Done, with the webviews' limits: `getSources` (feature `desktop-capturer`, on by default; `src/desktop_capturer.rs`) lists screens and windows with thumbnails and window icons through X11 on Linux (x11rb; under Wayland screens only, without thumbnails), GDI on Windows and CoreGraphics on macOS (no window icons). No webview lets the app pick the captured source: `getUserMedia({ chromeMediaSource: 'desktop' })` becomes `getDisplayMedia()` in app pages, so the webview's picker appears (the desktop portal with PipeWire on Linux, WebView2's on Windows, the system's on macOS), and that request is answered by the permission request handler (`'media'`). A page's `getDisplayMedia()` calls `setDisplayMediaRequestHandler` (Linux: WebKitGTK's display-device permission request; Windows: WebView2 `ScreenCaptureStarting` where the runtime has it, else WebView2 asks the user itself); without a handler it is denied, as in Electron; `callback({ video })` grants, the named source is not applied, `useSystemPicker` grants without the handler. macOS reports no screen-capture request (WebKit asks the user itself). BrowserWindows on Linux now have WebKitGTK's media-stream and WebRTC settings on (getUserMedia, getDisplayMedia, RTCPeerConnection), like every Electron page. `getMediaSourceId` stays unsupported; xcap was not used (it needs libpipewire to build). Linux verified with WebKit's mock capture devices (`TAURI_ELECTRON_MOCK_CAPTURE=1`, set by the smoke); a real capture needs a desktop portal. Windows / macOS compile-checked only.*
- [x] **C10. TLS and auth events.** `certificate-error`,
  `setCertificateVerifyProc`, `select-client-certificate`, `login`
  (WebView2 `ServerCertificateErrorDetected` / `BasicAuthenticationRequested`,
  WebKitGTK `load-failed-with-tls-errors` / `authenticate`; WKWebView's
  navigation delegate belongs to wry). Mostly used to accept self-signed
  servers. *Apps 12 and 7.* Effort L.
  *Done for Linux and Windows: `certificate-error` (webContents, then app; the session's `setCertificateVerifyProc` is asked first, but only about certificates the webview rejected), `login` (webContents, then app; cancelled without `preventDefault()`, as in Electron) and `select-client-certificate` (Windows only; the first certificate without `preventDefault()`). Linux: WebKitGTK `load-failed-with-tls-errors` (main frames; a trusted certificate is allowed for its host and the page loaded again) and `authenticate` (Basic, Digest, NTLM, Negotiate); Windows: WebView2 `ServerCertificateErrorDetected`, `BasicAuthenticationRequested`, `ClientCertificateRequested` (not verified). An untrusted certificate fails the load with `did-fail-load` (-202 & co.) and `loadURL()` rejects. macOS emits none of them (wry owns the WKNavigationDelegate). `net.request` emits `login` for Basic challenges; `net.fetch` does not consult `setCertificateVerifyProc`.*

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
