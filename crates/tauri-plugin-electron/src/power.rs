//! `powerSaveBlocker` with operating-system assertions (the `keepawake`
//! crate: IOPMAssertion on macOS, `SetThreadExecutionState` on Windows,
//! logind / ScreenSaver inhibitors on Linux), held until `stop`.

use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub struct Blockers {
    next: Mutex<u32>,
    held: Mutex<HashMap<u32, keepawake::KeepAwake>>,
}

impl Blockers {
    /// `type` is Electron's `'prevent-app-suspension'` (the system stays
    /// awake) or `'prevent-display-sleep'` (the display stays on too).
    pub fn start(&self, kind: &str, app_name: &str) -> Result<u32, String> {
        let display = kind == "prevent-display-sleep";
        let assertion = keepawake::Builder::default()
            .display(display)
            .idle(true)
            .reason(if display {
                "Keeping the display on"
            } else {
                "Preventing the system from sleeping"
            })
            .app_name(app_name)
            .app_reverse_domain(format!("app.{}", app_name.replace(' ', "-")))
            .create()
            .map_err(|e| e.to_string())?;
        let mut next = self.next.lock().unwrap();
        let id = *next;
        *next += 1;
        self.held.lock().unwrap().insert(id, assertion);
        Ok(id)
    }

    /// Release an assertion; false if it was not held.
    pub fn stop(&self, id: u32) -> bool {
        self.held.lock().unwrap().remove(&id).is_some()
    }
}
