// Loaded in renderer pages after the bootstrap under the webpack / rspack
// plugin (option `rendererNode`): Node built-ins for windows created with
// nodeIntegration or sandbox: false, and where the app's own files are.
// __TAURI_ELECTRON_APP__ is defined by the plugin (DefinePlugin).
import { hasNode } from '../src/renderer/node.js'
import { installWorkerRegistry } from './worker-registry.js'

if (hasNode) installWorkerRegistry()

// eslint-disable-next-line no-undef
if (hasNode && !globalThis.__TAURI_ELECTRON_APP__) globalThis.__TAURI_ELECTRON_APP__ = typeof __TAURI_ELECTRON_APP__ === 'undefined' ? null : __TAURI_ELECTRON_APP__
