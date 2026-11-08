/**
 * crashReporter: accepted as a no-op so startup code that calls
 * crashReporter.start() keeps running. Tauri has no crash-dump collection;
 * use a Rust crash reporter (e.g. sentry) if you need one.
 */
import { warnOnce } from '../internal/runtime.js'

let parameters = {}
let uploadToServer = false

export const crashReporter = {
  start(options = {}) {
    warnOnce('crashReporter.start', 'crashReporter.start(): crashes are not collected by tauri-electron.')
    parameters = { ...(options.globalExtra ?? {}), ...(options.extra ?? {}) }
    uploadToServer = options.uploadToServer !== false
  },
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => uploadToServer,
  setUploadToServer(value) {
    uploadToServer = Boolean(value)
  },
  addExtraParameter(key, value) {
    parameters[key] = String(value)
  },
  removeExtraParameter(key) {
    delete parameters[key]
  },
  getParameters: () => ({ ...parameters }),
  getCrashesDirectory: () => '',
}
