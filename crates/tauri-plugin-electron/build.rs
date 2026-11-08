const COMMANDS: &[&str] = &[
    "process_info",
    "set_window_config",
    "open_devtools",
    "close_devtools",
    "is_devtools_open",
    "trash_item",
    "bridge_respond",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();

    // Tauri discovers plugin permissions through Cargo `links` metadata
    // (`DEP_TAURI_PLUGIN_<NAME>_*`), which only reaches *direct* dependents.
    // The plugins this crate registers are its dependencies, not the app's,
    // so hand their metadata on; the app's build.rs (see the template)
    // puts it back under the original names. The value carries the
    // name so that tauri-build does not mistake it for a plugin of its own.
    let mut forwarded: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| key.starts_with("DEP_TAURI_PLUGIN_"))
        .collect();
    forwarded.sort();
    for (index, (key, value)) in forwarded.into_iter().enumerate() {
        println!("cargo:forward_{index}={key}={value}");
    }
}
