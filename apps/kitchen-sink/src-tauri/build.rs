fn main() {
    // tauri-plugin-electron registers official Tauri plugins for you (one per
    // enabled Cargo feature). Cargo only shows a build script the metadata of
    // its direct dependencies, so put theirs where tauri-build looks for
    // plugin permissions.
    for (key, value) in std::env::vars() {
        if key.starts_with("DEP_TAURI_PLUGIN_ELECTRON_FORWARD_") {
            if let Some((name, path)) = value.split_once('=') {
                std::env::set_var(name, path);
            }
        }
    }
    tauri_build::build()
}
