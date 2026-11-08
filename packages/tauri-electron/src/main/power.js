/**
 * powerMonitor and powerSaveBlocker. Neither has an official Tauri plugin,
 * so both are best effort with web APIs:
 *
 * - powerMonitor: battery state from the Battery Status API where the
 *   webview has it (WebView2); idle state/time and thermal state report
 *   'unknown' / 0. 'resume' is detected heuristically (a timer that fires
 *   much later than scheduled means the machine slept); 'suspend',
 *   'lock-screen', 'unlock-screen' and 'shutdown' are never emitted.
 * - powerSaveBlocker: the Screen Wake Lock API, requested in a visible
 *   window (wake locks need a visible document; the main window is hidden).
 */
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { report, warnOnce } from '../internal/runtime.js'
import { BrowserWindow } from './browser-window.js'

const RESUME_CHECK_MS = 5000
const RESUME_GAP_MS = 30000

class PowerMonitor extends EventEmitter {
  constructor() {
    super()
    this._onBattery = false
    this._battery = null
    this._resumeTimer = null
    this._initBattery()
  }

  _initBattery() {
    if (typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function') return
    navigator.getBattery().then((battery) => {
      this._battery = battery
      this._onBattery = !battery.charging
      battery.addEventListener('chargingchange', () => {
        const onBattery = !battery.charging
        if (onBattery === this._onBattery) return
        this._onBattery = onBattery
        this.emit(onBattery ? 'on-battery' : 'on-ac', createEvent())
      })
    }, report('powerMonitor battery'))
  }

  on(name, listener) {
    super.on(name, listener)
    if (name === 'resume') this._watchResume()
    return this
  }

  once(name, listener) {
    super.once(name, listener)
    if (name === 'resume') this._watchResume()
    return this
  }

  /** Heuristic: a 5 s timer that fires 30+ s late means the system slept. */
  _watchResume() {
    if (this._resumeTimer) return
    let last = Date.now()
    this._resumeTimer = setInterval(() => {
      const now = Date.now()
      const gap = now - last
      last = now
      if (gap > RESUME_GAP_MS) this.emit('resume', createEvent())
      if (this.listenerCount('resume') === 0) {
        clearInterval(this._resumeTimer)
        this._resumeTimer = null
      }
    }, RESUME_CHECK_MS)
  }

  getSystemIdleState() {
    return 'unknown'
  }

  getSystemIdleTime() {
    return 0
  }

  getCurrentThermalState() {
    return 'unknown'
  }

  isOnBatteryPower() {
    return this._onBattery
  }

  get onBatteryPower() {
    return this._onBattery
  }
}

export const powerMonitor = new PowerMonitor()

// --- powerSaveBlocker --------------------------------------------------------------

const blockers = new Map()
let nextBlockerId = 0
let lockedWindow = null

const ACQUIRE = `(async () => {
  if (window.__teWakeLock && !window.__teWakeLock.released) return true
  window.__teWakeLock = await navigator.wakeLock.request('screen')
  return true
})()`
const RELEASE = `(async () => { await window.__teWakeLock?.release(); window.__teWakeLock = null; return true })()`

function syncWakeLock() {
  if (blockers.size === 0) {
    const win = lockedWindow
    lockedWindow = null
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(RELEASE).catch(() => {})
    return
  }
  if (lockedWindow && !lockedWindow.isDestroyed()) return
  const win = BrowserWindow.getAllWindows().find((w) => w.isVisible() && !w.isDestroyed())
  if (!win) {
    warnOnce('powerSaveBlocker-window', 'powerSaveBlocker: no visible window to hold a screen wake lock in; the system may still sleep.')
    return
  }
  lockedWindow = win
  win.webContents.executeJavaScript(ACQUIRE).catch((error) => {
    lockedWindow = null
    warnOnce('powerSaveBlocker-wakelock', `powerSaveBlocker: the Screen Wake Lock API is unavailable (${error?.message ?? error}); the system may still sleep.`)
  })
}

export const powerSaveBlocker = {
  start(type) {
    const id = nextBlockerId++
    blockers.set(id, String(type))
    syncWakeLock()
    return id
  },

  stop(id) {
    const removed = blockers.delete(id)
    if (removed) syncWakeLock()
    return removed
  },

  isStarted(id) {
    return blockers.has(id)
  },
}
