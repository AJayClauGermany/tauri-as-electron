/**
 * dialog, implemented with @tauri-apps/plugin-dialog. The *Sync variants
 * use tauri-plugin-electron's synchronous bridge, which shows the same
 * plugin-dialog dialogs with its blocking Rust API.
 *
 * Message boxes the native dialogs cannot show (more than three buttons, a
 * `checkboxLabel`) open tauri-plugin-electron's message-box window instead:
 * a small window with every button, the checkbox, `defaultId` (Enter) and
 * `cancelId` (Escape, closing the window).
 */
import { open, save, message } from '@tauri-apps/plugin-dialog'
import { NotImplementedError, report } from '../internal/runtime.js'
import { syncRequest, native, hasNativePlugin } from '../internal/native.js'

/** Electron allows an optional BrowserWindow as the first argument. */
function splitArgs(windowOrOptions, maybeOptions) {
  if (maybeOptions !== undefined || (windowOrOptions && typeof windowOrOptions.webContents === 'object')) {
    return maybeOptions ?? {}
  }
  return windowOrOptions ?? {}
}

function filters(list) {
  return list?.map((filter) => ({
    name: filter.name,
    extensions: filter.extensions.map((ext) => (ext === '*' ? '*' : ext.replace(/^\./, ''))),
  }))
}

export function toOpenOptions(options = {}) {
  const props = options.properties ?? ['openFile']
  return {
    title: options.title,
    defaultPath: options.defaultPath,
    filters: filters(options.filters),
    directory: props.includes('openDirectory') && !props.includes('openFile'),
    multiple: props.includes('multiSelections'),
    canCreateDirectories: props.includes('createDirectory') || undefined,
  }
}

export function toSaveOptions(options = {}) {
  return {
    title: options.title,
    defaultPath: options.defaultPath,
    filters: filters(options.filters),
    canCreateDirectories: true,
  }
}

const KIND = { error: 'error', warning: 'warning', info: 'info', question: 'info', none: 'info' }

/**
 * Electron passes any number of button labels and returns the clicked
 * index; Tauri supports up to three (ok / ok+cancel / yes+no+cancel).
 */
export function toMessageOptions(options = {}) {
  const buttons = options.buttons?.length ? options.buttons : ['OK']
  if (buttons.length > 3) console.warn('[tauri-electron] dialog.showMessageBox: only the first 3 buttons are shown (tauri-plugin-electron shows them all)')
  let tauriButtons
  if (buttons.length === 1) tauriButtons = { ok: buttons[0] }
  else if (buttons.length === 2) tauriButtons = { ok: buttons[0], cancel: buttons[1] }
  else tauriButtons = { yes: buttons[0], no: buttons[1], cancel: buttons[2] }
  const text = [options.message, options.detail].filter(Boolean).join('\n\n')
  return {
    text,
    buttons: buttons.slice(0, 3),
    options: { title: options.title, kind: KIND[options.type] ?? 'info', buttons: tauriButtons },
  }
}

export function messageResultToIndex(result, buttons, cancelId) {
  const byLabel = buttons.indexOf(result)
  if (byLabel !== -1) return byLabel
  const cancel = Number.isInteger(cancelId) ? cancelId : buttons.length - 1
  const map = { Ok: 0, Yes: 0, No: 1, Cancel: cancel }
  return map[result] ?? cancel
}

/** The window passed as the first argument, if any. */
function parentOf(windowOrOptions, maybeOptions) {
  return maybeOptions !== undefined || (windowOrOptions && typeof windowOrOptions.webContents === 'object') ? windowOrOptions : null
}

/**
 * Electron's default cancelId: the first button labelled "Cancel" or "No",
 * else 0.
 */
export function defaultCancelId(buttons) {
  const index = buttons.findIndex((label) => /^(cancel|no)$/i.test(String(label).replace(/&/g, '').trim()))
  return index === -1 ? 0 : index
}

/** Whether a native message dialog cannot show these options (Tauri's have at most three buttons and no checkbox). */
export function needsMessageWindow(options = {}) {
  return (options.buttons?.length ?? 0) > 3 || Boolean(options.checkboxLabel)
}

let nextMessageBox = 1

/** What tauri-plugin-electron's message-box window shows. */
export function toMessageWindowOptions(options = {}, parent = null) {
  const buttons = (options.buttons?.length ? options.buttons : ['OK']).map(String)
  return {
    id: `${Date.now().toString(36)}-${nextMessageBox++}`,
    parent: parent?._label || null,
    title: options.title ? String(options.title) : '',
    type: options.type ?? 'none',
    message: String(options.message ?? ''),
    detail: options.detail ? String(options.detail) : '',
    buttons,
    defaultId: Number.isInteger(options.defaultId) ? options.defaultId : -1,
    cancelId: Number.isInteger(options.cancelId) ? options.cancelId : defaultCancelId(buttons),
    checkboxLabel: options.checkboxLabel ? String(options.checkboxLabel) : '',
    checkboxChecked: Boolean(options.checkboxChecked),
  }
}

async function messageWindow(options, parent) {
  const request = toMessageWindowOptions(options, parent)
  const signal = options.signal
  if (signal?.aborted) return { response: request.cancelId, checkboxChecked: request.checkboxChecked }
  const onAbort = () => native('message_box_close', { id: request.id }).catch(report('dialog.showMessageBox abort'))
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    const answer = await native('message_box', { options: request })
    return { response: answer.response, checkboxChecked: Boolean(answer.checkboxChecked) }
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
  }
}

export const dialog = {
  async showOpenDialog(windowOrOptions, maybeOptions) {
    const selected = await open(toOpenOptions(splitArgs(windowOrOptions, maybeOptions)))
    const filePaths = selected == null ? [] : Array.isArray(selected) ? selected : [selected]
    return { canceled: filePaths.length === 0, filePaths, bookmarks: [] }
  },

  async showSaveDialog(windowOrOptions, maybeOptions) {
    const filePath = await save(toSaveOptions(splitArgs(windowOrOptions, maybeOptions)))
    return { canceled: !filePath, filePath: filePath ?? '' }
  },

  async showMessageBox(windowOrOptions, maybeOptions) {
    const electronOptions = splitArgs(windowOrOptions, maybeOptions)
    // More than three buttons or a checkbox: tauri-plugin-electron's message-box window.
    if (needsMessageWindow(electronOptions) && hasNativePlugin()) return messageWindow(electronOptions, parentOf(windowOrOptions, maybeOptions))
    const { text, buttons, options } = toMessageOptions(electronOptions)
    const result = await message(text, options)
    return { response: messageResultToIndex(result, buttons, electronOptions.cancelId), checkboxChecked: Boolean(electronOptions.checkboxChecked) }
  },

  showErrorBox(title, content) {
    message(String(content), { title: String(title), kind: 'error' }).catch(report('dialog.showErrorBox'))
  },

  showCertificateTrustDialog() {
    return Promise.reject(new NotImplementedError('dialog.showCertificateTrustDialog', { reason: 'unsupported' }))
  },

  /** Returns the selected paths, or undefined when canceled. */
  showOpenDialogSync(windowOrOptions, maybeOptions) {
    const paths = syncDialog('open', toOpenOptions(splitArgs(windowOrOptions, maybeOptions)), 'showOpenDialogSync')
    return paths?.length ? paths : undefined
  },

  /** Returns the chosen path, or '' when canceled. */
  showSaveDialogSync(windowOrOptions, maybeOptions) {
    return syncDialog('save', toSaveOptions(splitArgs(windowOrOptions, maybeOptions)), 'showSaveDialogSync') ?? ''
  },

  /** Returns the index of the clicked button. */
  showMessageBoxSync(windowOrOptions, maybeOptions) {
    const electronOptions = splitArgs(windowOrOptions, maybeOptions)
    if (needsMessageWindow(electronOptions) && hasNativePlugin()) {
      const request = toMessageWindowOptions(electronOptions, parentOf(windowOrOptions, maybeOptions))
      return syncDialog('message-window', request, 'showMessageBoxSync').response
    }
    const { text, buttons, options } = toMessageOptions(electronOptions)
    const result = syncDialog('message', { title: options.title, message: text, kind: options.kind, buttons }, 'showMessageBoxSync')
    return messageResultToIndex(result, buttons, electronOptions.cancelId)
  },
}

/** Blocking dialog through tauri-plugin-electron's synchronous bridge. */
function syncDialog(kind, body, api) {
  let response
  try {
    response = syncRequest(`dialog/${kind}`, JSON.stringify(body))
  } catch {
    throw new NotImplementedError(`dialog.${api}`, { reason: 'plugin', hint: 'Register tauri-plugin-electron, or use the async version.' })
  }
  if (response.status !== 200) {
    if (response.status === 0 || response.status === 404) throw new NotImplementedError(`dialog.${api}`, { reason: 'plugin', hint: 'Register tauri-plugin-electron, or use the async version.' })
    if (response.status === 501) throw new NotImplementedError(`dialog.${api}`, { reason: 'feature', hint: 'Enable the `dialog` feature of tauri-plugin-electron.' })
    throw new Error(`dialog.${api} failed: ${response.text}`)
  }
  return JSON.parse(response.text)
}
