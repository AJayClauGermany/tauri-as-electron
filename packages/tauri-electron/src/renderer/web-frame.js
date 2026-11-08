/** webFrame: zoom via Tauri's webview zoom, CSS/JS injection in-page. */
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { report } from '../internal/runtime.js'

let zoomFactor = 1
let cssKey = 1

export const webFrame = {
  setZoomFactor(factor) {
    zoomFactor = factor
    getCurrentWebview().setZoom(factor).catch(report('webFrame.setZoomFactor'))
  },
  getZoomFactor: () => zoomFactor,
  setZoomLevel(level) {
    webFrame.setZoomFactor(Math.pow(1.2, level))
  },
  getZoomLevel: () => Math.log(zoomFactor) / Math.log(1.2),
  setVisualZoomLevelLimits() {},
  insertCSS(css) {
    const style = document.createElement('style')
    style.id = `tauri-electron-webframe-css-${cssKey++}`
    style.textContent = css
    document.head.appendChild(style)
    return style.id
  },
  removeInsertedCSS(key) {
    document.getElementById(key)?.remove()
  },
  executeJavaScript(code) {
    return Promise.resolve().then(() => (0, eval)(code))
  },
  getResourceUsage: () => ({}),
  clearCache() {},
  setSpellCheckProvider() {},
  get routingId() {
    return 0
  },
}
