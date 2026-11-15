//! Native half of tauri-electron.
//!
//! tauri-electron implements Electron's JavaScript API on top of Tauri's
//! JavaScript API and its official plugins. This plugin covers the few
//! things those cannot do from JavaScript:
//!
//! - **Process information** for `process.argv`, `process.env`,
//!   `process.execPath`, `process.pid`, `process.cwd()` and
//!   `app.commandLine`.
//! - **A synchronous bridge** (`tauri-electron://` URI scheme, reached with a
//!   synchronous `XMLHttpRequest`) for `ipcRenderer.sendSync`,
//!   `dialog.show*Sync` and `webPreferences.additionalArguments`.
//! - **`protocol.handle()`**: schemes declared with [`Builder::protocol`]
//!   are forwarded to the JavaScript handler registered in the main process.
//! - **Node built-ins** that need the operating system (`fs`, `os` and
//!   `child_process`, `net`, `dgram`, `dns`, `tls`, each behind a `node-*`
//!   feature; in the main window and in windows created with `nodeIntegration`
//!   or `sandbox: false`, see `node_windows.rs`): the synchronous variants over the bridge
//!   (`node/<module>/<op>`), the asynchronous ones over commands (`node_fs`,
//!   `child_spawn`, `net_connect` & co.).
//! - **DevTools** (`webContents.openDevTools()` and friends),
//!   **`shell.trashItem()`**, menu-bar visibility, `session.cookies`,
//!   `clipboard.readHTML` (and the synchronous clipboard reads of Electron
//!   < 45), `screen.getCursorScreenPoint()` (synchronous, over the bridge)
//!   and `powerSaveBlocker` (operating-system assertions).
//! - **BrowserWindows created in Rust** (`create_window`), for what Tauri only
//!   offers on the webview builder: downloads (`will-download`, `downloadURL`)
//!   and `setPermissionRequestHandler`.
//! - **Lifecycle events** that only exist in Rust: page loads (navigation
//!   events for every window, including remote pages), macOS `activate`,
//!   `open-file` / `open-url`, and `second-instance` (with the
//!   `single-instance` feature, which also takes the single-instance lock).
//!
//! Everything is forwarded to the hidden `electron-main` window, which runs the
//! app's Electron main-process code.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[cfg(all(desktop, feature = "clipboard"))]
mod clipboard;
mod cookies;
mod downloads;
mod features;
#[cfg(desktop)]
mod message_box;
#[cfg(feature = "node-child-process")]
mod node_child_process;
#[cfg(any(
    feature = "node-fs",
    feature = "node-os",
    feature = "node-child-process",
    feature = "node-net"
))]
mod node_common;
#[cfg(feature = "node-net")]
mod node_dns;
#[cfg(feature = "node-fs")]
mod node_fs;
#[cfg(feature = "node-fs")]
mod node_fs_watch;
#[cfg(feature = "node-net")]
mod node_net;
mod node_net_commands;
#[cfg(feature = "node-os")]
mod node_os;
#[cfg(feature = "node-tls")]
mod node_tls;
mod node_windows;
#[cfg(all(desktop, feature = "notification"))]
mod notification;
mod permissions;
#[cfg(all(desktop, feature = "power-save-blocker"))]
mod power;
#[cfg(all(desktop, feature = "power-monitor"))]
mod power_monitor;
#[cfg(feature = "safe-storage")]
mod safe_storage;
mod windows;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    http::{self, header, Request, Response, StatusCode},
    plugin::{Builder as PluginBuilder, TauriPlugin},
    webview::PageLoadEvent,
    AppHandle, Emitter, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder,
};

/// Label of the hidden window that runs the Electron main-process code.
pub const MAIN_LABEL: &str = "electron-main";
/// URI scheme of the synchronous bridge.
pub const BRIDGE_SCHEME: &str = "tauri-electron";

const BRIDGE_EVENT: &str = "tauri-electron:bridge-request";
const SYNC_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
struct Bridge {
    pending: Mutex<HashMap<u64, UriSchemeResponder>>,
    next_id: AtomicU64,
    window_config: Mutex<HashMap<String, Value>>,
}

type SharedBridge = Arc<Bridge>;

fn cors(builder: http::response::Builder) -> http::response::Builder {
    builder
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
}

fn respond(responder: UriSchemeResponder, status: u16, content_type: &str, body: Vec<u8>) {
    let response = cors(Response::builder())
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()));
    responder.respond(response);
}

fn respond_json(responder: UriSchemeResponder, status: u16, value: &Value) {
    respond(
        responder,
        status,
        "application/json",
        value.to_string().into_bytes(),
    );
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Store the responder, hand the request to the main window and answer with
/// `504` if it does not reply in time.
fn forward<R: Runtime>(
    app: &AppHandle<R>,
    bridge: &SharedBridge,
    responder: UriSchemeResponder,
    mut payload: Value,
    timeout: Duration,
) {
    let id = bridge.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    payload["id"] = json!(id);
    bridge.pending.lock().unwrap().insert(id, responder);
    if app.emit_to(MAIN_LABEL, BRIDGE_EVENT, payload).is_err() {
        if let Some(responder) = bridge.pending.lock().unwrap().remove(&id) {
            respond(
                responder,
                503,
                "text/plain",
                b"electron-main is not available".to_vec(),
            );
        }
        return;
    }
    let bridge = bridge.clone();
    thread::spawn(move || {
        thread::sleep(timeout);
        if let Some(responder) = bridge.pending.lock().unwrap().remove(&id) {
            respond(
                responder,
                504,
                "text/plain",
                b"electron-main did not answer".to_vec(),
            );
        }
    });
}

#[cfg(all(desktop, feature = "dialog"))]
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

#[cfg(all(desktop, feature = "dialog"))]
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileDialogOptions {
    title: Option<String>,
    default_path: Option<String>,
    filters: Vec<DialogFilter>,
    directory: bool,
    multiple: bool,
    can_create_directories: Option<bool>,
}

#[cfg(all(desktop, feature = "dialog"))]
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MessageDialogOptions {
    title: Option<String>,
    message: String,
    kind: Option<String>,
    buttons: Vec<String>,
}

#[cfg(all(desktop, feature = "dialog"))]
fn file_dialog<R: Runtime>(
    app: &AppHandle<R>,
    options: &FileDialogOptions,
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(path) = &options.default_path {
        let path = std::path::Path::new(path);
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else {
            if let Some(parent) = path.parent().filter(|p| p.is_dir()) {
                dialog = dialog.set_directory(parent);
            }
            if let Some(name) = path.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy());
            }
        }
    }
    for filter in &options.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    if let Some(can) = options.can_create_directories {
        dialog = dialog.set_can_create_directories(can);
    }
    dialog
}

/// Blocking dialogs for `dialog.show*Sync()`. Runs off the main thread.
#[cfg(all(desktop, feature = "dialog"))]
fn sync_dialog<R: Runtime>(app: &AppHandle<R>, kind: &str, body: &[u8]) -> Result<Value, String> {
    use tauri_plugin_dialog::{
        DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
    };
    let paths = |list: Option<Vec<tauri_plugin_dialog::FilePath>>| -> Value {
        json!(list
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>())
    };
    match kind {
        "open" => {
            let options: FileDialogOptions =
                serde_json::from_slice(body).map_err(|e| e.to_string())?;
            let dialog = file_dialog(app, &options);
            Ok(match (options.directory, options.multiple) {
                (true, true) => paths(dialog.blocking_pick_folders()),
                (true, false) => paths(dialog.blocking_pick_folder().map(|p| vec![p])),
                (false, true) => paths(dialog.blocking_pick_files()),
                (false, false) => paths(dialog.blocking_pick_file().map(|p| vec![p])),
            })
        }
        "save" => {
            let options: FileDialogOptions =
                serde_json::from_slice(body).map_err(|e| e.to_string())?;
            Ok(json!(file_dialog(app, &options)
                .blocking_save_file()
                .map(|p| p.to_string())))
        }
        "message" => {
            let options: MessageDialogOptions =
                serde_json::from_slice(body).map_err(|e| e.to_string())?;
            let b = &options.buttons;
            let buttons = match b.len() {
                0 => MessageDialogButtons::Ok,
                1 => MessageDialogButtons::OkCustom(b[0].clone()),
                2 => MessageDialogButtons::OkCancelCustom(b[0].clone(), b[1].clone()),
                _ => MessageDialogButtons::YesNoCancelCustom(
                    b[0].clone(),
                    b[1].clone(),
                    b[2].clone(),
                ),
            };
            let mut dialog = app.dialog().message(options.message).buttons(buttons).kind(
                match options.kind.as_deref() {
                    Some("warning") => MessageDialogKind::Warning,
                    Some("error") => MessageDialogKind::Error,
                    _ => MessageDialogKind::Info,
                },
            );
            if let Some(title) = options.title {
                dialog = dialog.title(title);
            }
            let result = match dialog.blocking_show_with_result() {
                MessageDialogResult::Custom(label) => label,
                MessageDialogResult::Ok | MessageDialogResult::Yes => "Ok".into(),
                MessageDialogResult::No => "No".into(),
                MessageDialogResult::Cancel => "Cancel".into(),
            };
            Ok(json!(result))
        }
        other => Err(format!("unknown dialog '{other}'")),
    }
}

fn handle_bridge<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if request.method() == http::Method::OPTIONS {
        respond(responder, 204, "text/plain", Vec::new());
        return;
    }
    let app = ctx.app_handle().clone();
    let label = ctx.webview_label().to_string();
    let bridge = app.state::<SharedBridge>().inner().clone();
    let path = percent_decode(request.uri().path().trim_start_matches('/'));
    let path = path.trim_start_matches('/');

    match path {
        // webPreferences.additionalArguments & co, read by the renderer
        // bootstrap before the preload script runs.
        "window-config" => {
            let config = bridge
                .window_config
                .lock()
                .unwrap()
                .get(&label)
                .cloned()
                .unwrap_or(Value::Null);
            respond_json(responder, 200, &config);
        }
        // ipcRenderer.sendSync(): answered by ipcMain in the main window.
        "sync-ipc" => {
            if label == MAIN_LABEL {
                respond(
                    responder,
                    400,
                    "text/plain",
                    b"sendSync from the main process".to_vec(),
                );
                return;
            }
            let body = String::from_utf8_lossy(request.body()).into_owned();
            forward(
                &app,
                &bridge,
                responder,
                json!({ "kind": "sync-ipc", "from": label, "body": body }),
                SYNC_TIMEOUT,
            );
        }
        // dialog.showMessageBoxSync() with options native dialogs lack:
        // blocks until the message-box window answers.
        "dialog/message-window" => {
            #[cfg(desktop)]
            {
                if label != MAIN_LABEL {
                    respond(
                        responder,
                        403,
                        "text/plain",
                        b"dialogs are main-process only".to_vec(),
                    );
                    return;
                }
                let body = request.body().clone();
                thread::spawn(move || {
                    let answer = serde_json::from_slice::<message_box::Options>(&body)
                        .map_err(|e| e.to_string())
                        .and_then(|options| message_box::open(&app, options))
                        .and_then(|receiver| receiver.recv().map_err(|e| e.to_string()));
                    match answer {
                        Ok(value) => respond_json(responder, 200, &value),
                        Err(error) => respond(responder, 500, "text/plain", error.into_bytes()),
                    }
                });
            }
            #[cfg(not(desktop))]
            respond(
                responder,
                501,
                "text/plain",
                b"not supported on this platform".to_vec(),
            );
        }
        // The message-box window's own page, size and answer.
        p if p.starts_with("message-box/") => {
            #[cfg(desktop)]
            {
                let query = request.uri().query().unwrap_or("").to_string();
                match message_box::bridge(&app, &label, p, &query) {
                    Some((content_type, body)) => respond(responder, 200, &content_type, body),
                    None => respond(responder, 404, "text/plain", Vec::new()),
                }
            }
            #[cfg(not(desktop))]
            respond(responder, 404, "text/plain", Vec::new());
        }
        p if p.starts_with("dialog/") => {
            #[cfg(all(desktop, feature = "dialog"))]
            {
                if label != MAIN_LABEL {
                    respond(
                        responder,
                        403,
                        "text/plain",
                        b"dialogs are main-process only".to_vec(),
                    );
                    return;
                }
                let kind = p.trim_start_matches("dialog/").to_string();
                let body = request.body().clone();
                thread::spawn(move || match sync_dialog(&app, &kind, &body) {
                    Ok(value) => respond_json(responder, 200, &value),
                    Err(error) => respond(responder, 500, "text/plain", error.into_bytes()),
                });
            }
            #[cfg(not(all(desktop, feature = "dialog")))]
            respond(
                responder,
                501,
                "text/plain",
                b"enable the `dialog` feature of tauri-plugin-electron".to_vec(),
            );
        }
        // screen.getCursorScreenPoint(), synchronous like Electron's. Asked
        // off the main thread: Tauri answers it through the event loop.
        "cursor" => {
            thread::spawn(move || match app.cursor_position() {
                Ok(p) => respond_json(responder, 200, &json!({ "x": p.x, "y": p.y })),
                Err(error) => respond(responder, 500, "text/plain", error.to_string().into_bytes()),
            });
        }
        // clipboard.readText() & co. for apps on Electron < 45, where they
        // are synchronous.
        p if p.starts_with("clipboard/") => {
            #[cfg(all(desktop, feature = "clipboard"))]
            {
                if label != MAIN_LABEL {
                    respond(
                        responder,
                        403,
                        "text/plain",
                        b"clipboard reads are main-process only".to_vec(),
                    );
                    return;
                }
                let op = p.trim_start_matches("clipboard/").to_string();
                thread::spawn(move || match clipboard::read(&op) {
                    Ok(clipboard::Answer::Json(value)) => respond_json(responder, 200, &value),
                    Ok(clipboard::Answer::Image(bytes)) => {
                        respond(responder, 200, "application/octet-stream", bytes)
                    }
                    Err(error) => respond(responder, 500, "text/plain", error.into_bytes()),
                });
            }
            #[cfg(not(all(desktop, feature = "clipboard")))]
            {
                let _ = p;
                respond(
                    responder,
                    501,
                    "text/plain",
                    b"enable the `clipboard` feature of tauri-plugin-electron".to_vec(),
                );
            }
        }
        // powerMonitor.getSystemIdleTime() / getSystemIdleState(), synchronous in Electron.
        "power/idle" => {
            #[cfg(all(desktop, feature = "power-monitor"))]
            thread::spawn(move || {
                respond_json(
                    responder,
                    200,
                    &app.state::<power_monitor::Monitor>().idle(),
                )
            });
            #[cfg(not(all(desktop, feature = "power-monitor")))]
            {
                let _ = app;
                respond_json(responder, 200, &json!({ "idle": null, "locked": null }));
            }
        }
        // safeStorage.encryptString() & co., synchronous like Electron's.
        p if p.starts_with("safe-storage/") => {
            let query = request.uri().query().unwrap_or("").to_string();
            handle_safe_storage(&app, &label, p, &query, request.body().clone(), responder);
        }
        p if p.starts_with("node/") => {
            let query = request.uri().query().unwrap_or("").to_string();
            handle_node(&app, &label, p, &query, request.body().clone(), responder);
        }
        _ => respond(responder, 404, "text/plain", Vec::new()),
    }
}

/// `safe-storage/<op>`: `status` (JSON), `encrypt` (text in, bytes out),
/// `decrypt` (bytes in, text out), `plain-text?on=<bool>`. Main process only.
fn handle_safe_storage<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    path: &str,
    query: &str,
    body: Vec<u8>,
    responder: UriSchemeResponder,
) {
    if label != MAIN_LABEL {
        return respond(
            responder,
            403,
            "text/plain",
            b"safeStorage is main-process only".to_vec(),
        );
    }
    #[cfg(feature = "safe-storage")]
    {
        let op = path.trim_start_matches("safe-storage/").to_string();
        let on = query.split('&').any(|pair| pair == "on=true");
        let app = app.clone();
        // The first call may wait for the keychain: never on the main thread.
        thread::spawn(move || {
            let storage = app.state::<safe_storage::SafeStorage>();
            let result = match op.as_str() {
                "status" => Ok(storage.status().to_string().into_bytes()),
                "encrypt" => storage.encrypt(&body),
                "decrypt" => storage.decrypt(&body),
                "plain-text" => {
                    storage.set_use_plain_text(on);
                    Ok(Vec::new())
                }
                other => Err(format!("unknown safeStorage operation '{other}'")),
            };
            match result {
                Ok(bytes) => respond(responder, 200, "application/octet-stream", bytes),
                Err(error) => respond(responder, 500, "text/plain", error.into_bytes()),
            }
        });
    }
    #[cfg(not(feature = "safe-storage"))]
    {
        let _ = (app, path, query, body);
        respond(
            responder,
            501,
            "text/plain",
            b"enable the `safe-storage` feature of tauri-plugin-electron".to_vec(),
        );
    }
}

/// Whether the webview shows the app's own frontend (the dev server in
/// development, the embedded assets in a build), not a page it navigated to.
fn is_app_page<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    let Some(url) = app.get_webview_window(label).and_then(|w| w.url().ok()) else {
        return false;
    };
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    cfg!(debug_assertions)
        && app
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| dev.origin() == url.origin())
}

/// Why a native Node built-in may not run for this caller, if it may not.
/// The main window, and renderer windows created with `nodeIntegration` or an
/// unsandboxed preload (see `node_windows.rs`), while they show the app's page.
fn node_refusal<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<Value> {
    let main = label == MAIN_LABEL;
    if !main && !app.state::<node_windows::NodeWindows>().is_granted(label) {
        return Some(
            json!({ "code": "ERR_ACCESS_DENIED", "message": "Node built-ins that use the operating system are only available in the main process and in windows created with nodeIntegration (or sandbox: false)" }),
        );
    }
    if !is_app_page(app, label) {
        return Some(json!({
            "code": "ERR_ACCESS_DENIED",
            "message": if main { "the main window is not showing the app's own page" } else { "the window is not showing the app's own page" },
        }));
    }
    None
}

/// `node/<module>/<op>?a=<json>`: the `*Sync` functions of native-backed Node
/// built-ins. Runs on its own thread: the handler runs on the main (UI) thread.
fn handle_node<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    path: &str,
    query: &str,
    body: Vec<u8>,
    responder: UriSchemeResponder,
) {
    if let Some(refusal) = node_refusal(app, label) {
        return respond_json(responder, 403, &refusal);
    }
    let Some((module, op)) = path.trim_start_matches("node/").split_once('/') else {
        return respond(responder, 404, "text/plain", Vec::new());
    };
    let args: Value = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("a="))
        .map(|raw| serde_json::from_str(&percent_decode(raw)).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    match module {
        "fs" => {
            #[cfg(feature = "node-fs")]
            {
                // Where a build's app files are, for app-relative paths used
                // before `process.resourcesPath` is known.
                if op == "resourceDir" {
                    let dir = app
                        .path()
                        .resource_dir()
                        .map(|p| p.to_string_lossy().into_owned())
                        .ok();
                    return respond_json(responder, 200, &json!(dir));
                }
                // fs.watch: the watcher exists when fs.watch() returns. Off
                // the main thread: a recursive watch walks the whole tree.
                if op == "watch" {
                    let owner = label.to_string();
                    thread::spawn(move || match node_fs_watch::watch(&owner, &args) {
                        Ok(value) => respond_json(responder, 200, &value),
                        Err(error) => respond_json(responder, 400, &json!(error)),
                    });
                    return;
                }
                let op = op.to_string();
                let owner = label.to_string();
                thread::spawn(move || match node_fs::run_for(&owner, &op, &args, &body) {
                    Ok(node_fs::Output::Bytes(bytes)) => {
                        respond(responder, 200, "application/octet-stream", bytes)
                    }
                    Ok(node_fs::Output::Json(value)) => respond_json(responder, 200, &value),
                    Err(error) => respond_json(responder, 400, &json!(error)),
                });
            }
            #[cfg(not(feature = "node-fs"))]
            {
                let _ = (op, args, body);
                respond_json(
                    responder,
                    501,
                    &json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-fs" }),
                );
            }
        }
        "os" => {
            #[cfg(feature = "node-os")]
            {
                let op = op.to_string();
                thread::spawn(move || match node_os::run(&op, &args) {
                    Ok(value) => respond_json(responder, 200, &value),
                    Err(error) => respond_json(responder, 400, &json!(error)),
                });
            }
            #[cfg(not(feature = "node-os"))]
            {
                let _ = (op, args, body);
                respond_json(
                    responder,
                    501,
                    &json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-os" }),
                );
            }
        }
        // dns.getServers() is synchronous in Node.
        "dns" => {
            #[cfg(feature = "node-net")]
            {
                let _ = (args, body);
                if op == "servers" {
                    return respond_json(responder, 200, &node_dns::system_servers());
                }
                respond(responder, 404, "text/plain", Vec::new());
            }
            #[cfg(not(feature = "node-net"))]
            {
                let _ = (op, args, body);
                respond_json(
                    responder,
                    501,
                    &json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-net" }),
                );
            }
        }
        "child_process" => {
            #[cfg(feature = "node-child-process")]
            {
                if op != "spawnSync" {
                    return respond(responder, 404, "text/plain", Vec::new());
                }
                // A blocking execSync only blocks the main window, like Node's.
                thread::spawn(move || {
                    match serde_json::from_value::<node_child_process::SpawnOptions>(args) {
                        Ok(options) => respond(
                            responder,
                            200,
                            "application/octet-stream",
                            node_child_process::spawn_sync(&options, &body),
                        ),
                        Err(error) => respond_json(
                            responder,
                            400,
                            &json!({ "code": "ERR_INVALID_ARG_VALUE", "message": error.to_string() }),
                        ),
                    }
                });
            }
            #[cfg(not(feature = "node-child-process"))]
            {
                let _ = (op, args, body);
                respond_json(
                    responder,
                    501,
                    &json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-child-process" }),
                );
            }
        }
        _ => respond(responder, 404, "text/plain", Vec::new()),
    }
}

/// A scheme declared with [`Builder::protocol`]: forwarded to `protocol.handle()`.
fn handle_protocol<R: Runtime>(
    scheme: &str,
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let bridge = app.state::<SharedBridge>().inner().clone();
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();
    let payload = json!({
        "kind": "protocol",
        "scheme": scheme,
        "from": ctx.webview_label(),
        "url": request.uri().to_string(),
        "method": request.method().as_str(),
        "headers": headers,
        "body": BASE64.encode(request.body()),
    });
    forward(&app, &bridge, responder, payload, PROTOCOL_TIMEOUT);
}

// --- commands ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessInfo {
    argv: Vec<String>,
    exec_path: String,
    pid: u32,
    cwd: String,
    env: HashMap<String, String>,
    resources_path: String,
    /// Enabled Cargo features of this crate (see `features.rs`).
    features: Vec<&'static str>,
}

#[tauri::command]
fn process_info<R: Runtime>(app: AppHandle<R>) -> ProcessInfo {
    let exec_path = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Electron's process.argv[0] is the executable path.
    let mut argv: Vec<String> = std::env::args().collect();
    if let Some(first) = argv.first_mut() {
        *first = exec_path.clone();
    }
    ProcessInfo {
        argv,
        exec_path,
        pid: std::process::id(),
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        env: std::env::vars().collect(),
        features: features::enabled(),
        resources_path: app
            .path()
            .resource_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// What a window's renderer bootstrap reads before the preload runs, and
/// (`node: true`) whether it gets Node built-ins. Only the main process may
/// configure windows: a renderer must not grant itself Node.
#[tauri::command]
fn set_window_config<R: Runtime>(
    webview: tauri::Webview<R>,
    bridge: State<'_, SharedBridge>,
    label: String,
    config: Option<Value>,
) -> Result<(), String> {
    if webview.label() != MAIN_LABEL {
        return Err("windows are configured by the main process only".into());
    }
    let node = config
        .as_ref()
        .and_then(|c| c.get("node"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if node {
        node_windows::grant(webview.app_handle(), &label)?;
    } else {
        webview.state::<node_windows::NodeWindows>().revoke(&label);
    }
    let mut map = bridge.window_config.lock().unwrap();
    match config {
        Some(config) => map.insert(label, config),
        None => map.remove(&label),
    };
    Ok(())
}

#[tauri::command]
fn open_devtools<R: Runtime>(app: AppHandle<R>, label: String) -> bool {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    if let Some(webview) = app.get_webview_window(&label) {
        webview.open_devtools();
        return true;
    }
    let _ = (app, label);
    false
}

#[tauri::command]
fn close_devtools<R: Runtime>(app: AppHandle<R>, label: String) {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    if let Some(webview) = app.get_webview_window(&label) {
        webview.close_devtools();
    }
    let _ = (app, label);
}

#[tauri::command]
fn is_devtools_open<R: Runtime>(app: AppHandle<R>, label: String) -> bool {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    if let Some(webview) = app.get_webview_window(&label) {
        return webview.is_devtools_open();
    }
    let _ = (app, label);
    false
}

#[tauri::command]
async fn trash_item(path: String) -> Result<(), String> {
    #[cfg(desktop)]
    return trash::delete(&path).map_err(|e| e.to_string());
    #[cfg(not(desktop))]
    {
        let _ = path;
        Err("not supported on this platform".into())
    }
}

/// `setMenuBarVisibility` / `setAutoHideMenuBar`. Not on macOS, where the
/// menu bar belongs to the app. Async: Tauri changes it on the main thread.
#[tauri::command]
async fn set_menu_visible<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    visible: bool,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    if visible {
        window.show_menu()
    } else {
        window.hide_menu()
    }
    .map_err(|e| e.to_string())
}

/// The webview whose cookie store a session uses: one of its windows.
fn cookie_webview<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<tauri::WebviewWindow<R>, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("no webview '{label}' to reach the cookie store through"))
}

// Cookie commands are async: WebView2 deadlocks when cookies are read on the
// main thread (wry#583), and the other platforms answer through it.

#[tauri::command]
async fn cookies_get<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: Option<String>,
) -> Result<Value, String> {
    cookies::get(&cookie_webview(&app, &label)?, url.as_deref())
}

#[tauri::command]
async fn cookies_set<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    details: cookies::Details,
) -> Result<Value, String> {
    cookies::set(&cookie_webview(&app, &label)?, details)
}

#[tauri::command]
async fn cookies_remove<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
    name: String,
) -> Result<Value, String> {
    cookies::remove(&cookie_webview(&app, &label)?, &url, &name)
}

/// `dialog.showMessageBox()` with options native dialogs lack (more than
/// three buttons, `checkboxLabel`, `defaultId`): a small window. Resolves to
/// `{ response, checkboxChecked }` when it closes.
#[tauri::command]
async fn message_box<R: Runtime>(
    webview: tauri::Webview<R>,
    options: Value,
) -> Result<Value, String> {
    if webview.label() != MAIN_LABEL {
        return Err("dialogs are main-process only".into());
    }
    #[cfg(desktop)]
    {
        let options: message_box::Options =
            serde_json::from_value(options).map_err(|e| e.to_string())?;
        let receiver = message_box::open(webview.app_handle(), options)?;
        tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(desktop))]
    {
        let _ = options;
        Err("not supported on this platform".into())
    }
}

/// Dismiss a message box (`showMessageBox`'s `signal` aborted): it answers `cancelId`.
#[tauri::command]
fn message_box_close<R: Runtime>(webview: tauri::Webview<R>, id: String) {
    #[cfg(desktop)]
    if webview.label() == MAIN_LABEL {
        message_box::close(webview.app_handle(), &id);
    }
    #[cfg(not(desktop))]
    let _ = (webview, id);
}

/// `clipboard.readHTML()`.
#[tauri::command]
async fn clipboard_read_html() -> Result<String, String> {
    #[cfg(all(desktop, feature = "clipboard"))]
    return clipboard::read_html();
    #[cfg(not(all(desktop, feature = "clipboard")))]
    Err("enable the `clipboard` feature of tauri-plugin-electron".into())
}

/// `powerSaveBlocker.start(type)`: the id of an operating-system assertion.
/// Async: taking one can mean a blocking D-Bus call (Linux), kept off the
/// main thread.
#[tauri::command]
async fn power_blocker_start<R: Runtime>(app: AppHandle<R>, kind: String) -> Result<u32, String> {
    #[cfg(all(desktop, feature = "power-save-blocker"))]
    {
        let name = app.package_info().name.clone();
        app.state::<power::Blockers>().start(&kind, &name)
    }
    #[cfg(not(all(desktop, feature = "power-save-blocker")))]
    {
        let _ = (app, kind);
        Err("enable the `power-save-blocker` feature of tauri-plugin-electron".into())
    }
}

/// `powerSaveBlocker.stop(id)`.
#[tauri::command]
async fn power_blocker_stop<R: Runtime>(app: AppHandle<R>, id: u32) -> bool {
    #[cfg(all(desktop, feature = "power-save-blocker"))]
    return app.state::<power::Blockers>().stop(id);
    #[cfg(not(all(desktop, feature = "power-save-blocker")))]
    {
        let _ = (app, id);
        false
    }
}

/// `new Notification(options).show()` with `click` / `action` / `close` reported
/// to the main process (`tauri-electron:notification`).
#[tauri::command]
async fn notification_show<R: Runtime>(app: AppHandle<R>, options: Value) -> Result<(), String> {
    #[cfg(all(desktop, feature = "notification"))]
    {
        let options = serde_json::from_value(options).map_err(|e| e.to_string())?;
        notification::show(&app, &app.state::<notification::State>(), options)
    }
    #[cfg(not(all(desktop, feature = "notification")))]
    {
        let _ = (app, options);
        Err("enable the `notification` feature of tauri-plugin-electron".into())
    }
}

/// `notification.close()`.
#[tauri::command]
async fn notification_close<R: Runtime>(app: AppHandle<R>, id: i32) -> Result<(), String> {
    #[cfg(all(desktop, feature = "notification"))]
    return notification::close(&app, id);
    #[cfg(not(all(desktop, feature = "notification")))]
    {
        let _ = (app, id);
        Err("enable the `notification` feature of tauri-plugin-electron".into())
    }
}

/// Start reporting powerMonitor's system events (`tauri-electron:power-monitor`);
/// returns the events this platform reports. Async: connecting to D-Bus blocks.
#[tauri::command]
async fn power_monitor_start<R: Runtime>(app: AppHandle<R>) -> Vec<&'static str> {
    #[cfg(all(desktop, feature = "power-monitor"))]
    return app.state::<power_monitor::Monitor>().start(&app);
    #[cfg(not(all(desktop, feature = "power-monitor")))]
    {
        let _ = app;
        Vec::new()
    }
}

#[cfg(feature = "node-child-process")]
type SharedChildren = Arc<node_child_process::Children>;

/// Whether `child_process` may run for this caller.
fn children<R: Runtime>(webview: &tauri::Webview<R>) -> Result<(), Value> {
    if let Some(refusal) = node_refusal(webview.app_handle(), webview.label()) {
        return Err(refusal);
    }
    if cfg!(feature = "node-child-process") {
        Ok(())
    } else {
        Err(json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-child-process" }))
    }
}

/// `child_process.spawn` / `exec` / `execFile`: start a child whose output
/// and exit are streamed to `on_event`. Returns `{ id, pid }`.
#[tauri::command]
fn child_spawn<R: Runtime>(
    webview: tauri::Webview<R>,
    options: Value,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<Value, Value> {
    children(&webview)?;
    #[cfg(feature = "node-child-process")]
    {
        let options: node_child_process::SpawnOptions = serde_json::from_value(options)
            .map_err(|e| json!({ "code": "ERR_INVALID_ARG_VALUE", "message": e.to_string() }))?;
        let table = webview.state::<SharedChildren>();
        table.spawn(&options, on_event).map_err(|e| json!(e))
    }
    #[cfg(not(feature = "node-child-process"))]
    {
        let _ = (options, on_event);
        Ok(Value::Null)
    }
}

/// Bytes (base64) for a child's stdin. False once stdin is closed.
#[tauri::command]
fn child_write<R: Runtime>(
    webview: tauri::Webview<R>,
    id: u32,
    data: String,
) -> Result<bool, Value> {
    children(&webview)?;
    #[cfg(feature = "node-child-process")]
    {
        let bytes = BASE64
            .decode(data.as_bytes())
            .map_err(|e| json!({ "message": e.to_string() }))?;
        Ok(webview.state::<SharedChildren>().write(id, bytes))
    }
    #[cfg(not(feature = "node-child-process"))]
    {
        let _ = (id, data);
        Ok(false)
    }
}

/// Close a child's stdin.
#[tauri::command]
fn child_end<R: Runtime>(webview: tauri::Webview<R>, id: u32) -> Result<(), Value> {
    children(&webview)?;
    #[cfg(feature = "node-child-process")]
    webview.state::<SharedChildren>().end(id);
    #[cfg(not(feature = "node-child-process"))]
    let _ = id;
    Ok(())
}

/// `subprocess.kill(signal)`: false when the child is gone.
#[tauri::command]
fn child_kill<R: Runtime>(webview: tauri::Webview<R>, id: u32, signal: i32) -> Result<bool, Value> {
    children(&webview)?;
    #[cfg(feature = "node-child-process")]
    {
        webview
            .state::<SharedChildren>()
            .kill(id, signal)
            .map_err(|e| json!(e))
    }
    #[cfg(not(feature = "node-child-process"))]
    {
        let _ = (id, signal);
        Ok(false)
    }
}

/// `fs.promises.*` and the callback API: the same operations as the bridge's
/// `node/fs/<op>`, off the main thread. The raw body is framed as described
/// in `node_fs::parse_frame`; the answer is raw bytes (JSON for every
/// operation but `read`).
#[tauri::command]
#[allow(clippy::result_large_err)]
async fn node_fs<R: Runtime>(
    webview: tauri::Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, Value> {
    if let Some(refusal) = node_refusal(webview.app_handle(), webview.label()) {
        return Err(refusal);
    }
    #[cfg(feature = "node-fs")]
    {
        let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
            return Err(
                json!({ "code": "ERR_INVALID_ARG_TYPE", "message": "node_fs expects a raw body" }),
            );
        };
        let body = body.clone();
        let owner = webview.label().to_string();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let (op, args, data) = node_fs::parse_frame(&body)?;
            node_fs::run_for(&owner, &op, &args, data)
        })
        .await
        .map_err(|e| json!({ "code": "ERR_INTERNAL", "message": e.to_string() }))?;
        match result {
            Ok(node_fs::Output::Bytes(bytes)) => Ok(tauri::ipc::Response::new(bytes)),
            Ok(node_fs::Output::Json(value)) => {
                Ok(tauri::ipc::Response::new(value.to_string().into_bytes()))
            }
            Err(error) => Err(json!(error)),
        }
    }
    #[cfg(not(feature = "node-fs"))]
    {
        let _ = request;
        Err(json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-fs" }))
    }
}

/// `fs.watch`: send the events of the watcher the bridge's `node/fs/watch`
/// created to `on_event`. False when it is gone.
#[tauri::command]
fn fs_watch<R: Runtime>(
    webview: tauri::Webview<R>,
    id: u32,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<bool, Value> {
    if let Some(refusal) = node_refusal(webview.app_handle(), webview.label()) {
        return Err(refusal);
    }
    #[cfg(feature = "node-fs")]
    return Ok(node_fs_watch::attach(webview.label(), id, on_event));
    #[cfg(not(feature = "node-fs"))]
    {
        let _ = (id, on_event);
        Err(json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-fs" }))
    }
}

/// `watcher.close()`.
#[tauri::command]
fn fs_unwatch<R: Runtime>(webview: tauri::Webview<R>, id: u32) -> Result<bool, Value> {
    if let Some(refusal) = node_refusal(webview.app_handle(), webview.label()) {
        return Err(refusal);
    }
    #[cfg(feature = "node-fs")]
    return Ok(node_fs_watch::unwatch(webview.label(), id));
    #[cfg(not(feature = "node-fs"))]
    {
        let _ = id;
        Ok(false)
    }
}

/// Page loads, for the lifetime of the files and watchers a page opened
/// (see `node_fs::owners`): a load takes a stamp when it starts; once it has
/// finished, what the webview opened before is closed, as a restarted Node
/// process starts with nothing open. A load that never finishes, or that
/// finishes back on the page already shown at another URL than it started
/// for (a link that becomes a download, a cancelled navigation), closes
/// nothing. Per label: the load under way, and the URL of the page shown.
#[cfg(feature = "node-fs")]
#[derive(Default)]
struct PageLoads {
    started: HashMap<String, (u64, String)>,
    shown: HashMap<String, String>,
}

#[cfg(feature = "node-fs")]
static PAGE_LOADS: std::sync::LazyLock<Mutex<PageLoads>> =
    std::sync::LazyLock::new(Default::default);

fn node_page_started(label: &str, url: &str) {
    #[cfg(feature = "node-fs")]
    PAGE_LOADS.lock().unwrap().started.insert(
        label.to_string(),
        (node_fs::owners::stamp(), url.to_string()),
    );
    let _ = (label, url);
}

fn node_page_finished(label: &str, url: &str) {
    #[cfg(feature = "node-fs")]
    {
        let stamp = {
            let mut loads = PAGE_LOADS.lock().unwrap();
            let load = loads.started.remove(label);
            let shown = loads.shown.insert(label.to_string(), url.to_string());
            match load {
                // Back on the page that was shown: nothing replaced it.
                Some((_, started)) if started != url && shown.as_deref() == Some(url) => None,
                Some((stamp, _)) => Some(stamp),
                None => None,
            }
        };
        if let Some(stamp) = stamp {
            node_fs::close_owned_before(label, stamp);
            node_fs_watch::close_owned_before(label, stamp);
        }
    }
    let _ = (label, url);
}

/// The window closed: everything its pages opened.
fn node_window_closed(label: &str) {
    #[cfg(feature = "node-fs")]
    {
        {
            let mut loads = PAGE_LOADS.lock().unwrap();
            loads.started.remove(label);
            loads.shown.remove(label);
        }
        node_fs::close_owned_before(label, u64::MAX);
        node_fs_watch::close_owned_before(label, u64::MAX);
    }
    let _ = label;
}

// safeStorage's asynchronous variants (and isAsyncEncryptionAvailable): the
// same state as the bridge's `safe-storage/<op>`, off the main thread.

#[cfg(feature = "safe-storage")]
fn safe_storage_state<R: Runtime>(
    webview: &tauri::Webview<R>,
) -> Result<tauri::State<'_, safe_storage::SafeStorage>, String> {
    if webview.label() != MAIN_LABEL {
        return Err("safeStorage is main-process only".into());
    }
    Ok(webview.state::<safe_storage::SafeStorage>())
}

#[cfg(not(feature = "safe-storage"))]
const SAFE_STORAGE_OFF: &str = "enable the `safe-storage` feature of tauri-plugin-electron";

#[tauri::command]
async fn safe_storage_status<R: Runtime>(webview: tauri::Webview<R>) -> Result<Value, String> {
    #[cfg(feature = "safe-storage")]
    return Ok(safe_storage_state(&webview)?.status());
    #[cfg(not(feature = "safe-storage"))]
    {
        let _ = webview;
        Err(SAFE_STORAGE_OFF.into())
    }
}

#[tauri::command]
async fn safe_storage_encrypt<R: Runtime>(
    webview: tauri::Webview<R>,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(feature = "safe-storage")]
    return safe_storage_state(&webview)?
        .encrypt(text.as_bytes())
        .map(tauri::ipc::Response::new);
    #[cfg(not(feature = "safe-storage"))]
    {
        let _ = (webview, text);
        Err(SAFE_STORAGE_OFF.into())
    }
}

/// Ciphertext as base64 (JSON arrays of bytes are wasteful).
#[tauri::command]
async fn safe_storage_decrypt<R: Runtime>(
    webview: tauri::Webview<R>,
    data: String,
) -> Result<String, String> {
    #[cfg(feature = "safe-storage")]
    {
        let bytes = BASE64.decode(data.as_bytes()).map_err(|e| e.to_string())?;
        let plain = safe_storage_state(&webview)?.decrypt(&bytes)?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    }
    #[cfg(not(feature = "safe-storage"))]
    {
        let _ = (webview, data);
        Err(SAFE_STORAGE_OFF.into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    id: u64,
    status: u16,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    base64: bool,
}

#[tauri::command]
fn bridge_respond(bridge: State<'_, SharedBridge>, response: BridgeResponse) -> Result<(), String> {
    let Some(responder) = bridge.pending.lock().unwrap().remove(&response.id) else {
        return Err(format!("no pending request {}", response.id));
    };
    let body = if response.base64 {
        BASE64
            .decode(response.body.as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        response.body.into_bytes()
    };
    let mut builder = cors(Response::builder())
        .status(StatusCode::from_u16(response.status).unwrap_or(StatusCode::OK));
    for (name, value) in response.headers {
        builder = builder.header(name, value);
    }
    responder.respond(builder.body(body).map_err(|e| e.to_string())?);
    Ok(())
}

// --- events ------------------------------------------------------------------------------

/// Forwards a second launch to the main process as Electron's `second-instance`.
/// [`Builder::install`] wires this up with the `single-instance` feature; it is
/// public for apps that configure `tauri-plugin-single-instance` on their own.
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>, cwd: String) {
    let _ = app.emit_to(
        MAIN_LABEL,
        "tauri-electron:second-instance",
        json!({ "argv": argv, "cwd": cwd }),
    );
}

/// Builder for the plugin.
pub struct Builder {
    protocols: Vec<String>,
    default_capabilities: bool,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            protocols: Vec::new(),
            default_capabilities: true,
        }
    }
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether to grant Electron's default capabilities at startup (on by
    /// default): the `electron-main` window gets every permission of the
    /// enabled features, and every window gets the renderer permissions (IPC,
    /// zoom, `window.close()`, window dragging). Turn it off to manage all
    /// permissions yourself in `src-tauri/capabilities/`.
    pub fn default_capabilities(mut self, enabled: bool) -> Self {
        self.default_capabilities = enabled;
        self
    }

    /// Declare a custom URI scheme handled by `protocol.handle(scheme, handler)`
    /// in the main process. Tauri needs to know schemes when the app is built,
    /// so they are listed here rather than registered from JavaScript.
    pub fn protocol(mut self, scheme: impl Into<String>) -> Self {
        self.protocols.push(scheme.into());
        self
    }

    /// Declare several schemes, typically the ones the bundler plugins found
    /// in the app's JavaScript: `.protocols(tauri_plugin_electron::bundled_schemes!())`.
    pub fn protocols<I, S>(mut self, schemes: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.protocols.extend(schemes.into_iter().map(Into::into));
        self
    }

    /// Register the plugin on an app builder, together with the official
    /// Tauri plugins of the enabled Cargo features (dialog, clipboard, ...,
    /// and opt-in ones such as `single-instance` and `updater`). Call it on
    /// a fresh builder, before other plugins: with `single-instance`, a second
    /// launch then exits before anything else starts.
    ///
    /// ```ignore
    /// tauri_plugin_electron::Builder::new()
    ///     .install(tauri::Builder::default())
    ///     .run(tauri::generate_context!())
    /// ```
    pub fn install<R: Runtime>(self, builder: tauri::Builder<R>) -> tauri::Builder<R> {
        #[cfg(all(desktop, feature = "single-instance"))]
        let builder = builder.plugin(tauri_plugin_single_instance::init(on_second_instance));
        features::register(builder.plugin(self.build()))
    }

    /// The plugin alone, without the official plugins of its features.
    /// Prefer [`Builder::install`].
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let default_capabilities = self.default_capabilities;
        let mut builder = PluginBuilder::new("electron")
            .invoke_handler(tauri::generate_handler![
                process_info,
                set_window_config,
                open_devtools,
                close_devtools,
                is_devtools_open,
                trash_item,
                bridge_respond,
                set_menu_visible,
                cookies_get,
                cookies_set,
                cookies_remove,
                clipboard_read_html,
                message_box,
                message_box_close,
                power_blocker_start,
                power_blocker_stop,
                notification_show,
                notification_close,
                power_monitor_start,
                safe_storage_status,
                safe_storage_encrypt,
                safe_storage_decrypt,
                node_fs,
                fs_watch,
                fs_unwatch,
                child_spawn,
                child_write,
                child_end,
                child_kill,
                node_net_commands::net_connect,
                node_net_commands::net_listen,
                node_net_commands::net_write,
                node_net_commands::net_end,
                node_net_commands::net_destroy,
                node_net_commands::net_pause,
                node_net_commands::net_set_option,
                node_net_commands::udp_bind,
                node_net_commands::udp_send,
                node_net_commands::udp_option,
                node_net_commands::udp_membership,
                node_net_commands::dns_lookup,
                node_net_commands::dns_resolve,
                node_net_commands::dns_reverse,
                node_net_commands::dns_servers,
                windows::create_window,
                windows::permission_handler,
                windows::permission_respond,
                windows::download_url,
                windows::download_control,
                windows::download_commit,
                windows::download_discard
            ])
            .setup(move |app, _api| {
                app.manage(SharedBridge::default());
                #[cfg(desktop)]
                app.manage(message_box::Boxes::default());
                app.manage(node_windows::NodeWindows::default());
                windows::manage(app);
                #[cfg(all(desktop, feature = "power-save-blocker"))]
                app.manage(power::Blockers::default());
                #[cfg(all(desktop, feature = "notification"))]
                app.manage(notification::State::default());
                #[cfg(all(desktop, feature = "power-monitor"))]
                app.manage(power_monitor::Monitor::default());
                #[cfg(feature = "safe-storage")]
                app.manage(safe_storage::SafeStorage::new(&app.package_info().name));
                #[cfg(feature = "node-child-process")]
                app.manage(SharedChildren::default());
                #[cfg(feature = "node-net")]
                app.manage(Arc::new(node_net::Net::default()));
                if default_capabilities {
                    for capability in features::capabilities() {
                        app.add_capability(capability)?;
                    }
                }
                Ok(())
            })
            // Navigation events for every window, including remote pages that
            // the renderer bootstrap cannot run in.
            .on_page_load(|webview, payload| {
                // A reloaded page (the main process, or a window with Node)
                // starts with no open files, as a restarted Node would.
                let url = payload.url().as_str();
                match payload.event() {
                    PageLoadEvent::Started => node_page_started(webview.label(), url),
                    PageLoadEvent::Finished => node_page_finished(webview.label(), url),
                }
                if webview.label() == MAIN_LABEL {
                    return;
                }
                // The origin permission decisions are kept for (Windows / macOS).
                webview
                    .state::<permissions::Permissions>()
                    .page_loaded(webview.label(), payload.url().as_str());
                let event = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                let _ = webview.app_handle().emit_to(
                    MAIN_LABEL,
                    "tauri-electron:page-load",
                    json!({ "label": webview.label(), "url": payload.url().as_str(), "event": event }),
                );
            })
            .on_event(|app, event| match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    let _ = app.emit_to(MAIN_LABEL, "tauri-electron:activate", *has_visible_windows);
                }
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                tauri::RunEvent::Opened { urls } => {
                    let urls: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
                    let _ = app.emit_to(MAIN_LABEL, "tauri-electron:opened", urls);
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } => node_window_closed(label),
                _ => {
                    let _ = app;
                }
            })
            .register_asynchronous_uri_scheme_protocol(BRIDGE_SCHEME, handle_bridge);
        let mut schemes = self.protocols;
        schemes.retain(|scheme| scheme != BRIDGE_SCHEME);
        schemes.sort();
        schemes.dedup();
        for scheme in schemes {
            let name = scheme.clone();
            builder = builder.register_asynchronous_uri_scheme_protocol(
                scheme,
                move |ctx, request, responder| handle_protocol(&name, ctx, request, responder),
            );
        }
        builder.build()
    }
}

/// The schemes in `electron-schemes.json`, as the app's build script hands
/// them over (see [`bundled_schemes!`]). Invalid entries are skipped.
pub fn schemes_from_json(json: Option<&str>) -> Vec<String> {
    let Some(json) = json else {
        return Vec::new();
    };
    let list: Vec<String> = serde_json::from_str(json).unwrap_or_default();
    list.into_iter()
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| {
            let mut chars = s.chars();
            chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+.-".contains(c))
        })
        .collect()
}

/// The custom schemes the bundler plugins found in the app's JavaScript
/// (`protocol.handle('app', …)`, `protocol.registerSchemesAsPrivileged`,
/// and schemes of known libraries such as `@sentry/electron`'s
/// `sentry-ipc`). They write `src-tauri/electron-schemes.json`; the app's
/// build.rs passes it on as the `TAURI_ELECTRON_SCHEMES` compile-time
/// variable:
///
/// ```ignore
/// // build.rs
/// println!("cargo:rerun-if-changed=electron-schemes.json");
/// if let Ok(json) = std::fs::read_to_string("electron-schemes.json") {
///     println!("cargo:rustc-env=TAURI_ELECTRON_SCHEMES={}", json.trim());
/// }
/// // lib.rs
/// tauri_plugin_electron::Builder::new().protocols(tauri_plugin_electron::bundled_schemes!())
/// ```
///
/// A macro so that the variable is read when the *app* is compiled.
#[macro_export]
macro_rules! bundled_schemes {
    () => {
        $crate::schemes_from_json(::core::option_env!("TAURI_ELECTRON_SCHEMES"))
    };
}

/// The plugin with no custom protocols.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}

#[cfg(test)]
mod tests {
    use super::schemes_from_json;

    #[test]
    fn schemes_from_the_bundler() {
        assert!(schemes_from_json(None).is_empty());
        assert!(schemes_from_json(Some("not json")).is_empty());
        assert_eq!(
            schemes_from_json(Some(r#"["app", "Sentry-IPC", "bad scheme", "1x", ""]"#)),
            vec!["app", "sentry-ipc"]
        );
    }
}
