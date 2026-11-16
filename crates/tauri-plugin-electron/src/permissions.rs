//! `session.setPermissionRequestHandler` applied to BrowserWindows.
//!
//! - **Linux**: WebKitGTK's `permission-request` signal of each window's
//!   webview. A request is held while the main process runs the handler and
//!   answered when its callback is called, as in Electron.
//! - **Windows / macOS**: Tauri's `on_permission_request`, which must answer
//!   synchronously on the main thread (where the main process' answer would
//!   arrive), so it answers from decisions the handler made earlier for the
//!   same window, origin and permission. The first request of each kind gets
//!   the platform's default (WebView2 / WebKit prompt) while the handler runs;
//!   its answer applies to the requests that follow.
//!
//! Without a handler, every permission is granted, which is Electron's
//! default.
//!
//! Requests reach the main window as `tauri-electron:permission-request`
//! `{ id, label, permission, mediaTypes, url }`; `permission_respond`
//! answers them.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::MAIN_LABEL;

pub const EVENT: &str = "tauri-electron:permission-request";

#[derive(Default)]
pub struct Permissions {
    next_id: AtomicU32,
    /// Windows whose session has a request handler.
    handlers: Mutex<HashMap<String, bool>>,
    /// (label, origin, permission) → granted. Windows / macOS only.
    #[allow(dead_code)]
    decisions: Mutex<HashMap<(String, String, String), bool>>,
    /// The page each window shows (from page loads), for the origin.
    #[allow(dead_code)]
    urls: Mutex<HashMap<String, String>>,
}

impl Permissions {
    /// Whether `label`'s session has a handler; clears what it decided before.
    pub fn set_handler(&self, label: &str, has_handler: bool) {
        self.handlers
            .lock()
            .unwrap()
            .insert(label.to_string(), has_handler);
        self.decisions
            .lock()
            .unwrap()
            .retain(|(l, _, _), _| l != label);
    }

    fn has_handler(&self, label: &str) -> bool {
        self.handlers
            .lock()
            .unwrap()
            .get(label)
            .copied()
            .unwrap_or(false)
    }

    pub fn page_loaded(&self, label: &str, url: &str) {
        self.urls
            .lock()
            .unwrap()
            .insert(label.to_string(), url.to_string());
    }

    #[allow(dead_code)]
    fn remember(&self, label: &str, origin: &str, permission: &str, granted: bool) {
        self.decisions.lock().unwrap().insert(
            (
                label.to_string(),
                origin.to_string(),
                permission.to_string(),
            ),
            granted,
        );
    }
}

/// What a remembered decision is for: the permission and, for `media`, the
/// device types (a camera grant must not answer for the microphone).
pub fn decision_key(permission: &str, media: &[&str]) -> String {
    if media.is_empty() {
        return permission.to_string();
    }
    let mut media = media.to_vec();
    media.sort_unstable();
    format!("{permission}:{}", media.join(","))
}

#[allow(dead_code)]
fn origin(url: &str) -> String {
    tauri::Url::parse(url)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default()
}

fn emit_request<R: Runtime>(
    app: &AppHandle<R>,
    id: u32,
    label: &str,
    permission: &str,
    media: &[&str],
    url: &str,
) -> bool {
    app.emit_to(
        MAIN_LABEL,
        EVENT,
        json!({ "id": id, "label": label, "permission": permission, "mediaTypes": media, "url": url }),
    )
    .is_ok()
}

// --- Windows / macOS: Tauri's synchronous hook ------------------------------------------------

/// Electron's name (and media types) for a Tauri permission kind.
#[allow(dead_code)]
pub fn electron_name(
    kind: tauri::webview::PermissionKind,
) -> (&'static str, &'static [&'static str]) {
    use tauri::webview::PermissionKind as K;
    match kind {
        K::Microphone => ("media", &["audio"]),
        K::Camera => ("media", &["video"]),
        K::Geolocation => ("geolocation", &[]),
        K::Notifications => ("notifications", &[]),
        K::ClipboardRead => ("clipboard-read", &[]),
        K::DisplayCapture => ("display-capture", &[]),
        K::Midi => ("midiSysex", &[]),
        K::Sensors => ("sensors", &[]),
        K::MediaKeySystemAccess => ("mediaKeySystem", &[]),
        K::LocalFonts => ("local-fonts", &[]),
        K::WindowManagement => ("window-management", &[]),
        K::PointerLock => ("pointerLock", &[]),
        K::AutomaticDownloads => ("automatic-downloads", &[]),
        K::FileSystemAccess => ("fileSystem", &[]),
        K::Autoplay => ("autoplay", &[]),
        _ => ("unknown", &[]),
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
pub fn on_permission_request<R: Runtime>(
    webview: tauri::Webview<R>,
    kind: tauri::webview::PermissionKind,
) -> tauri::webview::PermissionResponse {
    use tauri::webview::PermissionResponse;
    let app = webview.app_handle().clone();
    let state = app.state::<Permissions>();
    let label = webview.label().to_string();
    if !state.has_handler(&label) {
        return PermissionResponse::Allow;
    }
    let (permission, media) = electron_name(kind);
    let url = state
        .urls
        .lock()
        .unwrap()
        .get(&label)
        .cloned()
        .unwrap_or_default();
    let key = (label.clone(), origin(&url), decision_key(permission, media));
    if let Some(granted) = state.decisions.lock().unwrap().get(&key).copied() {
        return if granted {
            PermissionResponse::Allow
        } else {
            PermissionResponse::Deny
        };
    }
    // id 0: nothing waits for the answer; it is remembered for next time.
    emit_request(&app, 0, &label, permission, media, &url);
    PermissionResponse::Default
}

// --- Linux: WebKitGTK, answered asynchronously --------------------------------------------------

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
pub mod gtk {
    use super::*;
    use std::cell::RefCell;
    use webkit2gtk::{
        glib::prelude::*, DeviceInfoPermissionRequest, GeolocationPermissionRequest,
        MediaKeySystemPermissionRequest, NotificationPermissionRequest, PermissionRequest,
        PermissionRequestExt, PointerLockPermissionRequest, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebView, WebViewExt, WebsiteDataAccessPermissionRequest,
    };

    thread_local! {
        static PENDING: RefCell<HashMap<u32, PermissionRequest>> = RefCell::new(HashMap::new());
    }

    fn classify(request: &PermissionRequest) -> (&'static str, Vec<&'static str>) {
        if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
            // getDisplayMedia (C9): answered by the display media handler.
            if crate::display_media::gtk::is_display(media) {
                let audio = media.is_for_audio_device().then_some("audio");
                return (
                    "display-capture",
                    ["video"].into_iter().chain(audio).collect(),
                );
            }
            let mut types = Vec::new();
            if media.is_for_audio_device() {
                types.push("audio");
            }
            if media.is_for_video_device() {
                types.push("video");
            }
            return ("media", types);
        }
        let name = if request.is::<GeolocationPermissionRequest>() {
            "geolocation"
        } else if request.is::<NotificationPermissionRequest>() {
            "notifications"
        } else if request.is::<PointerLockPermissionRequest>() {
            "pointerLock"
        } else if request.is::<DeviceInfoPermissionRequest>() {
            "speaker-selection"
        } else if request.is::<MediaKeySystemPermissionRequest>() {
            "mediaKeySystem"
        } else if request.is::<WebsiteDataAccessPermissionRequest>() {
            "storage-access"
        } else {
            "unknown"
        };
        (name, Vec::new())
    }

    /// Called on the main thread for each webview `create_window` makes.
    pub fn attach<R: Runtime>(app: &AppHandle<R>, view: &WebView, label: &str) {
        let app = app.clone();
        let label = label.to_string();
        view.connect_permission_request(move |view, request| {
            let state = app.state::<Permissions>();
            let (permission, media) = classify(request);
            // Screen capture always asks the main process (setDisplayMediaRequestHandler).
            if !state.has_handler(&label) && permission != "display-capture" {
                request.allow();
                return true;
            }
            let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
            let url = view.uri().map(|u| u.to_string()).unwrap_or_default();
            PENDING.with(|p| p.borrow_mut().insert(id, request.clone()));
            if !emit_request(&app, id, &label, permission, &media, &url) {
                PENDING.with(|p| p.borrow_mut().remove(&id));
                request.deny();
            }
            true
        });
    }

    pub fn answer(id: u32, granted: bool) {
        if let Some(request) = PENDING.with(|p| p.borrow_mut().remove(&id)) {
            if granted {
                request.allow();
            } else {
                request.deny();
            }
        }
    }
}

/// The main process' answer to a request.
pub fn respond<R: Runtime>(
    app: &AppHandle<R>,
    id: u32,
    label: &str,
    url: &str,
    permission: &str,
    granted: bool,
) {
    if id == 0 {
        app.state::<Permissions>()
            .remember(label, &origin(url), permission, granted);
        return;
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    let _ = app.run_on_main_thread(move || gtk::answer(id, granted));
    #[cfg(windows)]
    let _ = app.run_on_main_thread(move || crate::display_media::answer(id, granted));
    let _ = (label, url, permission);
}
