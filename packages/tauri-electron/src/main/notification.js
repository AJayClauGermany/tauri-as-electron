/**
 * Notification (main-process flavour).
 *
 * With tauri-plugin-electron (feature `notification`, on by default) on
 * desktop, notifications are shown from Rust through
 * tauri-plugin-notification, which reports what the user does with them:
 * 'click' (the notification itself), 'action' (a button of `actions`, by
 * index) and, on Linux, 'close'. Otherwise @tauri-apps/plugin-notification
 * shows them from JavaScript and only 'show' / 'close()' are reported.
 *
 * 'reply' is never emitted: no desktop backend reports inline replies.
 */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { inTauri, report } from '../internal/runtime.js'
import { native, hasNativePlugin, hasFeature, loadProcessInfo } from '../internal/native.js'
import { platform } from '../process.js'

const NATIVE_EVENT = 'tauri-electron:notification'
const isDesktop = platform === 'darwin' || platform === 'win32' || platform === 'linux' || platform === 'freebsd' || platform === 'openbsd'

let permission = null

async function ensurePermission() {
  if (permission === true) return true
  permission = await isPermissionGranted()
  if (!permission) permission = (await requestPermission()) === 'granted'
  return permission
}

/** Shown notifications that can still report something, by id. */
const live = new Map()
// Ids are i32 in Rust; start at a random offset so a reloaded main process does not reuse them.
let nextId = 1 + Math.floor(Math.random() * 1e6) * 1000
let listening = null

function listenForNative() {
  listening ??= getCurrentWebviewWindow().listen(NATIVE_EVENT, ({ payload }) => live.get(payload?.id)?._onNative(payload))
  return listening
}

async function useNative() {
  if (!inTauri || !isDesktop) return false
  await loadProcessInfo()
  return hasNativePlugin() && hasFeature('notification')
}

export class Notification extends EventEmitter {
  constructor(options = {}) {
    super()
    this.title = options.title ?? ''
    this.subtitle = options.subtitle ?? ''
    this.body = options.body ?? ''
    this.silent = Boolean(options.silent)
    this.icon = typeof options.icon === 'string' ? options.icon : undefined
    this.urgency = options.urgency ?? 'normal'
    this.timeoutType = options.timeoutType ?? 'default'
    this.hasReply = Boolean(options.hasReply)
    this.replyPlaceholder = options.replyPlaceholder ?? ''
    this.closeButtonText = options.closeButtonText ?? ''
    this.toastXml = options.toastXml ?? ''
    this.actions = Array.isArray(options.actions) ? options.actions : []
    this._id = null
    this._closed = false
  }

  static isSupported() {
    return true
  }

  /** Labels of the buttons, in the order 'action' reports them. */
  _buttons() {
    return this.actions.filter((a) => a && (a.type ?? 'button') === 'button').map((a) => String(a.text ?? ''))
  }

  _onNative({ event, action }) {
    switch (event) {
      case 'click':
        this.emit('click', createEvent())
        break
      case 'action': {
        // Buttons are reported by index; macOS reports their title.
        const index = /^\d+$/.test(String(action)) ? Number(action) : this._buttons().indexOf(String(action))
        this.emit('action', createEvent(), index)
        break
      }
      case 'close':
        this._onClosed()
        break
    }
  }

  _onClosed() {
    if (this._closed) return
    this._closed = true
    live.delete(this._id)
    this.emit('close', createEvent())
  }

  show() {
    this._closed = false
    useNative()
      .then(async (nativeBackend) => {
        const body = [this.subtitle, this.body].filter(Boolean).join('\n')
        if (nativeBackend) {
          this._id ??= nextId++
          live.set(this._id, this)
          await listenForNative()
          await native('notification_show', {
            options: { id: this._id, title: this.title, body, icon: this.icon, silent: this.silent, actions: this._buttons() },
          })
          this.emit('show', createEvent())
          return
        }
        if (!(await ensurePermission())) {
          this.emit('failed', createEvent(), 'Notification permission denied')
          return
        }
        sendNotification({ title: this.title, body, icon: this.icon, sound: this.silent ? undefined : 'default' })
        this.emit('show', createEvent())
      })
      .catch((error) => {
        live.delete(this._id)
        report('Notification.show')(error)
        this.emit('failed', createEvent(), String(error?.message ?? error))
      })
  }

  close() {
    // Linux removes it from the screen; macOS and Windows cannot remove a shown notification.
    if (this._id !== null && live.has(this._id)) native('notification_close', { id: this._id }).catch(report('Notification.close'))
    this._onClosed()
  }
}
