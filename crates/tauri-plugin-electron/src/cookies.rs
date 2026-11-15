//! `session.cookies` on top of the webview's cookie store (`Webview::cookies`,
//! `cookies_for_url`, `set_cookie`, `delete_cookie`).
//!
//! Cookies are read and written as Electron's `Cookie` objects: `name`,
//! `value`, `domain`, `path`, `secure`, `httpOnly`, `session`,
//! `expirationDate` (seconds since the epoch) and `sameSite`. `hostOnly`
//! (optional in Electron) is left out: the `cookie` crate drops the leading
//! dot that tells domain cookies apart.

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    webview::cookie::{time::OffsetDateTime, Cookie, Expiration, SameSite},
    Runtime, Url, WebviewWindow as Webview,
};

/// A cookie as Electron reports it.
pub fn to_json(cookie: &Cookie<'_>) -> Value {
    let expires = cookie
        .expires_datetime()
        .map(|t| t.unix_timestamp_nanos() as f64 / 1e9);
    json!({
        "name": cookie.name(),
        "value": cookie.value(),
        "domain": cookie.domain().unwrap_or_default(),
        "path": cookie.path().unwrap_or("/"),
        "secure": cookie.secure().unwrap_or(false),
        "httpOnly": cookie.http_only().unwrap_or(false),
        "session": expires.is_none(),
        "expirationDate": expires,
        "sameSite": match cookie.same_site() {
            Some(SameSite::Strict) => "strict",
            Some(SameSite::Lax) => "lax",
            Some(SameSite::None) => "no_restriction",
            None => "unspecified",
        },
    })
}

/// `cookies.get(filter)`: every cookie, or those sent to `url`. The other
/// filter fields are applied in JavaScript.
pub fn get<R: Runtime>(webview: &Webview<R>, url: Option<&str>) -> Result<Value, String> {
    let cookies = match url {
        Some(url) => webview.cookies_for_url(parse_url(url)?),
        None => webview.cookies(),
    }
    .map_err(|e| e.to_string())?;
    Ok(Value::Array(cookies.iter().map(to_json).collect()))
}

/// `cookies.set(details)`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    url: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    value: String,
    domain: Option<String>,
    path: Option<String>,
    #[serde(default)]
    secure: bool,
    #[serde(default)]
    http_only: bool,
    expiration_date: Option<f64>,
    same_site: Option<String>,
}

pub fn set<R: Runtime>(webview: &Webview<R>, details: Details) -> Result<Value, String> {
    let url = parse_url(&details.url)?;
    let host = url
        .host_str()
        .ok_or_else(|| {
            format!(
                "Failed to set cookie with an invalid domain attribute: {}",
                details.url
            )
        })?
        .to_string();
    let domain = details.domain.filter(|d| !d.is_empty()).unwrap_or(host);
    let mut builder = Cookie::build((details.name, details.value))
        .domain(domain)
        .path(details.path.unwrap_or_else(|| "/".into()))
        .secure(details.secure)
        .http_only(details.http_only);
    if let Some(seconds) = details.expiration_date {
        let at = OffsetDateTime::from_unix_timestamp_nanos((seconds * 1e9) as i128)
            .map_err(|e| e.to_string())?;
        builder = builder.expires(Expiration::DateTime(at));
    }
    builder = match details.same_site.as_deref() {
        Some("strict") => builder.same_site(SameSite::Strict),
        Some("lax") => builder.same_site(SameSite::Lax),
        Some("no_restriction") => builder.same_site(SameSite::None),
        _ => builder,
    };
    let cookie = builder.build();
    webview
        .set_cookie(cookie.clone())
        .map_err(|e| e.to_string())?;
    Ok(to_json(&cookie))
}

/// `cookies.remove(url, name)`: deletes the cookies named `name` sent to
/// `url`, and returns them.
pub fn remove<R: Runtime>(webview: &Webview<R>, url: &str, name: &str) -> Result<Value, String> {
    let cookies = webview
        .cookies_for_url(parse_url(url)?)
        .map_err(|e| e.to_string())?;
    let mut removed = Vec::new();
    for cookie in cookies.into_iter().filter(|c| c.name() == name) {
        webview
            .delete_cookie(cookie.clone())
            .map_err(|e| e.to_string())?;
        removed.push(to_json(&cookie));
    }
    Ok(Value::Array(removed))
}

fn parse_url(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("invalid URL '{url}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_json() {
        let cookie = Cookie::build(("a", "1"))
            .domain(".example.com")
            .path("/x")
            .secure(true)
            .same_site(SameSite::Lax)
            .expires(Expiration::DateTime(
                OffsetDateTime::from_unix_timestamp(2_000_000_000).unwrap(),
            ))
            .build();
        let value = to_json(&cookie);
        assert_eq!(value["domain"], json!("example.com"));
        assert_eq!(value["sameSite"], json!("lax"));
        assert_eq!(value["expirationDate"], json!(2_000_000_000.0));
        assert_eq!(value["session"], json!(false));
        let session = to_json(&Cookie::build(("b", "2")).domain("example.com").build());
        assert_eq!(
            (&session["session"], &session["path"], &session["sameSite"]),
            (&json!(true), &json!("/"), &json!("unspecified"))
        );
    }
}
