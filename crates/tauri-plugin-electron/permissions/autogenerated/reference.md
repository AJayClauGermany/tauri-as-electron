## Default Permission

Everything tauri-electron needs in the hidden `electron-main` window (Electron's main process). Do not grant this to renderer windows.

#### This default permission set includes the following:

- `allow-process-info`
- `allow-set-window-config`
- `allow-open-devtools`
- `allow-close-devtools`
- `allow-is-devtools-open`
- `allow-trash-item`
- `allow-bridge-respond`
- `allow-set-menu-visible`
- `allow-cookies-get`
- `allow-cookies-set`
- `allow-cookies-remove`
- `allow-clipboard-read-html`
- `allow-message-box`
- `allow-message-box-close`
- `allow-power-blocker-start`
- `allow-power-blocker-stop`
- `allow-notification-show`
- `allow-notification-close`
- `allow-power-monitor-start`
- `allow-safe-storage-status`
- `allow-safe-storage-encrypt`
- `allow-safe-storage-decrypt`
- `allow-create-window`
- `allow-permission-handler`
- `allow-permission-respond`
- `allow-download-url`
- `allow-download-control`
- `allow-download-commit`
- `allow-download-discard`
- `allow-web-request-listeners`
- `allow-web-request-respond`
- `allow-tls-auth-respond`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`electron:allow-bridge-respond`

</td>
<td>

Enables the bridge_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-bridge-respond`

</td>
<td>

Denies the bridge_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-child-disconnect`

</td>
<td>

Enables the child_disconnect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-child-disconnect`

</td>
<td>

Denies the child_disconnect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-child-end`

</td>
<td>

Enables the child_end command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-child-end`

</td>
<td>

Denies the child_end command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-child-kill`

</td>
<td>

Enables the child_kill command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-child-kill`

</td>
<td>

Denies the child_kill command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-child-send`

</td>
<td>

Enables the child_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-child-send`

</td>
<td>

Denies the child_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-child-spawn`

</td>
<td>

Enables the child_spawn command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-child-spawn`

</td>
<td>

Denies the child_spawn command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-child-write`

</td>
<td>

Enables the child_write command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-child-write`

</td>
<td>

Denies the child_write command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-clipboard-read-html`

</td>
<td>

Enables the clipboard_read_html command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-clipboard-read-html`

</td>
<td>

Denies the clipboard_read_html command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-close-devtools`

</td>
<td>

Enables the close_devtools command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-close-devtools`

</td>
<td>

Denies the close_devtools command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-cookies-get`

</td>
<td>

Enables the cookies_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-cookies-get`

</td>
<td>

Denies the cookies_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-cookies-remove`

</td>
<td>

Enables the cookies_remove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-cookies-remove`

</td>
<td>

Denies the cookies_remove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-cookies-set`

</td>
<td>

Enables the cookies_set command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-cookies-set`

</td>
<td>

Denies the cookies_set command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-create-window`

</td>
<td>

Enables the create_window command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-create-window`

</td>
<td>

Denies the create_window command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-dns-lookup`

</td>
<td>

Enables the dns_lookup command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-dns-lookup`

</td>
<td>

Denies the dns_lookup command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-dns-resolve`

</td>
<td>

Enables the dns_resolve command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-dns-resolve`

</td>
<td>

Denies the dns_resolve command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-dns-reverse`

</td>
<td>

Enables the dns_reverse command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-dns-reverse`

</td>
<td>

Denies the dns_reverse command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-dns-servers`

</td>
<td>

Enables the dns_servers command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-dns-servers`

</td>
<td>

Denies the dns_servers command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-download-commit`

</td>
<td>

Enables the download_commit command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-download-commit`

</td>
<td>

Denies the download_commit command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-download-control`

</td>
<td>

Enables the download_control command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-download-control`

</td>
<td>

Denies the download_control command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-download-discard`

</td>
<td>

Enables the download_discard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-download-discard`

</td>
<td>

Denies the download_discard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-download-url`

</td>
<td>

Enables the download_url command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-download-url`

</td>
<td>

Denies the download_url command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-fs-unwatch`

</td>
<td>

Enables the fs_unwatch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-fs-unwatch`

</td>
<td>

Denies the fs_unwatch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-fs-watch`

</td>
<td>

Enables the fs_watch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-fs-watch`

</td>
<td>

Denies the fs_watch command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-is-devtools-open`

</td>
<td>

Enables the is_devtools_open command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-is-devtools-open`

</td>
<td>

Denies the is_devtools_open command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-keytar`

</td>
<td>

Enables the keytar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-keytar`

</td>
<td>

Denies the keytar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-message-box`

</td>
<td>

Enables the message_box command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-message-box`

</td>
<td>

Denies the message_box command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-message-box-close`

</td>
<td>

Enables the message_box_close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-message-box-close`

</td>
<td>

Denies the message_box_close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-net-connect`

</td>
<td>

Enables the net_connect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-net-connect`

</td>
<td>

Denies the net_connect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-net-destroy`

</td>
<td>

Enables the net_destroy command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-net-destroy`

</td>
<td>

Denies the net_destroy command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-net-end`

</td>
<td>

Enables the net_end command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-net-end`

</td>
<td>

Denies the net_end command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-net-listen`

</td>
<td>

Enables the net_listen command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-net-listen`

</td>
<td>

Denies the net_listen command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-net-pause`

</td>
<td>

Enables the net_pause command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-net-pause`

</td>
<td>

Denies the net_pause command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-net-set-option`

</td>
<td>

Enables the net_set_option command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-net-set-option`

</td>
<td>

Denies the net_set_option command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-net-write`

</td>
<td>

Enables the net_write command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-net-write`

</td>
<td>

Denies the net_write command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-node-fs`

</td>
<td>

Enables the node_fs command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-node-fs`

</td>
<td>

Denies the node_fs command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-notification-close`

</td>
<td>

Enables the notification_close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-notification-close`

</td>
<td>

Denies the notification_close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-notification-show`

</td>
<td>

Enables the notification_show command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-notification-show`

</td>
<td>

Denies the notification_show command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-open-devtools`

</td>
<td>

Enables the open_devtools command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-open-devtools`

</td>
<td>

Denies the open_devtools command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-permission-handler`

</td>
<td>

Enables the permission_handler command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-permission-handler`

</td>
<td>

Denies the permission_handler command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-permission-respond`

</td>
<td>

Enables the permission_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-permission-respond`

</td>
<td>

Denies the permission_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-power-blocker-start`

</td>
<td>

Enables the power_blocker_start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-power-blocker-start`

</td>
<td>

Denies the power_blocker_start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-power-blocker-stop`

</td>
<td>

Enables the power_blocker_stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-power-blocker-stop`

</td>
<td>

Denies the power_blocker_stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-power-monitor-start`

</td>
<td>

Enables the power_monitor_start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-power-monitor-start`

</td>
<td>

Denies the power_monitor_start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-process-info`

</td>
<td>

Enables the process_info command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-process-info`

</td>
<td>

Denies the process_info command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-pty-attach`

</td>
<td>

Enables the pty_attach command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-pty-attach`

</td>
<td>

Denies the pty_attach command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-pty-control`

</td>
<td>

Enables the pty_control command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-pty-control`

</td>
<td>

Denies the pty_control command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-safe-storage-decrypt`

</td>
<td>

Enables the safe_storage_decrypt command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-safe-storage-decrypt`

</td>
<td>

Denies the safe_storage_decrypt command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-safe-storage-encrypt`

</td>
<td>

Enables the safe_storage_encrypt command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-safe-storage-encrypt`

</td>
<td>

Denies the safe_storage_encrypt command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-safe-storage-status`

</td>
<td>

Enables the safe_storage_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-safe-storage-status`

</td>
<td>

Denies the safe_storage_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-set-menu-visible`

</td>
<td>

Enables the set_menu_visible command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-set-menu-visible`

</td>
<td>

Denies the set_menu_visible command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-set-window-config`

</td>
<td>

Enables the set_window_config command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-set-window-config`

</td>
<td>

Denies the set_window_config command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-sqlite`

</td>
<td>

Enables the sqlite command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-sqlite`

</td>
<td>

Denies the sqlite command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-tls-auth-respond`

</td>
<td>

Enables the tls_auth_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-tls-auth-respond`

</td>
<td>

Denies the tls_auth_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-trash-item`

</td>
<td>

Enables the trash_item command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-trash-item`

</td>
<td>

Denies the trash_item command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-udp-bind`

</td>
<td>

Enables the udp_bind command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-udp-bind`

</td>
<td>

Denies the udp_bind command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-udp-membership`

</td>
<td>

Enables the udp_membership command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-udp-membership`

</td>
<td>

Denies the udp_membership command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-udp-option`

</td>
<td>

Enables the udp_option command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-udp-option`

</td>
<td>

Denies the udp_option command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-udp-send`

</td>
<td>

Enables the udp_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-udp-send`

</td>
<td>

Denies the udp_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-web-request-listeners`

</td>
<td>

Enables the web_request_listeners command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-web-request-listeners`

</td>
<td>

Denies the web_request_listeners command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:allow-web-request-respond`

</td>
<td>

Enables the web_request_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:deny-web-request-respond`

</td>
<td>

Denies the web_request_respond command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`electron:keytar`

</td>
<td>

The `keytar` npm package (Cargo feature `keytar`): read, write, delete and list passwords of any service in the OS keychain. Granted to the `electron-main` window when the feature is on, and to windows the main process creates with `nodeIntegration` or `sandbox: false` (as in Electron). Do not grant it to other renderer windows.

</td>
</tr>

<tr>
<td>

`electron:sqlite`

</td>
<td>

The `better-sqlite3` and `sqlite3` npm packages (Cargo feature `sqlite`): open, read and write SQLite databases at any path the app's user can. Granted to the `electron-main` window when the feature is on, and to windows the main process creates with `nodeIntegration` or `sandbox: false` (as in Electron). Do not grant it to other renderer windows.

</td>
</tr>

<tr>
<td>

`electron:pty`

</td>
<td>

The `node-pty` npm package (Cargo feature `pty`): run any program the app's user can in a pseudo-terminal, write to it, resize and signal it. Granted to the `electron-main` window when the feature is on, and to windows the main process creates with `nodeIntegration` or `sandbox: false` (as in Electron). Do not grant it to other renderer windows.

</td>
</tr>

<tr>
<td>

`electron:node-child-process`

</td>
<td>

Node's `child_process` (Cargo feature `node-child-process`): start any program the app's user can (and a Node.js runtime for `child_process.fork` / `utilityProcess.fork`), and write to, read from, signal and message it. Granted to the `electron-main` window when the feature is on, and to windows the main process creates with `nodeIntegration` or `sandbox: false` (as in Electron). Do not grant it to other renderer windows.

</td>
</tr>

<tr>
<td>

`electron:node-fs`

</td>
<td>

Node's `fs` and `fs/promises` (Cargo feature `node-fs`): read and write any file the app's user can. Granted to the `electron-main` window when the feature is on, and to windows the main process creates with `nodeIntegration` or `sandbox: false` (as in Electron). Do not grant it to other renderer windows.

</td>
</tr>

<tr>
<td>

`electron:node-net`

</td>
<td>

Node's `net`, `dgram`, `dns` and `tls` (Cargo features `node-net`, `node-tls`): open and accept TCP / IPC connections, send and receive UDP datagrams, resolve names. Granted to the `electron-main` window when the feature is on, and to windows the main process creates with `nodeIntegration` or `sandbox: false` (as in Electron). Do not grant it to other renderer windows.

</td>
</tr>
</table>
