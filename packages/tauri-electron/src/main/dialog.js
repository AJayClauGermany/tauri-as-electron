/**
 * dialog, implemented with @tauri-apps/plugin-dialog. The *Sync variants
 * use tauri-plugin-electron's synchronous bridge, which shows the same
 * plugin-dialog dialogs with its blocking Rust API.
 */
import { open, save, message } from '@tauri-apps/plugin-dialog'
import { NotImplementedError, report } from '../internal/runtime.js'
import { syncRequest } from '../internal/native.js'

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
  if (buttons.length > 3) console.warn('[tauri-electron] dialog.showMessageBox: only the first 3 buttons are shown')
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

export function messageResultToIndex(result, buttons) {
  const byLabel = buttons.indexOf(result)
  if (byLabel !== -1) return byLabel
  const map = { Ok: 0, Yes: 0, No: 1, Cancel: buttons.length - 1 }
  return map[result] ?? buttons.length - 1
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
    const { text, buttons, options } = toMessageOptions(electronOptions)
    const result = await message(text, options)
    return { response: messageResultToIndex(result, buttons), checkboxChecked: Boolean(electronOptions.checkboxChecked) }
  },

  showErrorBox(title, content) {
    message(String(content), { title: String(title), kind: 'error' }).catch(report('dialog.showErrorBox'))
  },

  showCertificateTrustDialog() {
    return Promise.reject(new NotImplementedError('dialog.showCertificateTrustDialog'))
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
    const { text, buttons, options } = toMessageOptions(splitArgs(windowOrOptions, maybeOptions))
    const result = syncDialog('message', { title: options.title, message: text, kind: options.kind, buttons }, 'showMessageBoxSync')
    return messageResultToIndex(result, buttons)
  },
}

/** Blocking dialog through tauri-plugin-electron's synchronous bridge. */
function syncDialog(kind, body, api) {
  let response
  try {
    response = syncRequest(`dialog/${kind}`, JSON.stringify(body))
  } catch {
    throw new NotImplementedError(`dialog.${api}`, 'register tauri-plugin-electron, or use the async version')
  }
  if (response.status !== 200) {
    if (response.status === 0 || response.status === 404) throw new NotImplementedError(`dialog.${api}`, 'register tauri-plugin-electron, or use the async version')
    throw new Error(`dialog.${api} failed: ${response.text}`)
  }
  return JSON.parse(response.text)
}
