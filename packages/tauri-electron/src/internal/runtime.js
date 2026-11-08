/**
 * Runtime detection shared by every module.
 *
 * Electron has a Node "main process" plus one renderer process per window.
 * Tauri only runs JavaScript inside webviews, so tauri-electron runs the
 * Electron main-process code inside a hidden webview window whose label is
 * MAIN_LABEL. Every other window is a "renderer".
 */
export const MAIN_LABEL = 'electron-main'

/** Event names used by the IPC bridge (Tauri event names allow `a-z0-9-/:_`). */
export const TO_MAIN = 'tauri-electron:to-main'
export const TO_RENDERER = 'tauri-electron:to-renderer'

export const inTauri =
  typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined'

export function currentLabel() {
  if (!inTauri) return null
  return window.__TAURI_INTERNALS__.metadata?.currentWebview?.label ??
    window.__TAURI_INTERNALS__.metadata?.currentWindow?.label ?? null
}

export const isMainProcess = currentLabel() === MAIN_LABEL
export const isRenderer = inTauri && !isMainProcess

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const warned = new Set()
/** console.warn once per key, prefixed so users can grep for it. */
export function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[tauri-electron] ${message ?? key}`)
}

/** Report an error from a fire-and-forget Tauri call without throwing. */
export function report(what) {
  return (error) => console.error(`[tauri-electron] ${what} failed:`, explainError(what, error))
}

/**
 * Why an Electron API is unavailable. Every NotImplementedError carries one,
 * so a failure can be read without digging through the source:
 *
 * - `unimplemented`: tauri-electron does not implement it yet, but Tauri or
 *   the webview could support it. A candidate for a contribution.
 * - `unsupported`: there is no Tauri or WebKit equivalent (Node.js built-ins,
 *   Chromium-only features such as desktopCapturer). Not planned.
 * - `feature`: backed by an official Tauri plugin whose Cargo feature of
 *   tauri-plugin-electron is off (`features = ["updater"]` in Cargo.toml).
 * - `plugin`: tauri-plugin-electron itself is not registered.
 * - `permission`: Tauri's capability model denied the underlying command.
 *   Typically a main-process API called from a renderer window.
 */
export const REASONS = Object.freeze({
  unimplemented: 'not implemented by tauri-electron yet',
  unsupported: 'not supported on Tauri (no equivalent in Tauri or the webview)',
  feature: 'disabled: a Cargo feature of tauri-plugin-electron is off',
  plugin: 'unavailable: tauri-plugin-electron is not registered',
  permission: 'denied by Tauri\'s capability model',
})

export class NotImplementedError extends Error {
  /**
   * @param {string} api e.g. `webContents.capturePage`
   * @param {string|{reason?: keyof REASONS, hint?: string}} [details] a hint, or a reason and a hint
   */
  constructor(api, details) {
    const { reason = 'unimplemented', hint } = typeof details === 'string' ? { hint: details } : details ?? {}
    super(`${api} is ${REASONS[reason] ?? REASONS.unimplemented}${hint ? `. ${hint}` : ''}`)
    this.name = 'NotImplementedError'
    this.api = api
    this.reason = reason
    this.hint = hint
  }
}

/**
 * Tauri reports a denied command as
 * "<plugin>.<command> not allowed. Permissions associated with this command: ...".
 * Rewrite it so an Electron developer learns what it means here.
 */
export function isPermissionError(error) {
  return /not allowed\. Permissions associated with this command/i.test(String(error?.message ?? error))
}

export function explainError(api, error) {
  const message = String(error?.message ?? error)
  if (isPermissionError(error)) {
    const command = /^([a-z0-9_:.|-]+) not allowed/i.exec(message)?.[1] ?? 'the command'
    const where = isMainProcess
      ? 'The electron-main window lacks it: tauri-plugin-electron grants it with default_capabilities (on by default), so check src-tauri/capabilities/ or the Cargo features of tauri-plugin-electron.'
      : 'Renderer windows only get IPC permissions, like a sandboxed Electron renderer: call this API in the main process (ipcMain.handle) or add a capability file in src-tauri/capabilities/.'
    const explained = new NotImplementedError(api, { reason: 'permission', hint: `Tauri denied \`${command}\`. ${where}` })
    explained.cause = error
    return explained
  }
  if (/plugin [a-z-]+ not found/i.test(message)) {
    const plugin = /plugin ([a-z-]+) not found/i.exec(message)?.[1]
    const explained = new NotImplementedError(api, {
      reason: plugin === 'electron' ? 'plugin' : 'feature',
      hint:
        plugin === 'electron'
          ? 'Register tauri-plugin-electron in src-tauri/src/lib.rs (tauri_plugin_electron::Builder::new().install(...)).'
          : `The Tauri plugin \`${plugin}\` is not registered: enable the matching Cargo feature of tauri-plugin-electron in src-tauri/Cargo.toml (see FEATURES in tauri-electron).`,
    })
    explained.cause = error
    return explained
  }
  return error
}

/** Serialize an Error so it survives a JSON hop over Tauri events. */
export function serializeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'Error', message: String(error) }
}

export function deserializeError(data) {
  const error = new Error(data?.message ?? 'Unknown error')
  if (data?.name) error.name = data.name
  return error
}

/** Whether the app is running from a production bundle (not the dev server). */
export function isPackagedBuild() {
  if (typeof location === 'undefined') return false
  return location.protocol === 'tauri:' || location.hostname === 'tauri.localhost'
}
