# tauri-plugin-electron

The native half of [tauri-electron](../../packages/tauri-electron). It
registers the official Tauri plugins that Electron's API is built on,
grants Electron's default capabilities, and covers what those plugins
cannot do. Which Electron modules are available is controlled by Cargo
features alone: no Rust code or capability files to edit.

## Setup

```rust
// src-tauri/src/lib.rs
pub fn run() {
    tauri_plugin_electron::Builder::new()
        // The schemes your JavaScript passes to protocol.handle(), found by
        // the bundler plugin (src-tauri/electron-schemes.json, see build.rs).
        .protocols(tauri_plugin_electron::bundled_schemes!())
        .protocol("app") // or one by one
        .install(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

```toml
# src-tauri/Cargo.toml
tauri-plugin-electron = { git = "https://github.com/AJayClauGermany/tauri-as-electron", features = ["single-instance"] }
```

`src-tauri/build.rs` needs a few lines so Tauri sees the permissions of the
plugins registered for you (Cargo only exposes a build script to its direct
dependencies), and passes `src-tauri/electron-schemes.json` (written by the
bundler plugins) on to `bundled_schemes!()`; copy it from the
[template](../../templates/tauri-electron-app/src-tauri/build.rs).
`npx github:AJayClauGermany/tauri-as-electron --into .` writes all of this
for you. Pin with `tag = "v0.1.0"` (or `branch`, `rev`); keep the JavaScript
half (`tauri-electron`) at the same ref.

## Trusted origins: IPC for pages of a local server

Pages the app does not serve itself get no preload and no IPC, unless their
origin is declared trusted, for apps that start a server and show its pages
in a window (SiYuan's kernel at `http://127.0.0.1:6806`):

```jsonc
// src-tauri/tauri.conf.json
"plugins": {
  "electron": {
    "trustedOrigins": [
      "http://127.0.0.1:*",                                  // any port: a server that picks it at startup
      { "origin": "http://localhost:6806", "node": true }    // and Node built-ins in nodeIntegration windows
    ]
  }
}
```

or in Rust: `Builder::new().trusted_origin("http://127.0.0.1:*")` /
`.trusted_origin_with_node("http://localhost:6806")` (then set the bundler
plugin's `trustedOrigins: true`, as it only reads tauri.conf.json). Tauri's
`generate_context!()` needs `serde_json = "1"` in the app's `Cargo.toml`
once tauri.conf.json has a `plugins` section (the template has it).

- `http` origins and `*` ports are accepted on loopback hosts only
  (`localhost`, `127.0.0.0/8`, `[::1]`); `https` on any host, with a fixed
  port. No host wildcards or paths. `node: true` on loopback only. An
  invalid entry stops the app at startup.
- Pages of those origins get the renderer bootstrap and the preloads: the
  bundler plugins build them as one classic script
  (`__tauri-electron/trusted-renderer.js`), the main process hands it over
  (`set_trusted_renderer`), and every window created afterwards runs it as
  an initialization script whose first lines check the page's origin
  against the list, on every page load. The renderer permissions are
  granted to them through `remote.urls` (capability
  `electron-trusted-origins`), and the scheme's `sync-ipc` and
  `window-config` answer them.
- Everything such a server serves is trusted like the app's own pages, and
  with a `*` port so is any other local server the window is sent to:
  prefer exact ports, and keep windows on the server (`will-navigate`).
- Main frame only (iframes get neither the preload nor IPC). With
  `default_capabilities(false)`, add the `remote.urls` capability yourself.

## Features

| Feature | Default | Electron API | Official plugin |
| --- | --- | --- | --- |
| `dialog` | on | `dialog` (including `*Sync`) | `tauri-plugin-dialog` |
| `clipboard` | on | `clipboard` (`readHTML` and the synchronous reads of Electron < 45 with `arboard`) | `tauri-plugin-clipboard-manager` |
| `notification` | on | `Notification`, with `click` / `action` (and `close` on Linux) on desktop | `tauri-plugin-notification` |
| `shell` | on | `shell.openExternal`, `openPath`, `showItemInFolder` | `tauri-plugin-opener` |
| `net` | on | `net.fetch`, `net.request` | `tauri-plugin-http` |
| `global-shortcut` | on | `globalShortcut` | `tauri-plugin-global-shortcut` |
| `tray` | on | `Tray` | Tauri's `tray-icon` feature |
| `protocol-client` | on | `app.setAsDefaultProtocolClient` & co. | `tauri-plugin-deep-link` |
| `login-item` | on | `app.setLoginItemSettings` / `getLoginItemSettings` | `tauri-plugin-autostart` |
| `power-save-blocker` | on | `powerSaveBlocker` with operating-system assertions | `keepawake` crate |
| `power-monitor` | on | `powerMonitor` system events (logind / screen saver on Linux) and idle time | `zbus` on Linux (already in the build) |
| `safe-storage` | on | `safeStorage` with a key in the OS keychain (AES-256-GCM) | `keyring`, `aes-gcm` crates |
| `desktop-capturer` | on | `desktopCapturer.getSources` (screens and windows with thumbnails) | `x11rb` on Linux (already in the build with `clipboard`), GDI / CoreGraphics through the `windows` / `objc2-core-graphics` crates Tauri uses |
| `single-instance` | off | `app.requestSingleInstanceLock`, `second-instance` | `tauri-plugin-single-instance` |
| `updater` | off | `autoUpdater` (needs `plugins.updater` in `tauri.conf.json`) | `tauri-plugin-updater` |
| `devtools` | off | `webContents.openDevTools()` in release builds | Tauri's `devtools` feature |
| `macos-proxy` | off | `session.setProxy` on macOS (14+) | Tauri's `macos-proxy` feature |
| `node-fs` | off, listed by the template | Node's `fs`, `fs/promises` in the main process (`fs.watch` included) | `notify` crate (`std::fs` for the rest) |
| `node-os` | off, listed by the template | Node's `os` | `sysinfo` crate |
| `node-child-process` | off, listed by the template | Node's `child_process`, including `fork`, and `utilityProcess` (on a Node.js sidecar the app bundles) | none (`std::process`, in this crate) |
| `node-net` | off, listed by the template | Node's `net`, `dgram`, `dns`, and the HTTP servers | `tokio`, `socket2`, `hickory-resolver` |
| `node-tls` | off, listed by the template (implies `node-net`) | Node's `tls`, `https` servers | `rustls` (ring), `tokio-rustls`, `webpki-roots` |
| `keytar` | off, listed (commented) by the template | The `keytar` npm package, in keytar's own keychain format | `keyring` (B3's crate), `dbus-secret-service` on Linux, `security-framework` / `windows-sys` for listing |
| `sqlite` | off, listed (commented) by the template | The `better-sqlite3` and `sqlite3` npm packages | `rusqlite` with SQLite compiled in (`bundled`: a C compiler at build time) |
| `pty` | off, listed (commented) by the template | The `node-pty` npm package | `portable-pty` (Unix ptys, ConPTY) |

The Node built-ins backed by Rust are not default features: the template and
the scaffolder list them in the app's `src-tauri/Cargo.toml`, one line each,
so the native access an app has is visible and an app that already depends
on this crate does not gain it silently. Commands are granted to
`electron-main` through a permission set per feature (`electron:node-fs`,
`electron:node-child-process`, `electron:node-net`; `os` uses the bridge only).
The same goes for the npm packages with native code that the bundler
plugins alias to Rust versions (`keytar`, `sqlite`, `pty`; permission sets
`electron:keytar`, `electron:sqlite`, `electron:pty`): the scaffolder's
`--into` enables those the app's `package.json` depends on.

`tauri-plugin-os` and `tauri-plugin-process` are always registered.

`install()` registers the plugins of the enabled features (single-instance
first, so a second launch exits before anything else starts), then grants:

- `electron-main` (the hidden main-process window): every permission of the
  enabled features, plus the core window/webview permissions, like
  Electron's main process. `net` gets unrestricted `http(s)://**`; `shell`
  may open any URL (custom schemes included) and any path, like Electron's.
- `electron-renderer` (every window): IPC, zoom, `window.close()` and
  `-webkit-app-region` dragging, like a context-isolated, sandboxed
  Electron renderer.
- `electron-node-<label>` (added at runtime): the `node-*` permissions of
  the enabled features, for a window the main process creates with
  `nodeIntegration: true` or `sandbox: false`. Only `electron-main` can
  configure windows (`set_window_config`), and the Node built-ins also check
  the grant in Rust.

Add capability files in `src-tauri/capabilities/` for anything more, or call
`.default_capabilities(false)` to manage every permission yourself.

## What it implements itself

| Electron API | How |
| --- | --- |
| `process.argv`, `process.env`, `process.execPath`, `process.pid`, `process.cwd()`, `app.commandLine`, `app.getPath('exe')` | `process_info` command |
| `ipcRenderer.sendSync` + `event.returnValue` | A blocking `XMLHttpRequest` to the `tauri-electron://` scheme, forwarded to the main window, which answers with `bridge_respond` |
| `webPreferences.additionalArguments` (renderer `process.argv`) | `set_window_config` before the window is created; the renderer reads it synchronously from the scheme |
| `dialog.showOpenDialogSync`, `showSaveDialogSync`, `showMessageBoxSync` | Blocking `tauri-plugin-dialog` calls behind the scheme (main window only; `dialog` feature) |
| `dialog.showMessageBox` / `showMessageBoxSync` with more than three buttons or `checkboxLabel` | A small window (`src/message_box.rs`) whose page the scheme serves (`message-box/<id>`); the page reports its size and the answer over the same scheme. `message_box` / `message_box_close` commands, `dialog/message-window` on the scheme for the blocking variant |
| Node's `fs` (`node-fs` feature) | `fs.*Sync`: `node/fs/<op>` on the scheme, answered from a worker thread. `fs.promises` and callbacks: the `node_fs` command (raw body, off the main thread). One implementation (`src/node_fs.rs`) behind both. Refused unless the caller is `electron-main` showing the app's own page |
| `fs.watch`, `fs.promises.watch` (`node-fs` feature) | `node/fs/watch` on the scheme creates a notify watcher synchronously (events are kept until JavaScript attaches); the `fs_watch` command attaches a Channel that carries `rename` / `change` events, `fs_unwatch` stops it (`src/node_fs_watch.rs`) |
| `safeStorage` (`safe-storage` feature) | A random 256-bit key in the OS keychain (`keyring`: Keychain, Credential Manager, Secret Service), read on a worker thread with a 10 s limit; AES-256-GCM. `encryptString` / `decryptString` over `safe-storage/<op>` on the scheme, the async variants over `safe_storage_*` commands; main window only (`src/safe_storage.rs`) |
| Node's `os` (`node-os` feature) | `node/os/<op>` on the scheme (`src/node_os.rs`) |
| Node's `child_process` (`node-child-process` feature) | `spawnSync`: `node/child_process/spawnSync` on the scheme, stdin in the request body, both outputs in the answer. `spawn`: the `child_spawn` command with a Channel for output and exit, then `child_write`, `child_end`, `child_kill` (`src/node_child_process.rs`). `fork` / `utilityProcess.fork`: `child_spawn` with `node: true` (the runtime: the `execPath` option, `$TAURI_ELECTRON_NODE`, a `<crate>-node` or `node` sidecar next to the executable, `node` on PATH in debug builds) and `ipc` (a socketpair at the child's descriptor 3 with `NODE_CHANNEL_FD`, or `TAURI_ELECTRON_IPC` for tauri-electron's bootstrap; loopback TCP with a token on Windows); JSON lines arrive as `ipc` events, `child_send` / `child_disconnect` write and close (`src/node_fork.rs`) |
| Node's `worker_threads` (in the main window and nodeIntegration windows) | Nothing of its own: a worker's synchronous requests reach the scheme with its window's webview label (verified on WebKitGTK), so every check above applies as for the window, and its Tauri commands are relayed through the window by the JavaScript side |
| Node's `net`, `tls`, `dgram`, `dns` (`node-net`, `node-tls` features) | A handle table of tokio sockets (`src/node_net.rs`). `net_connect`, `net_listen`, `udp_bind` take a Channel that carries data, end, errors and accepted connections; `net_write` resolves once the bytes are flushed; `net_pause` stops reading in Rust. TLS is rustls on the same sockets (`src/node_tls.rs`); `dns_lookup` is the OS resolver, `dns_resolve` / `dns_reverse` use hickory-resolver (`src/node_dns.rs`) |
| `keytar` (`keytar` feature) | The `keytar` command, off the main thread (`src/native_modules/keytar.rs`): generic passwords (macOS) and credentials named `<service>/<account>` with UTF-8 secrets (Windows) through `keyring`; Secret Service items with libsecret's generic schema and keytar's `service` / `account` attributes (Linux, through `dbus-secret-service`). `findCredentials` searches the keychain (security-framework, `CredEnumerateW`, a Secret Service search) |
| `better-sqlite3`, `sqlite3` (`sqlite` feature) | A table of rusqlite connections (`src/native_modules/sqlite.rs`); JavaScript statements keep their SQL and run through each connection's prepared-statement cache. better-sqlite3's synchronous calls: `node/sqlite/<op>` on the scheme; sqlite3's callbacks and `backup()`: the `sqlite` command. User functions are answered from a memo the page fills between runs of the statement (writes run in a savepoint that is rolled back while results are missing) |
| `node-pty` (`pty` feature) | `node/pty/spawn` on the scheme opens a portable-pty terminal and starts the program (so `pid` is known synchronously); its output is kept until `pty_attach` hands over a Channel; `pty_control` writes (through a thread of its own), resizes, signals and pauses (`src/native_modules/pty.rs`) |
| `protocol.handle(scheme, handler)` | Schemes declared with `Builder::protocol` / `protocols(bundled_schemes!())` are forwarded to the main window's handler |
| `webContents.openDevTools`, `closeDevTools`, `isDevToolsOpened` | `WebviewWindow::open_devtools` (debug builds, or the `devtools` feature) |
| `shell.trashItem` | The [`trash`](https://crates.io/crates/trash) crate |
| `new BrowserWindow()` | `create_window`: Rust's `WebviewWindowBuilder` from the same `WindowConfig` as JavaScript's `new WebviewWindow()`, plus the hooks below (`src/windows.rs`) |
| `session.on('will-download')`, `DownloadItem`, `downloadURL` | Downloads go to a temporary file, moved to the save path by `download_commit`. Page downloads: WebKitGTK's download signals (Linux), `on_download` (Windows, macOS). `download_url`: a reqwest transfer with the window's cookies (`net` feature) that can pause and cancel (`src/downloads.rs`) |
| `session.setPermissionRequestHandler` | WebKitGTK's `permission-request`, answered when the handler calls back (Linux); `on_permission_request` answered from the handler's earlier decisions (Windows, macOS) (`src/permissions.rs`) |
| `webContents.printToPDF`, `capturePage` | `print_to_pdf` / `capture_page` through `with_webview`: a WebKitGTK print operation to GTK's "Print to File" printer and `get_snapshot` (Linux), `PrintToPdf` / `CapturePreview` (WebView2), `createPDF` / `takeSnapshot` (WKWebView). The command waits off the main thread for the completion callback (`src/capture.rs`) |
| `desktopCapturer.getSources` (`desktop-capturer` feature) | `desktop_sources`: X11 `GetImage` / `_NET_CLIENT_LIST` / `_NET_WM_ICON` (Linux), GDI `StretchBlt` / `PrintWindow` (Windows), `CGDisplayCreateImage` / `CGWindowListCreateImage` (macOS) (`src/desktop_capturer.rs`) |
| `session.setDisplayMediaRequestHandler`, screen sharing | A page's screen-capture request arrives as a `display-capture` permission request: WebKitGTK's display-device `UserMediaPermissionRequest` (Linux), WebView2 `ScreenCaptureStarting` with a deferral (Windows). BrowserWindows on Linux get WebKitGTK's media-stream and WebRTC settings; `TAURI_ELECTRON_MOCK_CAPTURE=1` gives them WebKit's mock screens and cameras instead of real devices, for automated tests (`src/display_media.rs`) |
| `session.webRequest` for page requests | WebView2's `WebResourceRequested` (a `*` filter while the session listens; each request held with a deferral until `web_request_respond`) and `WebResourceResponseReceived` (Windows); WebKitGTK's `resource-load-started` and the resource's signals, reported only (Linux); `web_request_listeners` tells Rust what each window's session listens to (`src/web_request.rs`). `net.fetch` and `protocol.handle` schemes are handled in JavaScript |
| `certificate-error`, `setCertificateVerifyProc`, `login`, `select-client-certificate` | WebKitGTK's `load-failed-with-tls-errors` (a trusted certificate is allowed for its host on the web context, then the page is loaded again) and `authenticate` (Linux); WebView2's `ServerCertificateErrorDetected`, `BasicAuthenticationRequested`, `ClientCertificateRequested` (Windows). Held until `tls_auth_respond` (`src/tls_auth.rs`) |
| Preloads and IPC in pages of trusted origins | An initialization script added by `create_window` (the renderer script the main process registered with `set_trusted_renderer`, run only on the listed origins), a capability with `remote.urls`, and the scheme's caller checks (`src/trusted_origins.rs`) |
| `did-start-loading`, `did-navigate`, `did-stop-loading` (every page, remote ones included) | `on_page_load` hook |
| `app` events `activate`, `open-file`, `open-url` (macOS) | `RunEvent::Reopen` / `RunEvent::Opened` |

Everything is delivered to the hidden `electron-main` window, which runs the
app's Electron main-process code. Renderers never get `electron:default`:
they use the URI scheme, which serves sync IPC and the window
configuration (each window its own) only to the app's own pages, its custom
schemes' pages and trusted origins, and sync dialogs only to the main window.
