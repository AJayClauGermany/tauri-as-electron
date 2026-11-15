import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nodeFs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

// Roadmap wave A: everything but fs descriptors and streams (see fs.test.js).
// tauri-plugin-electron is replaced by a scripted fake of its commands and
// synchronous bridge.
const state = vi.hoisted(() => ({ commands: [], sync: [], onCommand: null, onSync: null, features: ['node-fs', 'power-save-blocker'] }))

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => 'async text'),
  writeText: vi.fn(),
  writeHtml: vi.fn(),
  writeImage: vi.fn(),
  readImage: vi.fn(async () => { throw new Error('no image') }),
  clear: vi.fn(async () => {}),
}))
vi.mock('../src/main/browser-window.js', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true }))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  const json = (value) => new TextEncoder().encode(JSON.stringify(value))
  return {
    ...actual,
    hasNativePlugin: () => true,
    startBridgeListener: () => Promise.resolve(),
    hasFeature: (name) => state.features.includes(name),
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand?.(command, args)
    },
    syncRequest(path) {
      state.sync.push(path)
      const { status = 200, value } = state.onSync?.(path) ?? {}
      return { status, text: JSON.stringify(value ?? null) }
    },
    syncRequestBytes(path, options = {}) {
      state.sync.push(path)
      const { status = 200, value, bytes } = state.onSync?.(path, options) ?? {}
      return { status, bytes: bytes ?? json(value ?? null) }
    },
  }
})

const { encodePng, decodePng, resizeRgba } = await import('../src/internal/png.js')
const { nativeImage } = await import('../src/main/native-image.js')
const { netFetch, filePath } = await import('../src/main/net.js')
const { protocol, onRequest } = await import('../src/main/protocol.js')
const { screen } = await import('../src/main/screen.js')
const { clipboard } = await import('../src/main/clipboard.js')
const { powerSaveBlocker } = await import('../src/main/power.js')
const { session, filterCookies } = await import('../src/main/session.js')
const shared = createRequire(import.meta.url)('../bundler/shared.cjs')

beforeEach(() => {
  state.commands = []
  state.sync = []
  state.onCommand = null
  state.onSync = null
  state.features = ['node-fs', 'power-save-blocker']
})

afterEach(() => {
  delete globalThis.__TAURI_ELECTRON_APP__
})

// --- PNG -----------------------------------------------------------------------------------------------

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A PNG built by hand (not with encodePng), to check the decoder against the format itself. */
function handmadePng({ width, height, depth, color, interlace = 0, raw, palette, trns }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([depth, color, 0, 0, interlace], 8)
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(palette ? [chunk('PLTE', palette)] : []),
    ...(trns ? [chunk('tRNS', trns)] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', []),
  ]))
}

describe('PNG codec', () => {
  it('round-trips RGBA through encodePng / decodePng', () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff)
    expect(decodePng(encodePng(rgba, 3, 2))).toEqual({ width: 3, height: 2, rgba })
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('decodes 2-bit palettes with transparency, and filtered 16-bit RGB', () => {
    // 4×1, 2-bit palette indices 0 1 2 3, index 1 half transparent.
    const palette = handmadePng({ width: 4, height: 1, depth: 2, color: 3, raw: [0, 0b00011011], palette: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9], trns: [255, 128] })
    expect([...decodePng(palette).rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255])
    // 2×2 RGB, 16 bits; row 2 uses the Up filter (adds the row above).
    const row1 = [0, 0x10, 0, 0x20, 0, 0x30, 0, 0x40, 0, 0x50, 0, 0x60, 0]
    const row2 = [2, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
    const rgb16 = handmadePng({ width: 2, height: 2, depth: 16, color: 2, raw: [...row1, ...row2] })
    expect([...decodePng(rgb16).rgba]).toEqual([0x10, 0x20, 0x30, 255, 0x40, 0x50, 0x60, 255, 0x11, 0x21, 0x31, 255, 0x41, 0x51, 0x61, 255])
  })

  it('decodes Adam7-interlaced grey images', () => {
    // 3×3 grey, pixel (x, y) = 10 * (3y + x). Passes 1, 4, 5, 6, 7 cover it.
    const v = (x, y) => 10 * (3 * y + x)
    const raw = [
      0, v(0, 0), // pass 1
      0, v(2, 0), // pass 4
      0, v(0, 2), v(2, 2), // pass 5
      0, v(1, 0), 0, v(1, 2), // pass 6
      0, v(0, 1), v(1, 1), v(2, 1), // pass 7
    ]
    const { rgba } = decodePng(handmadePng({ width: 3, height: 3, depth: 8, color: 0, interlace: 1, raw }))
    expect([...rgba].filter((_, i) => i % 4 === 0)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80])
  })

  it('resizes by averaging when shrinking', () => {
    const rgba = new Uint8Array([0, 0, 0, 255, 200, 100, 50, 255, 0, 0, 0, 255, 200, 100, 50, 255])
    expect([...resizeRgba(rgba, 2, 2, 1, 1)]).toEqual([100, 50, 25, 255])
    expect(resizeRgba(rgba, 2, 2, 4, 4)).toHaveLength(64)
  })
})

// --- nativeImage ------------------------------------------------------------------------------------------

const red2x2 = () => encodePng(new Uint8Array(16).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)), 2, 2)

describe('nativeImage (A5)', () => {
  it('resizes and crops PNGs synchronously', () => {
    const image = nativeImage.createFromBuffer(red2x2())
    const bigger = image.resize({ width: 4 })
    expect(bigger.getSize()).toEqual({ width: 4, height: 4 })
    expect(decodePng(bigger.toPNG())).toMatchObject({ width: 4, height: 4 })
    expect([...bigger.toBitmap().subarray(0, 4)]).toEqual([0, 0, 255, 255]) // BGRA
    const piece = image.crop({ x: 1, y: 0, width: 5, height: 1 })
    expect(piece.getSize()).toEqual({ width: 1, height: 1 })
    expect(image.crop({ x: 5, y: 5, width: 1, height: 1 }).isEmpty()).toBe(true)
  })

  it('reads absolute paths through Node fs, and gives an empty image for a missing file', () => {
    const png = red2x2()
    state.onSync = (path, { query }) => {
      const { path: file } = JSON.parse(decodeURIComponent(query.slice(2)))
      if (file === '/pics/icon@2x.png') return { bytes: png }
      return { status: 400, value: { code: 'ENOENT', errno: -2, syscall: 'open', path: file } }
    }
    const image = nativeImage.createFromPath('/pics/icon@2x.png')
    expect(state.sync).toEqual(['node/fs/read'])
    expect(image.getSize()).toEqual({ width: 1, height: 1 }) // 2 px at scale factor 2
    expect(image.toDataURL()).toMatch(/^data:image\/png;base64,/)
    expect(nativeImage.createFromPath('/pics/missing.png').isEmpty()).toBe(true)
    // The app's own files are still fetched from the app.
    globalThis.__TAURI_ELECTRON_APP__ = { root: null, entries: ['public'] }
    state.sync = []
    expect(nativeImage.createFromPath('/public/icon.png').isEmpty()).toBe(false)
    expect(state.sync).toEqual([])
  })

  it('resizes and crops images that are not loaded yet once they are', async () => {
    globalThis.__TAURI_ELECTRON_APP__ = { root: null, entries: ['public'] }
    const png = encodePng(new Uint8Array(4 * 2 * 4).fill(200), 4, 2)
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(png)
    try {
      const image = nativeImage.createFromPath('/public/icon.png')
      const half = image.resize({ width: 2 })
      expect(half.isEmpty()).toBe(false)
      await half._load()
      expect(half.getSize()).toEqual({ width: 2, height: 1 })
      const corner = nativeImage.createFromPath('/public/icon.png').crop({ x: 1, y: 1, width: 5, height: 5 })
      await corner._load()
      expect(corner.getSize()).toEqual({ width: 3, height: 1 })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('makes thumbnails that fit the size', async () => {
    state.onSync = () => ({ bytes: encodePng(new Uint8Array(8 * 4 * 4).fill(255), 8, 4) })
    const thumbnail = await nativeImage.createThumbnailFromPath('/pics/wide.png', { width: 4, height: 4 })
    expect(thumbnail.getSize()).toEqual({ width: 4, height: 2 })
    state.onSync = () => ({ status: 400, value: { code: 'ENOENT', errno: -2, syscall: 'open' } })
    await expect(nativeImage.createThumbnailFromPath('/x.png', { width: 4, height: 4 })).rejects.toThrow(/thumbnail/)
  })
})

// --- net.fetch('file://') and file protocols (A7) -----------------------------------------------------------

describe('file-backed protocols (A7)', () => {
  const frameArgs = (frame) => {
    const length = new DataView(frame.buffer).getUint32(0, true)
    return JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length)))
  }

  it('net.fetch reads file:// URLs through node_fs, with a content type', async () => {
    state.onCommand = (command, frame) => {
      const { op, args } = frameArgs(frame)
      if (args.path === '/srv/app/index.html') return new TextEncoder().encode('<h1>hi</h1>').buffer
      throw { code: 'ENOENT', errno: -2, syscall: op, path: args.path }
    }
    const response = await netFetch('file:///srv/app/index.html')
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(response.url).toBe('file:///srv/app/index.html')
    expect(await response.text()).toBe('<h1>hi</h1>')
    await expect(netFetch('file:///srv/app/missing.js')).rejects.toThrow('net::ERR_FILE_NOT_FOUND')
    expect(filePath(new URL('file:///C:/a%20b/c.txt'), 'win32')).toBe('C:\\a b\\c.txt')
    state.features = []
    await expect(netFetch('file:///srv/app/index.html')).rejects.toMatchObject({ name: 'NotImplementedError', reason: 'feature' })
  })

  it('registerFileProtocol serves the path its callback returns', async () => {
    state.onCommand = (command, frame) => {
      const { args } = frameArgs(frame)
      if (args.path === '/srv/app/style.css') return new TextEncoder().encode('body{}').buffer
      throw { code: 'ENOENT', errno: -2, syscall: 'open', path: args.path }
    }
    protocol.registerFileProtocol('vector', (request, callback) => {
      const name = new URL(request.url).pathname
      callback(name === '/missing' ? { error: -6 } : name === '/gone' ? '/srv/app/gone' : { path: `/srv/app${name}`, headers: { 'x-test': '1' } })
    })
    expect(protocol.isProtocolRegistered('vector')).toBe(true)
    const ok = await onRequest({ scheme: 'vector', url: 'vector://app/style.css', method: 'GET' })
    expect(ok.status).toBe(200)
    expect(Object.fromEntries(ok.headers)).toMatchObject({ 'content-type': 'text/css', 'x-test': '1' })
    expect(atob(ok.body)).toBe('body{}')
    expect((await onRequest({ scheme: 'vector', url: 'vector://app/missing', method: 'GET' })).status).toBe(404)
    expect((await onRequest({ scheme: 'vector', url: 'vector://app/gone', method: 'GET' })).status).toBe(404)
  })

  it('registerFileProtocol keeps # and ? in paths, and answers bodiless statuses', async () => {
    const read = []
    state.onCommand = (command, frame) => {
      read.push(frameArgs(frame).args.path)
      return new TextEncoder().encode('x').buffer
    }
    protocol.registerFileProtocol('notes', (request, callback) => {
      callback(request.url.endsWith('cached') ? { path: '/n/a', statusCode: 304 } : '/n/C#/what?.md')
    })
    expect((await onRequest({ scheme: 'notes', url: 'notes://app/x', method: 'GET' })).status).toBe(200)
    expect(read).toEqual(['/n/C#/what?.md'])
    expect((await onRequest({ scheme: 'notes', url: 'notes://app/cached', method: 'GET' })).status).toBe(304)
  })
})

// --- screen, clipboard, power, cookies -------------------------------------------------------------------------

describe('screen.getCursorScreenPoint (A3)', () => {
  it('is synchronous, answered over the bridge', () => {
    state.onSync = () => ({ value: { x: 300, y: 150 } })
    expect(screen.getCursorScreenPoint()).toEqual({ x: 300, y: 150 })
    expect(state.sync).toEqual(['cursor'])
    state.onSync = () => ({ status: 500, value: 'no' })
    expect(screen.getCursorScreenPoint()).toEqual({ x: 0, y: 0 })
  })
})

describe('clipboard (A8)', () => {
  it('reads asynchronously for current Electron, readHTML through a command', async () => {
    globalThis.__TAURI_ELECTRON_APP__ = { entries: [], electron: 45 }
    expect(clipboard.readText()).toBeInstanceOf(Promise)
    expect(await clipboard.readText()).toBe('async text')
    state.onCommand = (command) => (command === 'clipboard_read_html' ? '<b>x</b>' : undefined)
    expect(await clipboard.readHTML()).toBe('<b>x</b>')
    expect(state.sync).toEqual([])
  })

  it('reads synchronously for apps on Electron < 45', () => {
    globalThis.__TAURI_ELECTRON_APP__ = { entries: [], electron: 28 }
    const pixels = new Uint8Array([4, 0, 0, 0, 1, 0, 0, 0, 10, 20, 30, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9])
    state.onSync = (path) => ({
      'clipboard/readText': { value: 'sync text' },
      'clipboard/readHTML': { value: '<i>y</i>' },
      'clipboard/formats': { value: ['text/plain', 'text/html'] },
      'clipboard/has/text/html': { value: true },
      'clipboard/has/image/png': { value: false },
      'clipboard/readImage': { bytes: pixels },
    })[path]
    expect(clipboard.readText()).toBe('sync text')
    expect(clipboard.readHTML()).toBe('<i>y</i>')
    expect(clipboard.availableFormats()).toEqual(['text/plain', 'text/html'])
    expect(clipboard.has('text/html')).toBe(true)
    expect(clipboard.has('image/png')).toBe(false)
    const image = clipboard.readImage()
    expect(image.getSize()).toEqual({ width: 4, height: 1 })
    expect([...image.toBitmap().subarray(0, 4)]).toEqual([30, 20, 10, 255])
  })
})

describe('powerSaveBlocker (A9)', () => {
  it('holds an operating-system assertion per blocker', async () => {
    let next = 7
    state.onCommand = (command) => (command === 'power_blocker_start' ? next++ : true)
    const id = powerSaveBlocker.start('prevent-display-sleep')
    expect(powerSaveBlocker.isStarted(id)).toBe(true)
    expect(state.commands[0]).toEqual({ command: 'power_blocker_start', args: { kind: 'prevent-display-sleep' } })
    expect(powerSaveBlocker.stop(id)).toBe(true)
    expect(powerSaveBlocker.stop(id)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.commands[1]).toEqual({ command: 'power_blocker_stop', args: { id: 7 } })
    expect(() => powerSaveBlocker.start('nap')).toThrow(TypeError)
  })
})

describe('session.cookies (A6)', () => {
  const cookie = (extra) => ({ name: 'a', value: '1', domain: '.example.com', hostOnly: false, path: '/', secure: false, httpOnly: false, session: true, expirationDate: null, sameSite: 'unspecified', ...extra })

  it('filters like Electron', () => {
    const all = [cookie(), cookie({ name: 'b', domain: 'api.example.com', secure: true }), cookie({ name: 'c', domain: 'other.test' })]
    expect(filterCookies(all, { domain: 'example.com' }).map((c) => c.name)).toEqual(['a', 'b'])
    expect(filterCookies(all, { secure: true }).map((c) => c.name)).toEqual(['b'])
    expect(filterCookies(all, { name: 'c' }).map((c) => c.name)).toEqual(['c'])
  })

  it('goes through the main window for the default session and emits changed', async () => {
    const changes = []
    const cookies = session.defaultSession.cookies
    cookies.on('changed', (event, c, cause, removed) => changes.push([c.name, cause, removed]))
    state.onCommand = (command, args) => ({
      cookies_get: [cookie(), cookie({ name: 'z', session: false, expirationDate: 2e9 })],
      cookies_set: cookie({ name: args.details?.name }),
      cookies_remove: [cookie()],
    })[command]
    const got = await cookies.get({ url: 'https://example.com', name: 'a' })
    expect(got).toEqual([{ ...cookie() , expirationDate: undefined }].map(({ expirationDate, ...rest }) => rest))
    expect(state.commands[0]).toEqual({ command: 'cookies_get', args: { label: 'electron-main', url: 'https://example.com' } })
    await cookies.set({ url: 'https://example.com', name: 'n', value: 'v', sameSite: 'lax' })
    expect(state.commands[1].args.details).toMatchObject({ url: 'https://example.com', name: 'n', value: 'v', sameSite: 'lax' })
    await cookies.remove('https://example.com', 'a')
    expect(changes).toEqual([['n', 'explicit', false], ['a', 'explicit', true]])
    await expect(cookies.set({ name: 'x' })).rejects.toThrow(/url is required/)
    await expect(session.fromPartition('persist:other').cookies.get({})).rejects.toThrow(/no window uses partition/)
  })
})

// --- bundler helpers (A8, A10) ----------------------------------------------------------------------------------

describe('bundler: Electron version and session preloads (A8, A10)', () => {
  let root
  beforeEach(() => {
    root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'te-wave-a-'))
  })
  afterEach(() => nodeFs.rmSync(root, { recursive: true, force: true }))

  const write = (file, text) => {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(root, file)), { recursive: true })
    nodeFs.writeFileSync(nodePath.join(root, file), text)
  }

  it('reads the electron major version from package.json', () => {
    write('package.json', JSON.stringify({ devDependencies: { electron: '^28.1.0' } }))
    expect(shared.electronMajor(root)).toBe(28)
    expect(shared.appFilesConfig(root, { dev: false }).electron).toBe(28)
    write('package.json', JSON.stringify({ dependencies: { electron: 'latest' } }))
    expect(shared.electronMajor(root)).toBeNull()
    expect('electron' in shared.appFilesConfig(root, { dev: false })).toBe(false)
  })

  it('prefers the installed electron version to the range', () => {
    write('package.json', JSON.stringify({ devDependencies: { electron: '>=44 <46' } }))
    write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '45.1.0' }))
    expect(shared.electronMajor(root)).toBe(45)
  })

  it('finds the preloads of libraries the app depends on', () => {
    write('package.json', JSON.stringify({ dependencies: { 'electron-log': '^5.0.0' } }))
    write('node_modules/electron-log/package.json', JSON.stringify({ name: 'electron-log', main: 'src/index.js', exports: { '.': './src/index.js' } }))
    write('node_modules/electron-log/src/renderer/electron-log-preload.js', 'module.exports = 1')
    const found = shared.sessionPreloads(root)
    expect(found).toEqual([{ name: 'electron-log', id: nodePath.join(root, 'node_modules/electron-log/src/renderer/electron-log-preload.js'), file: true }])
    expect(shared.appFilesConfig(root, { dev: true, sessionPreloads: found }).sessionPreloads).toEqual(['electron-log'])
    expect(shared.sessionPreloads(root, false)).toEqual([])
    expect(shared.sessionPreloads(root, ['./src/extra-preload.js']).at(-1)).toEqual({ name: './src/extra-preload.js', id: nodePath.join(root, 'src/extra-preload.js'), file: true })
  })
})
