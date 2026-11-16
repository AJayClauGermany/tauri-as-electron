import { beforeEach, describe, expect, it, vi } from 'vitest'

// Roadmap wave C: printToPDF / capturePage (C8) and screen capture (C9):
// desktopCapturer, setDisplayMediaRequestHandler and the desktop
// getUserMedia mapping. tauri-plugin-electron is replaced by a scripted fake.
const state = vi.hoisted(() => ({ commands: [], onCommand: null, plugin: true, handlers: new Map() }))

vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true, isMainProcess: true }))
vi.mock('../src/process.js', async (importOriginal) => ({ ...(await importOriginal()), platform: 'linux' }))
vi.mock('../src/main/ipc-main.js', () => ({ ipcMain: { _handlers: state.handlers } }))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    hasNativePlugin: () => state.plugin,
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand?.(command, args)
    },
  }
})

const { pdfOptions, parsePageRanges, printToPDF, capturePage, PAPER_FORMATS } = await import('../src/main/capture.js')
const { desktopCapturer, sourceOptions } = await import('../src/main/desktop-capturer.js')
const { onPermissionRequest } = await import('../src/main/permissions.js')
const { noteDesktopCapture, DESKTOP_CAPTURE_CHANNEL } = await import('../src/main/display-media.js')
const { session } = await import('../src/main/session.js')
const renderer = await import('../src/renderer/display-media.js')
const { encodePng } = await import('../src/internal/png.js')
const electron = await import('../src/index.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const base64 = (bytes) => btoa(String.fromCharCode(...bytes))

/** A webContents as capture.js uses it. */
function fakeContents(label = 'electron-window-1', scaleFactor = 1) {
  return { _label: label, _win: { _nativeReady: { promise: Promise.resolve() }, _state: { scaleFactor } }, isDestroyed: () => false }
}

function png(width, height) {
  const rgba = new Uint8Array(width * height * 4).fill(255)
  return encodePng(rgba, width, height)
}

beforeEach(() => {
  state.commands = []
  state.onCommand = null
  state.plugin = true
})

describe('printToPDF options', () => {
  it("uses Electron's defaults: Letter, 0.4 in margins, scale 1, every page", () => {
    expect(pdfOptions()).toEqual({
      landscape: false,
      printBackground: false,
      displayHeaderFooter: false,
      scale: 1,
      pageWidth: 8.5,
      pageHeight: 11,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
      pageRanges: [],
    })
  })

  it('takes named sizes (any case), sizes in inches and the microns of Electron < 21', () => {
    expect(pdfOptions({ pageSize: 'a4' })).toMatchObject({ pageWidth: 8.27, pageHeight: 11.7 })
    expect(pdfOptions({ pageSize: 'Tabloid', landscape: true })).toMatchObject({ pageWidth: 11, pageHeight: 17, landscape: true })
    expect(pdfOptions({ pageSize: { width: 5, height: 7 } })).toMatchObject({ pageWidth: 5, pageHeight: 7 })
    const microns = pdfOptions({ pageSize: { width: 210000, height: 297000 } })
    expect(microns.pageWidth).toBeCloseTo(8.27, 2)
    expect(microns.pageHeight).toBeCloseTo(11.69, 2)
    expect(Object.keys(PAPER_FORMATS)).toEqual(['letter', 'legal', 'tabloid', 'ledger', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
  })

  it('reads margins, the legacy margin types, backgrounds and scale', () => {
    expect(pdfOptions({ margins: { top: 0, left: 1 }, printBackground: true, scale: 0.5 })).toMatchObject({ marginTop: 0, marginLeft: 1, marginBottom: 0.4, printBackground: true, scale: 0.5 })
    expect(pdfOptions({ marginsType: 1 })).toMatchObject({ marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 })
    expect(pdfOptions({ margins: { marginType: 'none' } })).toMatchObject({ marginTop: 0 })
  })

  it('rejects what Electron rejects', () => {
    expect(() => pdfOptions({ pageSize: 'A9' })).toThrow('Invalid pageSize A9')
    expect(() => pdfOptions({ pageSize: { width: 5 } })).toThrow('height and width properties are required for pageSize')
    expect(() => pdfOptions({ landscape: 'yes' })).toThrow(TypeError)
    expect(() => pdfOptions({ scale: 3 })).toThrow(RangeError)
    expect(() => pdfOptions({ margins: { top: -1 } })).toThrow(TypeError)
  })

  it('parses page ranges (1-based) and the { from, to } of Electron < 21 (0-based)', () => {
    expect(parsePageRanges('1-5, 8, 11-13')).toEqual([[1, 5], [8, 8], [11, 13]])
    expect(parsePageRanges('')).toEqual([])
    expect(parsePageRanges({ from: 0, to: 2 })).toEqual([[1, 3]])
    expect(() => parsePageRanges('3-1')).toThrow('Invalid pageRanges')
    expect(() => parsePageRanges('a-b')).toThrow('Invalid pageRanges')
    expect(() => parsePageRanges('0')).toThrow('Invalid pageRanges')
  })
})

describe('webContents.printToPDF / capturePage', () => {
  it('prints through print_to_pdf and resolves with the bytes', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 fake')
    state.onCommand = () => pdf.buffer
    const result = await printToPDF(fakeContents('w9'), { pageSize: 'A4', pageRanges: '2' })
    expect(state.commands).toEqual([{ command: 'print_to_pdf', args: { label: 'w9', options: expect.objectContaining({ pageWidth: 8.27, pageRanges: [[2, 2]] }) } }])
    expect(new TextDecoder().decode(result)).toBe('%PDF-1.4 fake')
  })

  it('rejects invalid options before asking Rust, and without the plugin', async () => {
    await expect(printToPDF(fakeContents(), { pageSize: 'B5' })).rejects.toThrow('Invalid pageSize')
    state.plugin = false
    const error = await printToPDF(fakeContents()).catch((e) => e)
    expect(error.name).toBe('NotImplementedError')
    expect(error.reason).toBe('plugin')
    expect(state.commands).toEqual([])
  })

  it('passes errors from the webview on', async () => {
    state.onCommand = () => Promise.reject('printing failed: no printer')
    await expect(printToPDF(fakeContents())).rejects.toThrow('printing failed: no printer')
  })

  it('wraps the PNG in a NativeImage (DIP size from the scale factor) and crops to rect', async () => {
    state.onCommand = (command) => (command === 'capture_page' ? png(40, 20).buffer : null)
    const image = await capturePage(fakeContents('w2', 2))
    expect(state.commands).toEqual([{ command: 'capture_page', args: { label: 'w2' } }])
    expect(image.getSize()).toEqual({ width: 20, height: 10 })
    expect(image.toPNG().length).toBeGreaterThan(8)
    const cropped = await capturePage(fakeContents('w2', 2), { x: 5, y: 0, width: 10, height: 5 })
    expect(cropped.getSize()).toEqual({ width: 10, height: 5 })
  })

  it('gives an empty image when the webview has nothing to show', async () => {
    state.onCommand = () => new ArrayBuffer(0)
    expect((await capturePage(fakeContents())).isEmpty()).toBe(true)
  })
})

describe('desktopCapturer.getSources', () => {
  it('is exported by the electron module', () => {
    expect(electron.desktopCapturer).toBe(desktopCapturer)
  })

  it('maps the options (types required, 150 × 150 thumbnails by default)', () => {
    expect(sourceOptions({ types: ['screen'] })).toEqual({ screens: true, windows: false, thumbnailWidth: 150, thumbnailHeight: 150, fetchWindowIcons: false })
    expect(sourceOptions({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: true })).toEqual({ screens: true, windows: true, thumbnailWidth: 0, thumbnailHeight: 0, fetchWindowIcons: true })
    expect(() => sourceOptions({})).toThrow(TypeError)
  })

  it('returns DesktopCapturerSources with NativeImage thumbnails and icons', async () => {
    const thumb = base64(png(15, 10))
    state.onCommand = () => [
      { id: 'screen:1:0', name: 'Entire Screen', displayId: '1', thumbnail: thumb, appIcon: null },
      { id: 'window:42:0', name: 'Editor', displayId: '', thumbnail: '', appIcon: base64(png(4, 4)) },
    ]
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: true })
    expect(state.commands[0]).toEqual({ command: 'desktop_sources', args: { options: { screens: true, windows: true, thumbnailWidth: 150, thumbnailHeight: 150, fetchWindowIcons: true } } })
    expect(sources.map((s) => [s.id, s.name, s.display_id])).toEqual([['screen:1:0', 'Entire Screen', '1'], ['window:42:0', 'Editor', '']])
    expect(sources[0].thumbnail.getSize()).toEqual({ width: 15, height: 10 })
    expect(sources[0].appIcon).toBe(null)
    expect(sources[1].thumbnail.isEmpty()).toBe(true)
    expect(sources[1].appIcon.getSize()).toEqual({ width: 4, height: 4 })
  })

  it('names the Cargo feature when it is off', async () => {
    state.onCommand = () => Promise.reject({ code: 'ERR_FEATURE_DISABLED', feature: 'desktop-capturer' })
    const error = await desktopCapturer.getSources({ types: ['screen'] }).catch((e) => e)
    expect(error.name).toBe('NotImplementedError')
    expect(error.reason).toBe('feature')
    expect(error.message).toContain('desktop-capturer')
  })

  it('asks for nothing when no type is wanted', async () => {
    expect(await desktopCapturer.getSources({ types: [] })).toEqual([])
    expect(state.commands).toEqual([])
  })
})

describe('setDisplayMediaRequestHandler', () => {
  const ses = () => session.defaultSession
  const answers = () => state.commands.filter((c) => c.command === 'permission_respond').map((c) => c.args.granted)
  const request = (id, extra = {}) => onPermissionRequest({ id, label: 'w1', permission: 'display-capture', mediaTypes: ['video'], url: 'https://meet.test/room', ...extra })

  beforeEach(() => {
    ses().setDisplayMediaRequestHandler(null)
    ses().setPermissionRequestHandler(null)
  })

  it('denies getDisplayMedia without a handler, as Electron does', () => {
    request(1)
    expect(answers()).toEqual([false])
  })

  it('calls the handler with the request and grants when it names a video source', async () => {
    const seen = []
    ses().setDisplayMediaRequestHandler((req, callback) => {
      seen.push(req)
      setTimeout(() => callback({ video: { id: 'screen:1:0', name: 'Entire Screen' } }), 0)
    })
    request(2, { mediaTypes: ['video', 'audio'] })
    expect(answers()).toEqual([])
    await flush()
    expect(answers()).toEqual([true])
    expect(seen).toEqual([{ frame: null, securityOrigin: 'https://meet.test', videoRequested: true, audioRequested: true, userGesture: true }])
    expect(state.commands[0].args).toMatchObject({ id: 2, permission: 'display-capture', mediaTypes: ['video', 'audio'] })
  })

  it('denies on callback({}) and on a throwing handler; answers once', () => {
    ses().setDisplayMediaRequestHandler((req, callback) => { callback({}); callback({ video: {} }) })
    request(3)
    ses().setDisplayMediaRequestHandler(() => { throw new Error('boom') })
    request(4)
    expect(answers()).toEqual([false, false])
  })

  it('grants without calling the handler with useSystemPicker', () => {
    const handler = vi.fn()
    ses().setDisplayMediaRequestHandler(handler, { useSystemPicker: true })
    request(5)
    expect(handler).not.toHaveBeenCalled()
    expect(answers()).toEqual([true])
  })

  it("answers a desktop getUserMedia() with the permission handler ('media'), not the display handler", () => {
    const display = vi.fn()
    ses().setDisplayMediaRequestHandler(display)
    // The page announced it over IPC (registered on ipcMain when the module loads).
    state.handlers.get(DESKTOP_CAPTURE_CHANNEL)({ sender: { _label: 'w1' } }, { sourceId: 'screen:1:0', audio: false })
    const asked = []
    ses().setPermissionRequestHandler((webContents, permission, callback, details) => {
      asked.push([permission, details.mediaTypes])
      callback(true)
    })
    request(6)
    expect(display).not.toHaveBeenCalled()
    expect(asked).toEqual([['media', ['video']]])
    expect(answers()).toEqual([true])
    // The announcement is used once: the next request goes to the display handler.
    request(7)
    expect(display).toHaveBeenCalledTimes(1)
  })

  it('grants an announced desktop capture without a permission handler, and forgets stale announcements', () => {
    noteDesktopCapture('w1', { sourceId: 'window:9:0' })
    request(8)
    noteDesktopCapture('w1', {}, Date.now() - 60_000)
    request(9)
    expect(answers()).toEqual([true, false])
  })
})

describe('renderer: desktop getUserMedia → getDisplayMedia', () => {
  it('recognises chromeMediaSource constraints and maps the mandatory limits', () => {
    expect(renderer.DESKTOP_CAPTURE_CHANNEL).toBe(DESKTOP_CAPTURE_CHANNEL)
    expect(renderer.desktopRequest({ video: true, audio: true })).toBe(null)
    expect(renderer.desktopRequest({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:1:0', maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15 } } })).toEqual({
      sourceId: 'screen:1:0',
      video: true,
      audio: false,
      display: { video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } }, audio: false },
    })
    expect(renderer.desktopRequest({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: { mandatory: { chromeMediaSource: 'desktop' } } })).toMatchObject({ video: true, audio: true, display: { video: true, audio: true } })
  })

  function fakeDevices() {
    const calls = []
    const track = (kind) => ({ kind, stopped: false, stop() { this.stopped = true } })
    const devices = {
      calls,
      async getUserMedia(constraints) { calls.push(['getUserMedia', constraints]); return 'camera' },
      async getDisplayMedia(constraints) {
        calls.push(['getDisplayMedia', constraints])
        const tracks = [track('video'), track('audio')]
        return {
          tracks,
          getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
          removeTrack: (t) => tracks.splice(tracks.indexOf(t), 1),
        }
      },
    }
    return devices
  }

  it('leaves other requests alone and announces desktop ones before getDisplayMedia', async () => {
    const devices = fakeDevices()
    const announce = vi.fn(async (request) => devices.calls.push(['announce', request]))
    expect(renderer.installDesktopCapture(devices, announce)).toBe(true)
    expect(renderer.installDesktopCapture(devices, announce)).toBe(false)
    expect(await devices.getUserMedia({ video: true })).toBe('camera')
    await devices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'window:3:0' } } })
    expect(devices.calls.slice(1)).toEqual([
      ['announce', { sourceId: 'window:3:0', audio: false }],
      ['getDisplayMedia', { video: true, audio: false }],
    ])
  })

  it('keeps only the audio of a desktop-audio request', async () => {
    const devices = fakeDevices()
    renderer.installDesktopCapture(devices, async () => {})
    const stream = await devices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })
    expect(stream.tracks.map((t) => t.kind)).toEqual(['audio'])
  })

  it('reports NotSupportedError when the webview has no getDisplayMedia', async () => {
    const devices = { async getUserMedia() { return 'camera' } }
    renderer.installDesktopCapture(devices, async () => {})
    const error = await devices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'screen' } } }).catch((e) => e)
    expect(error.name).toBe('NotSupportedError')
  })
})
