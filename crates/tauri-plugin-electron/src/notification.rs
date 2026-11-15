//! Electron's main-process `Notification` events on desktop: `click`,
//! `action` and (Linux) `close`, through tauri-plugin-notification's Rust API.
//!
//! The plugin reports what the user does with a notification only to
//! handlers registered with `on_action`; JavaScript listeners would have to
//! live in the page that showed it. Notifications shown here carry their
//! buttons as an action type, and one Rust handler forwards every action to
//! the main process as `tauri-electron:notification`.

use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

use crate::MAIN_LABEL;

const EVENT: &str = "tauri-electron:notification";

/// What `new Notification(options).show()` sends.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    id: i32,
    title: String,
    body: String,
    icon: Option<String>,
    silent: bool,
    /// Button labels; reported back by index.
    actions: Vec<String>,
}

/// The action types registered so far (one per distinct set of buttons).
#[derive(Default)]
pub struct State {
    handler: OnceLock<()>,
    action_types: Mutex<HashSet<String>>,
}

fn action_type_id(labels: &[String]) -> String {
    format!("tauri-electron:{}", labels.join("\u{1f}"))
}

/// Forward every action on a notification to the main process, once.
fn install_handler<R: Runtime>(app: &AppHandle<R>, state: &State) {
    state.handler.get_or_init(|| {
        let app = app.clone();
        let _ = app.clone().notification().on_action(move |performed| {
            let Some(id) = performed.notification().map(|n| n.id()) else {
                return;
            };
            let action = performed.action_id();
            let payload = if action == "tap" {
                json!({ "id": id, "event": "click" })
            } else {
                // Buttons are identified by index; macOS reports their title instead.
                json!({ "id": id, "event": "action", "action": action })
            };
            let _ = app.emit_to(MAIN_LABEL, EVENT, payload);
        });
    });
}

/// Show a notification whose clicks, buttons and (Linux) closing are reported.
pub fn show<R: Runtime>(app: &AppHandle<R>, state: &State, options: Options) -> Result<(), String> {
    install_handler(app, state);
    let notifications = app.notification();
    let mut builder = notifications.builder().id(options.id).title(options.title);
    if !options.body.is_empty() {
        builder = builder.body(options.body);
    }
    if let Some(icon) = options.icon {
        builder = builder.icon(icon);
    }
    if !options.silent {
        builder = builder.sound("default");
    }
    if !options.actions.is_empty() {
        let type_id = action_type_id(&options.actions);
        let mut registered = state.action_types.lock().unwrap();
        if registered.insert(type_id.clone()) {
            let actions = options
                .actions
                .iter()
                .enumerate()
                .map(|(index, label)| Action::builder(index.to_string(), label).build())
                .collect();
            notifications
                .register_action_types(vec![ActionType::builder(&type_id).actions(actions).build()])
                .map_err(|e| e.to_string())?;
        }
        builder = builder.action_type_id(type_id);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let app = app.clone();
        let id = options.id;
        builder = builder.on_close(move || {
            let _ = app.emit_to(MAIN_LABEL, EVENT, json!({ "id": id, "event": "close" }));
        });
    }
    builder.show().map_err(|e| e.to_string())
}

/// `notification.close()`: removes it from the screen (Linux; elsewhere
/// notify-rust cannot remove a shown notification).
pub fn close<R: Runtime>(app: &AppHandle<R>, id: i32) -> Result<(), String> {
    app.notification()
        .remove_active(vec![id])
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_types_are_shared_by_identical_buttons() {
        let a = action_type_id(&["Reply".into(), "Snooze".into()]);
        assert_eq!(a, action_type_id(&["Reply".into(), "Snooze".into()]));
        assert_ne!(a, action_type_id(&["Reply Snooze".into()]));
    }
}
