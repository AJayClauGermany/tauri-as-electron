/**
 * contextBridge. tauri-electron runs the preload script in the page itself
 * (there is no isolated world), so exposing an API simply assigns it to
 * `window`. Keep the Electron habit of exposing narrow, purpose-built APIs.
 */
export const contextBridge = {
  exposeInMainWorld(key, api) {
    Object.defineProperty(window, key, { value: Object.freeze(api), configurable: false, enumerable: true })
  },
  exposeInIsolatedWorld(_worldId, key, api) {
    contextBridge.exposeInMainWorld(key, api)
  },
}
