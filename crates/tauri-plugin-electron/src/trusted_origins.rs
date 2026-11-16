//! Trusted origins: pages the app does not serve itself but trusts like its
//! own, typically a server it starts on loopback (SiYuan's kernel at
//! `http://127.0.0.1:6806`). Electron runs a window's preload in whatever
//! page it shows; here the bundler puts the renderer bootstrap and the
//! preload in the app's own HTML, which such pages are not. So:
//!
//! - every BrowserWindow gets the renderer script (bootstrap + preloads,
//!   built by the bundler plugins and handed over by the main process with
//!   [`set_trusted_renderer`]) as an initialization script that runs it only
//!   when the page's origin is on the list, checked on every page load;
//! - Tauri grants the renderer permissions (IPC) to the listed origins
//!   (`remote.urls` of the `electron-trusted-origins` capability), and the
//!   synchronous bridge answers them (`window-config`, `sync-ipc`), as it
//!   answers the app's own pages and nothing else;
//! - with `node: true`, windows created with `nodeIntegration` (or
//!   `sandbox: false`) keep their Node built-ins on that origin.
//!
//! The list is declared when the app is built, in `tauri.conf.json`:
//!
//! ```json
//! "plugins": {
//!   "electron": {
//!     "trustedOrigins": ["http://127.0.0.1:*", { "origin": "http://localhost:6806", "node": true }]
//!   }
//! }
//! ```
//!
//! or with [`crate::Builder::trusted_origin`]. Nothing a renderer does changes it.
//!
//! What may be listed: `http` only on loopback hosts (`localhost`,
//! `127.0.0.0/8`, `[::1]`), where `*` may stand for the port of a server
//! that picks it at startup; `https` on any host, with a fixed port. No
//! host wildcards, paths or credentials. `node: true` on loopback only.

use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindowBuilder};

use crate::MAIN_LABEL;

/// One entry of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedOrigin {
    /// `http` or `https`.
    scheme: String,
    /// As `Url::host_str` gives it: lower case, IPv6 in brackets.
    host: String,
    /// `None`: any port (loopback hosts only).
    port: Option<u16>,
    /// Windows with Node built-ins keep them on this origin.
    node: bool,
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

impl TrustedOrigin {
    /// An entry of `trustedOrigins`: `"http://127.0.0.1:*"` or
    /// `{ "origin": "http://127.0.0.1:*", "node": true }`.
    pub fn parse(entry: &Value) -> Result<Self, String> {
        match entry {
            Value::String(origin) => Self::parse_origin(origin, false),
            Value::Object(map) => {
                if let Some(key) = map.keys().find(|k| *k != "origin" && *k != "node") {
                    return Err(format!(
                        "unknown key '{key}' (an entry has `origin` and `node`)"
                    ));
                }
                let origin = map
                    .get("origin")
                    .and_then(Value::as_str)
                    .ok_or("an entry needs an `origin` string")?;
                let node = match map.get("node") {
                    None => false,
                    Some(Value::Bool(node)) => *node,
                    Some(_) => return Err(format!("'{origin}': `node` must be true or false")),
                };
                Self::parse_origin(origin, node)
            }
            _ => Err(format!(
                "{entry}: an entry is an origin string or {{ \"origin\": …, \"node\": … }}"
            )),
        }
    }

    fn parse_origin(text: &str, node: bool) -> Result<Self, String> {
        let fail = |why: &str| format!("'{text}': {why}");
        let (scheme, rest) = text
            .split_once("://")
            .ok_or_else(|| fail("an origin looks like http://127.0.0.1:6806"))?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return Err(fail("only http and https origins can be trusted"));
        }
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        if rest.is_empty() || rest.contains(['/', '?', '#', '@', '\\']) {
            return Err(fail(
                "an origin is a scheme, a host and a port: no path, query or credentials",
            ));
        }
        let (host, port) = match rest.strip_prefix('[') {
            Some(inside) => {
                let (address, tail) = inside
                    .split_once(']')
                    .ok_or_else(|| fail("unclosed IPv6 address"))?;
                let port = match tail {
                    "" => None,
                    tail => Some(
                        tail.strip_prefix(':')
                            .ok_or_else(|| fail("unexpected text after the IPv6 address"))?,
                    ),
                };
                (format!("[{address}]"), port)
            }
            None => match rest.rsplit_once(':') {
                Some((host, port)) => (host.to_string(), Some(port)),
                None => (rest.to_string(), None),
            },
        };
        if host.contains('*') {
            return Err(fail("hosts cannot be wildcards; list each host"));
        }
        let default_port = if scheme == "https" { 443 } else { 80 };
        let port = match port {
            None => Some(default_port),
            Some("*") => None,
            Some(port) => Some(
                port.parse::<u16>()
                    .ok()
                    .filter(|port| *port != 0)
                    .ok_or_else(|| fail("the port is a number or *"))?,
            ),
        };
        let url = Url::parse(&format!("{scheme}://{host}/")).map_err(|e| fail(&e.to_string()))?;
        let host = url
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| fail("no host"))?
            .to_string();
        let loopback = is_loopback(&host);
        if scheme == "http" && !loopback {
            return Err(fail(
                "plain http is only trusted on loopback hosts (localhost, 127.0.0.1, [::1]); anyone on the network could serve that page: use https",
            ));
        }
        if port.is_none() && !loopback {
            return Err(fail(
                "a port wildcard is only allowed on loopback hosts (localhost, 127.0.0.1, [::1])",
            ));
        }
        if node && !loopback {
            return Err(fail(
                "`node: true` is only allowed for loopback origins (localhost, 127.0.0.1, [::1])",
            ));
        }
        Ok(Self {
            scheme,
            host,
            port,
            node,
        })
    }

    fn default_port(&self) -> u16 {
        if self.scheme == "https" {
            443
        } else {
            80
        }
    }

    pub fn matches(&self, url: &Url) -> bool {
        url.scheme() == self.scheme
            && url.host_str() == Some(self.host.as_str())
            && self
                .port
                .is_none_or(|port| url.port_or_known_default() == Some(port))
    }

    /// The origin as written in configuration (`*` for any port).
    pub fn origin(&self) -> String {
        match self.port {
            None => format!("{}://{}:*", self.scheme, self.host),
            Some(port) if port == self.default_port() => format!("{}://{}", self.scheme, self.host),
            Some(port) => format!("{}://{}:{port}", self.scheme, self.host),
        }
    }

    /// The URLPattern of Tauri's `remote.urls` (any path, query and fragment).
    /// A default port is left out: URLs do not carry it. The colons of an
    /// IPv6 address are escaped (a `:` starts a named group in URLPatterns).
    pub fn pattern(&self) -> String {
        let host = self.host.replace(':', "\\:");
        match self.port {
            None => format!("{}://{host}:*", self.scheme),
            Some(port) if port == self.default_port() => format!("{}://{host}", self.scheme),
            Some(port) => format!("{}://{host}:{port}", self.scheme),
        }
    }

    /// What the main process needs to know (`process_info`).
    fn describe(&self) -> Value {
        json!({
            "origin": self.origin(),
            "scheme": self.scheme,
            "host": self.host,
            "port": self.port,
            "node": self.node,
        })
    }
}

/// The list, and the renderer script the main process registered.
#[derive(Default)]
pub struct TrustedOrigins {
    origins: Vec<TrustedOrigin>,
    /// Schemes of `Builder::protocol`: their pages are the app's own, as Tauri sees them.
    schemes: Vec<String>,
    /// The development server's origin, never injected (its pages have the bootstrap already).
    dev_origin: Option<String>,
    /// The initialization script built from the main process's renderer script.
    script: Mutex<Option<Arc<str>>>,
}

/// Collect the list from `tauri.conf.json` and the builder, keep it, and grant
/// the listed origins the renderer permissions (`capabilities`: the builder's
/// `default_capabilities`). An invalid entry stops the app: it is a security
/// setting, better refused loudly than ignored.
pub fn setup<R: Runtime>(
    app: &AppHandle<R>,
    declared: Vec<Value>,
    schemes: Vec<String>,
    capabilities: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut entries = declared;
    match app
        .config()
        .plugins
        .0
        .get("electron")
        .and_then(|config| config.get("trustedOrigins"))
    {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => entries.extend(list.iter().cloned()),
        Some(_) => {
            return Err("tauri.conf.json plugins.electron.trustedOrigins must be a list".into())
        }
    }
    let mut origins: Vec<TrustedOrigin> = Vec::new();
    for entry in &entries {
        let origin = TrustedOrigin::parse(entry)
            .map_err(|error| format!("tauri-plugin-electron trusted origin {error}"))?;
        match origins
            .iter_mut()
            .find(|o| o.scheme == origin.scheme && o.host == origin.host && o.port == origin.port)
        {
            Some(same) => same.node |= origin.node,
            None => origins.push(origin),
        }
    }
    let dev_origin = if cfg!(debug_assertions) {
        app.config()
            .build
            .dev_url
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
    } else {
        None
    };
    if capabilities && !origins.is_empty() {
        app.add_capability(capability(&origins).to_string())?;
    }
    app.manage(TrustedOrigins {
        origins,
        schemes,
        dev_origin,
        script: Mutex::new(None),
    });
    Ok(())
}

/// The renderer permissions (IPC, zoom, window dragging, …) for the listed
/// origins in every window, as `electron-renderer` gives them to the app's pages.
fn capability(origins: &[TrustedOrigin]) -> Value {
    json!({
        "identifier": "electron-trusted-origins",
        "description": "Pages of the origins listed in plugins.electron.trustedOrigins: what the app's own renderer pages may do (IPC with the main process, zoom, window dragging).",
        "local": false,
        "windows": ["*"],
        "remote": { "urls": origins.iter().map(TrustedOrigin::pattern).collect::<Vec<_>>() },
        "permissions": crate::features::RENDERER,
    })
}

fn state<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, TrustedOrigins>> {
    app.try_state::<TrustedOrigins>()
}

fn page_url<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<Url> {
    app.get_webview_window(label).and_then(|w| w.url().ok())
}

/// The entry the webview's current page is on, if any.
pub fn find<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<TrustedOrigin> {
    let state = state(app)?;
    if state.origins.is_empty() {
        return None;
    }
    let url = page_url(app, label)?;
    state.origins.iter().find(|o| o.matches(&url)).cloned()
}

/// A page served by one of the plugin's custom schemes (`Builder::protocol`):
/// `app://…`, or `http(s)://app.localhost/…` on Windows and Android.
fn is_scheme_page(schemes: &[String], url: &Url) -> bool {
    schemes.iter().any(|s| s == url.scheme())
        || (matches!(url.scheme(), "http" | "https")
            && url
                .host_str()
                .and_then(|host| host.strip_suffix(".localhost"))
                .is_some_and(|scheme| schemes.iter().any(|s| s == scheme)))
}

/// Whether the webview's page may use the synchronous bridge's IPC
/// (`window-config`, `sync-ipc`): the app's own pages, its custom schemes'
/// pages and the trusted origins; the main window always. A webview that is
/// not a window (a child webview, which only Tauri's `unstable` API creates)
/// is not looked up here and keeps the bridge, as before trusted origins.
pub fn ipc_allowed<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    if label == MAIN_LABEL || crate::is_app_page(app, label) {
        return true;
    }
    let Some(window) = app.get_webview_window(label) else {
        return true;
    };
    let Ok(url) = window.url() else {
        return false;
    };
    state(app).is_some_and(|state| {
        is_scheme_page(&state.schemes, &url) || state.origins.iter().any(|o| o.matches(&url))
    })
}

/// Whether the webview shows a trusted origin whose entry says `node: true`
/// (Node built-ins still need a window the main process granted them).
pub fn node_page<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    find(app, label).is_some_and(|origin| origin.node)
}

/// The URLPatterns of the origins with `node: true`, for the capability of
/// a window with Node built-ins (`node_windows::grant`).
pub fn node_patterns<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    state(app)
        .map(|state| {
            state
                .origins
                .iter()
                .filter(|o| o.node)
                .map(TrustedOrigin::pattern)
                .collect()
        })
        .unwrap_or_default()
}

/// The list for the main process (`process_info`).
pub fn describe<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    state(app)
        .map(|state| state.origins.iter().map(TrustedOrigin::describe).collect())
        .unwrap_or_default()
}

/// The window configuration the bridge's `window-config` returns to the page
/// shown now, or `None` when the page may not have it. On a trusted origin
/// without `node: true`, the window's Node grant does not apply, and the
/// environment is withheld as for a sandboxed, context-isolated window.
pub fn page_config<R: Runtime>(app: &AppHandle<R>, label: &str, config: Value) -> Option<Value> {
    if label == MAIN_LABEL || crate::is_app_page(app, label) {
        return Some(config);
    }
    match find(app, label) {
        Some(origin) => Some(if origin.node {
            config
        } else {
            without_node(config)
        }),
        None if ipc_allowed(app, label) => Some(config),
        None => None,
    }
}

fn without_node(mut config: Value) -> Value {
    if let Some(map) = config.as_object_mut() {
        if map.get("node").and_then(Value::as_bool) == Some(true) {
            map.insert("node".into(), json!(false));
            if map.get("contextIsolation").and_then(Value::as_bool) != Some(false) {
                map.insert("env".into(), json!({}));
            }
        }
    }
    config
}

/// The initialization script: the renderer script, run only on the listed
/// origins (never on the development server's own pages, which load it
/// themselves), once per page.
fn wrap(origins: &[TrustedOrigin], dev_origin: Option<&str>, script: &str) -> String {
    let list: Vec<Value> = origins
        .iter()
        .map(|o| {
            json!([
                format!("{}:", o.scheme),
                o.host,
                o.port.map(|p| p.to_string()).unwrap_or_default()
            ])
        })
        .collect();
    format!(
        r#";(function () {{
  var trusted = {list};
  var dev = {dev};
  var l = window.location;
  var port = l.port || (l.protocol === "https:" ? "443" : "80");
  var ok = false;
  for (var i = 0; i < trusted.length; i++) {{
    var t = trusted[i];
    if (t[0] === l.protocol && t[1] === l.hostname && (t[2] === "" || t[2] === port)) ok = true;
  }}
  if (!ok || l.origin === dev || window.__TAURI_ELECTRON_TRUSTED__) return;
  Object.defineProperty(window, "__TAURI_ELECTRON_TRUSTED__", {{ value: true }});
{script}
}})();
"#,
        list = Value::Array(list),
        dev = json!(dev_origin),
    )
}

/// Give a new window the renderer script for the trusted origins (see
/// `windows::create_window`). Nothing when none are declared or the main
/// process has not registered the script.
pub fn initialization_script<'a, R: Runtime, M: Manager<R>>(
    app: &AppHandle<R>,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let script = state(app).and_then(|state| state.script.lock().unwrap().clone());
    match script {
        Some(script) => builder.initialization_script(script.to_string()),
        None => builder,
    }
}

/// The main process hands over the renderer script the bundler plugins built
/// for the trusted origins (the bootstrap and the preloads, one classic
/// script). Windows created afterwards run it on those origins.
#[tauri::command]
pub fn set_trusted_renderer<R: Runtime>(
    webview: tauri::Webview<R>,
    script: String,
) -> Result<bool, String> {
    if webview.label() != MAIN_LABEL {
        return Err("the renderer script is set by the main process only".into());
    }
    let Some(state) = webview.try_state::<TrustedOrigins>() else {
        return Ok(false);
    };
    if state.origins.is_empty() {
        return Ok(false);
    }
    let wrapped = wrap(&state.origins, state.dev_origin.as_deref(), &script);
    *state.script.lock().unwrap() = Some(Arc::from(wrapped));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tauri::utils::acl::RemoteUrlPattern;

    fn parse(entry: Value) -> Result<TrustedOrigin, String> {
        TrustedOrigin::parse(&entry)
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn loopback_origins_with_any_or_one_port() {
        let any = parse(json!("http://127.0.0.1:*")).unwrap();
        assert!(any.matches(&url("http://127.0.0.1:6806/stage/index.html?x=1")));
        assert!(any.matches(&url("http://127.0.0.1/")));
        assert!(!any.matches(&url("http://localhost:6806/")));
        assert!(!any.matches(&url("https://127.0.0.1:6806/")));
        let one = parse(json!({ "origin": "http://LOCALHOST:6806/", "node": true })).unwrap();
        assert_eq!(one.origin(), "http://localhost:6806");
        assert!(one.node);
        assert!(one.matches(&url("http://localhost:6806/a")));
        assert!(!one.matches(&url("http://localhost:6807/a")));
        let ipv6 = parse(json!("http://[::1]:*")).unwrap();
        assert!(ipv6.matches(&url("http://[::1]:8080/")));
        let default = parse(json!("https://app.example.com")).unwrap();
        assert!(default.matches(&url("https://app.example.com/x")));
        assert!(default.matches(&url("https://app.example.com:443/x")));
        assert!(!default.matches(&url("https://app.example.com:8443/x")));
        assert!(parse(json!("http://127.1:5000"))
            .unwrap()
            .matches(&url("http://127.0.0.1:5000/")));
    }

    #[test]
    fn refuses_what_could_be_impersonated() {
        for (entry, why) in [
            (json!("http://example.com"), "plain http"),
            (json!("https://example.com:*"), "port wildcard"),
            (json!("https://*.example.com"), "wildcards"),
            (
                json!({ "origin": "https://example.com", "node": true }),
                "loopback origins",
            ),
            (json!("http://127.0.0.1:6806/app"), "no path"),
            (json!("http://user@127.0.0.1"), "no path"),
            (json!("file:///tmp"), "only http and https"),
            (json!("127.0.0.1:6806"), "looks like"),
            (json!("http://127.0.0.1:0"), "port"),
            (json!("http://127.0.0.1:abc"), "port"),
            (
                json!({ "origin": "http://127.0.0.1", "nodeIntegration": true }),
                "unknown key",
            ),
            (
                json!({ "origin": "http://127.0.0.1", "node": "yes" }),
                "true or false",
            ),
            (json!(42), "an entry is"),
        ] {
            let error = parse(entry.clone()).unwrap_err();
            assert!(error.contains(why), "{entry}: {error}");
        }
    }

    #[test]
    fn tauri_patterns_match_the_same_urls() {
        for (origin, yes, no) in [
            (
                "http://127.0.0.1:*",
                "http://127.0.0.1:6806/a/b?c#d",
                "http://127.0.0.2:6806/",
            ),
            (
                "http://127.0.0.1:*",
                "http://127.0.0.1/",
                "https://127.0.0.1/",
            ),
            (
                "http://localhost:6806",
                "http://localhost:6806/x",
                "http://localhost:6807/x",
            ),
            (
                "https://app.example.com",
                "https://app.example.com/x",
                "https://app.example.com:8443/x",
            ),
            (
                "https://app.example.com:8443",
                "https://app.example.com:8443/",
                "https://app.example.com/",
            ),
            (
                "http://[::1]:*",
                "http://[::1]:6806/x",
                "http://127.0.0.1:6806/x",
            ),
        ] {
            let entry = parse(json!(origin)).unwrap();
            let pattern = RemoteUrlPattern::from_str(&entry.pattern()).unwrap();
            assert!(pattern.test(&url(yes)), "{origin} should match {yes}");
            assert!(!pattern.test(&url(no)), "{origin} should not match {no}");
            assert!(entry.matches(&url(yes)) && !entry.matches(&url(no)));
        }
    }

    #[test]
    fn capability_and_script() {
        let origins = vec![
            parse(json!("http://127.0.0.1:*")).unwrap(),
            parse(json!("https://app.example.com")).unwrap(),
        ];
        let capability = capability(&origins);
        assert_eq!(capability["local"], json!(false));
        assert_eq!(
            capability["remote"]["urls"],
            json!(["http://127.0.0.1:*", "https://app.example.com"])
        );
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("core:event:default")));
        let script = wrap(
            &origins,
            Some("http://localhost:1421"),
            "RENDERER();//# sourceMappingURL=x",
        );
        assert!(script.contains(r#"[["http:","127.0.0.1",""],["https:","app.example.com","443"]]"#));
        assert!(script.contains(r#"var dev = "http://localhost:1421";"#));
        // The script's last line comment does not swallow the wrapper's end.
        assert!(script.contains("RENDERER();//# sourceMappingURL=x\n})();"));
    }

    #[test]
    fn config_without_node_on_origins_that_do_not_allow_it() {
        let config =
            json!({ "node": true, "contextIsolation": true, "env": { "A": "1" }, "argv": [] });
        assert_eq!(
            without_node(config),
            json!({ "node": false, "contextIsolation": true, "env": {}, "argv": [] })
        );
        let open = json!({ "node": true, "contextIsolation": false, "env": { "A": "1" } });
        assert_eq!(without_node(open)["env"], json!({ "A": "1" }));
        assert_eq!(
            without_node(json!({ "node": false, "env": {} })),
            json!({ "node": false, "env": {} })
        );
    }

    #[test]
    fn custom_scheme_pages() {
        let schemes = vec!["kitchen".to_string()];
        assert!(is_scheme_page(
            &schemes,
            &url("kitchen://localhost/page.html")
        ));
        assert!(is_scheme_page(
            &schemes,
            &url("http://kitchen.localhost/page.html")
        ));
        assert!(!is_scheme_page(&schemes, &url("http://other.localhost/")));
        assert!(!is_scheme_page(&schemes, &url("http://127.0.0.1/")));
    }
}
