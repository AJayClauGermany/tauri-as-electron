// First module of the hidden main-process page under the webpack / rspack
// plugin: the Node built-ins tauri-electron implements (fs, buffer, …) and
// where the app's own files are, like the Vite plugin's main entry.
// __TAURI_ELECTRON_APP__ is defined by the plugin (DefinePlugin).
import '../src/node/index.js'

// eslint-disable-next-line no-undef
globalThis.__TAURI_ELECTRON_APP__ = typeof __TAURI_ELECTRON_APP__ === 'undefined' ? null : __TAURI_ELECTRON_APP__
