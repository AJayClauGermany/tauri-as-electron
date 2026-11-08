/**
 * screen: monitors are fetched before `ready` and refreshed in the
 * background on every call, so the sync getters return recent data.
 * getCursorScreenPoint() is async in Tauri, so it returns a Promise here.
 */
import { availableMonitors, primaryMonitor, cursorPosition } from '@tauri-apps/api/window'
import { EventEmitter } from '../internal/emitter.js'
import { inTauri, report } from '../internal/runtime.js'

let displays = []
let primaryId = null

function toDisplay(monitor, index) {
  const scale = monitor.scaleFactor || 1
  const rect = (position, size) => ({
    x: Math.round(position.x / scale),
    y: Math.round(position.y / scale),
    width: Math.round(size.width / scale),
    height: Math.round(size.height / scale),
  })
  const bounds = rect(monitor.position, monitor.size)
  const workArea = monitor.workArea ? rect(monitor.workArea.position, monitor.workArea.size) : bounds
  return {
    id: index + 1,
    label: monitor.name ?? `Display ${index + 1}`,
    bounds,
    workArea,
    size: { width: bounds.width, height: bounds.height },
    workAreaSize: { width: workArea.width, height: workArea.height },
    scaleFactor: scale,
    rotation: 0,
    internal: false,
    monochrome: false,
    accelerometerSupport: 'unknown',
    touchSupport: 'unknown',
    colorDepth: 24,
    colorSpace: '',
    depthPerComponent: 8,
    displayFrequency: 60,
    detected: true,
  }
}

async function refresh() {
  const [all, primary] = await Promise.all([availableMonitors(), primaryMonitor()])
  displays = all.map(toDisplay)
  const primaryIndex = primary ? all.findIndex((m) => m.name === primary.name && m.position.x === primary.position.x && m.position.y === primary.position.y) : 0
  primaryId = displays[Math.max(primaryIndex, 0)]?.id ?? null
}

let refreshing = null
function refreshInBackground() {
  refreshing ??= refresh().catch(report('screen refresh')).finally(() => (refreshing = null))
}

function distanceToRect(point, r) {
  const dx = Math.max(r.x - point.x, 0, point.x - (r.x + r.width))
  const dy = Math.max(r.y - point.y, 0, point.y - (r.y + r.height))
  return dx * dx + dy * dy
}

class Screen extends EventEmitter {
  getAllDisplays() {
    refreshInBackground()
    return displays.map((d) => ({ ...d }))
  }

  getPrimaryDisplay() {
    refreshInBackground()
    const display = displays.find((d) => d.id === primaryId) ?? displays[0]
    return display ? { ...display } : undefined
  }

  getDisplayNearestPoint(point) {
    refreshInBackground()
    return [...displays].sort((a, b) => distanceToRect(point, a.bounds) - distanceToRect(point, b.bounds))[0]
  }

  getDisplayMatching(rect) {
    return this.getDisplayNearestPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
  }

  /** Async in tauri-electron (sync in Electron) - `await` it. */
  async getCursorScreenPoint() {
    const position = await cursorPosition()
    const display = this.getDisplayNearestPoint({ x: position.x, y: position.y })
    const scale = display?.scaleFactor ?? 1
    return { x: Math.round(position.x / scale), y: Math.round(position.y / scale) }
  }

  screenToDipPoint(point) {
    return point
  }

  dipToScreenPoint(point) {
    return point
  }
}

export const screen = new Screen()

export async function initScreen() {
  if (!inTauri) return
  await refresh().catch(report('screen init'))
}
