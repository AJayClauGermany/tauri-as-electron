// Checks for roadmap wave B items B9 (Notification events on desktop) and
// B11 (powerMonitor system events and idle time). Same shape as checks.js
// and, like it, runs unchanged on Electron and on Tauri.
import { Notification, powerMonitor } from 'electron'

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Resolves with the first of `events` that `emitter` emits, or 'timeout'. */
function firstOf(emitter, events, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done('timeout'), timeout)
    const handlers = events.map((name) => [name, (...args) => done(name, args)])
    function done(name, args = []) {
      clearTimeout(timer)
      for (const [event, handler] of handlers) emitter.removeListener(event, handler)
      resolve({ name, args })
    }
    for (const [event, handler] of handlers) emitter.on(event, handler)
  })
}

const STATES = new Set(['active', 'idle', 'locked', 'unknown'])

export const waveBNative2Checks = [
  // --- B11: powerMonitor ------------------------------------------------------------------------
  { id: 'powerMonitor.getSystemIdleTime / getSystemIdleState', run: () => {
    const idle = powerMonitor.getSystemIdleTime()
    assert(Number.isInteger(idle) && idle >= 0, `idle time is a non-negative integer (${idle})`)
    const state = powerMonitor.getSystemIdleState(60)
    assert(STATES.has(state), `known state (${state})`)
    let threw = false
    try {
      powerMonitor.getSystemIdleState(-1)
    } catch {
      threw = true
    }
    assert(threw, 'a negative threshold throws')
    return `${idle}s, ${state}`
  } },
  { id: "powerMonitor.on('suspend' / 'lock-screen' / 'shutdown')", run: async () => {
    const listener = () => {}
    for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) powerMonitor.on(name, listener)
    // tauri-electron: the events the operating system reports here.
    const events = powerMonitor._native ? [...(await powerMonitor._native)] : null
    for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) powerMonitor.removeListener(name, listener)
    return events ? `system reports: ${events.join(', ') || 'none (resume by heuristic)'}` : 'listening'
  } },

  // --- B9: Notification events ------------------------------------------------------------------
  { id: "Notification with actions: 'show' or 'failed'", run: async () => {
    const n = new Notification({ title: 'Kitchen sink', body: 'Wave B notification check', silent: true, actions: [{ type: 'button', text: 'OK' }] })
    const shown = firstOf(n, ['show', 'failed'], 10000)
    n.show()
    const { name, args } = await shown
    assert(name !== 'timeout', 'show or failed within 10 s')
    n.close()
    return name === 'show' ? 'shown' : `failed: ${args[1]} (no notification server?)`
  } },
  { id: "Notification 'click' / 'action' / 'close'", manual: true, run: async () => {
    const n = new Notification({ title: 'Kitchen sink', body: 'Click me, a button, or dismiss me', actions: [{ type: 'button', text: 'First' }, { type: 'button', text: 'Second' }] })
    const acted = firstOf(n, ['click', 'action', 'close'], 60000)
    n.show()
    const { name, args } = await acted
    assert(name !== 'timeout', 'an event within 60 s')
    return name === 'action' ? `action ${args[1]}` : name
  } },
]
