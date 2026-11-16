//! Child webviews: Electron's `WebContentsView` / `BrowserView` and the
//! `<webview>` tag (feature `child-webviews`, on Tauri's unstable
//! `Window::add_child`).
//!
//! The main process creates each view as a child webview of a BrowserWindow
//! (`view_create`), then moves, shows, hides, raises and focuses it
//! (`view_update`), navigates it (`view_navigate`), runs script in it
//! (`view_eval`, for pages without the renderer bootstrap) and closes it
//! (`view_close`). Only `electron-main` may call these commands.
//!
//! A `<webview>` element keeps its guest over its box through the bridge's
//! `view/bounds` endpoint ([`tag_bounds`]): the embedder page reports the
//! element's rectangle (relative to its own viewport), which only moves the
//! guests the main process attached to that page.
//!
//! Linux: tauri-runtime-wry packs every webview of a window into the window's
//! vertical `GtkBox`, where bounds have no effect. Views are moved into a
//! `GtkOverlay` laid over the window's own webview instead, which places each
//! one at its bounds and clips it to the window's content area
//! ([`gtk_overlay`]).

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

/// A window's own webview or (feature `child-webviews`) any child webview,
/// by label. Once a window holds child webviews Tauri no longer reports it
/// as a `WebviewWindow`, so lookups by label go through here.
pub fn find<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<tauri::Webview<R>> {
    #[cfg(feature = "child-webviews")]
    return app.get_webview(label);
    #[cfg(not(feature = "child-webviews"))]
    app.get_webview_window(label).map(|w| w.as_ref().clone())
}

/// A rectangle in logical pixels, relative to the window's content area (for
/// `<webview>` guests: to the embedder's viewport).
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(not(all(desktop, feature = "child-webviews")), allow(dead_code))]
impl Rect {
    fn offset(self, by: Rect) -> Rect {
        Rect {
            x: self.x + by.x,
            y: self.y + by.y,
            ..self
        }
    }

    fn is_empty(&self) -> bool {
        self.width < 1.0 || self.height < 1.0
    }
}

/// What `new WebContentsView()` / `<webview>` add to the webview options.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Extras {
    /// The view's session has a permission request handler.
    pub permission_handler: bool,
    /// The view's session called setProxy (without a proxy: direct).
    pub proxy_configured: bool,
    /// Where the view goes in its window.
    pub bounds: Option<Rect>,
    /// Shown once created (default true).
    pub visible: Option<bool>,
    /// A `<webview>` guest: the embedder page's label and the element's id there.
    pub embedder: Option<String>,
    pub instance: Option<String>,
    /// The session.webRequest events the view's session listens to.
    pub web_request: Vec<String>,
}

/// `view_update`: what changes, in this order.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Update {
    /// Move the view to another window (`addChildView` on another window's view).
    pub window: Option<String>,
    pub bounds: Option<Rect>,
    pub visible: Option<bool>,
    /// On top of the window's other views (Linux; elsewhere the creation order stays).
    pub top: bool,
    pub focus: bool,
    pub background_color: Option<tauri::utils::config::Color>,
}

/// A `<webview>` element's rectangle, reported by its page.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagBounds {
    instance: String,
    seq: u64,
    #[serde(flatten)]
    rect: Rect,
    visible: bool,
}

/// Which views exist, where, and for `<webview>` guests, which page owns them.
#[derive(Default)]
pub struct Views {
    #[cfg(all(desktop, feature = "child-webviews"))]
    inner: std::sync::Mutex<imp::State>,
}

fn error(message: impl std::fmt::Display) -> Value {
    json!({ "message": message.to_string() })
}

#[cfg(not(all(desktop, feature = "child-webviews")))]
fn disabled() -> Value {
    json!({ "code": "ERR_FEATURE_DISABLED", "feature": "child-webviews" })
}

/// Commands that create and drive views: the main process only.
fn main_only<R: Runtime>(caller: &tauri::Webview<R>) -> Result<(), Value> {
    if caller.label() == crate::MAIN_LABEL {
        Ok(())
    } else {
        Err(error("views are managed by the main process only"))
    }
}

/// `new WebContentsView()` attached to a window, `BrowserWindow#setBrowserView`,
/// or a `<webview>` element: a child webview of `window` (a BrowserWindow's
/// label). `options` are those of a window's webview (`create_window`); its
/// `label` names the view. Async: WebView2 deadlocks when a webview is
/// created from a synchronous command, and `add_child` waits for the main thread.
#[tauri::command]
pub async fn view_create<R: Runtime>(
    webview: tauri::Webview<R>,
    window: String,
    options: tauri::utils::config::WindowConfig,
    extras: Option<Extras>,
) -> Result<(), Value> {
    main_only(&webview)?;
    #[cfg(all(desktop, feature = "child-webviews"))]
    return imp::create(
        webview.app_handle(),
        &window,
        options,
        extras.unwrap_or_default(),
    );
    #[cfg(not(all(desktop, feature = "child-webviews")))]
    {
        let _ = (window, options, extras);
        Err(disabled())
    }
}

/// `view.setBounds()`, `setVisible()`, `addChildView()` (raise, or move to
/// another window), `webContents.focus()`, `setBackgroundColor()`.
#[tauri::command]
pub async fn view_update<R: Runtime>(
    webview: tauri::Webview<R>,
    label: String,
    update: Update,
) -> Result<(), Value> {
    main_only(&webview)?;
    #[cfg(all(desktop, feature = "child-webviews"))]
    return imp::update(webview.app_handle(), &label, update);
    #[cfg(not(all(desktop, feature = "child-webviews")))]
    {
        let _ = (label, update);
        Err(disabled())
    }
}

/// `webContents.loadURL()` (or `reload()`) of a view: navigates in place,
/// remote pages included.
#[tauri::command]
pub async fn view_navigate<R: Runtime>(
    webview: tauri::Webview<R>,
    label: String,
    url: Option<String>,
    reload: Option<bool>,
) -> Result<(), Value> {
    main_only(&webview)?;
    if label == crate::MAIN_LABEL {
        return Err(error("the main process cannot be navigated"));
    }
    let target =
        find(webview.app_handle(), &label).ok_or_else(|| error(format!("no webview '{label}'")))?;
    if reload.unwrap_or(false) {
        return target.reload().map_err(error);
    }
    let url = url.ok_or_else(|| error("no url"))?;
    target.navigate(url.parse().map_err(error)?).map_err(error)
}

/// Run `script` in a view's page and answer its result as JSON (empty when it
/// threw). For pages without the renderer bootstrap (remote pages), where
/// `executeJavaScript` cannot go through IPC.
#[tauri::command]
pub async fn view_eval<R: Runtime>(
    webview: tauri::Webview<R>,
    label: String,
    script: String,
) -> Result<String, Value> {
    main_only(&webview)?;
    if label == crate::MAIN_LABEL {
        return Err(error("not in the main process"));
    }
    let target =
        find(webview.app_handle(), &label).ok_or_else(|| error(format!("no webview '{label}'")))?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = std::sync::Mutex::new(Some(sender));
    target
        .eval_with_callback(script, move |result| {
            if let Some(sender) = sender.lock().unwrap().take() {
                let _ = sender.send(result);
            }
        })
        .map_err(error)?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|_| error("the page did not answer"))
    })
    .await
    .map_err(error)?
}

/// `webContents.close()` of a view, or its `<webview>` element left the page.
#[tauri::command]
pub async fn view_close<R: Runtime>(
    webview: tauri::Webview<R>,
    label: String,
) -> Result<(), Value> {
    main_only(&webview)?;
    #[cfg(all(desktop, feature = "child-webviews"))]
    return imp::close(webview.app_handle(), &label);
    #[cfg(not(all(desktop, feature = "child-webviews")))]
    {
        let _ = label;
        Err(disabled())
    }
}

/// The bridge's `view/bounds`: the page `caller` reports where one of its
/// `<webview>` elements is. Moves only guests attached to that page.
pub fn tag_bounds<R: Runtime>(app: &AppHandle<R>, caller: &str, body: &[u8]) -> Result<(), String> {
    let bounds: TagBounds = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    #[cfg(all(desktop, feature = "child-webviews"))]
    return imp::tag_bounds(app, caller, bounds);
    #[cfg(not(all(desktop, feature = "child-webviews")))]
    {
        let _ = (
            app,
            caller,
            bounds.instance,
            bounds.seq,
            bounds.rect,
            bounds.visible,
        );
        Err("enable the `child-webviews` feature of tauri-plugin-electron".into())
    }
}

#[cfg(all(desktop, feature = "child-webviews"))]
mod imp {
    use std::collections::{HashMap, HashSet};

    use serde_json::Value;
    use tauri::{
        webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize, Manager, Runtime,
    };

    use super::{error, Extras, Rect, TagBounds, Update, Views};
    use crate::permissions;

    pub struct Guest {
        /// The window the view is in.
        pub window: String,
        /// `<webview>` guests: (embedder label, element id).
        pub tag: Option<(String, String)>,
        /// As last set: absolute for views, relative to the embedder for guests.
        pub rect: Rect,
        pub visible: bool,
        /// The last `view/bounds` report applied (they may arrive out of order).
        pub seq: u64,
    }

    #[derive(Default)]
    pub struct State {
        pub guests: HashMap<String, Guest>,
        /// Windows whose destruction is watched (to forget their views).
        pub watched: HashSet<String>,
    }

    impl State {
        /// Where `label` is in its window: a guest's rectangle is relative to
        /// its embedder, which may itself be a view.
        pub fn absolute(&self, label: &str) -> Option<Rect> {
            let mut guest = self.guests.get(label)?;
            let mut rect = guest.rect;
            let mut depth = 0;
            while let Some((embedder, _)) = &guest.tag {
                let Some(parent) = self.guests.get(embedder) else {
                    break;
                };
                rect = rect.offset(parent.rect);
                guest = parent;
                depth += 1;
                if depth > 16 {
                    break;
                }
            }
            Some(rect)
        }

        /// `label` and the guests embedded in it (they move with it).
        fn subtree(&self, label: &str) -> Vec<String> {
            let mut out = vec![label.to_string()];
            let mut i = 0;
            while i < out.len() {
                let parent = out[i].clone();
                for (child, guest) in &self.guests {
                    if guest.tag.as_ref().is_some_and(|(e, _)| *e == parent) && !out.contains(child)
                    {
                        out.push(child.clone());
                    }
                }
                i += 1;
            }
            out
        }
    }

    fn state<R: Runtime>(app: &AppHandle<R>) -> std::sync::MutexGuard<'_, State> {
        app.state::<Views>().inner().inner.lock().unwrap()
    }

    pub fn create<R: Runtime>(
        app: &AppHandle<R>,
        window: &str,
        options: tauri::utils::config::WindowConfig,
        extras: Extras,
    ) -> Result<(), Value> {
        if window == crate::MAIN_LABEL {
            // Its capability names the window: a view in it would get every API.
            return Err(error("views cannot be added to the main-process window"));
        }
        let host = app
            .get_window(window)
            .ok_or_else(|| error(format!("no window '{window}'")))?;
        let label = options.label.clone();
        if app.get_webview(&label).is_some() {
            return Err(error(format!("a webview '{label}' exists")));
        }
        let tag = match (extras.embedder.clone(), extras.instance.clone()) {
            (Some(embedder), Some(instance)) => Some((embedder, instance)),
            _ => None,
        };
        let rect = extras.bounds.unwrap_or(Rect {
            x: options.x.unwrap_or(0.0),
            y: options.y.unwrap_or(0.0),
            width: options.width,
            height: options.height,
        });
        let visible = extras.visible.unwrap_or(true);
        app.state::<permissions::Permissions>()
            .set_handler(&label, extras.permission_handler);
        #[cfg(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        ))]
        crate::windows::linux_proxy::before_create(app, &options, extras.proxy_configured);
        let absolute = {
            let mut views = state(app);
            views.guests.insert(
                label.clone(),
                Guest {
                    window: window.to_string(),
                    tag,
                    rect,
                    visible,
                    seq: 0,
                },
            );
            views.absolute(&label).unwrap_or(rect)
        };
        let mut builder = WebviewBuilder::from_config(&options);
        // The bootstrap and preload for pages of trusted origins, as windows
        // get them (trusted_origins.rs).
        if let Some(script) = crate::trusted_origins::script(app) {
            builder = builder.initialization_script(script.to_string());
        }
        #[cfg(not(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        )))]
        let builder = builder
            .on_download(crate::downloads::on_download)
            .on_permission_request(permissions::on_permission_request);
        let view = match host.add_child(
            builder,
            LogicalPosition::new(absolute.x, absolute.y),
            LogicalSize::new(absolute.width.max(1.0), absolute.height.max(1.0)),
        ) {
            Ok(view) => view,
            Err(e) => {
                state(app).guests.remove(&label);
                return Err(error(e));
            }
        };
        watch(app, &host);
        // As for windows: session.webRequest, TLS / login, screen sharing.
        crate::web_request::attach(app, &view, &label, &extras.web_request);
        crate::tls_auth::attach(app, &view, &label);
        crate::display_media::attach(app, &view, &label);
        let shown = visible && !absolute.is_empty();
        #[cfg(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        ))]
        {
            let handle = app.clone();
            let name = label.clone();
            view.with_webview(move |webview| {
                let inner = webview.inner();
                crate::downloads::gtk::attach(&handle, &inner, &name);
                permissions::gtk::attach(&handle, &inner, &name);
                super::gtk_overlay::place(&name, &inner, absolute, shown);
            })
            .map_err(error)?;
        }
        #[cfg(not(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        )))]
        if !shown {
            view.hide().map_err(error)?;
        }
        Ok(())
    }

    /// Forget a window's views when it is destroyed (Tauri destroys them with it).
    fn watch<R: Runtime>(app: &AppHandle<R>, host: &tauri::Window<R>) {
        let label = host.label().to_string();
        if !state(app).watched.insert(label.clone()) {
            return;
        }
        let handle = app.clone();
        host.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                let gone: Vec<String> = {
                    let mut views = state(&handle);
                    views.watched.remove(&label);
                    let gone = views
                        .guests
                        .iter()
                        .filter(|(_, g)| g.window == label)
                        .map(|(l, _)| l.clone())
                        .collect::<Vec<_>>();
                    for name in &gone {
                        views.guests.remove(name);
                    }
                    gone
                };
                #[cfg(any(
                    target_os = "linux",
                    target_os = "dragonfly",
                    target_os = "freebsd",
                    target_os = "netbsd",
                    target_os = "openbsd"
                ))]
                let _ = handle.run_on_main_thread(move || {
                    for name in gone {
                        super::gtk_overlay::forget(&name);
                    }
                });
                #[cfg(not(any(
                    target_os = "linux",
                    target_os = "dragonfly",
                    target_os = "freebsd",
                    target_os = "netbsd",
                    target_os = "openbsd"
                )))]
                let _ = gone;
            }
        });
    }

    /// Put `labels` where the state says they are.
    fn apply<R: Runtime>(app: &AppHandle<R>, labels: &[String]) -> Result<(), Value> {
        let placements: Vec<(String, Rect, bool)> = {
            let views = state(app);
            labels
                .iter()
                .filter_map(|l| {
                    let guest = views.guests.get(l)?;
                    let rect = views.absolute(l)?;
                    Some((l.clone(), rect, guest.visible && !rect.is_empty()))
                })
                .collect()
        };
        for (label, rect, shown) in placements {
            let Some(view) = app.get_webview(&label) else {
                continue;
            };
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            ))]
            {
                let _ = view;
                app.run_on_main_thread(move || super::gtk_overlay::set(&label, rect, shown))
                    .map_err(error)?;
            }
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            {
                let _ = label;
                if shown {
                    view.set_bounds(tauri::Rect {
                        position: LogicalPosition::new(rect.x, rect.y).into(),
                        size: LogicalSize::new(rect.width, rect.height).into(),
                    })
                    .map_err(error)?;
                    view.show().map_err(error)?;
                } else {
                    view.hide().map_err(error)?;
                }
            }
        }
        Ok(())
    }

    pub fn update<R: Runtime>(
        app: &AppHandle<R>,
        label: &str,
        update: Update,
    ) -> Result<(), Value> {
        let view = app
            .get_webview(label)
            .ok_or_else(|| error(format!("no view '{label}'")))?;
        if !state(app).guests.contains_key(label) {
            return Err(error(format!("'{label}' is not a view")));
        }
        if let Some(window) = update.window.as_deref() {
            let current = state(app).guests.get(label).map(|g| g.window.clone());
            if current.as_deref() != Some(window) {
                if window == crate::MAIN_LABEL {
                    return Err(error("views cannot be added to the main-process window"));
                }
                let host = app
                    .get_window(window)
                    .ok_or_else(|| error(format!("no window '{window}'")))?;
                view.reparent(&host).map_err(error)?;
                watch(app, &host);
                let moved = state(app).subtree(label);
                for name in &moved {
                    if let Some(guest) = state(app).guests.get_mut(name) {
                        guest.window = window.to_string();
                    }
                }
                #[cfg(any(
                    target_os = "linux",
                    target_os = "dragonfly",
                    target_os = "freebsd",
                    target_os = "netbsd",
                    target_os = "openbsd"
                ))]
                for name in moved {
                    // Reparented into the new window's box: back into an overlay.
                    let Some(moved_view) = app.get_webview(&name) else {
                        continue;
                    };
                    let (rect, shown) = {
                        let views = state(app);
                        let rect = views.absolute(&name).unwrap_or_default();
                        let shown = views.guests.get(&name).is_some_and(|g| g.visible);
                        (rect, shown && !rect.is_empty())
                    };
                    moved_view
                        .with_webview(move |webview| {
                            super::gtk_overlay::place(&name, &webview.inner(), rect, shown)
                        })
                        .map_err(error)?;
                }
            }
        }
        let mut changed = false;
        {
            let mut views = state(app);
            if let Some(guest) = views.guests.get_mut(label) {
                if let Some(bounds) = update.bounds {
                    changed |= guest.rect != bounds;
                    guest.rect = bounds;
                }
                if let Some(visible) = update.visible {
                    changed |= guest.visible != visible;
                    guest.visible = visible;
                }
            }
        }
        if changed || update.bounds.is_some() || update.visible.is_some() {
            let subtree = state(app).subtree(label);
            apply(app, &subtree)?;
        }
        if update.top {
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            ))]
            {
                let name = label.to_string();
                app.run_on_main_thread(move || super::gtk_overlay::raise(&name))
                    .map_err(error)?;
            }
        }
        if let Some(color) = update.background_color {
            view.set_background_color(Some(color)).map_err(error)?;
        }
        if update.focus {
            view.set_focus().map_err(error)?;
        }
        Ok(())
    }

    pub fn close<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), Value> {
        let gone = {
            let mut views = state(app);
            if !views.guests.contains_key(label) {
                return Ok(());
            }
            // Guests embedded in the view go with it.
            let gone = views.subtree(label);
            for name in &gone {
                views.guests.remove(name);
            }
            gone
        };
        for name in gone {
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            ))]
            {
                let forget = name.clone();
                let _ = app.run_on_main_thread(move || super::gtk_overlay::forget(&forget));
            }
            if let Some(view) = app.get_webview(&name) {
                view.close().map_err(error)?;
            }
        }
        Ok(())
    }

    pub fn tag_bounds<R: Runtime>(
        app: &AppHandle<R>,
        caller: &str,
        bounds: TagBounds,
    ) -> Result<(), String> {
        let label = {
            let mut views = state(app);
            let Some((label, guest)) = views.guests.iter_mut().find(|(_, g)| {
                g.tag
                    .as_ref()
                    .is_some_and(|(e, i)| e == caller && *i == bounds.instance)
            }) else {
                return Err("no such <webview>".into());
            };
            if bounds.seq <= guest.seq {
                return Ok(());
            }
            guest.seq = bounds.seq;
            guest.rect = bounds.rect;
            guest.visible = bounds.visible;
            label.clone()
        };
        let subtree = state(app).subtree(&label);
        apply(app, &subtree).map_err(|e| e.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn guest(window: &str, tag: Option<(&str, &str)>, rect: Rect) -> Guest {
            Guest {
                window: window.into(),
                tag: tag.map(|(e, i)| (e.into(), i.into())),
                rect,
                visible: true,
                seq: 0,
            }
        }

        #[test]
        fn guests_are_placed_relative_to_their_embedder() {
            let mut state = State::default();
            let view = Rect {
                x: 100.0,
                y: 50.0,
                width: 400.0,
                height: 300.0,
            };
            let inner = Rect {
                x: 10.0,
                y: 20.0,
                width: 50.0,
                height: 60.0,
            };
            state.guests.insert("view".into(), guest("w", None, view));
            state
                .guests
                .insert("tag".into(), guest("w", Some(("view", "a-1")), inner));
            state
                .guests
                .insert("top".into(), guest("w", Some(("w", "a-2")), inner));
            assert_eq!(state.absolute("view"), Some(view));
            assert_eq!(
                state.absolute("tag"),
                Some(Rect {
                    x: 110.0,
                    y: 70.0,
                    width: 50.0,
                    height: 60.0
                })
            );
            // Embedded in the window's own page: relative to the window.
            assert_eq!(state.absolute("top"), Some(inner));
            let mut subtree = state.subtree("view");
            subtree.sort();
            assert_eq!(subtree, vec!["tag".to_string(), "view".to_string()]);
            assert!(Rect { width: 0.5, ..view }.is_empty());
        }
    }
}

/// Linux: views laid over the window's webview in a `GtkOverlay`.
///
/// tauri-runtime-wry packs each webview into the window's vertical box
/// (`default_vbox`), where wry cannot position it. The first view of a
/// window moves the window's own webview into an overlay (inside an event box
/// whose window clips the views to the content area) that takes its place in
/// the box; every view is then an overlay child placed at its rectangle by the
/// overlay's `get-child-position` signal. Main thread only.
#[cfg(all(
    desktop,
    feature = "child-webviews",
    any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )
))]
pub mod gtk_overlay {
    use std::{cell::RefCell, collections::HashMap};

    use gtk::{
        glib::{self, translate::from_glib_none},
        prelude::*,
    };
    use webkit2gtk::WebView;

    use super::Rect;

    /// Widget name of the event box that holds a window's overlay.
    const NAME: &str = "tauri-electron-views";

    struct Placed {
        view: WebView,
        rect: Rect,
    }

    thread_local! {
        static PLACED: RefCell<HashMap<String, Placed>> = RefCell::new(HashMap::new());
    }

    fn rect_of(widget: &gtk::Widget) -> Option<Rect> {
        PLACED.with(|placed| {
            placed
                .borrow()
                .values()
                .find(|p| p.view.upcast_ref::<gtk::Widget>() == widget)
                .map(|p| p.rect)
        })
    }

    unsafe extern "C" fn child_position(
        _overlay: *mut gtk::ffi::GtkOverlay,
        widget: *mut gtk::ffi::GtkWidget,
        allocation: *mut gtk::gdk::ffi::GdkRectangle,
        _data: glib::ffi::gpointer,
    ) -> glib::ffi::gboolean {
        let widget: gtk::Widget = from_glib_none(widget);
        let Some(rect) = rect_of(&widget) else {
            return glib::ffi::GFALSE;
        };
        let allocation = &mut *allocation;
        allocation.x = rect.x.round() as i32;
        allocation.y = rect.y.round() as i32;
        allocation.width = rect.width.round().max(1.0) as i32;
        allocation.height = rect.height.round().max(1.0) as i32;
        glib::ffi::GTRUE
    }

    fn new_overlay(vbox: &gtk::Box, view: &WebView) -> gtk::Overlay {
        let overlay = gtk::Overlay::new();
        // SAFETY: the trampoline matches `get-child-position`'s signature
        // (overlay, widget, out allocation, user data) -> gboolean; the
        // closure data is a zero-sized box.
        unsafe {
            glib::signal::connect_raw(
                overlay.as_ptr() as *mut glib::gobject_ffi::GObject,
                c"get-child-position".as_ptr(),
                Some(std::mem::transmute::<*const (), unsafe extern "C" fn()>(
                    child_position as *const (),
                )),
                Box::into_raw(Box::new(())),
            );
        }
        let holder = gtk::EventBox::new();
        holder.set_widget_name(NAME);
        holder.set_visible_window(true);
        holder.add(&overlay);
        // The window's own webview becomes the overlay's main child, where it was in the box.
        let main = vbox
            .children()
            .into_iter()
            .find(|w| w.is::<WebView>() && w != view.upcast_ref::<gtk::Widget>());
        match main {
            Some(main) => {
                let position: i32 = vbox.child_property(&main, "position");
                vbox.remove(&main);
                overlay.add(&main);
                vbox.pack_start(&holder, true, true, 0);
                vbox.reorder_child(&holder, position);
            }
            None => vbox.pack_start(&holder, true, true, 0),
        }
        overlay.show();
        holder.show();
        overlay
    }

    /// The overlay of the window whose box is `vbox`, made on first use.
    fn overlay_of(vbox: &gtk::Box, view: &WebView) -> gtk::Overlay {
        vbox.children()
            .into_iter()
            .find(|w| w.widget_name().as_str() == NAME)
            .and_then(|holder| holder.downcast::<gtk::EventBox>().ok())
            .and_then(|holder| holder.child())
            .and_then(|child| child.downcast::<gtk::Overlay>().ok())
            .unwrap_or_else(|| new_overlay(vbox, view))
    }

    /// Move a view Tauri just packed into its window's box (created, or
    /// reparented) into the window's overlay, at `rect`.
    pub fn place(label: &str, view: &WebView, rect: Rect, shown: bool) {
        PLACED.with(|placed| {
            placed.borrow_mut().insert(
                label.to_string(),
                Placed {
                    view: view.clone(),
                    rect,
                },
            )
        });
        let Some(parent) = view.parent() else {
            return;
        };
        if let Ok(vbox) = parent.clone().downcast::<gtk::Box>() {
            let overlay = overlay_of(&vbox, view);
            vbox.remove(view);
            overlay.add_overlay(view);
            overlay.set_overlay_pass_through(view, false);
        }
        show(view, shown);
    }

    fn show(view: &WebView, shown: bool) {
        if shown {
            view.show();
        } else {
            view.hide();
        }
        view.queue_resize();
    }

    /// New rectangle and visibility.
    pub fn set(label: &str, rect: Rect, shown: bool) {
        let view = PLACED.with(|placed| {
            let mut placed = placed.borrow_mut();
            let entry = placed.get_mut(label)?;
            entry.rect = rect;
            Some(entry.view.clone())
        });
        if let Some(view) = view {
            show(&view, shown);
        }
    }

    /// Above the window's other views.
    pub fn raise(label: &str) {
        let view = PLACED.with(|placed| placed.borrow().get(label).map(|p| p.view.clone()));
        let Some(view) = view else {
            return;
        };
        if let Some(overlay) = view
            .parent()
            .and_then(|p| p.downcast::<gtk::Overlay>().ok())
        {
            overlay.reorder_overlay(&view, -1);
        }
    }

    pub fn forget(label: &str) {
        PLACED.with(|placed| placed.borrow_mut().remove(label));
    }

    /// Edge resizing of a frameless window through its webview. In
    /// multi-webview mode (Tauri's `unstable`) tauri-runtime-wry no longer
    /// gives a window's own webview these handles; adapted from its
    /// `undecorated_resizing` (Apache-2.0 / MIT).
    pub fn attach_resize_handles(view: &WebView) {
        use gtk::{
            gdk::{EventMask, WindowEdge},
            glib::Propagation,
        };
        const INSET: i32 = 5;
        fn edge(view: &WebView, (root_x, root_y): (f64, f64)) -> Option<(gtk::Window, WindowEdge)> {
            let window = view.toplevel()?.downcast::<gtk::Window>().ok()?;
            if window.is_decorated() || !window.is_resizable() || window.is_maximized() {
                return None;
            }
            let surface = window.window()?;
            let (left, top) = surface.position();
            let (x, y) = (root_x - left as f64, root_y - top as f64);
            let border = (surface.scale_factor() * INSET) as f64;
            let (width, height) = (surface.width() as f64, surface.height() as f64);
            let edge = match (
                x < border,
                x >= width - border,
                y < border,
                y >= height - border,
            ) {
                (true, false, true, false) => WindowEdge::NorthWest,
                (false, true, true, false) => WindowEdge::NorthEast,
                (true, false, false, true) => WindowEdge::SouthWest,
                (false, true, false, true) => WindowEdge::SouthEast,
                (true, false, false, false) => WindowEdge::West,
                (false, true, false, false) => WindowEdge::East,
                (false, false, true, false) => WindowEdge::North,
                (false, false, false, true) => WindowEdge::South,
                _ => return None,
            };
            Some((window, edge))
        }
        fn cursor(edge: WindowEdge) -> gtk::gdk::CursorType {
            use gtk::gdk::CursorType;
            match edge {
                WindowEdge::NorthWest => CursorType::TopLeftCorner,
                WindowEdge::NorthEast => CursorType::TopRightCorner,
                WindowEdge::SouthWest => CursorType::BottomLeftCorner,
                WindowEdge::SouthEast => CursorType::BottomRightCorner,
                WindowEdge::West => CursorType::LeftSide,
                WindowEdge::East => CursorType::RightSide,
                WindowEdge::North => CursorType::TopSide,
                _ => CursorType::BottomSide,
            }
        }
        view.add_events(
            EventMask::POINTER_MOTION_MASK
                | EventMask::BUTTON1_MOTION_MASK
                | EventMask::BUTTON_PRESS_MASK,
        );
        view.connect_motion_notify_event(|view, event| {
            let Some((_, edge)) = edge(view, event.root()) else {
                return Propagation::Proceed;
            };
            if let Some(surface) = view.window() {
                let cursor = gtk::gdk::Cursor::for_display(&surface.display(), cursor(edge));
                surface.set_cursor(cursor.as_ref());
            }
            Propagation::Stop
        });
        view.connect_button_press_event(|view, event| {
            if event.button() != 1 {
                return Propagation::Proceed;
            }
            let Some((window, edge)) = edge(view, event.root()) else {
                return Propagation::Proceed;
            };
            let (x, y) = event.root();
            window.begin_resize_drag(edge, 1, x as i32, y as i32, event.time());
            Propagation::Stop
        });
    }
}
