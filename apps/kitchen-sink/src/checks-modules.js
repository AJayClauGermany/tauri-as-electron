// Checks for the modules used on the main code path of VS Code and GitHub
// Desktop (net, session, protocol, power, systemPreferences, ...). Same shape
// as checks.js and, like it, runs unchanged on Electron and on Tauri.
import {
  app,
  net,
  session,
  protocol,
  powerMonitor,
  powerSaveBlocker,
  systemPreferences,
  safeStorage,
  crashReporter,
  autoUpdater,
  screen,
  clipboard,
  nativeImage,
  dialog,
  shell,
} from 'electron'
import path from 'node:path'

// 1x1 transparent PNG
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const bytes = (text) => (typeof Buffer !== 'undefined' ? Buffer.from(text) : new TextEncoder().encode(text))

export const moduleChecks = [
  // --- net ------------------------------------------------------------------------
  { id: 'net.isOnline', run: () => { const v = net.isOnline(); assert(typeof v === 'boolean', 'boolean'); return v } },
  { id: 'net.fetch(https://example.com)', manual: true, run: async () => {
    const response = await net.fetch('https://example.com')
    return `${response.status} ${(await response.text()).length} bytes`
  } },
  { id: 'net.request(https://example.com)', manual: true, run: () => new Promise((resolve, reject) => {
    const request = net.request('https://example.com')
    request.on('response', (response) => {
      let size = 0
      response.on('data', (chunk) => (size += chunk.length))
      response.on('end', () => resolve(`${response.statusCode} ${response.headers['content-type']} ${size} bytes`))
    })
    request.on('error', reject)
    request.end()
  }) },

  // --- session ----------------------------------------------------------------------
  { id: 'session.defaultSession.getUserAgent', run: () => { const ua = session.defaultSession.getUserAgent(); assert(ua, 'non-empty'); return ua.slice(0, 60) } },
  { id: 'session.defaultSession.resolveProxy', run: async () => { const v = await session.defaultSession.resolveProxy('https://example.com'); assert(typeof v === 'string', 'string'); return v } },
  { id: 'session.setSpellCheckerLanguages', run: () => {
    const s = session.defaultSession
    const languages = s.availableSpellCheckerLanguages.length ? [s.availableSpellCheckerLanguages[0]] : []
    s.setSpellCheckerLanguages(languages)
    return JSON.stringify(s.getSpellCheckerLanguages())
  } },
  { id: "session.fromPartition('persist:kitchen')", run: () => {
    const s = session.fromPartition('persist:kitchen')
    assert(s.isPersistent(), 'persistent')
    assert(s === session.fromPartition('persist:kitchen'), 'cached')
    return 'persistent'
  } },

  // --- protocol ---------------------------------------------------------------------
  { id: "protocol.handle('kitchen')", run: async () => {
    if (!(await protocol.isProtocolHandled('kitchen'))) {
      protocol.handle('kitchen', (request) => new Response(`<title>kitchen</title>hello from ${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html' } }))
    }
    assert(await protocol.isProtocolHandled('kitchen'), 'handled')
    return 'handled'
  } },

  // --- power ------------------------------------------------------------------------
  { id: 'powerMonitor.getSystemIdleState', run: () => { const v = powerMonitor.getSystemIdleState(60); assert(['active', 'idle', 'locked', 'unknown'].includes(v), v); return v } },
  { id: 'powerMonitor.isOnBatteryPower', run: () => { const v = powerMonitor.isOnBatteryPower(); assert(typeof v === 'boolean', 'boolean'); return v } },
  { id: 'powerSaveBlocker.start/stop', run: () => {
    const id = powerSaveBlocker.start('prevent-app-suspension')
    assert(powerSaveBlocker.isStarted(id), 'started')
    powerSaveBlocker.stop(id)
    assert(!powerSaveBlocker.isStarted(id), 'stopped')
    return `id ${id}`
  } },

  // --- systemPreferences / safeStorage / crashReporter / autoUpdater -------------------
  { id: 'systemPreferences.getAnimationSettings', run: () => {
    const v = systemPreferences.getAnimationSettings()
    assert(typeof v.prefersReducedMotion === 'boolean', 'prefersReducedMotion')
    return JSON.stringify(v)
  } },
  { id: 'systemPreferences.getMediaAccessStatus', run: () => {
    // macOS/Windows only in Electron; tauri-electron provides it everywhere.
    if (typeof systemPreferences.getMediaAccessStatus !== 'function') return `not on ${process.platform}`
    return systemPreferences.getMediaAccessStatus('microphone')
  } },
  { id: 'safeStorage.isEncryptionAvailable', run: () => { const v = safeStorage.isEncryptionAvailable(); assert(typeof v === 'boolean', 'boolean'); return v } },
  { id: 'crashReporter.getUploadedReports', run: () => crashReporter.getUploadedReports().length },
  { id: 'autoUpdater.getFeedURL', run: () => {
    try {
      return autoUpdater.getFeedURL() || '(empty)'
    } catch (error) {
      // Electron's autoUpdater has no Linux implementation.
      if (process.platform === 'linux' && process.versions.electron) return `not on Linux: ${error.message}`
      throw error
    }
  } },

  // --- screen events -------------------------------------------------------------------
  { id: "screen.on('display-metrics-changed')", run: () => {
    const listener = () => {}
    screen.on('display-metrics-changed', listener)
    screen.removeListener('display-metrics-changed', listener)
    return 'registered'
  } },

  // --- clipboard / nativeImage -----------------------------------------------------------
  { id: 'clipboard.writeBuffer/readBuffer', run: async () => {
    if (typeof clipboard.writeBuffer !== 'function') return 'not in this Electron version'
    clipboard.writeBuffer('application/x-kitchen-sink', bytes('kitchen'))
    const read = await clipboard.readBuffer('application/x-kitchen-sink')
    const text = new TextDecoder().decode(read)
    assert(text === 'kitchen', `read "${text}"`)
    return text
  } },
  { id: 'clipboard.readImage', manual: true, run: async () => { const image = await clipboard.readImage(); return image.isEmpty() ? '(no image)' : JSON.stringify(image.getSize()) } },
  { id: 'nativeImage.getSize', run: () => {
    const size = nativeImage.createFromDataURL(PNG_DATA_URL).getSize()
    assert(size.width === 1 && size.height === 1, JSON.stringify(size))
    return JSON.stringify(size)
  } },

  // --- dialog (sync) ------------------------------------------------------------------------
  { id: 'dialog.showMessageBoxSync (3 buttons)', manual: true, run: () => dialog.showMessageBoxSync({ type: 'question', message: 'Pick one', buttons: ['One', 'Two', 'Three'] }) },
  { id: 'dialog.showSaveDialogSync', manual: true, run: () => dialog.showSaveDialogSync({ defaultPath: 'untitled.txt' }) || '(canceled)' },

  // --- shell ------------------------------------------------------------------------------
  { id: 'shell.trashItem (missing file rejects)', run: async () => {
    const missing = path.join(app.getPath('temp'), `kitchen-sink-missing-${Date.now()}`)
    try {
      await shell.trashItem(missing)
    } catch (error) {
      if (error?.name === 'NotImplementedError') throw error
      return `rejected: ${String(error?.message ?? error).slice(0, 60)}`
    }
    return 'resolved (nothing to trash)'
  } },
]
