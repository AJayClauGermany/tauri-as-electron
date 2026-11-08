# tauri-plugin-electron

The native half of [tauri-electron](../../packages/tauri-electron). Most of
Electron's API is built on Tauri's JavaScript API and the official plugins.
This plugin covers the rest:

| Electron API | How |
| --- | --- |
| `process.argv`, `process.env`, `process.execPath`, `process.pid`, `process.cwd()`, `app.commandLine`, `app.getPath('exe')` | `process_info` command |
| `ipcRenderer.sendSync` + `event.returnValue` | A blocking `XMLHttpRequest` to the `tauri-electron://` scheme, forwarded to the main window, which answers with `bridge_respond` |
| `webPreferences.additionalArguments` (renderer `process.argv`) | `set_window_config` before the window is created; the renderer reads it synchronously from the scheme |
| `dialog.showOpenDialogSync`, `showSaveDialogSync`, `showMessageBoxSync` | Blocking `tauri-plugin-dialog` calls behind the scheme (main window only) |
| `protocol.handle(scheme, handler)` | Schemes declared with `Builder::protocol` are forwarded to the main window's handler |
| `webContents.openDevTools`, `closeDevTools`, `isDevToolsOpened` | `WebviewWindow::open_devtools` (debug builds, or the `devtools` feature) |
| `shell.trashItem` | The [`trash`](https://crates.io/crates/trash) crate |
| `did-start-loading`, `did-navigate`, `did-stop-loading` (every page, remote ones included) | `on_page_load` hook |
| `app` events `activate`, `open-file`, `open-url` (macOS) | `RunEvent::Reopen` / `RunEvent::Opened` |
| `app` event `second-instance` | `on_second_instance`, the callback for `tauri-plugin-single-instance` |

Everything is delivered to the hidden `electron-main` window, which runs the
app's Electron main-process code.

```rust
tauri::Builder::default()
    // Optional, and must come first: Electron's single-instance lock.
    .plugin(tauri_plugin_single_instance::init(tauri_plugin_electron::on_second_instance))
    .plugin(
        tauri_plugin_electron::Builder::new()
            .protocol("app") // one per scheme passed to protocol.handle()
            .build(),
    )
```

Grant `electron:default` to the `electron-main` window only. Renderers
never need it: they use the URI scheme, which serves sync IPC from any
window but serves the window configuration only to the window it belongs
to, and sync dialogs only to the main window.

## Features

- `devtools`: allow `webContents.openDevTools()` in release builds
  (Tauri's `devtools` feature; it uses private APIs on macOS, so it is not
  App Store compatible).
