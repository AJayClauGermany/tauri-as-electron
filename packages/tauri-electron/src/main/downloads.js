/**
 * Downloads: `session.on('will-download')`, DownloadItem,
 * `webContents.downloadURL()` and `session.downloadURL()`, on
 * tauri-plugin-electron (src/downloads.rs).
 *
 * The webview picks a download's destination before the main process hears
 * of it, so every download is written to a temporary file and moved to the
 * item's save path when it is complete. `item.setSavePath()` therefore works
 * as in Electron: call it in the 'will-download' handler (or later; the move
 * waits for it). Without a save path, a save dialog asks, as in Electron.
 *
 * - Downloads the page starts: progress and sizes on Linux (WebKitGTK); on
 *   Windows and macOS the total size is unknown and cancel() discards the
 *   file once the transfer ends. pause() works for neither.
 * - downloadURL(): an HTTP transfer in Rust with the session's cookies:
 *   sizes, pause, resume and cancel work (the `net` feature).
 */
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { MAIN_LABEL, report, warnOnce } from '../internal/runtime.js'
import { native, hasNativePlugin } from '../internal/native.js'
import { join } from '../path.js'

const items = new Map()
/** downloadURL() calls whose download Rust has not reported yet, by tag. */
const pendingTags = new Map()
let nextTag = 1

// Set by browser-window.js / session.js (avoids import cycles).
let resolveContents = () => null
let defaultSessionRef = null
let showSaveDialog = null
let downloadsDir = () => ''

export function configureDownloads({ webContentsFromLabel, defaultSession, saveDialog, getDownloadsPath }) {
  if (webContentsFromLabel) resolveContents = webContentsFromLabel
  if (defaultSession) defaultSessionRef = defaultSession
  if (saveDialog) showSaveDialog = saveDialog
  if (getDownloadsPath) downloadsDir = getDownloadsPath
}

export class DownloadItem extends EventEmitter {
  constructor(details, session) {
    super()
    this._id = details.id
    this._session = session
    this._url = details.url ?? ''
    this._filename = details.filename || 'download'
    this._mimeType = details.mimeType ?? ''
    this._totalBytes = details.totalBytes ?? 0
    this._receivedBytes = 0
    this._canPause = Boolean(details.canPause)
    this._paused = false
    this._state = 'progressing'
    this._savePath = ''
    this._dialogOptions = {}
    this._startTime = Date.now() / 1000
    this._endTime = 0
    this._done = false
    this._lastProgress = { time: Date.now(), bytes: 0, rate: 0 }
    this._savePathSet = null
    this._savePathPromise = new Promise((resolve) => (this._savePathSet = resolve))
  }

  setSavePath(path) {
    this._savePath = String(path)
    this._savePathSet(this._savePath)
  }

  getSavePath() {
    return this._savePath
  }

  get savePath() { return this.getSavePath() }
  set savePath(path) { this.setSavePath(path) }

  setSaveDialogOptions(options) {
    this._dialogOptions = { ...options }
  }

  getSaveDialogOptions() {
    return { ...this._dialogOptions }
  }

  pause() {
    if (this._state !== 'progressing' || this._paused) return
    if (!this._canPause) {
      warnOnce('DownloadItem.pause', 'DownloadItem.pause() only works for webContents.downloadURL() downloads in tauri-electron; downloads started by the page keep going.')
      return
    }
    this._paused = true
    native('download_control', { id: this._id, action: 'pause' }).catch(report('DownloadItem.pause'))
  }

  isPaused() {
    return this._paused
  }

  resume() {
    if (!this._paused) return
    this._paused = false
    native('download_control', { id: this._id, action: 'resume' }).catch(report('DownloadItem.resume'))
  }

  canResume() {
    return this._canPause && this._paused
  }

  cancel() {
    if (this._done) return
    native('download_control', { id: this._id, action: 'cancel' }).catch(report('DownloadItem.cancel'))
    this._finish('cancelled')
  }

  getURL() { return this._url }
  getURLChain() { return [this._url] }
  getMimeType() { return this._mimeType }
  hasUserGesture() { return false }
  getFilename() { return this._filename }
  getTotalBytes() { return this._totalBytes }
  getReceivedBytes() { return this._receivedBytes }
  getContentDisposition() { return '' }
  getState() { return this._state }
  getLastModifiedTime() { return '' }
  getETag() { return '' }
  getStartTime() { return this._startTime }
  getEndTime() { return this._endTime }
  getCurrentBytesPerSecond() { return this._state === 'progressing' && !this._paused ? this._lastProgress.rate : 0 }
  getPercentComplete() {
    if (this._state === 'completed') return 100
    return this._totalBytes > 0 ? Math.floor((this._receivedBytes / this._totalBytes) * 100) : -1
  }

  _onProgress({ receivedBytes, totalBytes }) {
    if (this._done) return
    const now = Date.now()
    const elapsed = (now - this._lastProgress.time) / 1000
    const rate = elapsed > 0 ? Math.round((receivedBytes - this._lastProgress.bytes) / elapsed) : 0
    this._lastProgress = { time: now, bytes: receivedBytes, rate }
    this._receivedBytes = receivedBytes ?? this._receivedBytes
    if (totalBytes) this._totalBytes = totalBytes
    this.emit('updated', createEvent(), this._paused ? 'interrupted' : 'progressing')
  }

  async _onDone({ state, receivedBytes, totalBytes }) {
    if (this._done) return
    if (receivedBytes !== undefined) this._receivedBytes = receivedBytes
    if (totalBytes) this._totalBytes = totalBytes
    if (state !== 'completed') return this._finish(state)
    const path = await this._savePathPromise
    if (this._done) return
    if (!path) {
      native('download_discard', { id: this._id }).catch(() => {})
      return this._finish('cancelled')
    }
    try {
      this._savePath = await native('download_commit', { id: this._id, path })
      this._finish('completed')
    } catch (error) {
      report('DownloadItem save')(error)
      this._finish('interrupted')
    }
  }

  _finish(state) {
    if (this._done) return
    this._done = true
    this._state = state
    this._endTime = Date.now() / 1000
    items.delete(this._id)
    this.emit('done', createEvent(), state)
  }
}

/** Without setSavePath() in 'will-download', Electron asks with a save dialog. */
async function askForSavePath(item, webContents) {
  if (!showSaveDialog) return item.setSavePath('')
  const dir = item._session?._downloadPath || downloadsDir()
  const options = { defaultPath: dir ? join(dir, item.getFilename()) : item.getFilename(), ...item._dialogOptions }
  try {
    const owner = webContents?._win && !webContents._win.isDestroyed() ? webContents._win : undefined
    const { canceled, filePath } = owner ? await showSaveDialog(owner, options) : await showSaveDialog(options)
    if (canceled || !filePath) item.cancel()
    else item.setSavePath(filePath)
  } catch (error) {
    report('download save dialog')(error)
    item.cancel()
  }
}

/** `tauri-electron:download` events from tauri-plugin-electron. */
export function onDownloadEvent(payload) {
  if (payload.event === 'started') {
    const pending = payload.tag ? pendingTags.get(payload.tag) : null
    if (pending) pendingTags.delete(payload.tag)
    const webContents = pending?.webContents ?? resolveContents(payload.label) ?? null
    const session = pending?.session ?? webContents?.session ?? defaultSessionRef
    const item = new DownloadItem(payload, session)
    items.set(payload.id, item)
    const event = createEvent()
    session?.emit('will-download', event, item, webContents)
    if (event.defaultPrevented) {
      item._done = true
      item._state = 'cancelled'
      items.delete(item._id)
      native('download_control', { id: item._id, action: 'cancel' }).catch(() => {})
      return item
    }
    if (!item._savePath && !item._done) askForSavePath(item, webContents)
    return item
  }
  const item = items.get(payload.id)
  if (!item) return null
  if (payload.event === 'progress') item._onProgress(payload)
  else if (payload.event === 'done') item._onDone(payload)
  return item
}

/** webContents.downloadURL() / session.downloadURL(). */
export function downloadURL(session, webContents, url, options = {}) {
  if (!hasNativePlugin()) {
    warnOnce('downloadURL', 'downloadURL() needs tauri-plugin-electron.')
    return
  }
  const tag = `download-${nextTag++}`
  pendingTags.set(tag, { session, webContents })
  const headers = Object.entries(options?.headers ?? {}).map(([name, value]) => [name, String(value)])
  const start = (label) =>
    native('download_url', { label, url: String(url), headers, tag }).catch((error) => {
      pendingTags.delete(tag)
      report('downloadURL')(error)
    })
  if (webContents?._win) {
    // The window's cookie store is reached through its webview.
    webContents._win._nativeReady.promise.then(() => start(webContents._label), () => start(MAIN_LABEL))
  } else {
    start(MAIN_LABEL)
  }
}
