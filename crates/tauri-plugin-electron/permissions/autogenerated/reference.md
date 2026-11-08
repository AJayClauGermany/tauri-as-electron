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
</table>
