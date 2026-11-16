//! TLS and HTTP authentication events of BrowserWindow pages:
//! `certificate-error` (with `setCertificateVerifyProc`), `login` and
//! `select-client-certificate`. Each one is held while the main process asks
//! its listeners, then answered by `tls_auth_respond`.
//!
//! - **Linux** (WebKitGTK): `load-failed-with-tls-errors` (main frames; a
//!   trusted certificate is allowed for its host on the web context and the
//!   page loaded again) and `authenticate` (Basic, Digest, NTLM, Negotiate;
//!   cancelling continues without credentials, so the page shows the 401
//!   response, as in Electron). Client certificate requests keep WebKitGTK's
//!   default.
//! - **Windows** (WebView2): `ServerCertificateErrorDetected` (always allow
//!   or cancel), `BasicAuthenticationRequested` and
//!   `ClientCertificateRequested` (the mutually trusted certificates).
//! - **macOS**: wry owns the WKNavigationDelegate, so nothing is reported.
//!
//! Events reach the main window as `tauri-electron:certificate-error`
//! `{ id, label, url, errors, certificate: [pem, ...], isMainFrame }`,
//! `tauri-electron:login` `{ id, label, url, scheme, host, port, realm,
//! isProxy }` and `tauri-electron:select-client-certificate`
//! `{ id, label, url, certificates: [[pem, ...], ...] }`.

use std::sync::atomic::{AtomicU32, Ordering};

#[allow(unused_imports)]
use serde_json::{json, Value};
#[allow(unused_imports)]
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[allow(unused_imports)]
use crate::MAIN_LABEL;

pub const CERTIFICATE_EVENT: &str = "tauri-electron:certificate-error";
pub const LOGIN_EVENT: &str = "tauri-electron:login";
#[allow(dead_code)]
pub const CLIENT_CERTIFICATE_EVENT: &str = "tauri-electron:select-client-certificate";

#[derive(Default)]
pub struct TlsAuth {
    next_id: AtomicU32,
}

impl TlsAuth {
    #[allow(dead_code)]
    fn id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }
}

#[allow(dead_code)]
fn emit<R: Runtime>(app: &AppHandle<R>, event: &str, payload: Value) -> bool {
    app.emit_to(MAIN_LABEL, event, payload).is_ok()
}

/// Hook a new window's webview (from `create_window`) or a view's (`views.rs`).
pub fn attach<R: Runtime>(app: &AppHandle<R>, window: &tauri::Webview<R>, label: &str) {
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
        webview2::attach(&handle, &webview, &label);
        let _ = (handle, label, webview);
    });
}

/// The main process' answer: `{ trusted }` (certificate), `{ username,
/// password }` or `{ cancel }` (login), `{ certificate: index }` (-1: none).
#[tauri::command]
pub fn tls_auth_respond<R: Runtime>(app: AppHandle<R>, id: u32, answer: Value) {
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    let _ = app.run_on_main_thread(move || gtk::answer(id, &answer));
    #[cfg(windows)]
    let _ = app.run_on_main_thread(move || webview2::answer(id, &answer));
    #[cfg(not(any(
        windows,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    let _ = (app, id, answer);
}

/// The host a certificate exception is for (`https://host:port/…` → `host`).
#[allow(dead_code)]
pub fn host_of(url: &str) -> Option<String> {
    let url = tauri::Url::parse(url).ok()?;
    let host = url.host_str()?;
    // IPv6 addresses without their brackets.
    Some(
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .to_string(),
    )
}

// --- Linux: WebKitGTK -----------------------------------------------------------------------------

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
pub mod gtk {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    use webkit2gtk::{
        ffi,
        gio::{self, prelude::TlsCertificateExt, TlsCertificateFlags},
        glib::translate::{ToGlibPtr, ToGlibPtrMut},
        AuthenticationRequest, AuthenticationRequestExt, AuthenticationScheme, Credential,
        CredentialPersistence, WebContextExt, WebView, WebViewExt,
    };

    enum Pending {
        Certificate {
            view: WebView,
            certificate: gio::TlsCertificate,
            url: String,
        },
        Login(AuthenticationRequest),
    }

    thread_local! {
        static PENDING: RefCell<HashMap<u32, Pending>> = RefCell::new(HashMap::new());
    }

    /// The certificate and its issuers, as PEM, leaf first.
    fn chain(certificate: &gio::TlsCertificate) -> Vec<String> {
        let mut out = Vec::new();
        let mut current = Some(certificate.clone());
        while let Some(certificate) = current {
            if let Some(pem) = certificate.certificate_pem() {
                out.push(pem.to_string());
            }
            if out.len() >= 8 {
                break;
            }
            current = certificate.issuer();
        }
        out
    }

    pub fn flag_names(flags: TlsCertificateFlags) -> Vec<&'static str> {
        [
            (TlsCertificateFlags::UNKNOWN_CA, "unknown-ca"),
            (TlsCertificateFlags::BAD_IDENTITY, "bad-identity"),
            (TlsCertificateFlags::NOT_ACTIVATED, "not-activated"),
            (TlsCertificateFlags::EXPIRED, "expired"),
            (TlsCertificateFlags::REVOKED, "revoked"),
            (TlsCertificateFlags::INSECURE, "insecure"),
            (TlsCertificateFlags::GENERIC_ERROR, "generic-error"),
        ]
        .into_iter()
        .filter(|(flag, _)| flags.contains(*flag))
        .map(|(_, name)| name)
        .collect()
    }

    /// Called on the main thread for each webview `create_window` makes.
    pub fn attach<R: Runtime>(app: &AppHandle<R>, view: &WebView, label: &str) {
        {
            let (app, label) = (app.clone(), label.to_string());
            view.connect_load_failed_with_tls_errors(move |view, uri, certificate, errors| {
                let id = app.state::<TlsAuth>().id();
                PENDING.with(|p| {
                    p.borrow_mut().insert(
                        id,
                        Pending::Certificate {
                            view: view.clone(),
                            certificate: certificate.clone(),
                            url: uri.to_string(),
                        },
                    )
                });
                let payload = json!({
                    "id": id,
                    "label": label,
                    "url": uri,
                    "errors": flag_names(errors),
                    "certificate": chain(certificate),
                    "isMainFrame": true,
                });
                if !emit(&app, CERTIFICATE_EVENT, payload) {
                    PENDING.with(|p| p.borrow_mut().remove(&id));
                    return false;
                }
                // Handled: WebKit's load-failed (and its error page) is skipped.
                true
            });
        }
        let (app, label) = (app.clone(), label.to_string());
        view.connect_authenticate(move |view, request| {
            let scheme = match request.scheme() {
                AuthenticationScheme::HttpBasic | AuthenticationScheme::Default => "basic",
                AuthenticationScheme::HttpDigest => "digest",
                AuthenticationScheme::Ntlm => "ntlm",
                AuthenticationScheme::Negotiate => "negotiate",
                // Client certificates (and the rest): WebKitGTK's default.
                _ => return false,
            };
            let id = app.state::<TlsAuth>().id();
            PENDING.with(|p| p.borrow_mut().insert(id, Pending::Login(request.clone())));
            let payload = json!({
                "id": id,
                "label": label,
                "url": view.uri().map(|u| u.to_string()).unwrap_or_default(),
                "scheme": scheme,
                "host": request.host().map(|h| h.to_string()).unwrap_or_default(),
                "port": request.port(),
                "realm": request.realm().map(|r| r.to_string()).unwrap_or_default(),
                "isProxy": request.is_for_proxy(),
            });
            if !emit(&app, LOGIN_EVENT, payload) {
                PENDING.with(|p| p.borrow_mut().remove(&id));
                return false;
            }
            true
        });
    }

    pub fn answer(id: u32, answer: &Value) {
        let Some(pending) = PENDING.with(|p| p.borrow_mut().remove(&id)) else {
            return;
        };
        match pending {
            Pending::Certificate {
                view,
                certificate,
                url,
            } => {
                if answer.get("trusted").and_then(Value::as_bool) != Some(true) {
                    return;
                }
                if let (Some(context), Some(host)) = (view.context(), host_of(&url)) {
                    context.allow_tls_certificate_for_host(&certificate, &host);
                    view.load_uri(&url);
                }
            }
            Pending::Login(request) => unsafe {
                match answer.get("username").and_then(Value::as_str) {
                    Some(username) => {
                        let password = answer.get("password").and_then(Value::as_str).unwrap_or("");
                        let mut credential =
                            Credential::new(username, password, CredentialPersistence::ForSession);
                        ffi::webkit_authentication_request_authenticate(
                            request.to_glib_none().0,
                            credential.to_glib_none_mut().0,
                        );
                    }
                    // Cancelled: go on without credentials (the 401 page), like Chromium.
                    None => ffi::webkit_authentication_request_authenticate(
                        request.to_glib_none().0,
                        std::ptr::null_mut(),
                    ),
                }
            },
        }
    }
}

// --- Windows: WebView2 ----------------------------------------------------------------------------

#[cfg(windows)]
pub mod webview2 {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    use tauri::webview::PlatformWebview;
    use webview2_com::{
        take_pwstr, BasicAuthenticationRequestedEventHandler,
        ClientCertificateRequestedEventHandler, Microsoft::Web::WebView2::Win32::*,
        ServerCertificateErrorDetectedEventHandler,
    };
    use windows::core::{Interface, HSTRING, PWSTR};

    enum Pending {
        Certificate(
            ICoreWebView2ServerCertificateErrorDetectedEventArgs,
            ICoreWebView2Deferral,
        ),
        Login(
            ICoreWebView2BasicAuthenticationRequestedEventArgs,
            ICoreWebView2Deferral,
        ),
        Client(
            ICoreWebView2ClientCertificateRequestedEventArgs,
            ICoreWebView2Deferral,
            Vec<ICoreWebView2ClientCertificate>,
        ),
    }

    thread_local! {
        static PENDING: RefCell<HashMap<u32, Pending>> = RefCell::new(HashMap::new());
    }

    fn error_names(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> Vec<&'static str> {
        vec![match status {
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT => "bad-identity",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED => "expired",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => "revoked",
            // Untrusted issuers, weak signatures, pinning, ...: most often an unknown CA.
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID => "unknown-ca",
            _ => "generic-error",
        }]
    }

    unsafe fn strings(collection: ICoreWebView2StringCollection) -> Vec<String> {
        let mut count = 0u32;
        if collection.Count(&mut count).is_err() {
            return Vec::new();
        }
        (0..count)
            .filter_map(|index| {
                let mut value = PWSTR::null();
                collection.GetValueAtIndex(index, &mut value).ok()?;
                Some(take_pwstr(value))
            })
            .collect()
    }

    unsafe fn server_chain(certificate: &ICoreWebView2Certificate) -> Vec<String> {
        let mut pem = PWSTR::null();
        let mut out = Vec::new();
        if certificate.ToPemEncoding(&mut pem).is_ok() {
            out.push(take_pwstr(pem));
        }
        if let Ok(issuers) = certificate.PemEncodedIssuerCertificateChain() {
            out.extend(strings(issuers));
        }
        out
    }

    unsafe fn client_chain(certificate: &ICoreWebView2ClientCertificate) -> Vec<String> {
        let mut pem = PWSTR::null();
        let mut out = Vec::new();
        if certificate.ToPemEncoding(&mut pem).is_ok() {
            out.push(take_pwstr(pem));
        }
        if let Ok(issuers) = certificate.PemEncodedIssuerCertificateChain() {
            out.extend(strings(issuers));
        }
        out
    }

    pub fn attach<R: Runtime>(app: &AppHandle<R>, webview: &PlatformWebview, label: &str) {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        if let Ok(core14) = core.cast::<ICoreWebView2_14>() {
            let (app, label) = (app.clone(), label.to_string());
            let handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(
                move |_, args| unsafe {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.ErrorStatus(&mut status)?;
                    let mut uri = PWSTR::null();
                    args.RequestUri(&mut uri)?;
                    let certificate = args
                        .ServerCertificate()
                        .map(|c| server_chain(&c))
                        .unwrap_or_default();
                    let deferral = args.GetDeferral()?;
                    let id = app.state::<TlsAuth>().id();
                    PENDING.with(|p| {
                        p.borrow_mut()
                            .insert(id, Pending::Certificate(args.clone(), deferral))
                    });
                    let payload = json!({
                        "id": id,
                        "label": label,
                        "url": take_pwstr(uri),
                        "errors": error_names(status),
                        "certificate": certificate,
                        "isMainFrame": true,
                    });
                    if !emit(&app, CERTIFICATE_EVENT, payload) {
                        answer(id, &json!({ "trusted": false }));
                    }
                    Ok(())
                },
            ));
            let mut token = 0i64;
            unsafe {
                let _ = core14.add_ServerCertificateErrorDetected(&handler, &mut token);
            }
        }
        if let Ok(core10) = core.cast::<ICoreWebView2_10>() {
            let (app, label) = (app.clone(), label.to_string());
            let handler = BasicAuthenticationRequestedEventHandler::create(Box::new(
                move |_, args| unsafe {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let url = take_pwstr(uri);
                    let mut challenge = PWSTR::null();
                    args.Challenge(&mut challenge)?;
                    let challenge = take_pwstr(challenge);
                    let parsed = tauri::Url::parse(&url).ok();
                    let deferral = args.GetDeferral()?;
                    let id = app.state::<TlsAuth>().id();
                    PENDING.with(|p| {
                        p.borrow_mut()
                            .insert(id, Pending::Login(args.clone(), deferral))
                    });
                    let payload = json!({
                        "id": id,
                        "label": label,
                        "url": url,
                        "scheme": challenge.split_whitespace().next().unwrap_or("basic").to_ascii_lowercase(),
                        "host": parsed.as_ref().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default(),
                        "port": parsed.as_ref().and_then(|u| u.port_or_known_default()).unwrap_or(0),
                        "realm": realm_of(&challenge),
                        "isProxy": false,
                    });
                    if !emit(&app, LOGIN_EVENT, payload) {
                        answer(id, &json!({ "cancel": true }));
                    }
                    Ok(())
                },
            ));
            let mut token = 0i64;
            unsafe {
                let _ = core10.add_BasicAuthenticationRequested(&handler, &mut token);
            }
        }
        if let Ok(core5) = core.cast::<ICoreWebView2_5>() {
            let (app, label) = (app.clone(), label.to_string());
            let handler =
                ClientCertificateRequestedEventHandler::create(Box::new(move |_, args| unsafe {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut host = PWSTR::null();
                    args.Host(&mut host)?;
                    let mut port = 0i32;
                    args.Port(&mut port)?;
                    let mut certificates = Vec::new();
                    if let Ok(collection) = args.MutuallyTrustedCertificates() {
                        let mut count = 0u32;
                        collection.Count(&mut count)?;
                        for index in 0..count {
                            if let Ok(certificate) = collection.GetValueAtIndex(index) {
                                certificates.push(certificate);
                            }
                        }
                    }
                    let chains: Vec<Vec<String>> =
                        certificates.iter().map(|c| client_chain(c)).collect();
                    let deferral = args.GetDeferral()?;
                    let id = app.state::<TlsAuth>().id();
                    PENDING.with(|p| {
                        p.borrow_mut()
                            .insert(id, Pending::Client(args.clone(), deferral, certificates))
                    });
                    let payload = json!({
                        "id": id,
                        "label": label,
                        "url": format!("https://{}:{}", take_pwstr(host), port),
                        "certificates": chains,
                    });
                    if !emit(&app, CLIENT_CERTIFICATE_EVENT, payload) {
                        answer(id, &json!({ "certificate": 0 }));
                    }
                    Ok(())
                }));
            let mut token = 0i64;
            unsafe {
                let _ = core5.add_ClientCertificateRequested(&handler, &mut token);
            }
        }
    }

    pub fn answer(id: u32, answer: &Value) {
        let Some(pending) = PENDING.with(|p| p.borrow_mut().remove(&id)) else {
            return;
        };
        unsafe {
            match pending {
                Pending::Certificate(args, deferral) => {
                    let action = if answer.get("trusted").and_then(Value::as_bool) == Some(true) {
                        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW
                    } else {
                        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL
                    };
                    let _ = args.SetAction(action);
                    let _ = deferral.Complete();
                }
                Pending::Login(args, deferral) => {
                    match answer.get("username").and_then(Value::as_str) {
                        Some(username) => {
                            if let Ok(response) = args.Response() {
                                let password =
                                    answer.get("password").and_then(Value::as_str).unwrap_or("");
                                let _ = response.SetUserName(&HSTRING::from(username));
                                let _ = response.SetPassword(&HSTRING::from(password));
                            }
                        }
                        None => {
                            let _ = args.SetCancel(true);
                        }
                    }
                    let _ = deferral.Complete();
                }
                Pending::Client(args, deferral, certificates) => {
                    let index = answer
                        .get("certificate")
                        .and_then(Value::as_i64)
                        .unwrap_or(-1);
                    match usize::try_from(index)
                        .ok()
                        .and_then(|i| certificates.get(i))
                    {
                        Some(certificate) => {
                            let _ = args.SetSelectedCertificate(certificate);
                        }
                        None => {
                            let _ = args.SetSelectedCertificate(None);
                        }
                    }
                    let _ = args.SetHandled(true);
                    let _ = deferral.Complete();
                }
            }
        }
    }
}

/// `Basic realm="x"` → `x`.
#[allow(dead_code)]
pub fn realm_of(challenge: &str) -> String {
    let lower = challenge.to_ascii_lowercase();
    let Some(start) = lower.find("realm=") else {
        return String::new();
    };
    let rest = &challenge[start + "realm=".len()..];
    if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split('"').next().unwrap_or("").to_string()
    } else {
        rest.split([',', ' ']).next().unwrap_or("").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realms_and_hosts() {
        assert_eq!(realm_of(r#"Basic realm="Kitchen sink""#), "Kitchen sink");
        assert_eq!(realm_of("Digest realm=office, nonce=\"x\""), "office");
        assert_eq!(realm_of("Negotiate"), "");
        assert_eq!(
            host_of("https://localhost:8443/x").as_deref(),
            Some("localhost")
        );
        assert_eq!(host_of("https://[::1]:8443/").as_deref(), Some("::1"));
        assert_eq!(host_of("nope"), None);
    }

    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    #[test]
    fn tls_flags_have_names() {
        use webkit2gtk::gio::TlsCertificateFlags as F;
        assert_eq!(
            gtk::flag_names(F::UNKNOWN_CA | F::BAD_IDENTITY),
            vec!["unknown-ca", "bad-identity"]
        );
        assert!(gtk::flag_names(F::empty()).is_empty());
    }
}
