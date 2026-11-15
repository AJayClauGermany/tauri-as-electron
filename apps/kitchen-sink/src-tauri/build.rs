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
    // Custom schemes of protocol.handle(), found in your JavaScript by the
    // tauri-electron bundler plugin (src-tauri/electron-schemes.json), for
    // tauri_plugin_electron::bundled_schemes!() in lib.rs.
    println!("cargo:rerun-if-changed=electron-schemes.json");
    if let Ok(json) = std::fs::read_to_string("electron-schemes.json") {
        println!("cargo:rustc-env=TAURI_ELECTRON_SCHEMES={}", json.trim());
    }
    tauri_build::build()
}
