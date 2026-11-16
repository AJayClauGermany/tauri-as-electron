//! npm packages with native code that Electron apps load in the main process,
//! re-implemented in Rust behind the bundler plugins' module aliases
//! (`tauri-electron/keytar`, `/better-sqlite3`, `/sqlite3`, `/node-pty`):
//!
//! - **keytar** (feature `keytar`, [`keytar`]): the OS keychain, through the
//!   items keytar itself writes, so an app's existing entries are found.
//!   Promise-based: the `keytar` command.
//! - **better-sqlite3** and **sqlite3** (feature `sqlite`, [`sqlite`]):
//!   rusqlite with a handle table. better-sqlite3 is synchronous: the bridge's
//!   `node/sqlite/<op>`; sqlite3's callbacks and `backup()` use the `sqlite`
//!   command, which runs the same operations off the main thread.
//! - **node-pty** (feature `pty`, [`pty`]): portable-pty. `spawn` is
//!   synchronous over the bridge (`node/pty/spawn`, so `pid` is known at
//!   once), the output streams over a Channel (`pty_attach`), and
//!   `pty_control` writes, resizes, signals and pauses.
//!
//! Like the Node built-ins, they answer the main window and windows created
//! with `nodeIntegration` / `sandbox: false` only (`node_refusal`). What a page
//! opened (databases, terminals) is closed when the page is replaced or its
//! window closes, as a restarted Node process starts with nothing open.

// The error payloads sent to JavaScript are JSON values.
#![allow(clippy::result_large_err)]

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
};

use serde_json::{json, Value};
use tauri::{ipc::Channel, Manager, Runtime, UriSchemeResponder};

#[cfg(feature = "keytar")]
mod keytar;
#[cfg(feature = "pty")]
mod pty;
#[cfg(feature = "sqlite")]
mod sqlite;

// --- lifetimes: what a page opened ------------------------------------------------------------

static NEXT_STAMP: AtomicU64 = AtomicU64::new(1);

/// A stamp later than every one taken before.
fn stamp() -> u64 {
    NEXT_STAMP.fetch_add(1, Ordering::Relaxed)
}

/// Per label: the page load under way (stamp, URL), and the URL shown.
#[derive(Default)]
struct Loads {
    started: HashMap<String, (u64, String)>,
    shown: HashMap<String, String>,
}

static LOADS: LazyLock<Mutex<Loads>> = LazyLock::new(Default::default);

/// A page load started in `label`.
pub fn page_started(label: &str, url: &str) {
    LOADS
        .lock()
        .unwrap()
        .started
        .insert(label.to_string(), (stamp(), url.to_string()));
}

/// A page load finished: what the previous page opened is closed, unless the
/// load ended back on the page already shown (a cancelled navigation, a link
/// that became a download), as `node_fs` decides for files.
pub fn page_finished(label: &str, url: &str) {
    let stamp = {
        let mut loads = LOADS.lock().unwrap();
        let load = loads.started.remove(label);
        let shown = loads.shown.insert(label.to_string(), url.to_string());
        match load {
            Some((_, started)) if started != url && shown.as_deref() == Some(url) => None,
            Some((stamp, _)) => Some(stamp),
            None => None,
        }
    };
    if let Some(stamp) = stamp {
        close_owned_before(label, stamp);
    }
}

/// The window closed: everything its pages opened.
pub fn window_closed(label: &str) {
    {
        let mut loads = LOADS.lock().unwrap();
        loads.started.remove(label);
        loads.shown.remove(label);
    }
    close_owned_before(label, u64::MAX);
}

fn close_owned_before(label: &str, stamp: u64) {
    #[cfg(feature = "sqlite")]
    sqlite::close_owned_before(label, stamp);
    #[cfg(feature = "pty")]
    pty::close_owned_before(label, stamp);
    let _ = (label, stamp);
}

// --- errors ------------------------------------------------------------------------------------

#[cfg_attr(
    all(feature = "keytar", feature = "sqlite", feature = "pty"),
    allow(dead_code)
)]
fn disabled(feature: &str) -> Value {
    json!({ "code": "ERR_FEATURE_DISABLED", "feature": feature })
}

fn internal(error: impl std::fmt::Display) -> Value {
    json!({ "code": "ERR_INTERNAL", "message": error.to_string() })
}

/// What a bridge or command call answers with.
#[cfg_attr(not(feature = "sqlite"), allow(dead_code))]
pub enum Output {
    Json(Value),
    Bytes(Vec<u8>),
}

fn respond(responder: UriSchemeResponder, result: Result<Output, Value>) {
    match result {
        Ok(Output::Json(value)) => crate::respond_json(responder, 200, &value),
        Ok(Output::Bytes(bytes)) => {
            crate::respond(responder, 200, "application/octet-stream", bytes)
        }
        Err(error) => {
            let status = if error["code"] == "ERR_FEATURE_DISABLED" {
                501
            } else {
                400
            };
            crate::respond_json(responder, status, &error)
        }
    }
}

/// `node/sqlite/<op>` and `node/pty/<op>` on the synchronous bridge, after
/// `handle_node` checked the caller. The body is the JSON request. Runs on a
/// thread of its own (the scheme handler runs on the main thread).
pub fn bridge(label: &str, module: &str, op: &str, body: Vec<u8>, responder: UriSchemeResponder) {
    let request: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(error) => {
                return respond(
                    responder,
                    Err(json!({ "code": "ERR_INVALID_ARG_VALUE", "message": error.to_string() })),
                )
            }
        }
    };
    let (owner, module, op) = (label.to_string(), module.to_string(), op.to_string());
    std::thread::spawn(move || {
        let result = match module.as_str() {
            "sqlite" => run_sqlite(&owner, &op, &request),
            "pty" => run_pty(&owner, &op, &request),
            _ => Err(json!({ "code": "ERR_UNKNOWN_MODULE", "message": module })),
        };
        respond(responder, result)
    });
}

fn run_sqlite(owner: &str, op: &str, request: &Value) -> Result<Output, Value> {
    #[cfg(feature = "sqlite")]
    return sqlite::run(owner, op, request, stamp);
    #[cfg(not(feature = "sqlite"))]
    {
        let _ = (owner, op, request);
        Err(disabled("sqlite"))
    }
}

fn run_pty(owner: &str, op: &str, request: &Value) -> Result<Output, Value> {
    #[cfg(feature = "pty")]
    return pty::run(owner, op, request, stamp).map(Output::Json);
    #[cfg(not(feature = "pty"))]
    {
        let _ = (owner, op, request);
        Err(disabled("pty"))
    }
}

fn refused<R: Runtime>(webview: &tauri::Webview<R>) -> Result<(), Value> {
    match crate::node_refusal(webview.app_handle(), webview.label()) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
}

// --- commands ----------------------------------------------------------------------------------

/// keytar's functions: `{ op: "get" | "set" | "delete" | "find" | "findOne",
/// service, account?, password? }`. Off the main thread: the keychain may
/// prompt the user.
#[tauri::command]
pub async fn keytar<R: Runtime>(
    webview: tauri::Webview<R>,
    request: Value,
) -> Result<Value, Value> {
    refused(&webview)?;
    #[cfg(feature = "keytar")]
    {
        tauri::async_runtime::spawn_blocking(move || keytar::run(&request))
            .await
            .map_err(internal)?
    }
    #[cfg(not(feature = "keytar"))]
    {
        let _ = request;
        Err(disabled("keytar"))
    }
}

/// The asynchronous side of `node/sqlite/<op>` (node-sqlite3's API,
/// better-sqlite3's `backup()`): `{ op, ... }`, answered with JSON, or raw
/// bytes for `serialize`.
#[tauri::command]
pub async fn sqlite<R: Runtime>(
    webview: tauri::Webview<R>,
    request: Value,
) -> Result<tauri::ipc::Response, Value> {
    refused(&webview)?;
    let owner = webview.label().to_string();
    let op = request["op"].as_str().unwrap_or_default().to_string();
    let result = tauri::async_runtime::spawn_blocking(move || run_sqlite(&owner, &op, &request))
        .await
        .map_err(internal)?;
    match result? {
        Output::Json(value) => Ok(tauri::ipc::Response::new(value.to_string().into_bytes())),
        Output::Bytes(bytes) => Ok(tauri::ipc::Response::new(bytes)),
    }
}

/// Send the output and exit of the terminal `id` (created by the bridge's
/// `node/pty/spawn`) to `on_event`; what came before is replayed first.
/// False when it is gone.
#[tauri::command]
pub fn pty_attach<R: Runtime>(
    webview: tauri::Webview<R>,
    id: u32,
    on_event: Channel<Value>,
) -> Result<bool, Value> {
    refused(&webview)?;
    #[cfg(feature = "pty")]
    return Ok(pty::attach(webview.label(), id, on_event));
    #[cfg(not(feature = "pty"))]
    {
        let _ = (id, on_event);
        Err(disabled("pty"))
    }
}

/// `write` (`data`, base64), `resize` (`cols`, `rows`), `kill` (`signal`),
/// `pause`, `resume` and `clear` on the terminal `id`.
#[tauri::command]
pub async fn pty_control<R: Runtime>(
    webview: tauri::Webview<R>,
    id: u32,
    op: String,
    args: Option<Value>,
) -> Result<Value, Value> {
    refused(&webview)?;
    #[cfg(feature = "pty")]
    return pty::control(webview.label(), id, &op, &args.unwrap_or(Value::Null));
    #[cfg(not(feature = "pty"))]
    {
        let _ = (id, op, args);
        Err(disabled("pty"))
    }
}
