/**
 * The window's configuration, set by the main process when it created the
 * BrowserWindow (`BrowserWindow#_rendererConfig`) and read synchronously
 * from tauri-plugin-electron before the preload runs: process.argv,
 * contextIsolation / sandbox, and whether the window gets Node built-ins
 * (`node`: nodeIntegration, or an unsandboxed preload).
 */
import { syncRequest } from '../internal/native.js'
import { isRenderer } from '../internal/runtime.js'

let config

/** The configuration, or null (no tauri-plugin-electron, not a renderer, a window it did not create). */
export function windowConfig() {
  if (config !== undefined) return config
  config = null
  if (!isRenderer) return config
  try {
    const { status, text } = syncRequest('window-config')
    config = status === 200 ? JSON.parse(text) : null
  } catch {
    /* no tauri-plugin-electron */
  }
  return config
}
