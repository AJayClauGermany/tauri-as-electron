/**
 * JavaScript side of tauri-plugin-electron (crates/tauri-plugin-electron),
 * the small Rust plugin for what Tauri's JS API and official plugins cannot
 * do: process info, a synchronous bridge, devtools, trash, custom protocols.
 *
 * Every helper degrades gracefully when the plugin is not installed:
 * `hasNativePlugin()` is false and callers fall back or report the API as
 * unsupported.
 */
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { inTauri, report, NotImplementedError } from './runtime.js'

export const BRIDGE_SCHEME = 'tauri-electron'

/** Invoke a tauri-plugin-electron command. */
export function native(command, args) {
  return invoke(`plugin:electron|${command}`, args)
}

/** URL of a synchronous-bridge endpoint (scheme URLs differ per platform). */
export function bridgeUrl(path) {
  return convertFileSrc(path, BRIDGE_SCHEME)
}

/**
 * Synchronous request to the bridge (a blocking XMLHttpRequest).
 * Returns { status, text } or throws if the bridge is unreachable.
 */
export function syncRequest(path, body) {
  const xhr = new XMLHttpRequest()
  xhr.open(body === undefined ? 'GET' : 'POST', bridgeUrl(path), false)
  xhr.send(body === undefined ? null : body)
  return { status: xhr.status, text: xhr.responseText }
}

/**
 * Synchronous request to the bridge with a binary answer. `query` is appended
 * after `bridgeUrl()` (which percent-encodes its whole argument); `body`
 * must be a Uint8Array (a Blob arrives empty on WebKitGTK). The response is
 * read as raw bytes through `x-user-defined`: `responseType` is not allowed
 * on synchronous requests. Returns { status, bytes }.
 */
export function syncRequestBytes(path, { query, body } = {}) {
  const xhr = new XMLHttpRequest()
  xhr.open(body === undefined ? 'GET' : 'POST', bridgeUrl(path) + (query ? `?${query}` : ''), false)
  xhr.overrideMimeType('text/plain; charset=x-user-defined')
  xhr.send(body === undefined ? null : body)
  const text = xhr.responseText ?? ''
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return { status: xhr.status, bytes }
}

let info = null
let infoPromise = null

/** Fetch argv/env/execPath/pid/cwd once. Resolves to null without the plugin. */
export function loadProcessInfo() {
  infoPromise ??= inTauri
    ? native('process_info').then((value) => (info = value), () => null)
    : Promise.resolve(null)
  return infoPromise
}

export function processInfo() {
  return info
}

export function hasNativePlugin() {
  return info !== null
}

/**
 * Whether a Cargo feature of tauri-plugin-electron is enabled ('updater',
 * 'single-instance', ...). Unknown (true) when the plugin is not installed.
 */
export function hasFeature(name) {
  return info === null || (info.features ?? []).includes(name)
}

/** Error for an API whose tauri-plugin-electron feature is off. */
export function featureError(api, feature) {
  return new NotImplementedError(api, {
    reason: 'feature',
    hint: `Add "${feature}" to the features of tauri-plugin-electron in src-tauri/Cargo.toml.`,
  })
}

// --- requests forwarded from Rust to the main process -----------------------------

const handlers = new Map()

/**
 * Handle bridge requests of `kind` ('sync-ipc', 'protocol'). The handler
 * returns (or resolves to) { status, headers, body, base64 }.
 */
export function onBridgeRequest(kind, handler) {
  handlers.set(kind, handler)
}

function respond(id, response) {
  return native('bridge_respond', {
    response: { id, status: response.status ?? 200, headers: response.headers ?? [], body: response.body ?? '', base64: Boolean(response.base64) },
  }).catch(report('bridge response'))
}

let listening = null
export function startBridgeListener() {
  if (!inTauri) return Promise.resolve()
  listening ??= getCurrentWebviewWindow().listen('tauri-electron:bridge-request', async ({ payload }) => {
    const handler = handlers.get(payload.kind)
    if (!handler) return respond(payload.id, { status: 404, body: `no handler for ${payload.kind}` })
    try {
      respond(payload.id, await handler(payload))
    } catch (error) {
      respond(payload.id, { status: 500, body: String(error?.stack ?? error) })
    }
  })
  return listening
}
