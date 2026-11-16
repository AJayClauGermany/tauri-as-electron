/**
 * What the shims of npm packages with native code share (`keytar`,
 * `better-sqlite3`, `sqlite3`, `node-pty`): calls to tauri-plugin-electron
 * over the synchronous bridge (`node/<module>/<op>`, a JSON request in the
 * body) and its commands, and the explanations for refusals (feature off,
 * a sandboxed renderer, no Tauri).
 *
 * Like the Node built-ins backed by Rust, they answer the main process and
 * windows created with `nodeIntegration` / `sandbox: false` only.
 */
import { native, syncRequestBytes } from '../internal/native.js'
import { inTauri, explainError, NotImplementedError } from '../internal/runtime.js'
import { nodeFailure, parseJson, responseBytes } from '../internal/node-bridge.js'

const encoder = new TextEncoder()

/** The Cargo feature each package needs. */
export const FEATURES = Object.freeze({ keytar: 'keytar', 'better-sqlite3': 'sqlite', sqlite3: 'sqlite', 'node-pty': 'pty' })

function noTauri(api, pkg) {
  return new NotImplementedError(api, {
    reason: 'unsupported',
    hint: `${pkg} needs the Tauri runtime (tauri-plugin-electron with its "${FEATURES[pkg]}" feature).`,
  })
}

/** A refusal (feature off, renderer, old plugin) as an explained error, or null for the package's own errors. */
function refusal(api, pkg, status, body) {
  if (body?.code === 'ERR_FEATURE_DISABLED' || body?.code === 'ERR_ACCESS_DENIED' || status === 404) {
    return nodeFailure({ api, module: pkg, feature: FEATURES[pkg], status, body })
  }
  return null
}

/**
 * Blocking call to `node/<module>/<op>`. Returns the parsed JSON answer (the
 * raw bytes with `binary`); a failure is thrown as `toError(body)` makes it.
 */
export function callSync({ api, pkg, module, op, request, binary = false, toError }) {
  if (!inTauri) throw noTauri(api, pkg)
  let response
  try {
    response = syncRequestBytes(`node/${module}/${op}`, { body: encoder.encode(JSON.stringify(request ?? null)) })
  } catch (error) {
    const explained = new NotImplementedError(api, {
      reason: 'plugin',
      hint: 'The tauri-electron:// bridge did not answer: register tauri-plugin-electron in src-tauri/src/lib.rs.',
    })
    explained.cause = error
    throw explained
  }
  if (response.status === 200) return binary ? response.bytes : parseJson(response.bytes)
  const body = parseJson(response.bytes)
  throw refusal(api, pkg, response.status, body) ?? toError(body)
}

/** A tauri-plugin-electron command; failures as `toError(body)` makes them. */
export async function callAsync({ api, pkg, command, args, toError }) {
  if (!inTauri) throw noTauri(api, pkg)
  try {
    return await native(command, args)
  } catch (error) {
    if (error && typeof error === 'object' && !(error instanceof Error)) {
      throw refusal(api, pkg, 400, error) ?? toError(error)
    }
    throw explainError(api, error)
  }
}

/** A raw (`tauri::ipc::Response`) answer as bytes, or parsed as JSON. */
export function rawAnswer(value, binary = false) {
  const bytes = responseBytes(value)
  return binary ? bytes : parseJson(bytes)
}

/** Disposable (node-pty's `IDisposable`, VS Code's shape). */
export function disposable(dispose) {
  return { dispose }
}
