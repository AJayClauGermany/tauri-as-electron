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
//! - **DevTools** (`webContents.openDevTools()` and friends) and
//!   **`shell.trashItem()`**.
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

mod features;

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

#[tauri::command]
fn set_window_config(bridge: State<'_, SharedBridge>, label: String, config: Option<Value>) {
    let mut map = bridge.window_config.lock().unwrap();
    match config {
        Some(config) => map.insert(label, config),
        None => map.remove(&label),
    };
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
                bridge_respond
            ])
            .setup(move |app, _api| {
                app.manage(SharedBridge::default());
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
                if webview.label() == MAIN_LABEL {
                    return;
                }
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
                _ => {
                    let _ = app;
                }
            })
            .register_asynchronous_uri_scheme_protocol(BRIDGE_SCHEME, handle_bridge);
        for scheme in self.protocols {
            let name = scheme.clone();
            builder = builder.register_asynchronous_uri_scheme_protocol(
                scheme,
                move |ctx, request, responder| handle_protocol(&name, ctx, request, responder),
            );
        }
        builder.build()
    }
}

/// The plugin with no custom protocols.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}
