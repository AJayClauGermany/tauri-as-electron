//! The Rust side is intentionally boilerplate: it registers the official
//! plugins that tauri-electron builds the Electron API on, plus
//! tauri-plugin-electron for the few things they do not cover. Your app
//! logic lives in JavaScript (src/main.js), like in an Electron app.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // tauri-plugin-electron goes first. Its Cargo features add what they
    // need here: "single-instance" registers tauri-plugin-single-instance
    // ahead of everything else, so a second launch exits early.
    // "kitchen": exercised by the protocol.handle() checks. Add one
    // `.protocol()` per scheme passed to protocol.handle().
    let mut builder = tauri_plugin_electron::Builder::new()
        .protocol("kitchen")
        .install(tauri::Builder::default());

    builder = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_autostart::Builder::new().build());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
