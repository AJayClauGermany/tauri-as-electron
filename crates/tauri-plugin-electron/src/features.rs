//! Cargo features → official Tauri plugins and the permissions Electron's
//! main process gets for them.
//!
//! Each Electron module that relies on an official plugin is a feature of
//! this crate. [`register`] adds the plugins of the enabled features to the
//! app, and [`capabilities`] grants them the way Electron does: the main
//! process may use everything, renderers may only talk to it.

use serde_json::{json, Value};
use tauri::Runtime;

use crate::MAIN_LABEL;

/// The enabled features, reported to JavaScript (`process_info`) so that
/// tauri-electron can explain what to enable when an API is unavailable.
pub fn enabled() -> Vec<&'static str> {
    let mut list = Vec::new();
    macro_rules! feature {
        ($($name:literal),*) => {$( if cfg!(feature = $name) { list.push($name) } )*};
    }
    feature!(
        "dialog",
        "clipboard",
        "notification",
        "shell",
        "net",
        "global-shortcut",
        "tray",
        "protocol-client",
        "login-item",
        "single-instance",
        "updater",
        "devtools",
        "node-fs"
    );
    // Desktop-only plugins are not built on mobile.
    if !cfg!(desktop) {
        list.retain(|name| {
            !matches!(
                *name,
                "global-shortcut" | "login-item" | "single-instance" | "updater"
            )
        });
    }
    list
}

/// Register the official plugins of the enabled features (after the
/// single-instance plugin and tauri-plugin-electron itself).
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let builder = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init());
    #[cfg(feature = "dialog")]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "clipboard")]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(feature = "notification")]
    let builder = builder.plugin(tauri_plugin_notification::init());
    #[cfg(feature = "shell")]
    let builder = builder.plugin(tauri_plugin_opener::init());
    #[cfg(feature = "net")]
    let builder = builder.plugin(tauri_plugin_http::init());
    #[cfg(feature = "protocol-client")]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    #[cfg(all(desktop, feature = "global-shortcut"))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(all(desktop, feature = "login-item"))]
    let builder = builder.plugin(tauri_plugin_autostart::Builder::new().build());
    #[cfg(all(desktop, feature = "updater"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
}

/// Core window/webview permissions the main process uses for BrowserWindow,
/// app, screen, Menu and nativeTheme.
const MAIN_CORE: &[&str] = &[
    "core:default",
    "core:app:allow-app-show",
    "core:app:allow-app-hide",
    "core:app:allow-set-app-theme",
    "core:app:allow-set-dock-visibility",
    "core:app:allow-default-window-icon",
    "core:webview:allow-create-webview-window",
    "core:webview:allow-set-webview-zoom",
    "core:webview:allow-clear-all-browsing-data",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "core:window:allow-set-focus",
    "core:window:allow-set-focusable",
    "core:window:allow-set-enabled",
    "core:window:allow-is-enabled",
    "core:window:allow-minimize",
    "core:window:allow-unminimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-set-fullscreen",
    "core:window:allow-set-simple-fullscreen",
    "core:window:allow-set-title",
    "core:window:allow-set-size",
    "core:window:allow-set-min-size",
    "core:window:allow-set-max-size",
    "core:window:allow-set-position",
    "core:window:allow-center",
    "core:window:allow-set-resizable",
    "core:window:allow-set-minimizable",
    "core:window:allow-set-maximizable",
    "core:window:allow-set-closable",
    "core:window:allow-set-always-on-top",
    "core:window:allow-set-skip-taskbar",
    "core:window:allow-set-visible-on-all-workspaces",
    "core:window:allow-set-content-protected",
    "core:window:allow-set-ignore-cursor-events",
    "core:window:allow-set-background-color",
    "core:window:allow-set-shadow",
    "core:window:allow-set-progress-bar",
    "core:window:allow-request-user-attention",
    "core:window:allow-set-icon",
    "core:window:allow-set-overlay-icon",
    "core:window:allow-set-badge-count",
    "core:window:allow-cursor-position",
    "electron:default",
    "os:default",
    "process:default",
];

/// What a context-isolated, sandboxed Electron renderer can do: IPC with the
/// main process, zoom, `window.close()`, and dragging `-webkit-app-region`
/// areas. Sync IPC and window configuration use tauri-plugin-electron's URI
/// scheme, which needs no permission.
const RENDERER: &[&str] = &[
    "core:event:default",
    "core:window:default",
    "core:webview:default",
    "core:webview:allow-set-webview-zoom",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
];

fn main_permissions() -> Vec<Value> {
    let mut permissions: Vec<Value> = MAIN_CORE.iter().map(|p| json!(p)).collect();
    let mut add = |list: &[Value]| permissions.extend_from_slice(list);
    if cfg!(feature = "dialog") {
        add(&[json!("dialog:default")]);
    }
    if cfg!(feature = "clipboard") {
        add(&[
            json!("clipboard-manager:allow-read-text"),
            json!("clipboard-manager:allow-read-image"),
            json!("clipboard-manager:allow-write-text"),
            json!("clipboard-manager:allow-write-html"),
            json!("clipboard-manager:allow-write-image"),
            json!("clipboard-manager:allow-clear"),
        ]);
    }
    if cfg!(feature = "notification") {
        add(&[json!("notification:default")]);
    }
    if cfg!(feature = "shell") {
        // Electron's shell.openExternal opens any URL (custom schemes such as
        // `vscode://` included) and shell.openPath any path.
        add(&[
            json!("opener:default"),
            json!({ "identifier": "opener:allow-open-url", "allow": [{ "url": "*" }] }),
            json!({ "identifier": "opener:allow-open-path", "allow": [{ "path": "**" }] }),
        ]);
    }
    if cfg!(feature = "net") {
        // Electron's main process has unrestricted network access.
        add(&[
            json!({ "identifier": "http:default", "allow": [{ "url": "https://**" }, { "url": "http://**" }] }),
        ]);
    }
    if cfg!(feature = "protocol-client") {
        add(&[
            json!("deep-link:default"),
            json!("deep-link:allow-register"),
            json!("deep-link:allow-unregister"),
            json!("deep-link:allow-is-registered"),
        ]);
    }
    if cfg!(all(desktop, feature = "global-shortcut")) {
        add(&[
            json!("global-shortcut:allow-register"),
            json!("global-shortcut:allow-unregister"),
            json!("global-shortcut:allow-unregister-all"),
            json!("global-shortcut:allow-is-registered"),
        ]);
    }
    if cfg!(all(desktop, feature = "login-item")) {
        add(&[json!("autostart:default")]);
    }
    if cfg!(all(desktop, feature = "updater")) {
        add(&[json!("updater:default")]);
    }
    if cfg!(feature = "node-fs") {
        add(&[json!("electron:node-fs")]);
    }
    permissions
}

/// The capabilities granted at startup, as capability-file JSON.
pub fn capabilities() -> [String; 2] {
    let main = json!({
        "identifier": "electron-main",
        "description": "The hidden window running Electron main-process code: every API of the enabled tauri-plugin-electron features, like Electron's main process.",
        "windows": [MAIN_LABEL],
        "permissions": main_permissions(),
    });
    let renderer = json!({
        "identifier": "electron-renderer",
        "description": "Every BrowserWindow, like a context-isolated, sandboxed Electron renderer.",
        "windows": ["*"],
        "permissions": RENDERER,
    });
    [main.to_string(), renderer.to_string()]
}
