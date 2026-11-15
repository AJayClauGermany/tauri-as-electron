//! BrowserWindows created from Rust (`create_window`), so that each webview
//! gets the hooks Tauri only offers on its builder: downloads
//! ([`crate::downloads`]) and permission requests ([`crate::permissions`]).
//! The options are those of Tauri's own `create_webview_window` command (a
//! `WindowConfig`, proxy included), so the window is the one JavaScript's
//! `new WebviewWindow()` would make.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::{utils::config::WindowConfig, AppHandle, Manager, Runtime, WebviewWindowBuilder};

use crate::{downloads, permissions, tls_auth, web_request};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Extras {
    /// The window's session has a permission request handler.
    permission_handler: bool,
    /// The window's session called setProxy (without a proxy: direct).
    proxy_configured: bool,
    /// The session.webRequest events the window's session listens to.
    web_request: Vec<String>,
}

/// `new BrowserWindow()`. Async: WebView2 deadlocks when a webview is
/// created from a synchronous command.
#[tauri::command]
pub async fn create_window<R: Runtime>(
    app: AppHandle<R>,
    options: WindowConfig,
    extras: Option<Extras>,
) -> Result<(), String> {
    let extras = extras.unwrap_or_default();
    let label = options.label.clone();
    app.state::<permissions::Permissions>()
        .set_handler(&label, extras.permission_handler);
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    linux_proxy::before_create(&app, &options, extras.proxy_configured);
    let builder = WebviewWindowBuilder::from_config(&app, &options).map_err(|e| e.to_string())?;
    #[cfg(not(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    let builder = builder
        .on_download(downloads::on_download)
        .on_permission_request(permissions::on_permission_request);
    let window = builder.build().map_err(|e| e.to_string())?;
    web_request::attach(&app, &window, &label, &extras.web_request);
    tls_auth::attach(&app, &window, &label);
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        let handle = app.clone();
        window
            .with_webview(move |webview| {
                let view = webview.inner();
                downloads::gtk::attach(&handle, &view, &label);
                permissions::gtk::attach(&handle, &view, &label);
            })
            .map_err(|e| e.to_string())?;
    }
    let _ = window;
    Ok(())
}

/// WebKitGTK keeps the proxy on the web context, which the windows of the
/// default data store share (the default session and `persist:`
/// partitions), so on Linux those sessions share one proxy: the last one set
/// wins for all their windows. wry sets it when a window with a proxy is
/// created and never unsets it; a window whose session chose no proxy
/// (`setProxy` to direct) puts the context back on the system settings,
/// while a window of a session that never called `setProxy` leaves it as it is.
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
mod linux_proxy {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };
    use tauri::{utils::config::WindowConfig, AppHandle, Manager, Runtime};
    use webkit2gtk::{NetworkProxyMode, WebContextExt, WebViewExt, WebsiteDataManagerExt};

    static USED: AtomicBool = AtomicBool::new(false);

    pub fn before_create<R: Runtime>(
        app: &AppHandle<R>,
        options: &WindowConfig,
        proxy_configured: bool,
    ) {
        if options.proxy_url.is_some() {
            USED.store(true, Ordering::Relaxed);
            return;
        }
        if !proxy_configured || !USED.load(Ordering::Relaxed) || options.incognito {
            return;
        }
        // Any window of the default store reaches its context: the main one.
        let Some(main) = app.get_webview_window(crate::MAIN_LABEL) else {
            return;
        };
        let (done, wait) = std::sync::mpsc::channel();
        let sent = main.with_webview(move |webview| {
            if let Some(manager) = webview
                .inner()
                .context()
                .and_then(|context| context.website_data_manager())
            {
                manager.set_network_proxy_settings(NetworkProxyMode::Default, None);
            }
            let _ = done.send(());
        });
        if sent.is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(2));
        }
    }
}

/// The session of these windows got (or lost) a permission request handler.
#[tauri::command]
pub fn permission_handler<R: Runtime>(app: AppHandle<R>, labels: Vec<String>, enabled: bool) {
    let state = app.state::<permissions::Permissions>();
    for label in labels {
        state.set_handler(&label, enabled);
    }
}

/// The handler's answer to a `tauri-electron:permission-request`.
#[tauri::command]
pub fn permission_respond<R: Runtime>(
    app: AppHandle<R>,
    id: u32,
    label: String,
    url: String,
    permission: String,
    media_types: Option<Vec<String>>,
    granted: bool,
) {
    let media: Vec<&str> = media_types.iter().flatten().map(String::as_str).collect();
    let key = permissions::decision_key(&permission, &media);
    permissions::respond(&app, id, &label, &url, &key, granted);
}

/// `webContents.downloadURL` / `session.downloadURL`: returns the item id.
#[tauri::command]
pub async fn download_url<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
    headers: Option<Vec<(String, String)>>,
    tag: Option<String>,
) -> Result<u32, Value> {
    #[cfg(feature = "net")]
    return downloads::start_http(&app, &label, &url, headers.unwrap_or_default(), tag)
        .map_err(|message| serde_json::json!({ "message": message }));
    #[cfg(not(feature = "net"))]
    {
        let _ = (app, label, url, headers, tag);
        Err(serde_json::json!({ "code": "ERR_FEATURE_DISABLED", "feature": "net" }))
    }
}

/// `item.pause()` / `resume()` / `cancel()`.
#[tauri::command]
pub fn download_control<R: Runtime>(app: AppHandle<R>, id: u32, action: String) -> bool {
    downloads::control(&app, id, &action)
}

/// Move a completed download to its save path.
#[tauri::command]
pub async fn download_commit<R: Runtime>(
    app: AppHandle<R>,
    id: u32,
    path: String,
) -> Result<String, String> {
    downloads::commit(&app, id, &path)
}

/// Drop a download's temporary file.
#[tauri::command]
pub async fn download_discard<R: Runtime>(app: AppHandle<R>, id: u32) {
    downloads::discard_item(&app, id);
}

/// The state the plugin keeps for these features.
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Arc::new(downloads::Downloads::default()));
    app.manage(permissions::Permissions::default());
}
