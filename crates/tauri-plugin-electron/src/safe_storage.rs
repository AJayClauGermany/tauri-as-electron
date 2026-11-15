//! `safeStorage`: AES-256-GCM with a random key kept in the operating
//! system's keychain (macOS Keychain, Windows Credential Manager, the Secret
//! Service on Linux), through the `keyring` crate.
//!
//! The key is read (or created) the first time it is needed, on a worker
//! thread: a keychain can prompt the user or, on Linux, a D-Bus call can
//! stall when no Secret Service runs. Callers wait at most [`KEY_TIMEOUT`];
//! a late answer is kept for the next call.
//!
//! Linux without a secret store behaves like Electron's `basic_text`
//! backend: encryption is unavailable until `setUsePlainTextEncryption(true)`,
//! after which a key fixed in this crate is used (obfuscation, not secrecy).
//!
//! Ciphertext: a 4-byte tag (`tev1` with the keychain key, `tev0` with the
//! fixed key), a 12-byte nonce, then the AES-GCM output. Not compatible with
//! Electron's.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};

const KEY_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_AFTER: Duration = Duration::from_secs(60);
/// How long a retry may hold a caller (the first ask waits `KEY_TIMEOUT`).
const RETRY_WAIT: Duration = Duration::from_secs(2);
const TAG_KEYCHAIN: &[u8; 4] = b"tev1";
const TAG_PLAIN: &[u8; 4] = b"tev0";
/// The `basic_text` key: public, like Chromium's "peanuts".
const PLAIN_KEY: &[u8; 32] = b"tauri-electron basic_text key!!!";

type KeyResult = Result<[u8; 32], String>;

#[derive(Default)]
struct KeySlot {
    started: bool,
    result: Option<KeyResult>,
    /// When the keychain last failed: it is asked again after `RETRY_AFTER`
    /// (a prompt was dismissed, or the keyring was still locked at login).
    failed_at: Option<Instant>,
    /// A retry is under way (the previous answer is still served).
    retrying: bool,
}

/// Plugin state: the keychain key once known, and the plaintext switch.
pub struct SafeStorage {
    service: String,
    account: String,
    slot: Arc<(Mutex<KeySlot>, Condvar)>,
    plain_text: AtomicBool,
}

impl SafeStorage {
    pub fn new(app_name: &str) -> Self {
        Self {
            service: format!("{app_name} Safe Storage"),
            account: app_name.to_string(),
            slot: Arc::default(),
            plain_text: AtomicBool::new(false),
        }
    }

    /// Ask the keychain on a worker thread; the answer replaces `result`.
    fn ask(&self, slot: &mut KeySlot) {
        slot.started = true;
        slot.retrying = slot.result.is_some();
        let shared = self.slot.clone();
        let (service, account) = (self.service.clone(), self.account.clone());
        thread::spawn(move || {
            let result = load_or_create_key(&service, &account);
            let (lock, ready) = &*shared;
            let mut slot = lock.lock().unwrap();
            slot.failed_at = result.is_err().then(Instant::now);
            slot.retrying = false;
            slot.result = Some(result);
            drop(slot);
            ready.notify_all();
        });
    }

    /// The keychain key, waiting for the keychain at most `KEY_TIMEOUT` the
    /// first time. After a failure the keychain is asked again at most every
    /// `RETRY_AFTER` (the keyring may have been locked at login), waiting
    /// `RETRY_WAIT` for it; other callers get the last answer meanwhile.
    fn key(&self) -> KeyResult {
        let (lock, ready) = &*self.slot;
        let mut slot = lock.lock().unwrap();
        let retry = !slot.retrying && slot.failed_at.is_some_and(|at| at.elapsed() >= RETRY_AFTER);
        if !slot.started || retry {
            self.ask(&mut slot);
        }
        // A retry is waited for briefly, so the call that finds the keychain
        // unlocked gets the key; slower answers serve the next call.
        let (slot, _) = ready
            .wait_timeout_while(slot, if retry { RETRY_WAIT } else { KEY_TIMEOUT }, |s| {
                if retry {
                    s.retrying
                } else {
                    s.result.is_none()
                }
            })
            .unwrap();
        slot.result
            .clone()
            .unwrap_or_else(|| Err("the keychain did not answer in time".into()))
    }

    /// Whether the fixed key stands in for a missing keychain (Linux only).
    fn plain_text_fallback(&self) -> bool {
        cfg!(target_os = "linux") && self.plain_text.load(Ordering::Relaxed)
    }

    pub fn set_use_plain_text(&self, on: bool) {
        self.plain_text.store(on, Ordering::Relaxed);
    }

    /// `{ available, backend, error? }` for isEncryptionAvailable() and
    /// getSelectedStorageBackend().
    pub fn status(&self) -> Value {
        match self.key() {
            Ok(_) => json!({ "available": true, "backend": backend_name(true) }),
            Err(error) => json!({
                "available": self.plain_text_fallback(),
                "backend": backend_name(false),
                "error": error,
            }),
        }
    }

    pub fn encrypt(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        match self.key() {
            Ok(key) => seal(TAG_KEYCHAIN, &key, plain),
            Err(_) if self.plain_text_fallback() => seal(TAG_PLAIN, PLAIN_KEY, plain),
            Err(error) => Err(format!("Encryption is not available: {error}")),
        }
    }

    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        if data.starts_with(TAG_PLAIN) {
            return open(PLAIN_KEY, &data[4..]);
        }
        if !data.starts_with(TAG_KEYCHAIN) {
            return Err("the ciphertext was not made by safeStorage".into());
        }
        let key = self
            .key()
            .map_err(|error| format!("Decryption is not available: {error}"))?;
        open(&key, &data[4..])
    }
}

/// Electron's names (`getSelectedStorageBackend` is Linux-only there).
fn backend_name(keychain: bool) -> &'static str {
    if !cfg!(target_os = "linux") {
        "unknown"
    } else if keychain {
        // keyring talks to the Secret Service API (GNOME Keyring, KeePassXC,
        // and KWallet 5.97+ all provide it), which is Chromium's libsecret backend.
        "gnome_libsecret"
    } else {
        "basic_text"
    }
}

fn load_or_create_key(service: &str, account: &str) -> KeyResult {
    #[cfg(desktop)]
    {
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(stored) => {
                let bytes = BASE64.decode(stored.trim()).map_err(|e| e.to_string())?;
                bytes
                    .try_into()
                    .map_err(|_| "the stored safeStorage key is not 32 bytes".to_string())
            }
            Err(keyring::Error::NoEntry) => {
                let key: [u8; 32] = Aes256Gcm::generate_key(OsRng).into();
                entry
                    .set_password(&BASE64.encode(key))
                    .map_err(|e| e.to_string())?;
                Ok(key)
            }
            Err(error) => Err(error.to_string()),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (service, account);
        Err("no keychain on this platform".into())
    }
}

fn seal(tag: &[u8; 4], key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let sealed = cipher.encrypt(&nonce, plain).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + nonce.len() + sealed.len());
    out.extend_from_slice(tag);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn open(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 + 16 {
        return Err("the ciphertext is truncated".into());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
        .map_err(|_| "the ciphertext is corrupt or was encrypted with another key".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_key(key: KeyResult) -> SafeStorage {
        let storage = SafeStorage::new("test");
        *storage.slot.0.lock().unwrap() = KeySlot {
            started: true,
            result: Some(key),
            failed_at: None,
            retrying: false,
        };
        storage
    }

    #[test]
    fn round_trip_with_the_keychain_key() {
        let storage = with_key(Ok([7; 32]));
        let sealed = storage.encrypt("héllo".as_bytes()).unwrap();
        assert!(sealed.starts_with(TAG_KEYCHAIN));
        assert_ne!(
            storage.encrypt(b"x").unwrap(),
            storage.encrypt(b"x").unwrap(),
            "fresh nonces"
        );
        assert_eq!(storage.decrypt(&sealed).unwrap(), "héllo".as_bytes());
        assert_eq!(storage.status()["available"], true);
    }

    #[test]
    fn another_key_or_tampering_fails() {
        let sealed = with_key(Ok([1; 32])).encrypt(b"secret").unwrap();
        assert!(with_key(Ok([2; 32])).decrypt(&sealed).is_err());
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(with_key(Ok([1; 32])).decrypt(&tampered).is_err());
        assert!(with_key(Ok([1; 32])).decrypt(b"tev1short").is_err());
        assert!(with_key(Ok([1; 32]))
            .decrypt(b"plain bytes, not ours")
            .is_err());
    }

    #[test]
    fn no_keychain_means_no_encryption_until_plain_text_is_allowed() {
        let storage = with_key(Err("no secret service".into()));
        assert_eq!(storage.status()["available"], false);
        assert!(storage.encrypt(b"x").is_err());
        storage.set_use_plain_text(true);
        if cfg!(target_os = "linux") {
            assert_eq!(storage.status()["available"], true);
            assert_eq!(storage.status()["backend"], "basic_text");
            let sealed = storage.encrypt(b"obfuscated").unwrap();
            assert!(sealed.starts_with(TAG_PLAIN));
            // Readable without the keychain, as Electron's basic_text is.
            assert_eq!(
                with_key(Err("none".into())).decrypt(&sealed).unwrap(),
                b"obfuscated"
            );
        } else {
            assert!(storage.encrypt(b"x").is_err());
        }
    }
}
