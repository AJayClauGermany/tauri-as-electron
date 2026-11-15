//! Downloads: `session.on('will-download')`, `DownloadItem`,
//! `webContents.downloadURL` and `session.downloadURL`.
//!
//! Every download is written to a temporary file first; the main process
//! moves it to the item's save path when it is done (`download_commit`).
//! That is how `item.setSavePath()` works although the webview decides the
//! destination synchronously, before JavaScript has seen the download: the
//! Rust hooks cannot wait for the main process (they run on the main thread,
//! which delivers its answer).
//!
//! - Downloads a page starts (links with `download`, `Content-Disposition:
//!   attachment`): on Linux through WebKitGTK's `download-started` signal on
//!   each web context (progress, sizes, MIME type and cancellation from
//!   `WebKitDownload`); on Windows and macOS through Tauri's `on_download`
//!   hook (progress from the size of the temporary file, no cancellation of
//!   the transfer itself: a cancelled item's file is discarded).
//! - `downloadURL`: an HTTP transfer in Rust (reqwest, from the `net`
//!   feature) with the window's cookies for the URL, so pause, resume and
//!   cancel are real and the total size is known.
//!
//! Events go to the main window as `tauri-electron:download` with `event`
//! `started`, `progress` or `done`.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::MAIN_LABEL;

pub const EVENT: &str = "tauri-electron:download";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct Downloads {
    next_id: AtomicU32,
    items: Mutex<HashMap<u32, Item>>,
    /// Page downloads on Windows / macOS, by URL: `on_download`'s `Finished`
    /// names the URL, not the download.
    #[allow(dead_code)]
    by_url: Mutex<HashMap<(String, String), Vec<u32>>>,
}

struct Item {
    temp: PathBuf,
    control: Arc<Control>,
}

/// What `pause` / `resume` / `cancel` act on.
#[derive(Default)]
struct Control {
    cancelled: AtomicBool,
    paused: AtomicBool,
    finished: AtomicBool,
    #[cfg_attr(not(feature = "net"), allow(dead_code))]
    received: AtomicU64,
    /// Only HTTP transfers can pause.
    http: bool,
}

/// A file name that is safe as the last component of a path.
fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim().trim_matches('.').to_string();
    if name.is_empty() {
        "download".into()
    } else {
        name
    }
}

/// The file name a URL suggests (its last path segment), as Chromium does
/// without a `Content-Disposition` header.
#[cfg_attr(not(feature = "net"), allow(dead_code))]
pub fn name_from_url(url: &str) -> String {
    let path = tauri::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|mut s| s.next_back().map(String::from))
        })
        .unwrap_or_default();
    safe_name(&crate::percent_decode(&path))
}

/// `filename="x"` / `filename*=UTF-8''x` of a `Content-Disposition` header.
#[cfg_attr(not(feature = "net"), allow(dead_code))]
pub fn name_from_disposition(header: &str) -> Option<String> {
    let mut plain = None;
    for part in header.split(';').map(str::trim) {
        if let Some(value) = part.strip_prefix("filename*=") {
            let value = value.trim_matches('"');
            let encoded = value.splitn(3, '\'').nth(2).unwrap_or(value);
            return Some(safe_name(&crate::percent_decode(encoded)));
        }
        if let Some(value) = part.strip_prefix("filename=") {
            plain = Some(safe_name(value.trim_matches('"')));
        }
    }
    plain
}

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("tauri-electron-downloads")
}

impl Downloads {
    /// A new item writing to a fresh temporary file.
    fn begin(&self, filename: &str, http: bool) -> (u32, PathBuf, Arc<Control>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let dir = temp_dir().join(format!("{}-{id}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let temp = dir.join(safe_name(filename));
        let control = Arc::new(Control {
            http,
            ..Control::default()
        });
        self.items.lock().unwrap().insert(
            id,
            Item {
                temp: temp.clone(),
                control: control.clone(),
            },
        );
        (id, temp, control)
    }

    fn control(&self, id: u32) -> Option<Arc<Control>> {
        self.items
            .lock()
            .unwrap()
            .get(&id)
            .map(|i| i.control.clone())
    }

    fn remove(&self, id: u32) -> Option<Item> {
        self.items.lock().unwrap().remove(&id)
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    let _ = app.emit_to(MAIN_LABEL, EVENT, payload);
}

#[allow(clippy::too_many_arguments)]
fn emit_started<R: Runtime>(
    app: &AppHandle<R>,
    id: u32,
    label: &str,
    tag: Option<&str>,
    url: &str,
    filename: &str,
    mime_type: &str,
    total: u64,
    can_pause: bool,
) {
    emit(
        app,
        json!({
            "event": "started", "id": id, "label": label, "tag": tag, "url": url,
            "filename": filename, "mimeType": mime_type, "totalBytes": total, "canPause": can_pause,
        }),
    );
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, id: u32, received: u64, total: u64) {
    emit(
        app,
        json!({ "event": "progress", "id": id, "receivedBytes": received, "totalBytes": total }),
    );
}

/// `state`: completed, interrupted or cancelled.
fn emit_done<R: Runtime>(app: &AppHandle<R>, id: u32, state: &str, received: u64, total: u64) {
    emit(
        app,
        json!({ "event": "done", "id": id, "state": state, "receivedBytes": received, "totalBytes": total }),
    );
}

fn discard(path: &Path) {
    let _ = std::fs::remove_file(path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir);
    }
}

// --- downloadURL: an HTTP transfer in Rust --------------------------------------------------

#[cfg(feature = "net")]
pub fn start_http<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: &str,
    headers: Vec<(String, String)>,
    tag: Option<String>,
) -> Result<u32, String> {
    use tauri_plugin_http::reqwest;
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "downloadURL supports http(s) URLs, not '{}:'",
            parsed.scheme()
        ));
    }
    // The session's cookies for the URL, as a browser download would send them.
    let cookie = app
        .get_webview_window(label)
        .and_then(|w| w.cookies_for_url(parsed.clone()).ok())
        .map(|cookies| {
            cookies
                .iter()
                .map(|c| format!("{}={}", c.name(), c.value()))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|c| !c.is_empty());

    let downloads = app.state::<Arc<Downloads>>().inner().clone();
    let (id, temp, control) = downloads.begin(&name_from_url(url), true);
    let app = app.clone();
    let label = label.to_string();
    let url = url.to_string();
    std::thread::spawn(move || {
        let started = AtomicBool::new(false);
        let result: Result<(u64, u64), String> = tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder()
                .build()
                .map_err(|e| e.to_string())?;
            let mut request = client.get(parsed);
            for (name, value) in &headers {
                request = request.header(name, value);
            }
            if let Some(cookie) = &cookie {
                if !headers
                    .iter()
                    .any(|(n, _)| n.eq_ignore_ascii_case("cookie"))
                {
                    request = request.header("cookie", cookie);
                }
            }
            let mut response = request.send().await.map_err(|e| e.to_string())?;
            let total = response.content_length().unwrap_or(0);
            let mime = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
                .unwrap_or_default();
            let filename = response
                .headers()
                .get("content-disposition")
                .and_then(|v| v.to_str().ok())
                .and_then(name_from_disposition)
                .unwrap_or_else(|| name_from_url(&url));
            emit_started(
                &app,
                id,
                &label,
                tag.as_deref(),
                &url,
                &filename,
                &mime,
                total,
                true,
            );
            started.store(true, Ordering::Relaxed);
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
            let mut last = Instant::now();
            let mut received = 0u64;
            loop {
                while control.paused.load(Ordering::Relaxed)
                    && !control.cancelled.load(Ordering::Relaxed)
                {
                    std::thread::sleep(Duration::from_millis(100));
                }
                if control.cancelled.load(Ordering::Relaxed) {
                    return Ok((received, total));
                }
                match response.chunk().await.map_err(|e| e.to_string())? {
                    Some(chunk) => {
                        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                        received += chunk.len() as u64;
                        control.received.store(received, Ordering::Relaxed);
                        if last.elapsed() >= PROGRESS_INTERVAL {
                            last = Instant::now();
                            emit_progress(&app, id, received, total);
                        }
                    }
                    None => break,
                }
            }
            std::io::Write::flush(&mut file).map_err(|e| e.to_string())?;
            Ok((received, total))
        });
        control.finished.store(true, Ordering::Relaxed);
        match result {
            Ok((received, total)) if control.cancelled.load(Ordering::Relaxed) => {
                discard(&temp);
                downloads.remove(id);
                emit_done(&app, id, "cancelled", received, total);
            }
            Ok((received, total)) => emit_done(&app, id, "completed", received, total),
            Err(error) => {
                log_error(&error);
                discard(&temp);
                downloads.remove(id);
                let received = control.received.load(Ordering::Relaxed);
                // A failure before the response: the item still starts (so
                // the app sees it fail), marked failed so no save dialog asks.
                if !started.load(Ordering::Relaxed) {
                    emit(
                        &app,
                        json!({
                            "event": "started", "id": id, "label": label, "tag": tag, "url": url,
                            "filename": name_from_url(&url), "mimeType": "", "totalBytes": 0,
                            "canPause": false, "failed": true,
                        }),
                    );
                }
                emit_done(&app, id, "interrupted", received, 0);
            }
        }
    });
    Ok(id)
}

#[cfg(feature = "net")]
fn log_error(error: &str) {
    eprintln!("[tauri-plugin-electron] download failed: {error}");
}

// --- page downloads on Windows and macOS (Tauri's on_download) -------------------------------

/// The `on_download` hook of windows created by `create_window`.
#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
pub fn on_download<R: Runtime>(
    webview: tauri::Webview<R>,
    event: tauri::webview::DownloadEvent<'_>,
) -> bool {
    use tauri::webview::DownloadEvent;
    let app = webview.app_handle().clone();
    let downloads = app.state::<Arc<Downloads>>().inner().clone();
    let label = webview.label().to_string();
    match event {
        DownloadEvent::Requested { url, destination } => {
            let filename = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| name_from_url(url.as_str()));
            let (id, temp, control) = downloads.begin(&filename, false);
            *destination = temp.clone();
            downloads
                .by_url
                .lock()
                .unwrap()
                .entry((label.clone(), url.to_string()))
                .or_default()
                .push(id);
            emit_started(
                &app,
                id,
                &label,
                None,
                url.as_str(),
                &filename,
                "",
                0,
                false,
            );
            // Progress: the size of the file being written.
            std::thread::spawn(move || {
                let mut last = 0;
                while !control.finished.load(Ordering::Relaxed)
                    && !control.cancelled.load(Ordering::Relaxed)
                {
                    std::thread::sleep(Duration::from_millis(500));
                    let size = std::fs::metadata(&temp).map(|m| m.len()).unwrap_or(0);
                    if size != last {
                        last = size;
                        control.received.store(size, Ordering::Relaxed);
                        emit_progress(&app, id, size, 0);
                    }
                }
            });
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let id = {
                let mut by_url = downloads.by_url.lock().unwrap();
                let key = (label, url.to_string());
                let id = by_url
                    .get_mut(&key)
                    .and_then(|ids| (!ids.is_empty()).then(|| ids.remove(0)));
                if by_url.get(&key).is_some_and(Vec::is_empty) {
                    by_url.remove(&key);
                }
                id
            };
            let Some(id) = id else { return true };
            let Some(control) = downloads.control(id) else {
                return true;
            };
            control.finished.store(true, Ordering::Relaxed);
            let temp = downloads
                .items
                .lock()
                .unwrap()
                .get(&id)
                .map(|i| i.temp.clone());
            // macOS reports no path: the file is where the hook put it.
            if let (Some(path), Some(temp)) = (path, temp.as_ref()) {
                if &path != temp {
                    if let Some(item) = downloads.items.lock().unwrap().get_mut(&id) {
                        item.temp = path;
                    }
                }
            }
            let size = temp
                .and_then(|t| std::fs::metadata(t).ok())
                .map(|m| m.len())
                .unwrap_or(0);
            if control.cancelled.load(Ordering::Relaxed) {
                if let Some(item) = downloads.remove(id) {
                    discard(&item.temp);
                }
            } else if success {
                emit_done(&app, id, "completed", size, size);
            } else {
                if let Some(item) = downloads.remove(id) {
                    discard(&item.temp);
                }
                emit_done(&app, id, "interrupted", size, 0);
            }
            true
        }
        _ => true,
    }
}

// --- page downloads on Linux (WebKitGTK) ----------------------------------------------------

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
        glib, glib::prelude::*, DownloadExt, URIResponseExt, WebContext, WebContextExt, WebView,
        WebViewExt,
    };

    thread_local! {
        /// Web contexts whose `download-started` is connected.
        static CONTEXTS: RefCell<Vec<WebContext>> = const { RefCell::new(Vec::new()) };
        /// Webviews of BrowserWindows, with their labels.
        static VIEWS: RefCell<Vec<(glib::WeakRef<WebView>, String)>> = const { RefCell::new(Vec::new()) };
        /// Downloads in progress, for `cancel`.
        static ACTIVE: RefCell<HashMap<u32, webkit2gtk::Download>> = RefCell::new(HashMap::new());
    }

    fn label_of(view: &WebView) -> Option<String> {
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            views.retain(|(weak, _)| weak.upgrade().is_some());
            views
                .iter()
                .find(|(weak, _)| weak.upgrade().as_ref() == Some(view))
                .map(|(_, label)| label.clone())
        })
    }

    /// Called on the main thread for each webview `create_window` makes.
    pub fn attach<R: Runtime>(app: &AppHandle<R>, view: &WebView, label: &str) {
        VIEWS.with(|views| {
            views
                .borrow_mut()
                .push((view.downgrade(), label.to_string()))
        });
        let Some(context) = view.context() else {
            return;
        };
        let known = CONTEXTS.with(|c| c.borrow().iter().any(|k| k == &context));
        if known {
            return;
        }
        CONTEXTS.with(|c| c.borrow_mut().push(context.clone()));
        let app = app.clone();
        context.connect_download_started(move |_, download| {
            // Downloads of other webviews (the main window) keep WebKit's default handling.
            let Some(view) = download.web_view() else {
                return;
            };
            let Some(label) = label_of(&view) else { return };
            let app = app.clone();
            let failed = Rc::new(std::cell::Cell::new(false));
            let id_cell = Rc::new(std::cell::Cell::new(0u32));
            // Write to a temporary file. Set now: WebKitGTK (2.52) decides the destination
            // itself when no `decide-destination` handler was connected before the download
            // was created, and that is before `download-started`.
            let downloads = app.state::<Arc<Downloads>>().inner().clone();
            let (id, temp, _) = downloads.begin("download", false);
            id_cell.set(id);
            download.set_allow_overwrite(true);
            download.set_destination(&temp.to_string_lossy());
            ACTIVE.with(|a| a.borrow_mut().insert(id, download.clone()));
            // 'started' once the response (name, type, size) is known.
            let announce: Announce = {
                let app = app.clone();
                let announced = Rc::new(std::cell::Cell::new(false));
                Rc::new(
                    move |download: &webkit2gtk::Download, suggested: Option<&str>| {
                        if announced.replace(true) {
                            return;
                        }
                        let url = download
                            .request()
                            .and_then(|r| webkit2gtk::URIRequestExt::uri(&r))
                            .map(|u| u.to_string())
                            .unwrap_or_default();
                        let response = download.response();
                        let filename = suggested
                            .map(String::from)
                            .or_else(|| {
                                response
                                    .as_ref()
                                    .and_then(|r| r.suggested_filename())
                                    .map(|n| n.to_string())
                            })
                            .filter(|n| !n.is_empty())
                            .unwrap_or_else(|| name_from_url(&url));
                        let total = response.as_ref().map(|r| r.content_length()).unwrap_or(0);
                        let mime = response
                            .as_ref()
                            .and_then(|r| r.mime_type())
                            .map(|m| m.to_string())
                            .unwrap_or_default();
                        emit_started(
                            &app,
                            id,
                            &label,
                            None,
                            &url,
                            &safe_name(&filename),
                            &mime,
                            total,
                            false,
                        );
                    },
                )
            };
            {
                let announce = announce.clone();
                download.connect_response_notify(move |download| announce(download, None));
            }
            {
                let announce = announce.clone();
                download.connect_decide_destination(move |download, suggested| {
                    announce(download, Some(suggested));
                    // Keep the temporary destination.
                    download.destination().is_some()
                });
            }
            {
                let app = app.clone();
                let id_cell = id_cell.clone();
                let last = Rc::new(std::cell::Cell::new(Instant::now()));
                download.connect_received_data(move |download, _| {
                    let id = id_cell.get();
                    if id == 0 || last.get().elapsed() < PROGRESS_INTERVAL {
                        return;
                    }
                    last.set(Instant::now());
                    let total = download.response().map(|r| r.content_length()).unwrap_or(0);
                    emit_progress(&app, id, download.received_data_length(), total);
                });
            }
            {
                let failed = failed.clone();
                download.connect_failed(move |_, _| failed.set(true));
            }
            download.connect_finished(move |download| {
                let id = id_cell.get();
                if id == 0 {
                    return;
                }
                ACTIVE.with(|a| a.borrow_mut().remove(&id));
                announce(download, None);
                let downloads = app.state::<Arc<Downloads>>().inner().clone();
                // Where WebKit actually wrote the file, if it ignored the temporary path.
                if let Some(actual) = download.destination().map(|d| PathBuf::from(d.as_str())) {
                    if let Some(item) = downloads.items.lock().unwrap().get_mut(&id) {
                        if item.temp != actual {
                            item.temp = actual;
                        }
                    }
                }
                let Some(control) = downloads.control(id) else {
                    return;
                };
                control.finished.store(true, Ordering::Relaxed);
                let received = download.received_data_length();
                let total = download.response().map(|r| r.content_length()).unwrap_or(0);
                if control.cancelled.load(Ordering::Relaxed) || failed.get() {
                    if let Some(item) = downloads.remove(id) {
                        discard(&item.temp);
                    }
                    let state = if control.cancelled.load(Ordering::Relaxed) {
                        "cancelled"
                    } else {
                        "interrupted"
                    };
                    emit_done(&app, id, state, received, total);
                } else {
                    emit_done(&app, id, "completed", received, total.max(received));
                }
            });
        });
    }

    use std::rc::Rc;

    type Announce = Rc<dyn Fn(&webkit2gtk::Download, Option<&str>)>;

    /// Cancel a WebKit download (main thread).
    pub fn cancel(id: u32) {
        if let Some(download) = ACTIVE.with(|a| a.borrow_mut().remove(&id)) {
            download.cancel();
        }
    }
}

// --- commands ---------------------------------------------------------------------------------

/// `item.pause()` / `resume()` / `cancel()`. False when the item cannot do it.
pub fn control<R: Runtime>(app: &AppHandle<R>, id: u32, action: &str) -> bool {
    let downloads = app.state::<Arc<Downloads>>().inner().clone();
    let Some(control) = downloads.control(id) else {
        return false;
    };
    match action {
        "pause" if control.http => {
            control.paused.store(true, Ordering::Relaxed);
            true
        }
        "resume" if control.http => {
            control.paused.store(false, Ordering::Relaxed);
            true
        }
        "cancel" => {
            control.cancelled.store(true, Ordering::Relaxed);
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            ))]
            if !control.http {
                let _ = app.run_on_main_thread(move || gtk::cancel(id));
            }
            // Already complete: just drop the file.
            if control.finished.load(Ordering::Relaxed) {
                if let Some(item) = downloads.remove(id) {
                    discard(&item.temp);
                }
            }
            true
        }
        _ => false,
    }
}

/// Move a completed download to its save path. Returns the final path.
pub fn commit<R: Runtime>(app: &AppHandle<R>, id: u32, path: &str) -> Result<String, String> {
    let downloads = app.state::<Arc<Downloads>>().inner().clone();
    let item = downloads
        .remove(id)
        .ok_or_else(|| format!("no completed download {id}"))?;
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(&item.temp, &target).is_err() {
        // Another file system: copy, then remove.
        std::fs::copy(&item.temp, &target).map_err(|e| e.to_string())?;
    }
    discard(&item.temp);
    Ok(target.to_string_lossy().into_owned())
}

/// Drop a download's temporary file (the save dialog was cancelled).
pub fn discard_item<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let downloads = app.state::<Arc<Downloads>>().inner().clone();
    if let Some(item) = downloads.remove(id) {
        discard(&item.temp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        assert_eq!(
            name_from_url("https://example.com/a/b%20c.zip?x=1"),
            "b c.zip"
        );
        assert_eq!(name_from_url("https://example.com/"), "download");
        assert_eq!(
            name_from_disposition("attachment; filename=\"r.pdf\""),
            Some("r.pdf".into())
        );
        assert_eq!(
            name_from_disposition("attachment; filename=a.txt; filename*=UTF-8''%E2%82%AC.txt"),
            Some("€.txt".into())
        );
        assert_eq!(
            name_from_disposition("attachment; filename=\"../../x\""),
            Some("_.._x".into())
        );
        assert_eq!(name_from_disposition("inline"), None);
    }
}
