/**
 * Injected into every renderer page by the Vite plugin (before the preload).
 * Reports page lifecycle to the main process so that `ready-to-show`,
 * `did-finish-load`, `page-title-updated`, queued webContents.send() and
 * webContents.executeJavaScript() work.
 */
import { installProcessShim } from '../process.js'
import { isRenderer, report } from '../internal/runtime.js'
import { postToMain, rendererReady } from './ipc-renderer.js'

installProcessShim()

function lifecycle(name, data) {
  return postToMain({ type: 'lifecycle', name, data }).catch(report(`lifecycle ${name}`))
}

if (isRenderer) {
  const whenDom = new Promise((resolve) => {
    if (document.readyState !== 'loading') resolve()
    else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
  })
  const whenLoaded = new Promise((resolve) => {
    if (document.readyState === 'complete') resolve()
    else window.addEventListener('load', () => resolve(), { once: true })
  })

  Promise.all([rendererReady, whenDom])
    .then(() => lifecycle('dom-ready', { url: location.href }))
    .then(() => Promise.all([rendererReady, whenLoaded]))
    .then(() => {
      lifecycle('did-finish-load', { url: location.href, title: document.title })
      let lastTitle = document.title
      if (lastTitle) lifecycle('page-title-updated', { title: lastTitle })
      new MutationObserver(() => {
        if (document.title === lastTitle) return
        lastTitle = document.title
        lifecycle('page-title-updated', { title: lastTitle })
      }).observe(document.head ?? document.documentElement, { subtree: true, childList: true, characterData: true })
    })

  window.addEventListener('pagehide', () => lifecycle('unload'))
}
