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
        .protocol("app") // one per scheme passed to protocol.handle()
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
dependencies); copy it from the [template](../../templates/tauri-electron-app/src-tauri/build.rs).
`npx github:AJayClauGermany/tauri-as-electron --into .` writes all of this
for you. Pin with `tag = "v0.1.0"` (or `branch`, `rev`); keep the JavaScript
half (`tauri-electron`) at the same ref.

## Features

| Feature | Default | Electron API | Official plugin |
| --- | --- | --- | --- |
| `dialog` | on | `dialog` (including `*Sync`) | `tauri-plugin-dialog` |
| `clipboard` | on | `clipboard` | `tauri-plugin-clipboard-manager` |
| `notification` | on | `Notification` | `tauri-plugin-notification` |
| `shell` | on | `shell.openExternal`, `openPath`, `showItemInFolder` | `tauri-plugin-opener` |
| `net` | on | `net.fetch`, `net.request` | `tauri-plugin-http` |
| `global-shortcut` | on | `globalShortcut` | `tauri-plugin-global-shortcut` |
| `tray` | on | `Tray` | Tauri's `tray-icon` feature |
| `protocol-client` | on | `app.setAsDefaultProtocolClient` & co. | `tauri-plugin-deep-link` |
| `login-item` | on | `app.setLoginItemSettings` / `getLoginItemSettings` | `tauri-plugin-autostart` |
| `single-instance` | off | `app.requestSingleInstanceLock`, `second-instance` | `tauri-plugin-single-instance` |
| `updater` | off | `autoUpdater` (needs `plugins.updater` in `tauri.conf.json`) | `tauri-plugin-updater` |
| `devtools` | off | `webContents.openDevTools()` in release builds | Tauri's `devtools` feature |
| `node-fs` | off, listed by the template | Node's `fs`, `fs/promises` in the main process | none (`std::fs`, in this crate) |
| `node-os` | off, listed by the template | Node's `os` | `sysinfo` crate |
| `node-child-process` | off, listed by the template | Node's `child_process` | none (`std::process`, in this crate) |

The Node built-ins backed by Rust are not default features: the template and
the scaffolder list them in the app's `src-tauri/Cargo.toml`, one line each,
so the native access an app has is visible and an app that already depends
on this crate does not gain it silently. Commands are granted to
`electron-main` through a permission set per feature (`electron:node-fs`,
`electron:node-child-process`; `os` uses the bridge only).

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

Add capability files in `src-tauri/capabilities/` for anything more, or call
`.default_capabilities(false)` to manage every permission yourself.

## What it implements itself

| Electron API | How |
| --- | --- |
| `process.argv`, `process.env`, `process.execPath`, `process.pid`, `process.cwd()`, `app.commandLine`, `app.getPath('exe')` | `process_info` command |
| `ipcRenderer.sendSync` + `event.returnValue` | A blocking `XMLHttpRequest` to the `tauri-electron://` scheme, forwarded to the main window, which answers with `bridge_respond` |
| `webPreferences.additionalArguments` (renderer `process.argv`) | `set_window_config` before the window is created; the renderer reads it synchronously from the scheme |
| `dialog.showOpenDialogSync`, `showSaveDialogSync`, `showMessageBoxSync` | Blocking `tauri-plugin-dialog` calls behind the scheme (main window only; `dialog` feature) |
| Node's `fs` (`node-fs` feature) | `fs.*Sync`: `node/fs/<op>` on the scheme, answered from a worker thread. `fs.promises` and callbacks: the `node_fs` command (raw body, off the main thread). One implementation (`src/node_fs.rs`) behind both. Refused unless the caller is `electron-main` showing the app's own page |
| Node's `os` (`node-os` feature) | `node/os/<op>` on the scheme (`src/node_os.rs`) |
| Node's `child_process` (`node-child-process` feature) | `spawnSync`: `node/child_process/spawnSync` on the scheme, stdin in the request body, both outputs in the answer. `spawn`: the `child_spawn` command with a Channel for output and exit, then `child_write`, `child_end`, `child_kill` (`src/node_child_process.rs`) |
| `protocol.handle(scheme, handler)` | Schemes declared with `Builder::protocol` are forwarded to the main window's handler |
| `webContents.openDevTools`, `closeDevTools`, `isDevToolsOpened` | `WebviewWindow::open_devtools` (debug builds, or the `devtools` feature) |
| `shell.trashItem` | The [`trash`](https://crates.io/crates/trash) crate |
| `did-start-loading`, `did-navigate`, `did-stop-loading` (every page, remote ones included) | `on_page_load` hook |
| `app` events `activate`, `open-file`, `open-url` (macOS) | `RunEvent::Reopen` / `RunEvent::Opened` |

Everything is delivered to the hidden `electron-main` window, which runs the
app's Electron main-process code. Renderers never get `electron:default`:
they use the URI scheme, which serves sync IPC from any window but serves
the window configuration only to the window it belongs to, and sync
dialogs only to the main window.
