/**
 * powerMonitor and powerSaveBlocker. Neither has an official Tauri plugin,
 * so both are best effort with web APIs:
 *
 * - powerMonitor: battery state from the Battery Status API where the
 *   webview has it (WebView2); idle state/time and thermal state report
 *   'unknown' / 0. 'resume' is detected heuristically (a timer that fires
 *   much later than scheduled means the machine slept); 'suspend',
 *   'lock-screen', 'unlock-screen' and 'shutdown' are never emitted.
 * - powerSaveBlocker: an operating-system assertion held by
 *   tauri-plugin-electron (feature `power-save-blocker`, on by default:
 *   IOPMAssertion, SetThreadExecutionState, logind / ScreenSaver
 *   inhibitors). Without it, the Screen Wake Lock API in a visible window
 *   (wake locks need a visible document; the main window is hidden), which
 *   only holds while that window is visible.
 */
import { EventEmitter, createEvent } from '../internal/emitter.js'
import { report, warnOnce } from '../internal/runtime.js'
import { native, hasNativePlugin, hasFeature } from '../internal/native.js'
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

  /** Called by EventEmitter for every way of adding a listener (on, once, addListener, prepend*). */
  _newListener(name) {
    if (name === 'resume') this._watchResume()
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

const useAssertions = () => hasNativePlugin() && hasFeature('power-save-blocker')
const TYPES = new Set(['prevent-app-suspension', 'prevent-display-sleep'])

/** Hold an OS assertion for blocker `id`; falls back to the wake lock if Rust refuses. */
function assert(id, type) {
  const blocker = blockers.get(id)
  blocker.assertion = native('power_blocker_start', { kind: type }).catch((error) => {
    warnOnce('powerSaveBlocker-assertion', `powerSaveBlocker: no operating-system assertion (${error?.message ?? error}); using a screen wake lock instead.`)
    blocker.wakeLock = true
    syncWakeLock()
    return null
  })
}

const ACQUIRE = `(async () => {
  if (window.__teWakeLock && !window.__teWakeLock.released) return true
  window.__teWakeLock = await navigator.wakeLock.request('screen')
  return true
})()`
const RELEASE = `(async () => { await window.__teWakeLock?.release(); window.__teWakeLock = null; return true })()`

function syncWakeLock() {
  if (![...blockers.values()].some((b) => b.wakeLock)) {
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
    type = String(type)
    if (!TYPES.has(type)) throw new TypeError(`Invalid powerSaveBlocker type: ${type}`)
    const id = nextBlockerId++
    blockers.set(id, { type, assertion: null, wakeLock: !useAssertions() })
    if (useAssertions()) assert(id, type)
    else syncWakeLock()
    return id
  },

  stop(id) {
    const blocker = blockers.get(id)
    if (!blocker) return false
    blockers.delete(id)
    blocker.assertion?.then((nativeId) => nativeId !== null && native('power_blocker_stop', { id: nativeId })).catch(report('powerSaveBlocker.stop'))
    if (blocker.wakeLock) syncWakeLock()
    return true
  },

  isStarted(id) {
    return blockers.has(id)
  },
}
