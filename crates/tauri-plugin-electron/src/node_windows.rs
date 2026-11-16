//! Renderer windows that get Node built-ins: Electron windows created with
//! `nodeIntegration: true`, or whose preload runs unsandboxed
//! (`sandbox: false`). The main process records the grant when it creates
//! the window (`set_window_config`, a command only `electron-main` may
//! call), and a capability with the `node-*` command permissions is added
//! for that window label. The bridge and the `node_*` commands then accept
//! the window as they accept `electron-main` (still only while it shows the
//! app's own page).

use std::{collections::HashSet, sync::Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Default)]
pub struct NodeWindows {
    /// Labels allowed to use Node built-ins right now.
    granted: Mutex<HashSet<String>>,
    /// Labels a capability was added for (capabilities cannot be removed).
    capable: Mutex<HashSet<String>>,
}

impl NodeWindows {
    pub fn is_granted(&self, label: &str) -> bool {
        self.granted.lock().unwrap().contains(label)
    }

    pub fn revoke(&self, label: &str) {
        self.granted.lock().unwrap().remove(label);
    }
}

/// The `node-*` permission sets of the enabled features.
fn permissions() -> Vec<Value> {
    let mut list = Vec::new();
    if cfg!(feature = "node-fs") {
        list.push(json!("electron:node-fs"));
    }
    if cfg!(feature = "node-child-process") {
        list.push(json!("electron:node-child-process"));
    }
    if cfg!(feature = "node-net") {
        list.push(json!("electron:node-net"));
    }
    list.extend(native_module_permissions());
    list
}

/// The permission sets of the enabled native-module features (keytar,
/// better-sqlite3 / sqlite3, node-pty), which follow the `node-*` rules.
pub fn native_module_permissions() -> Vec<Value> {
    let mut list = Vec::new();
    if cfg!(feature = "keytar") {
        list.push(json!("electron:keytar"));
    }
    if cfg!(feature = "sqlite") {
        list.push(json!("electron:sqlite"));
    }
    if cfg!(feature = "pty") {
        list.push(json!("electron:pty"));
    }
    list
}

/// Let the window `label` use Node built-ins (before it is created).
pub fn grant<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let windows = app.state::<NodeWindows>();
    let first = windows.capable.lock().unwrap().insert(label.to_string());
    let permissions = permissions();
    if first && !permissions.is_empty() {
        let mut capability = json!({
            "identifier": format!("electron-node-{label}"),
            "description": "A BrowserWindow created with nodeIntegration or an unsandboxed preload: Node built-ins, like Electron gives it.",
            "windows": [label],
            "permissions": permissions,
        });
        // Also on trusted origins declared with `node: true` (trusted_origins.rs).
        let remote = crate::trusted_origins::node_patterns(app);
        if !remote.is_empty() {
            capability["remote"] = json!({ "urls": remote });
        }
        if let Err(error) = app.add_capability(capability.to_string()) {
            windows.capable.lock().unwrap().remove(label);
            return Err(error.to_string());
        }
    }
    windows.granted.lock().unwrap().insert(label.to_string());
    Ok(())
}
