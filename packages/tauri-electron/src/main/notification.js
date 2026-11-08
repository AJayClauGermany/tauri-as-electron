/** Notification (main-process flavour), via @tauri-apps/plugin-notification. */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { report } from '../internal/runtime.js'

let permission = null

async function ensurePermission() {
  if (permission === true) return true
  permission = await isPermissionGranted()
  if (!permission) permission = (await requestPermission()) === 'granted'
  return permission
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
    this.hasReply = false
    this.actions = []
  }

  static isSupported() {
    return true
  }

  show() {
    ensurePermission()
      .then((granted) => {
        if (!granted) {
          this.emit('failed', createEvent(), 'Notification permission denied')
          return
        }
        const body = [this.subtitle, this.body].filter(Boolean).join('\n')
        sendNotification({ title: this.title, body, icon: this.icon, sound: this.silent ? undefined : 'default' })
        this.emit('show', createEvent())
      })
      .catch((error) => {
        report('Notification.show')(error)
        this.emit('failed', createEvent(), String(error))
      })
  }

  close() {
    this.emit('close', createEvent())
  }
}
