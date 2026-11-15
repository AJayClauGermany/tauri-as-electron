//! keytar (feature `keytar`): passwords in the operating system's keychain,
//! stored as keytar stores them, so an app moving from Electron finds the
//! entries it saved there:
//!
//! - **macOS**: generic passwords (service, account) in the login keychain,
//!   through `keyring` (B3's crate); `findCredentials` searches the keychain
//!   with security-framework.
//! - **Windows**: generic credentials named `<service>/<account>` with the
//!   password as UTF-8 bytes, through `keyring`; `findCredentials` lists
//!   them with `CredEnumerateW`.
//! - **Linux / BSD**: Secret Service items with libsecret's
//!   `org.freedesktop.Secret.Generic` schema and keytar's `service` /
//!   `account` attributes, labelled `<service>/<account>`, in the default
//!   collection. keyring's own items carry other attributes, so this talks
//!   to the Secret Service through the crate keyring is built on
//!   (dbus-secret-service), which also searches. Without a Secret Service
//!   every call fails, as keytar's does: nothing is stored in plain text.
//!
//! Locked items and collections are unlocked first, which may prompt.

use serde_json::{json, Value};

/// One credential found by `findCredentials`.
struct Credential {
    account: String,
    password: String,
}

fn text(request: &Value, key: &str) -> Result<String, Value> {
    request[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| json!({ "message": format!("{key} is required.") }))
}

fn failure(message: impl std::fmt::Display) -> Value {
    json!({ "message": message.to_string() })
}

/// `{ op, service, account?, password? }` → keytar's answer.
pub fn run(request: &Value) -> Result<Value, Value> {
    let op = request["op"].as_str().unwrap_or_default();
    let service = text(request, "service")?;
    match op {
        "get" => Ok(json!(
            platform::get(&service, &text(request, "account")?).map_err(failure)?
        )),
        "set" => {
            platform::set(
                &service,
                &text(request, "account")?,
                &text(request, "password")?,
            )
            .map_err(failure)?;
            Ok(Value::Null)
        }
        "delete" => Ok(json!(platform::delete(
            &service,
            &text(request, "account")?
        )
        .map_err(failure)?)),
        "find" => {
            let found = platform::find(&service).map_err(failure)?;
            Ok(Value::Array(
                found
                    .into_iter()
                    .map(|c| json!({ "account": c.account, "password": c.password }))
                    .collect(),
            ))
        }
        "findOne" => {
            let found = platform::find(&service).map_err(failure)?;
            Ok(json!(found.into_iter().next().map(|c| c.password)))
        }
        other => Err(failure(format!("unknown keytar operation '{other}'"))),
    }
}

/// UTF-8 text of a stored secret (keytar stores UTF-8 on every platform).
fn utf8(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

// --- Linux / BSD: the Secret Service -------------------------------------------------------------

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "ios", target_os = "android"))
))]
mod platform {
    use std::collections::HashMap;

    use dbus_secret_service::{EncryptionType, Item, SecretService};

    use super::{utf8, Credential};

    /// The libsecret schema keytar stores with (libsecret adds it as `xdg:schema`).
    const SCHEMA: &str = "org.freedesktop.Secret.Generic";

    fn connect() -> Result<SecretService, String> {
        SecretService::connect(EncryptionType::Dh).map_err(|e| e.to_string())
    }

    fn attributes<'a>(service: &'a str, account: Option<&'a str>) -> HashMap<&'a str, &'a str> {
        let mut map = HashMap::from([("xdg:schema", SCHEMA), ("service", service)]);
        if let Some(account) = account {
            map.insert("account", account);
        }
        map
    }

    /// Items with these attributes in any collection, unlocked.
    fn search<'a>(
        ss: &'a SecretService,
        attributes: HashMap<&str, &str>,
    ) -> Result<Vec<Item<'a>>, String> {
        let found = ss.search_items(attributes).map_err(|e| e.to_string())?;
        if !found.locked.is_empty() {
            let locked: Vec<&Item> = found.locked.iter().collect();
            ss.unlock_all(&locked).map_err(|e| e.to_string())?;
        }
        Ok(found.unlocked.into_iter().chain(found.locked).collect())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        let ss = connect()?;
        match search(&ss, attributes(service, Some(account)))?.first() {
            Some(item) => Ok(Some(utf8(item.get_secret().map_err(|e| e.to_string())?))),
            None => Ok(None),
        }
    }

    pub fn set(service: &str, account: &str, password: &str) -> Result<(), String> {
        let ss = connect()?;
        let collection = ss
            .get_default_collection()
            .or_else(|_| ss.get_any_collection())
            .map_err(|e| e.to_string())?;
        collection.ensure_unlocked().map_err(|e| e.to_string())?;
        collection
            .create_item(
                &format!("{service}/{account}"),
                attributes(service, Some(account)),
                password.as_bytes(),
                true,
                "text/plain",
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Every matching item, as libsecret's `secret_password_clear_sync` does.
    pub fn delete(service: &str, account: &str) -> Result<bool, String> {
        let ss = connect()?;
        let items = search(&ss, attributes(service, Some(account)))?;
        for item in &items {
            item.delete().map_err(|e| e.to_string())?;
        }
        Ok(!items.is_empty())
    }

    pub fn find(service: &str) -> Result<Vec<Credential>, String> {
        let ss = connect()?;
        let mut found = Vec::new();
        for item in search(&ss, attributes(service, None))? {
            let attributes = item.get_attributes().map_err(|e| e.to_string())?;
            let Some(account) = attributes.get("account") else {
                continue;
            };
            found.push(Credential {
                account: account.clone(),
                password: utf8(item.get_secret().map_err(|e| e.to_string())?),
            });
        }
        Ok(found)
    }
}

// --- macOS and Windows: keyring, plus a search of our own ----------------------------------------

#[cfg(any(target_os = "macos", windows))]
mod platform {
    use super::{utf8, Credential};

    /// keytar's item for (service, account): the generic password of that
    /// service and account on macOS, the credential `<service>/<account>` on
    /// Windows.
    fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
        #[cfg(windows)]
        let entry =
            keyring::Entry::new_with_target(&format!("{service}/{account}"), service, account);
        #[cfg(not(windows))]
        let entry = keyring::Entry::new(service, account);
        entry.map_err(|e| e.to_string())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        // Raw bytes: keytar stores UTF-8 (keyring's passwords are UTF-16 on Windows).
        match entry(service, account)?.get_secret() {
            Ok(bytes) => Ok(Some(utf8(bytes))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn set(service: &str, account: &str, password: &str) -> Result<(), String> {
        entry(service, account)?
            .set_secret(password.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, account: &str) -> Result<bool, String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn find(service: &str) -> Result<Vec<Credential>, String> {
        let mut found = Vec::new();
        for account in accounts(service)? {
            if let Some(password) = get(service, &account)? {
                found.push(Credential { account, password });
            }
        }
        Ok(found)
    }

    /// The accounts with a generic password for `service`.
    #[cfg(target_os = "macos")]
    fn accounts(service: &str) -> Result<Vec<String>, String> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        /// errSecItemNotFound
        const NOT_FOUND: i32 = -25300;
        let results = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(service)
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        match results {
            Ok(results) => Ok(results
                .into_iter()
                .filter_map(|result| result.simplify_dict()?.get("acct").cloned())
                .collect()),
            Err(error) if error.code() == NOT_FOUND => Ok(Vec::new()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// The accounts of the credentials named `<service>/…`.
    #[cfg(windows)]
    fn accounts(service: &str) -> Result<Vec<String>, String> {
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_NOT_FOUND},
            Security::Credentials::{CredEnumerateW, CredFree, CREDENTIALW},
        };
        let prefix = format!("{service}/");
        let filter: Vec<u16> = format!("{prefix}*").encode_utf16().chain([0]).collect();
        let mut count = 0u32;
        let mut list: *mut *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: the filter is NUL-terminated; on success `list` holds
        // `count` credentials until CredFree.
        if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut list) } == 0 {
            let error = unsafe { GetLastError() };
            return if error == ERROR_NOT_FOUND {
                Ok(Vec::new())
            } else {
                Err(std::io::Error::from_raw_os_error(error as i32).to_string())
            };
        }
        let wide = |ptr: *const u16| -> Option<String> {
            if ptr.is_null() {
                return None;
            }
            // SAFETY: a NUL-terminated string owned by the credential list.
            let len = (0..).take_while(|&i| unsafe { *ptr.add(i) } != 0).count();
            Some(String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(ptr, len)
            }))
        };
        let mut accounts = Vec::new();
        for index in 0..count as usize {
            // SAFETY: `index < count`, each entry points at a CREDENTIALW.
            let credential = unsafe { &**list.add(index) };
            let target = wide(credential.TargetName).unwrap_or_default();
            let account = wide(credential.UserName)
                .filter(|name| !name.is_empty())
                .or_else(|| target.strip_prefix(&prefix).map(str::to_string));
            if let Some(account) = account {
                accounts.push(account);
            }
        }
        // SAFETY: allocated by CredEnumerateW.
        unsafe { CredFree(list as *const _) };
        Ok(accounts)
    }
}

// --- elsewhere -----------------------------------------------------------------------------------

#[cfg(not(any(
    target_os = "macos",
    windows,
    all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    )
)))]
mod platform {
    use super::Credential;

    const NONE: &str = "keytar: there is no keychain on this platform";

    pub fn get(_: &str, _: &str) -> Result<Option<String>, String> {
        Err(NONE.into())
    }
    pub fn set(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }
    pub fn delete(_: &str, _: &str) -> Result<bool, String> {
        Err(NONE.into())
    }
    pub fn find(_: &str) -> Result<Vec<Credential>, String> {
        Err(NONE.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_need_a_service_and_an_account() {
        assert_eq!(
            run(&json!({ "op": "get" })).unwrap_err()["message"],
            "service is required."
        );
        assert_eq!(
            run(&json!({ "op": "set", "service": "s", "account": "a" })).unwrap_err()["message"],
            "password is required."
        );
        assert!(run(&json!({ "op": "nope", "service": "s" })).is_err());
    }

    #[test]
    fn secrets_are_utf8() {
        assert_eq!(utf8("pässwörd".as_bytes().to_vec()), "pässwörd");
        assert_eq!(utf8(vec![0x61, 0xff]), "a\u{fffd}");
    }
}
