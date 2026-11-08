/** Tray, implemented with Tauri's TrayIcon (requires the `tray-icon` cargo feature). */
import { TrayIcon } from '@tauri-apps/api/tray'
import { defaultWindowIcon } from '@tauri-apps/api/app'
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { deferred, report } from '../internal/runtime.js'
import { resolveImage } from './native-image.js'

let nextTrayId = 1

async function iconFor(image) {
  try {
    const bytes = await resolveImage(image)
    if (bytes) return bytes
  } catch (error) {
    report('Tray icon')(error)
  }
  return defaultWindowIcon()
}

export class Tray extends EventEmitter {
  constructor(image, guid) {
    super()
    this._id = guid ?? `electron-tray-${nextTrayId++}`
    this._destroyed = false
    this._title = ''
    this._tooltip = ''
    this._ready = deferred()
    iconFor(image)
      .then((icon) =>
        TrayIcon.new({
          id: this._id,
          icon: icon ?? undefined,
          showMenuOnLeftClick: false,
          action: (event) => this._onEvent(event),
        }),
      )
      .then((native) => {
        this._native = native
        this._ready.resolve(native)
      })
      .catch((error) => {
        this._ready.reject(error)
        report('new Tray()')(error)
      })
  }

  _onEvent(event) {
    const bounds = event.rect
      ? { x: event.rect.position.x ?? 0, y: event.rect.position.y ?? 0, width: event.rect.size.width ?? 0, height: event.rect.size.height ?? 0 }
      : {}
    const position = event.position ?? {}
    switch (event.type) {
      case 'Click':
        if (event.buttonState !== 'Up') return
        if (event.button === 'Left') this.emit('click', createEvent(), bounds, position)
        else if (event.button === 'Right') this.emit('right-click', createEvent(), bounds)
        else if (event.button === 'Middle') this.emit('middle-click', createEvent(), bounds)
        break
      case 'DoubleClick':
        this.emit('double-click', createEvent(), bounds)
        break
      case 'Enter':
        this.emit('mouse-enter', createEvent(), position)
        break
      case 'Leave':
        this.emit('mouse-leave', createEvent(), position)
        break
      case 'Move':
        this.emit('mouse-move', createEvent(), position)
        break
    }
  }

  _call(fn, what) {
    return this._ready.promise.then(fn).catch(report(`Tray.${what}`))
  }

  setImage(image) {
    this._call(async (n) => n.setIcon(await iconFor(image)), 'setImage')
  }

  setPressedImage() {}

  setToolTip(tooltip) {
    this._tooltip = tooltip
    this._call((n) => n.setTooltip(tooltip), 'setToolTip')
  }

  setTitle(title) {
    this._title = title
    this._call((n) => n.setTitle(title), 'setTitle')
  }

  getTitle() {
    return this._title
  }

  setContextMenu(menu) {
    this._menu = menu
    this._call(async (n) => n.setMenu(menu ? await menu._build() : null), 'setContextMenu')
  }

  popUpContextMenu(menu) {
    ;(menu ?? this._menu)?.popup()
  }

  closeContextMenu() {}

  setIgnoreDoubleClickEvents() {}

  getIgnoreDoubleClickEvents() {
    return false
  }

  getBounds() {
    return { x: 0, y: 0, width: 0, height: 0 }
  }

  focus() {}

  displayBalloon() {}

  removeBalloon() {}

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._call((n) => n.close(), 'destroy')
  }

  isDestroyed() {
    return this._destroyed
  }
}
