/**
 * `keytar` on tauri-plugin-electron's `keytar` feature: passwords in the
 * operating system's keychain (macOS Keychain, Windows Credential Manager,
 * the Secret Service on Linux). The bundler plugins alias `keytar` here.
 *
 * Entries are stored where keytar stores them (a generic password per
 * service and account; the credential `<service>/<account>`; a Secret
 * Service item with keytar's `service` / `account` attributes), so an app
 * moving from Electron keeps the passwords it saved. Like keytar, every call
 * fails when there is no keychain (Linux without a Secret Service): nothing
 * is kept in plain text.
 *
 * Main process (and `nodeIntegration` windows) only, as the Node built-ins.
 */
import { callAsync } from './common.js'

const PKG = 'keytar'

function checkRequired(value, name) {
  if (!value || value.length <= 0) throw new Error(`${name} is required.`)
}

function call(api, request) {
  return callAsync({
    api: `keytar.${api}`,
    pkg: PKG,
    command: 'keytar',
    args: { request },
    toError: (body) => new Error(body?.message ?? String(body)),
  })
}

/** The password of `account` for `service`, or null. */
export function getPassword(service, account) {
  checkRequired(service, 'Service')
  checkRequired(account, 'Account')
  return call('getPassword', { op: 'get', service, account })
}

/** Store (or replace) the password of `account` for `service`. */
export function setPassword(service, account, password) {
  checkRequired(service, 'Service')
  checkRequired(account, 'Account')
  checkRequired(password, 'Password')
  return call('setPassword', { op: 'set', service, account, password }).then(() => undefined)
}

/** Delete the password of `account` for `service`; whether there was one. */
export function deletePassword(service, account) {
  checkRequired(service, 'Service')
  checkRequired(account, 'Account')
  return call('deletePassword', { op: 'delete', service, account })
}

/** Every `{ account, password }` stored for `service`. */
export function findCredentials(service) {
  checkRequired(service, 'Service')
  return call('findCredentials', { op: 'find', service })
}

/** The password of one account of `service`, or null. */
export function findPassword(service) {
  checkRequired(service, 'Service')
  return call('findPassword', { op: 'findOne', service })
}

const keytar = { getPassword, setPassword, deletePassword, findCredentials, findPassword }
export default keytar
