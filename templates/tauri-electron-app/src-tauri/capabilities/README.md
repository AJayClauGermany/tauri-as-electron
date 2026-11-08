# Capabilities

tauri-plugin-electron grants Electron's defaults at startup, so this folder
can stay empty:

- `electron-main` (the hidden main-process window): every permission of the
  enabled tauri-plugin-electron features, like Electron's main process.
- `electron-renderer` (every window): IPC with the main process, zoom,
  `window.close()` and `-webkit-app-region` dragging, like a
  context-isolated, sandboxed Electron renderer.

Add `*.json` capability files here for anything else, for example if your
renderer pages call Tauri APIs directly. To manage every permission
yourself, use `tauri_plugin_electron::Builder::new().default_capabilities(false)`.
