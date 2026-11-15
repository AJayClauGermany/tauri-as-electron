const COMMANDS: &[&str] = &[
    "process_info",
    "set_window_config",
    "open_devtools",
    "close_devtools",
    "is_devtools_open",
    "trash_item",
    "bridge_respond",
    "set_menu_visible",
    "cookies_get",
    "cookies_set",
    "cookies_remove",
    "clipboard_read_html",
    "message_box",
    "message_box_close",
    "power_blocker_start",
    "power_blocker_stop",
    "notification_show",
    "notification_close",
    "power_monitor_start",
    "safe_storage_status",
    "safe_storage_encrypt",
    "safe_storage_decrypt",
    "node_fs",
    "fs_watch",
    "fs_unwatch",
    "child_spawn",
    "child_write",
    "child_end",
    "child_kill",
    "child_send",
    "child_disconnect",
    "net_connect",
    "net_listen",
    "net_write",
    "net_end",
    "net_destroy",
    "net_pause",
    "net_set_option",
    "udp_bind",
    "udp_send",
    "udp_option",
    "udp_membership",
    "dns_lookup",
    "dns_resolve",
    "dns_reverse",
    "dns_servers",
    "create_window",
    "permission_handler",
    "permission_respond",
    "download_url",
    "download_control",
    "download_commit",
    "download_discard",
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
