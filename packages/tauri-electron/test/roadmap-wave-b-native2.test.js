import { beforeEach, describe, expect, it, vi } from 'vitest'

// Roadmap wave B: Notification events on desktop (B9) and powerMonitor's
// system events and idle time (B11). tauri-plugin-electron is a scripted fake.
const state = vi.hoisted(() => ({ commands: [], sync: [], listeners: new Map(), onCommand: null, idle: { idle: 42, locked: false }, features: ['notification', 'power-monitor'], sent: [] }))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn((options) => state.sent.push(options)),
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    listen: async (event, handler) => {
      state.listeners.set(event, handler)
      return () => state.listeners.delete(event)
    },
  }),
}))
vi.mock('../src/main/browser-window.js', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true, isMainProcess: true }))
vi.mock('../src/process.js', async (importOriginal) => ({ ...(await importOriginal()), platform: 'linux' }))
vi.mock('../src/internal/native.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProcessInfo: async () => ({}),
  hasNativePlugin: () => true,
  hasFeature: (name) => state.features.includes(name),
  async native(command, args) {
    state.commands.push({ command, args })
    return state.onCommand?.(command, args)
  },
  syncRequest(path) {
    state.sync.push(path)
    return { status: 200, text: JSON.stringify(state.idle) }
  },
}))

const { Notification } = await import('../src/main/notification.js')
const { powerMonitor } = await import('../src/main/power.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const fire = (event, payload) => state.listeners.get(event)?.({ payload })

beforeEach(() => {
  state.commands = []
  state.sync = []
  state.sent = []
  state.onCommand = null
  state.features = ['notification', 'power-monitor']
})

describe('Notification (B9)', () => {
  it('shows through tauri-plugin-electron and reports click, action and close', async () => {
    const n = new Notification({ title: 'Hi', subtitle: 'sub', body: 'there', actions: [{ type: 'button', text: 'Yes' }, { type: 'button', text: 'No' }] })
    const seen = []
    for (const name of ['show', 'click', 'action', 'close']) n.on(name, (_e, arg) => seen.push(arg === undefined ? name : `${name}:${arg}`))
    n.show()
    await flush()
    const shown = state.commands.find((c) => c.command === 'notification_show')
    expect(shown.args.options).toMatchObject({ title: 'Hi', body: 'sub\nthere', actions: ['Yes', 'No'], silent: false })
    const id = shown.args.options.id
    fire('tauri-electron:notification', { id, event: 'click' })
    fire('tauri-electron:notification', { id, event: 'action', action: '1' })
    fire('tauri-electron:notification', { id, event: 'action', action: 'Yes' }) // macOS: by title
    fire('tauri-electron:notification', { id: id + 1, event: 'click' }) // another notification
    fire('tauri-electron:notification', { id, event: 'close' })
    fire('tauri-electron:notification', { id, event: 'close' })
    expect(seen).toEqual(['show', 'click', 'action:1', 'action:0', 'close'])
  })

  it('close() asks Rust to remove it and emits close once', async () => {
    const n = new Notification({ title: 'x' })
    const close = vi.fn()
    n.on('close', close)
    n.show()
    await flush()
    n.close()
    n.close()
    expect(state.commands.filter((c) => c.command === 'notification_close')).toHaveLength(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('falls back to plugin-notification without the feature, and reports failures', async () => {
    state.features = []
    const n = new Notification({ title: 'plain', body: 'b' })
    const show = vi.fn()
    n.on('show', show)
    n.show()
    await flush()
    expect(state.sent).toEqual([{ title: 'plain', body: 'b', icon: undefined, sound: 'default' }])
    expect(show).toHaveBeenCalled()

    state.features = ['notification']
    state.onCommand = (command) => {
      if (command === 'notification_show') throw new Error('no notification server')
    }
    const failing = new Notification({ title: 'f' })
    const failed = vi.fn()
    failing.on('failed', failed)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    failing.show()
    await flush()
    expect(failed.mock.calls[0][1]).toBe('no notification server')
  })
})

describe('powerMonitor (B11)', () => {
  it('reads idle time and state over the synchronous bridge', () => {
    state.idle = { idle: 42, locked: false }
    expect(powerMonitor.getSystemIdleTime()).toBe(42)
    expect(powerMonitor.getSystemIdleState(60)).toBe('active')
    expect(powerMonitor.getSystemIdleState(30)).toBe('idle')
    state.idle = { idle: 1, locked: true }
    expect(powerMonitor.getSystemIdleState(60)).toBe('locked')
    state.idle = { idle: null, locked: null }
    expect(powerMonitor.getSystemIdleState(60)).toBe('unknown')
    expect(powerMonitor.getSystemIdleTime()).toBe(0)
    expect(() => powerMonitor.getSystemIdleState(-1)).toThrow(TypeError)
    expect(state.sync.every((p) => p === 'power/idle')).toBe(true)
  })

  it('starts the native events on the first listener and forwards them', async () => {
    state.onCommand = (command) => (command === 'power_monitor_start' ? ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown'] : undefined)
    const seen = []
    for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) powerMonitor.on(name, () => seen.push(name))
    await powerMonitor._native
    expect(state.commands.filter((c) => c.command === 'power_monitor_start')).toHaveLength(1)
    // The system reports resume: no heuristic timer runs.
    expect(powerMonitor._resumeTimer).toBeNull()
    for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown', 'bogus']) fire('tauri-electron:power-monitor', { event })
    expect(seen).toEqual(['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown'])
    powerMonitor.removeAllListeners()
  })
})
