//! `powerMonitor`: system events (`suspend`, `resume`, `lock-screen`,
//! `unlock-screen`, `shutdown`) and the idle time behind
//! `getSystemIdleTime()` / `getSystemIdleState()`.
//!
//! - **Linux and the BSDs**: logind on the system bus (`PrepareForSleep`,
//!   `PrepareForShutdown`, the session's `Lock` / `Unlock` and `LockedHint`)
//!   and the screen saver on the session bus (`ActiveChanged` of
//!   `org.gnome.ScreenSaver` / `org.freedesktop.ScreenSaver`). Idle time from
//!   Mutter's `IdleMonitor` (GNOME), else `org.freedesktop.ScreenSaver`'s
//!   `GetSessionIdleTime` (KDE and others).
//! - **macOS**: idle time from `CGEventSourceSecondsSinceLastEventType`.
//! - **Windows**: idle time from `GetLastInputInfo`.
//!
//! Every D-Bus connection is made off the main thread, with a timeout on
//! method calls; without a bus the events are simply not reported (the
//! JavaScript side keeps its sleep heuristic for `resume`).

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

/// Events reported by the operating system on this platform, once watching started.
#[derive(Default)]
pub struct Monitor {
    #[cfg(all(unix, not(target_os = "macos")))]
    linux: linux::State,
}

impl Monitor {
    /// Start watching (idempotent) and return the events that will be reported.
    pub fn start<R: Runtime>(&self, app: &AppHandle<R>) -> Vec<&'static str> {
        #[cfg(all(unix, not(target_os = "macos")))]
        return self.linux.start(app);
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        {
            let _ = app;
            Vec::new()
        }
    }

    /// `{ idle: seconds | null, locked: bool | null }`.
    pub fn idle(&self) -> Value {
        #[cfg(all(unix, not(target_os = "macos")))]
        let (idle, locked) = (self.linux.idle_seconds(), self.linux.locked());
        #[cfg(target_os = "macos")]
        let (idle, locked) = (macos::idle_seconds(), None::<bool>);
        #[cfg(windows)]
        let (idle, locked) = (windows::idle_seconds(), None::<bool>);
        #[cfg(not(any(unix, windows)))]
        let (idle, locked) = (None::<u64>, None::<bool>);
        json!({ "idle": idle, "locked": locked })
    }
}

#[cfg(target_os = "macos")]
mod macos {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // CGEventSourceStateID (int32_t), CGEventType (uint32_t).
        fn CGEventSourceSecondsSinceLastEventType(source: i32, event_type: u32) -> f64;
    }

    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = !0;

    pub fn idle_seconds() -> Option<u64> {
        // SAFETY: a pure query without pointers.
        let seconds = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT)
        };
        seconds.is_finite().then(|| seconds.max(0.0) as u64)
    }
}

#[cfg(windows)]
mod windows {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }

    pub fn idle_seconds() -> Option<u64> {
        let mut info = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            dw_time: 0,
        };
        // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        // Both are milliseconds since boot and wrap after 49.7 days.
        let now = unsafe { GetTickCount() };
        Some(u64::from(now.wrapping_sub(info.dw_time)) / 1000)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod linux {
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicU8, Ordering},
            mpsc, Arc, Mutex, OnceLock,
        },
        thread,
        time::Duration,
    };

    use serde_json::json;
    use tauri::{AppHandle, Emitter, Runtime};
    use zbus::{
        blocking::{connection::Builder, Connection, MessageIterator},
        zvariant::{OwnedObjectPath, OwnedValue},
        MatchRule,
    };

    use crate::MAIN_LABEL;

    const EVENT: &str = "tauri-electron:power-monitor";
    const CALL_TIMEOUT: Duration = Duration::from_secs(1);
    const SETUP_TIMEOUT: Duration = Duration::from_secs(3);
    const LOGIN1: &str = "org.freedesktop.login1";

    // 0: unknown (the default).
    const UNLOCKED: u8 = 1;
    const LOCKED: u8 = 2;

    #[derive(Default)]
    pub struct State {
        started: Mutex<Option<Vec<&'static str>>>,
        session: OnceLock<Option<Connection>>,
        locked: Arc<AtomicU8>,
    }

    fn connect(system: bool) -> Option<Connection> {
        let builder = if system {
            Builder::system()
        } else {
            Builder::session()
        };
        builder.ok()?.method_timeout(CALL_TIMEOUT).build().ok()
    }

    /// Run `f` on a thread of its own and wait for it at most `timeout`.
    fn with_timeout<T: Send + 'static>(
        timeout: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("power-monitor-setup".into())
            .spawn(move || {
                let _ = tx.send(f());
            })
            .ok()?;
        rx.recv_timeout(timeout).ok()
    }

    fn subscribe(connection: &Connection, rule: MatchRule<'static>) -> Option<MessageIterator> {
        MessageIterator::for_match_rule(rule, connection, None).ok()
    }

    /// Emit lock-screen / unlock-screen when the state changes.
    fn set_locked<R: Runtime>(app: &AppHandle<R>, state: &AtomicU8, locked: bool) {
        let next = if locked { LOCKED } else { UNLOCKED };
        if state.swap(next, Ordering::SeqCst) != next {
            let event = if locked {
                "lock-screen"
            } else {
                "unlock-screen"
            };
            let _ = app.emit_to(MAIN_LABEL, EVENT, json!({ "event": event }));
        }
    }

    fn emit<R: Runtime>(app: &AppHandle<R>, event: &str) {
        let _ = app.emit_to(MAIN_LABEL, EVENT, json!({ "event": event }));
    }

    /// logind: sleep, shutdown, and this session's lock state.
    fn watch_logind<R: Runtime>(app: AppHandle<R>, locked: Arc<AtomicU8>) -> Vec<&'static str> {
        let Some(system) = connect(true) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        let manager = MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(LOGIN1)
            .and_then(|b| b.interface("org.freedesktop.login1.Manager"))
            .map(|b| b.build());
        if let Some(signals) = manager.ok().and_then(|rule| subscribe(&system, rule)) {
            events.extend(["suspend", "resume", "shutdown"]);
            let app = app.clone();
            let _ = thread::Builder::new()
                .name("power-monitor-logind".into())
                .spawn(move || {
                    for message in signals.flatten() {
                        let header = message.header();
                        let Ok(starting) = message.body().deserialize::<bool>() else {
                            continue;
                        };
                        match header.member().map(|m| m.as_str()) {
                            Some("PrepareForSleep") => {
                                emit(&app, if starting { "suspend" } else { "resume" })
                            }
                            Some("PrepareForShutdown") if starting => emit(&app, "shutdown"),
                            _ => {}
                        }
                    }
                });
        }
        // This session's object: Lock / Unlock and LockedHint.
        let session: Option<OwnedObjectPath> = system
            .call_method(
                Some(LOGIN1),
                "/org/freedesktop/login1",
                Some("org.freedesktop.login1.Manager"),
                "GetSessionByPID",
                &(std::process::id()),
            )
            .ok()
            .and_then(|reply| reply.body().deserialize::<OwnedObjectPath>().ok());
        if let Some(path) = session {
            if let Ok(reply) = system.call_method(
                Some(LOGIN1),
                path.as_str(),
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &("org.freedesktop.login1.Session", "LockedHint"),
            ) {
                if let Ok(value) = reply.body().deserialize::<OwnedValue>() {
                    if let Ok(hint) = bool::try_from(value) {
                        locked.store(if hint { LOCKED } else { UNLOCKED }, Ordering::SeqCst);
                    }
                }
            }
            let rule = MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .sender(LOGIN1)
                .and_then(|b| b.path(path.as_str().to_owned()))
                .map(|b| b.build());
            if let Some(signals) = rule.ok().and_then(|rule| subscribe(&system, rule)) {
                events.extend(["lock-screen", "unlock-screen"]);
                let _ = thread::Builder::new()
                    .name("power-monitor-session".into())
                    .spawn(move || {
                        for message in signals.flatten() {
                            let header = message.header();
                            match header.member().map(|m| m.as_str()) {
                                Some("Lock") => set_locked(&app, &locked, true),
                                Some("Unlock") => set_locked(&app, &locked, false),
                                Some("PropertiesChanged") => {
                                    let Ok((_, changed, _)) = message.body().deserialize::<(
                                        String,
                                        HashMap<String, OwnedValue>,
                                        Vec<String>,
                                    )>(
                                    ) else {
                                        continue;
                                    };
                                    if let Some(hint) = changed
                                        .get("LockedHint")
                                        .and_then(|v| bool::try_from(v).ok())
                                    {
                                        set_locked(&app, &locked, hint);
                                    }
                                }
                                _ => {}
                            }
                        }
                    });
            }
        }
        // The signal iterators keep their own handle on the connection.
        events
    }

    /// The screen saver on the session bus (GNOME's shield is its lock screen).
    fn watch_screensaver<R: Runtime>(
        app: AppHandle<R>,
        connection: Connection,
        locked: Arc<AtomicU8>,
    ) -> bool {
        let rule = MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .member("ActiveChanged")
            .map(|b| b.build());
        let Some(signals) = rule.ok().and_then(|rule| subscribe(&connection, rule)) else {
            return false;
        };
        let _ = thread::Builder::new()
            .name("power-monitor-screensaver".into())
            .spawn(move || {
                for message in signals.flatten() {
                    let interface = message.header().interface().map(|i| i.to_string());
                    if !matches!(
                        interface.as_deref(),
                        Some("org.gnome.ScreenSaver" | "org.freedesktop.ScreenSaver")
                    ) {
                        continue;
                    }
                    if let Ok(active) = message.body().deserialize::<bool>() {
                        set_locked(&app, &locked, active);
                    }
                }
            });
        true
    }

    impl State {
        fn session(&self) -> Option<&Connection> {
            self.session
                .get_or_init(|| with_timeout(SETUP_TIMEOUT, || connect(false)).flatten())
                .as_ref()
        }

        pub fn start<R: Runtime>(&self, app: &AppHandle<R>) -> Vec<&'static str> {
            let mut started = self.started.lock().unwrap();
            if let Some(events) = started.as_ref() {
                return events.clone();
            }
            let (app_logind, locked) = (app.clone(), self.locked.clone());
            let mut events = with_timeout(SETUP_TIMEOUT, move || watch_logind(app_logind, locked))
                .unwrap_or_default();
            if let Some(session) = self.session().cloned() {
                let (app, locked) = (app.clone(), self.locked.clone());
                let watching = with_timeout(SETUP_TIMEOUT, move || {
                    watch_screensaver(app, session, locked)
                })
                .unwrap_or(false);
                if watching {
                    for event in ["lock-screen", "unlock-screen"] {
                        if !events.contains(&event) {
                            events.push(event);
                        }
                    }
                }
            }
            *started = Some(events.clone());
            events
        }

        pub fn idle_seconds(&self) -> Option<u64> {
            let session = self.session()?;
            if let Ok(reply) = session.call_method(
                Some("org.gnome.Mutter.IdleMonitor"),
                "/org/gnome/Mutter/IdleMonitor/Core",
                Some("org.gnome.Mutter.IdleMonitor"),
                "GetIdletime",
                &(),
            ) {
                if let Ok(ms) = reply.body().deserialize::<u64>() {
                    return Some(ms / 1000);
                }
            }
            // KDE (and others implementing the freedesktop interface): seconds.
            let reply = session
                .call_method(
                    Some("org.freedesktop.ScreenSaver"),
                    "/org/freedesktop/ScreenSaver",
                    Some("org.freedesktop.ScreenSaver"),
                    "GetSessionIdleTime",
                    &(),
                )
                .ok()?;
            reply.body().deserialize::<u32>().ok().map(u64::from)
        }

        /// Known lock state (from the watched signals), else the screen saver's.
        pub fn locked(&self) -> Option<bool> {
            match self.locked.load(Ordering::SeqCst) {
                LOCKED => return Some(true),
                UNLOCKED => return Some(false),
                _ => {}
            }
            let session = self.session()?;
            for (name, path) in [
                ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
                (
                    "org.freedesktop.ScreenSaver",
                    "/org/freedesktop/ScreenSaver",
                ),
            ] {
                if let Ok(reply) =
                    session.call_method(Some(name), path, Some(name), "GetActive", &())
                {
                    if let Ok(active) = reply.body().deserialize::<bool>() {
                        return Some(active);
                    }
                }
            }
            None
        }
    }
}
