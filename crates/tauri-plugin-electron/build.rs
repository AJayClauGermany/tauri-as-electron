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
}
