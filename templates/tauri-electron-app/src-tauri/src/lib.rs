//! The Rust side is boilerplate. tauri-plugin-electron registers the
//! official Tauri plugins that tauri-electron builds the Electron API on
//! (pick them with its Cargo features in Cargo.toml) and grants Electron's
//! default capabilities. Your app logic lives in JavaScript (src/main.js),
//! like in an Electron app.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri_plugin_electron::Builder::new()
        // Declare every scheme your main process passes to protocol.handle();
        // Tauri needs to know them when the app is built.
        // .protocol("app")
        .install(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
