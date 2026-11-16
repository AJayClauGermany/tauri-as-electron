//! Screen sharing in BrowserWindows (roadmap C9): `getDisplayMedia()` and
//! `session.setDisplayMediaRequestHandler`.
//!
//! A page's screen-capture request reaches the main process as a
//! `tauri-electron:permission-request` with permission `display-capture`
//! (the permission plumbing of `permissions.rs`) and is answered with
//! `permission_respond`; tauri-electron decides with the session's display
//! media handler (src/main/display-media.js).
//!
//! - **Linux (WebKitGTK)**: windows and views get WebKit's media-stream and WebRTC
//!   settings (off by default in WebKitGTK, always on in Electron); the
//!   request is WebKitGTK's `UserMediaPermissionRequest` for a display device
//!   (held until the handler answers). The source is then chosen in the
//!   desktop portal's picker (xdg-desktop-portal ScreenCast with PipeWire):
//!   without a portal, granted requests fail in the page.
//! - **Windows (WebView2)**: `ScreenCaptureStarting` (`ICoreWebView2_27`;
//!   older runtimes show their picker without asking), deferred until the
//!   handler answers; WebView2's own picker chooses the source.
//! - **macOS (WKWebView)**: no hook. WebKit asks the user and shows the
//!   system picker; the handler is not called.

use tauri::{AppHandle, Runtime, Webview};

/// Set (to anything but `0`) to give BrowserWindows WebKitGTK's mock capture
/// devices instead of the real ones (Linux; for tests).
#[allow(dead_code)]
pub const MOCK_CAPTURE_ENV: &str = "TAURI_ELECTRON_MOCK_CAPTURE";

/// Called for each window `create_window` makes and each view (`views.rs`).
#[allow(unused_variables)]
pub fn attach<R: Runtime>(app: &AppHandle<R>, window: &Webview<R>, label: &str) {
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    let _ = window.with_webview(|webview| gtk::enable_media(&webview.inner()));
    #[cfg(windows)]
    webview2::attach(app, window, label);
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
pub mod gtk {
    use webkit2gtk::{
        glib::translate::ToGlibPtr, SettingsExt, UserMediaPermissionRequest, WebViewExt,
    };

    /// `navigator.mediaDevices` (getUserMedia, getDisplayMedia) and
    /// `RTCPeerConnection`, as every Electron page has them.
    pub fn enable_media(view: &webkit2gtk::WebView) {
        if let Some(settings) = WebViewExt::settings(view) {
            settings.set_enable_media_stream(true);
            settings.set_enable_webrtc(true);
            // For automated tests without a desktop portal or devices: WebKit's
            // mock screens, cameras and microphones.
            if std::env::var_os(super::MOCK_CAPTURE_ENV).is_some_and(|v| !v.is_empty() && v != "0")
            {
                settings.set_enable_mock_capture_devices(true);
            }
        }
    }

    /// Whether a media request is for a screen or window (getDisplayMedia).
    pub fn is_display(request: &UserMediaPermissionRequest) -> bool {
        unsafe {
            webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(
                request.to_glib_none().0,
            ) != 0
        }
    }
}

#[cfg(windows)]
mod webview2 {
    use std::{
        cell::RefCell,
        collections::HashMap,
        sync::atomic::{AtomicU32, Ordering},
    };

    use serde_json::json;
    use tauri::{AppHandle, Emitter, Runtime, Webview};
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Deferral, ICoreWebView2ScreenCaptureStartingEventArgs, ICoreWebView2_27,
        },
        ScreenCaptureStartingEventHandler,
    };
    use windows::core::Interface;

    static NEXT_ID: AtomicU32 = AtomicU32::new(0);

    thread_local! {
        static PENDING: RefCell<HashMap<u32, (ICoreWebView2ScreenCaptureStartingEventArgs, ICoreWebView2Deferral)>> =
            RefCell::new(HashMap::new());
    }

    pub fn attach<R: Runtime>(app: &AppHandle<R>, window: &Webview<R>, label: &str) {
        let app = app.clone();
        let label = label.to_string();
        let _ = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            // Older WebView2 runtimes have no ScreenCaptureStarting: their picker decides.
            let Ok(core27) = core.cast::<ICoreWebView2_27>() else {
                return;
            };
            let handler = ScreenCaptureStartingEventHandler::create(Box::new(move |sender, args| {
                let Some(args) = args else { return Ok(()) };
                let url = sender
                    .and_then(|core| {
                        let mut source = windows::core::PWSTR::null();
                        core.Source(&mut source).ok()?;
                        let url = source.to_string().ok();
                        windows::Win32::System::Com::CoTaskMemFree(Some(source.0 as _));
                        url
                    })
                    .unwrap_or_default();
                let deferral = args.GetDeferral()?;
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed) + 1;
                PENDING.with(|p| p.borrow_mut().insert(id, (args, deferral)));
                let sent = app.emit_to(
                    crate::MAIN_LABEL,
                    crate::permissions::EVENT,
                    json!({ "id": id, "label": label, "permission": "display-capture", "mediaTypes": ["video"], "url": url }),
                );
                if sent.is_err() {
                    answer(id, false);
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core27.add_ScreenCaptureStarting(&handler, &mut token);
        });
    }

    /// The handler's answer (on the main thread).
    pub fn answer(id: u32, granted: bool) {
        if let Some((args, deferral)) = PENDING.with(|p| p.borrow_mut().remove(&id)) {
            unsafe {
                if !granted {
                    let _ = args.SetCancel(true);
                }
                let _ = deferral.Complete();
            }
        }
    }
}

#[cfg(windows)]
pub use webview2::answer;
