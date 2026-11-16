/**
 * Trusted origins: pages served by someone else's server (typically one the
 * app starts on loopback, like SiYuan's kernel at `http://127.0.0.1:6806`)
 * that get the renderer bootstrap, the preload and IPC like the app's own
 * pages. They are declared when the app is built
 * (`tauri.conf.json` > `plugins.electron.trustedOrigins`); tauri-plugin-electron
 * checks them and reports them in `process_info`.
 *
 * The bundler plugins cannot put the bootstrap in those pages' HTML, so they
 * build it (with the preloads) as one classic script; the main process hands
 * it to tauri-plugin-electron, which gives every window created afterwards an
 * initialization script running it on the trusted origins only.
 */
import { native, hasNativePlugin, processInfo } from '../internal/native.js'
import { report, warnOnce } from '../internal/runtime.js'

/** `[{ origin, scheme, host, port, node }]`; `port` null: any port. */
export function trustedOrigins() {
  return processInfo()?.trustedOrigins ?? []
}

/** The entry `url` is on, or null. */
export function trustedOriginOf(url) {
  const list = trustedOrigins()
  if (!list.length) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (scheme !== 'http' && scheme !== 'https') return null
  const port = Number(parsed.port || (scheme === 'https' ? 443 : 80))
  return list.find((o) => o.scheme === scheme && o.host === parsed.hostname && (o.port == null || o.port === port)) ?? null
}

/** How long window creation waits for the renderer script. */
const FETCH_TIMEOUT_MS = 15_000

/** The script's text, given up after FETCH_TIMEOUT_MS (window creation waits for it). */
function fetchScript(url, dev) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(new Error(`${url}: no answer in ${FETCH_TIMEOUT_MS / 1000} s`)), FETCH_TIMEOUT_MS) : null
  const options = { ...(dev ? { cache: 'no-store' } : {}), ...(controller ? { signal: controller.signal } : {}) }
  // The timer also covers the body: the abort ends a stalled read.
  return fetch(url, options)
    .then((response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`)
      return response.text()
    })
    .finally(() => clearTimeout(timer))
}

let registration = null
let registered = false
let lastScript = null
// The last attempt failed (a build tries again for the next window).
let failed = false

/**
 * Hand the renderer script to tauri-plugin-electron. Resolves to whether
 * windows created from now on run it on the trusted origins. In a build it
 * is fetched once (later calls share the first one's promise); in
 * development (the dev server rebuilds it after a source change) it is
 * fetched again for each window (one fetch at a time, in order) and handed
 * over again when it changed.
 */
export function registerTrustedRenderer() {
  const app = globalThis.__TAURI_ELECTRON_APP__
  const dev = Boolean(app?.root)
  if (registration && !dev && !failed) return registration
  if (!hasNativePlugin() || !trustedOrigins().length) return (registration = Promise.resolve(false))
  const url = app?.trustedRenderer
  if (!url) {
    warnOnce(
      'trusted-renderer',
      'tauri.conf.json declares trusted origins (plugins.electron.trustedOrigins), but the bundler plugin did not build their renderer script ' +
        "(its `trustedOrigins` option is false, or tauri.conf.json is not in src-tauri/): pages of those origins get no preload or IPC.",
    )
    return (registration = Promise.resolve(false))
  }
  const base = globalThis.location?.href
  // One registration at a time (in development each starts after the
  // previous one ended), so an older script never replaces a newer one.
  registration = (registration ?? Promise.resolve())
    .then(() => fetchScript(base ? new URL(url, base) : url, dev))
    .then(async (script) => {
      failed = false
      if (script === lastScript) return registered
      const ok = Boolean(await native('set_trusted_renderer', { script }))
      lastScript = script
      return (registered = ok)
    })
    .catch((error) => {
      failed = true
      report('trusted origins: renderer script')(error)
      return registered
    })
  return registration
}

/** Whether windows created now get the renderer script on trusted origins. */
export function trustedRendererRegistered() {
  return registered
}
