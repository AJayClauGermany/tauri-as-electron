//! `session.webRequest` for the http(s) requests of BrowserWindow pages
//! (`net.fetch` and `protocol.handle()` schemes are handled in JavaScript).
//!
//! - **Windows**: WebView2's `WebResourceRequested` (a `*` filter, added only
//!   while the window's session listens to onBeforeRequest,
//!   onBeforeSendHeaders or onSendHeaders). Each request is held with a
//!   deferral until the main process answers: cancelled (an empty 403
//!   response), redirected (`SetUri`) or sent with other headers.
//!   `WebResourceResponseReceived` reports onResponseStarted / onCompleted.
//!   Requests to `*.localhost` (Tauri's own pages and custom schemes) are
//!   left to wry.
//! - **Linux**: WebKitGTK cannot change a page's requests from the UI
//!   process, but reports them: `resource-load-started` and the resource's
//!   `sent-request` (redirects), `response`, `finished` and `failed` become
//!   onSendHeaders, onBeforeRedirect, onResponseStarted, onCompleted and
//!   onErrorOccurred.
//! - **macOS**: WKWebView reports nothing.
//!
//! Events reach the main window as `tauri-electron:web-request`
//! `{ reply, label, event, request, url, method, ... }`; `reply` is non-zero
//! when the request waits for `web_request_respond`.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};

use serde::Deserialize;
#[allow(unused_imports)]
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::MAIN_LABEL;

pub const EVENT: &str = "tauri-electron:web-request";

/// Page request ids start here, apart from the ones JavaScript gives
/// `net.fetch` and custom-scheme requests.
const FIRST_REQUEST_ID: u32 = 1 << 30;

/// What a window's session listens to, as far as page requests go.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Wants {
    /// Hold requests for onBeforeRequest / onBeforeSendHeaders / onSendHeaders (Windows).
    pub request: bool,
    /// Report what happens to requests.
    pub report: bool,
}

impl Wants {
    pub fn from_events(events: &[String]) -> Self {
        let has = |names: &[&str]| events.iter().any(|e| names.contains(&e.as_str()));
        if cfg!(windows) {
            Wants {
                request: has(&["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders"]),
                report: has(&["onResponseStarted", "onCompleted"]),
            }
        } else {
            Wants {
                request: false,
                report: has(&[
                    "onSendHeaders",
                    "onResponseStarted",
                    "onBeforeRedirect",
                    "onCompleted",
                    "onErrorOccurred",
                ]),
            }
        }
    }
}

#[derive(Default)]
pub struct WebRequests {
    next_reply: AtomicU32,
    next_request: AtomicU32,
    wants: Mutex<HashMap<String, Wants>>,
}

impl WebRequests {
    pub fn set(&self, label: &str, wants: Wants) {
        self.wants.lock().unwrap().insert(label.to_string(), wants);
    }

    pub fn wants(&self, label: &str) -> Wants {
        self.wants
            .lock()
            .unwrap()
            .get(label)
            .copied()
            .unwrap_or_default()
    }

    #[allow(dead_code)]
    fn reply_id(&self) -> u32 {
        self.next_reply.fetch_add(1, Ordering::Relaxed) + 1
    }

    #[allow(dead_code)]
    fn request_id(&self) -> u32 {
        FIRST_REQUEST_ID.wrapping_add(self.next_request.fetch_add(1, Ordering::Relaxed))
    }
}

/// Whether WebView2 hands this request to us: http(s), not Tauri's own
/// `*.localhost` hosts (the app's pages, `ipc`, custom schemes).
#[allow(dead_code)]
pub fn is_page_request(url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && !url
            .host_str()
            .is_some_and(|host| host.ends_with(".localhost"))
}

#[allow(dead_code)]
fn emit<R: Runtime>(app: &AppHandle<R>, payload: Value) -> bool {
    app.emit_to(MAIN_LABEL, EVENT, payload).is_ok()
}

/// The main process' answer to a held request.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Answer {
    pub cancel: bool,
    pub redirect_url: Option<String>,
    pub request_headers: Option<Vec<(String, String)>>,
}

/// Hook a new window's webview (from `create_window`).
pub fn attach<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    label: &str,
    events: &[String],
) {
    let wants = Wants::from_events(events);
    app.state::<WebRequests>().set(label, wants);
    let handle = app.clone();
    let label = label.to_string();
    let _ = window.with_webview(move |webview| {
        #[cfg(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        ))]
        gtk::attach(&handle, &webview.inner(), &label);
        #[cfg(windows)]
        webview2::attach(&handle, &webview, &label, wants);
        let _ = (handle, label, webview);
    });
}

/// The session of these windows changed its listeners.
#[tauri::command]
pub fn web_request_listeners<R: Runtime>(
    app: AppHandle<R>,
    labels: Vec<String>,
    events: Vec<String>,
) {
    let wants = Wants::from_events(&events);
    let state = app.state::<WebRequests>();
    for label in labels {
        state.set(&label, wants);
        #[cfg(windows)]
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window
                .with_webview(move |webview| webview2::set_filter(&webview, &label, wants.request));
        }
    }
}

/// The answer to a held request (`reply`).
#[tauri::command]
pub fn web_request_respond<R: Runtime>(
    app: AppHandle<R>,
    reply: u32,
    cancel: Option<bool>,
    redirect_url: Option<String>,
    request_headers: Option<Vec<(String, String)>>,
) {
    let answer = Answer {
        cancel: cancel.unwrap_or(false),
        redirect_url,
        request_headers,
    };
    #[cfg(windows)]
    let _ = app.run_on_main_thread(move || webview2::answer(reply, answer));
    #[cfg(not(windows))]
    let _ = (app, reply, answer);
}

// --- Linux: WebKitGTK reports page requests ----------------------------------------------------

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
pub mod gtk {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    use webkit2gtk::{
        glib::{prelude::ObjectExt, translate::ToGlibPtr},
        URIRequest, URIRequestExt, URIResponse, URIResponseExt, WebResourceExt, WebView,
        WebViewExt,
    };

    /// `[[name, value], ...]` of a request's or response's (libsoup) headers.
    macro_rules! headers {
        ($headers:expr) => {{
            let mut out: Vec<(String, String)> = Vec::new();
            if let Some(headers) = $headers {
                headers.foreach(|name: &str, value: &str| {
                    out.push((name.to_string(), value.to_string()))
                });
            }
            out
        }};
    }

    fn response_fields(response: &URIResponse) -> Value {
        json!({
            "statusCode": response.status_code(),
            "responseHeaders": headers!(response.http_headers()),
        })
    }

    fn merged(mut base: Value, event: &str, extra: Value) -> Value {
        base["event"] = json!(event);
        if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
            base.extend(extra);
        }
        base
    }

    /// Called on the main thread for each webview `create_window` makes.
    pub fn attach<R: Runtime>(app: &AppHandle<R>, view: &WebView, label: &str) {
        let app = app.clone();
        let label = label.to_string();
        view.connect_resource_load_started(move |view, resource, request| {
            let state = app.state::<WebRequests>();
            if !state.wants(&label).report {
                return;
            }
            let url = request.uri().map(|u| u.to_string()).unwrap_or_default();
            let main = view.main_resource().as_ref() == Some(resource);
            let base = json!({
                "reply": 0,
                "label": label,
                "request": state.request_id(),
                "url": url,
                "method": request.http_method().map(|m| m.to_string()).unwrap_or_else(|| "GET".into()),
                "resourceType": if main { Some("mainFrame") } else { None },
            });
            emit(
                &app,
                merged(
                    base.clone(),
                    "onSendHeaders",
                    json!({ "requestHeaders": headers!(request.http_headers()) }),
                ),
            );
            let current = Rc::new(RefCell::new(base));
            {
                let (app, current) = (app.clone(), current.clone());
                // Connected by name: the first emission has no redirect
                // response (NULL), which the typed binding cannot take.
                resource.connect_local("sent-request", false, move |values| {
                    let request = values.get(1)?.get::<URIRequest>().ok()?;
                    let redirected = values.get(2)?.get::<Option<URIResponse>>().ok()??;
                    let target = request.uri().map(|u| u.to_string()).unwrap_or_default();
                    let mut extra = response_fields(&redirected);
                    extra["redirectURL"] = json!(target);
                    emit(&app, merged(current.borrow().clone(), "onBeforeRedirect", extra));
                    current.borrow_mut()["url"] = json!(target);
                    None
                });
            }
            {
                let (app, current) = (app.clone(), current.clone());
                resource.connect_response_notify(move |resource| {
                    if let Some(response) = resource.response() {
                        emit(
                            &app,
                            merged(current.borrow().clone(), "onResponseStarted", response_fields(&response)),
                        );
                    }
                });
            }
            {
                let (app, current) = (app.clone(), current.clone());
                resource.connect_finished(move |resource| {
                    let extra = resource
                        .response()
                        .map(|r| response_fields(&r))
                        .unwrap_or_else(|| json!({}));
                    emit(&app, merged(current.borrow().clone(), "onCompleted", extra));
                });
            }
            {
                let (app, current) = (app.clone(), current.clone());
                resource.connect_failed(move |_, error| {
                    let raw: *const webkit2gtk::glib::ffi::GError = error.to_glib_none().0;
                    let code = unsafe { (*raw).code };
                    let domain = error.domain().as_str().to_string();
                    let extra = json!({ "error": { "domain": domain, "code": code, "message": error.message() } });
                    emit(&app, merged(current.borrow().clone(), "onErrorOccurred", extra));
                });
            }
        });
    }
}

// --- Windows: WebView2 holds requests until the main process answers ----------------------------

#[cfg(windows)]
pub mod webview2 {
    use super::*;
    use std::{cell::RefCell, collections::HashSet};
    use tauri::webview::PlatformWebview;
    use webview2_com::{
        take_pwstr, Microsoft::Web::WebView2::Win32::*, WebResourceRequestedEventHandler,
        WebResourceResponseReceivedEventHandler,
    };
    use windows::core::{Interface, BOOL, HSTRING, PWSTR};

    struct Pending {
        args: ICoreWebView2WebResourceRequestedEventArgs,
        deferral: ICoreWebView2Deferral,
        environment: ICoreWebView2Environment,
    }

    thread_local! {
        static PENDING: RefCell<HashMap<u32, Pending>> = RefCell::new(HashMap::new());
        /// Windows whose `*` filter is on.
        static FILTERED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    }

    fn core(webview: &PlatformWebview) -> Option<ICoreWebView2> {
        unsafe { webview.controller().CoreWebView2().ok() }
    }

    /// Electron's resourceType for a WebView2 resource context.
    fn resource_type(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
        match context.0 {
            1 => "mainFrame",
            2 => "stylesheet",
            3 => "image",
            4 => "media",
            5 => "font",
            6 => "script",
            7 | 8 => "xhr",
            11 => "webSocket",
            14 => "ping",
            15 => "cspReport",
            _ => "other",
        }
    }

    unsafe fn collect(
        iterator: ICoreWebView2HttpHeadersCollectionIterator,
    ) -> windows::core::Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        let mut has = BOOL::default();
        iterator.HasCurrentHeader(&mut has)?;
        while has.as_bool() {
            let (mut name, mut value) = (PWSTR::null(), PWSTR::null());
            iterator.GetCurrentHeader(&mut name, &mut value)?;
            out.push((take_pwstr(name), take_pwstr(value)));
            iterator.MoveNext(&mut has)?;
        }
        Ok(out)
    }

    unsafe fn request_headers(
        request: &ICoreWebView2WebResourceRequest,
    ) -> windows::core::Result<Vec<(String, String)>> {
        collect(request.Headers()?.GetIterator()?)
    }

    unsafe fn uri_of(request: &ICoreWebView2WebResourceRequest) -> windows::core::Result<String> {
        let mut uri = PWSTR::null();
        request.Uri(&mut uri)?;
        Ok(take_pwstr(uri))
    }

    /// Turn the `*` filter on or off (on the main thread).
    pub fn set_filter(webview: &PlatformWebview, label: &str, on: bool) {
        let Some(core) = core(webview) else {
            return;
        };
        let filter = HSTRING::from("*");
        FILTERED.with(|filtered| {
            let mut filtered = filtered.borrow_mut();
            unsafe {
                if on && filtered.insert(label.to_string()) {
                    let _ = core.AddWebResourceRequestedFilter(
                        &filter,
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    );
                } else if !on && filtered.remove(label) {
                    let _ = core.RemoveWebResourceRequestedFilter(
                        &filter,
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    );
                }
            }
        });
    }

    pub fn attach<R: Runtime>(
        app: &AppHandle<R>,
        webview: &PlatformWebview,
        label: &str,
        wants: Wants,
    ) {
        let Some(core) = core(webview) else {
            return;
        };
        let environment = webview.environment();
        let requested = {
            let (app, label) = (app.clone(), label.to_string());
            WebResourceRequestedEventHandler::create(Box::new(move |_, args| unsafe {
                let Some(args) = args else {
                    return Ok(());
                };
                let state = app.state::<WebRequests>();
                if !state.wants(&label).request {
                    return Ok(());
                }
                let request = args.Request()?;
                let url = uri_of(&request)?;
                if !is_page_request(&url) {
                    return Ok(());
                }
                let mut method = PWSTR::null();
                request.Method(&mut method)?;
                let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
                args.ResourceContext(&mut context)?;
                let deferral = args.GetDeferral()?;
                let reply = state.reply_id();
                let payload = json!({
                    "reply": reply,
                    "label": label,
                    "event": "request",
                    "request": state.request_id(),
                    "url": url,
                    "method": take_pwstr(method),
                    "resourceType": resource_type(context),
                    "requestHeaders": request_headers(&request).unwrap_or_default(),
                });
                PENDING.with(|p| {
                    p.borrow_mut().insert(
                        reply,
                        Pending {
                            args: args.clone(),
                            deferral,
                            environment: environment.clone(),
                        },
                    )
                });
                if !emit(&app, payload) {
                    answer(reply, Answer::default());
                }
                Ok(())
            }))
        };
        let mut token = 0i64;
        unsafe {
            let _ = core.add_WebResourceRequested(&requested, &mut token);
        }
        if let Ok(core2) = core.cast::<ICoreWebView2_2>() {
            let (app, label) = (app.clone(), label.to_string());
            let received =
                WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| unsafe {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let state = app.state::<WebRequests>();
                    if !state.wants(&label).report {
                        return Ok(());
                    }
                    let request = args.Request()?;
                    let url = uri_of(&request)?;
                    if !is_page_request(&url) {
                        return Ok(());
                    }
                    let mut method = PWSTR::null();
                    request.Method(&mut method)?;
                    let response = args.Response()?;
                    let mut status = 0i32;
                    response.StatusCode(&mut status)?;
                    let mut reason = PWSTR::null();
                    response.ReasonPhrase(&mut reason)?;
                    let headers = collect(response.Headers()?.GetIterator()?).unwrap_or_default();
                    let base = json!({
                        "reply": 0,
                        "label": label,
                        "request": state.request_id(),
                        "url": url,
                        "method": take_pwstr(method),
                        "statusCode": status,
                        "statusText": take_pwstr(reason),
                        "responseHeaders": headers,
                    });
                    // WebView2 reports the headers only: the request is complete as far as we can tell.
                    for event in ["onResponseStarted", "onCompleted"] {
                        let mut payload = base.clone();
                        payload["event"] = json!(event);
                        emit(&app, payload);
                    }
                    Ok(())
                }));
            let mut token = 0i64;
            unsafe {
                let _ = core2.add_WebResourceResponseReceived(&received, &mut token);
            }
        }
        set_filter(webview, label, wants.request);
    }

    /// Apply the main process' answer and release the request (main thread).
    pub fn answer(reply: u32, answer: Answer) {
        let Some(pending) = PENDING.with(|p| p.borrow_mut().remove(&reply)) else {
            return;
        };
        unsafe {
            if answer.cancel {
                if let Ok(response) = pending.environment.CreateWebResourceResponse(
                    None,
                    403,
                    &HSTRING::from("Blocked by session.webRequest"),
                    &HSTRING::new(),
                ) {
                    let _ = pending.args.SetResponse(&response);
                }
            } else if let Ok(request) = pending.args.Request() {
                if let Some(url) = answer.redirect_url {
                    let _ = request.SetUri(&HSTRING::from(url));
                }
                if let Some(wanted) = answer.request_headers {
                    if let Ok(headers) = request.Headers() {
                        for (name, _) in request_headers(&request).unwrap_or_default() {
                            if !wanted.iter().any(|(n, _)| n.eq_ignore_ascii_case(&name)) {
                                let _ = headers.RemoveHeader(&HSTRING::from(name));
                            }
                        }
                        for (name, value) in wanted {
                            let _ = headers.SetHeader(&HSTRING::from(name), &HSTRING::from(value));
                        }
                    }
                }
            }
            let _ = pending.deferral.Complete();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wants_follow_the_listeners() {
        let none = Wants::from_events(&[]);
        assert_eq!(none, Wants::default());
        let events = vec!["onCompleted".to_string()];
        assert!(Wants::from_events(&events).report);
        let events = vec!["onBeforeSendHeaders".to_string()];
        assert_eq!(Wants::from_events(&events).request, cfg!(windows));
    }

    #[test]
    fn page_requests_skip_tauri_hosts() {
        assert!(is_page_request("https://example.com/a"));
        assert!(is_page_request("http://127.0.0.1:8080/"));
        assert!(is_page_request("http://localhost:3000/"));
        assert!(!is_page_request("http://tauri.localhost/index.html"));
        assert!(!is_page_request("http://app.localhost/x"));
        assert!(!is_page_request("file:///etc/hosts"));
        assert!(!is_page_request("not a url"));
    }
}
