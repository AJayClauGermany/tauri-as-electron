/**
 * Creates a BrowserWindow's Tauri window through tauri-plugin-electron's
 * `create_window` (Rust's WebviewWindowBuilder, with the download and
 * permission hooks Tauri only offers there), or with JavaScript's
 * `new WebviewWindow()` when the plugin is not installed. Either way the
 * returned WebviewWindow emits 'tauri://created' or 'tauri://error'.
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { native, hasNativePlugin } from '../internal/native.js'

export function createWebviewWindow(label, options, extras = {}) {
  if (!hasNativePlugin()) return new WebviewWindow(label, options)
  // `skip`: an object for a window that exists (or is about to) without creating it.
  const win = new WebviewWindow(label, { ...options, skip: true })
  const parent = typeof options.parent === 'string' ? options.parent : options.parent?.label
  native('create_window', { options: { ...options, parent, label }, extras }).then(
    () => win.emit('tauri://created'),
    (error) => win.emit('tauri://error', error),
  )
  return win
}
