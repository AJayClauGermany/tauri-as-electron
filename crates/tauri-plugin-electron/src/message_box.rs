//! `dialog.showMessageBox` for what native message dialogs cannot show:
//! more than three buttons, a checkbox (`checkboxLabel`), a default button.
//! A small window renders the box from a page served by the bridge scheme
//! (`message-box/<id>`); the page reports its size and the answer back over
//! the same scheme, so it needs no IPC permission.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// What the main process asks for (already normalised by tauri-electron).
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// Chosen by the caller, so that it can close the box (`signal`).
    pub id: String,
    pub parent: Option<String>,
    pub title: String,
    #[serde(flatten)]
    pub page: Value,
}

/// `{ response, checkboxChecked }`.
pub type Answer = Value;

struct Pending {
    label: String,
    page: Value,
    cancel_id: i64,
    checkbox_checked: bool,
    parent: Option<String>,
    answer: Option<mpsc::Sender<Answer>>,
}

#[derive(Default)]
pub struct Boxes {
    next: AtomicU64,
    pending: Mutex<HashMap<String, Pending>>,
}

const PAGE: &str = include_str!("message_box.html");

impl Boxes {
    /// Send the answer once, close the window and re-enable the parent.
    fn finish<R: Runtime>(&self, app: &AppHandle<R>, id: &str, answer: Option<Answer>) {
        let Some(mut pending) = self.pending.lock().unwrap().remove(id) else {
            return;
        };
        let answer = answer.unwrap_or_else(|| {
            json!({ "response": pending.cancel_id, "checkboxChecked": pending.checkbox_checked })
        });
        if let Some(sender) = pending.answer.take() {
            let _ = sender.send(answer);
        }
        if let Some(parent) = pending
            .parent
            .as_deref()
            .and_then(|l| app.get_webview_window(l))
        {
            let _ = parent.set_enabled(true);
            let _ = parent.set_focus();
        }
        if let Some(window) = app.get_webview_window(&pending.label) {
            let _ = window.destroy();
        }
    }
}

/// Open the box; the receiver gets the answer when it closes.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    options: Options,
) -> Result<mpsc::Receiver<Answer>, String> {
    let boxes = app.state::<Boxes>();
    let id = if options.id.is_empty() {
        format!("auto-{}", boxes.next.fetch_add(1, Ordering::Relaxed))
    } else {
        options.id.clone()
    };
    let label = format!(
        "electron-message-box-{}",
        boxes.next.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = mpsc::channel();
    let parent = options
        .parent
        .clone()
        .filter(|l| app.get_webview_window(l).is_some());
    boxes.pending.lock().unwrap().insert(
        id.clone(),
        Pending {
            label: label.clone(),
            page: options.page.clone(),
            cancel_id: options.page["cancelId"].as_i64().unwrap_or(0),
            checkbox_checked: options.page["checkboxChecked"].as_bool().unwrap_or(false),
            parent: parent.clone(),
            answer: Some(sender),
        },
    );
    let path = format!("message-box/{}", percent_encode(&id));
    // Tauri serves custom schemes as http://<scheme>.localhost on Windows and Android.
    let url = if cfg!(any(windows, target_os = "android")) {
        format!("http://{}.localhost/{path}", crate::BRIDGE_SCHEME)
    } else {
        format!("{}://localhost/{path}", crate::BRIDGE_SCHEME)
    };
    let url = url.parse().map_err(|e| format!("{e}"))?;
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title(if options.title.is_empty() {
            app.package_info().name.clone()
        } else {
            options.title.clone()
        })
        .inner_size(420.0, 150.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .skip_taskbar(parent.is_some())
        .visible(false)
        .center();
    if let Some(parent) = parent.as_deref().and_then(|l| app.get_webview_window(l)) {
        builder = builder.parent(&parent).map_err(|e| e.to_string())?;
        let _ = parent.set_enabled(false);
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            boxes.finish(app, &id, None);
            return Err(error.to_string());
        }
    };
    let app_for_events = app.clone();
    let id_for_events = id.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            app_for_events
                .state::<Boxes>()
                .finish(&app_for_events, &id_for_events, None);
        }
    });
    Ok(receiver)
}

/// Close a box as if dismissed (`signal` aborted).
pub fn close<R: Runtime>(app: &AppHandle<R>, id: &str) {
    app.state::<Boxes>().finish(app, id, None);
}

fn percent_encode(input: &str) -> String {
    input
        .bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// What the bridge answers for `message-box/<id>[/<op>]`, or None (404).
/// Only the box's own window may ask.
pub fn bridge<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    path: &str,
    query: &str,
) -> Option<(String, Vec<u8>)> {
    let rest = path.strip_prefix("message-box/")?;
    let (id, op) = rest.split_once('/').unwrap_or((rest, ""));
    let boxes = app.state::<Boxes>();
    let (window_label, page) = {
        let pending = boxes.pending.lock().unwrap();
        let entry = pending.get(id)?;
        (entry.label.clone(), entry.page.clone())
    };
    if window_label != label {
        return None;
    }
    let param = |name: &str| {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
            .map(crate::percent_decode)
    };
    match op {
        "" => {
            // The options go in as JSON; `<` is escaped so text cannot end the script.
            let data = page.to_string().replace('<', "\\u003c");
            Some((
                "text/html; charset=utf-8".into(),
                PAGE.replace("__OPTIONS__", &data).into_bytes(),
            ))
        }
        "size" => {
            let width = param("w")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(420.0);
            let height = param("h")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(150.0);
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.set_size(tauri::LogicalSize::new(
                    width.clamp(320.0, 900.0),
                    height.clamp(100.0, 800.0),
                ));
                let _ = window.center();
                let _ = window.show();
                let _ = window.set_focus();
            }
            Some(("application/json".into(), b"null".to_vec()))
        }
        "result" => {
            let response = param("response")
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            let checked = param("checked").is_some_and(|v| v == "true");
            boxes.finish(
                app,
                id,
                Some(json!({ "response": response, "checkboxChecked": checked })),
            );
            Some(("application/json".into(), b"null".to_vec()))
        }
        _ => None,
    }
}
