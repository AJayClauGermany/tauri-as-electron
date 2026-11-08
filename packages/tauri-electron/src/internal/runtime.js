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
  return (error) => console.error(`[tauri-electron] ${what} failed:`, error)
}

export class NotImplementedError extends Error {
  constructor(api, hint) {
    super(`${api} is not implemented by tauri-electron${hint ? `: ${hint}` : ''}`)
    this.name = 'NotImplementedError'
    this.api = api
  }
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
