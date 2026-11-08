//! The Rust side is intentionally boilerplate: it registers the official
//! plugins that tauri-electron builds the Electron API on. Your app logic
//! lives in JavaScript (src/main.js), like in an Electron app.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Electron's `app.on('activate')`: macOS dock icon clicked.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = _event {
                use tauri::Emitter;
                let _ = _app.emit_to("electron-main", "tauri-electron:activate", has_visible_windows);
            }
        });
}
