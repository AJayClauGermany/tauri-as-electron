/**
 * Transport shared by the Node built-ins backed by tauri-plugin-electron
 * (`fs`, `os`, `child_process`): blocking calls over the synchronous bridge
 * (`node/<module>/<op>?a=<json>`, binary answers), and the explanations for
 * the ways such a call can be refused.
 */
import { syncRequestBytes, featureError } from './native.js'
import { inTauri, NotImplementedError } from './runtime.js'

const utf8 = new TextDecoder()

export function parseJson(bytes) {
  const text = utf8.decode(bytes)
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

/** A plain Uint8Array view (never a Blob: it arrives empty on WebKitGTK). */
export function plainBytes(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/**
 * Why a call to `module` failed: the feature is off, a renderer called it,
 * the plugin is too old, or (`toError`, for answers with a `syscall`) the
 * operation itself failed.
 */
export function nodeFailure({ api, module, feature, status, body, toError }) {
  if (body?.code === 'ERR_FEATURE_DISABLED') return featureError(api, feature)
  if (body?.code === 'ERR_ACCESS_DENIED') {
    return new NotImplementedError(api, {
      reason: 'permission',
      hint: `${body.message}. Use ${module} in the main process and reach it from renderer windows over ipcMain.handle, as with a sandboxed Electron renderer.`,
    })
  }
  if (body && typeof body === 'object' && 'syscall' in body && toError) return toError(body)
  if (status === 404) {
    return new NotImplementedError(api, { reason: 'plugin', hint: `This tauri-plugin-electron predates Node ${module} support: update it and enable its "${feature}" feature.` })
  }
  return new Error(`${api} failed (${status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`)
}

export function noTauri(api, module, feature) {
  return new NotImplementedError(api, {
    reason: 'unsupported',
    hint: `Node ${module} needs the Tauri runtime (tauri-plugin-electron with its "${feature}" feature).`,
  })
}

/**
 * Blocking call: returns the answer's bytes, or throws what `nodeFailure`
 * makes of a refusal.
 */
export function nodeCallSync({ api, module, feature, op, args = {}, body, toError }) {
  if (!inTauri) throw noTauri(api, module, feature)
  let response
  try {
    response = syncRequestBytes(`node/${module}/${op}`, {
      query: `a=${encodeURIComponent(JSON.stringify(args))}`,
      body: body === undefined ? undefined : plainBytes(body),
    })
  } catch (error) {
    const explained = new NotImplementedError(api, {
      reason: 'plugin',
      hint: 'The tauri-electron:// bridge did not answer: register tauri-plugin-electron in src-tauri/src/lib.rs.',
    })
    explained.cause = error
    throw explained
  }
  if (response.status === 200) return response.bytes
  throw nodeFailure({ api, module, feature, status: response.status, body: parseJson(response.bytes), toError })
}
