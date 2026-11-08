import { describe, expect, it, vi } from 'vitest'

// Pure helpers only; the Tauri plugins are mocked out.
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))
vi.mock('../src/main/browser-window.js', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const { toNodeHeaders, normalizeRequestOptions } = await import('../src/main/net.js')
const { toNativeSchemeUrl, fromNativeSchemeUrl, isCustomScheme, protocol } = await import('../src/main/protocol.js')
const { parseImageSize, nativeImage } = await import('../src/main/native-image.js')
const { safeStorage } = await import('../src/main/safe-storage.js')
const { session, partitionWebviewOptions, dataStoreIdentifier } = await import('../src/main/session.js')
const { diffDisplays } = await import('../src/main/screen.js')
const { rgbToHex } = await import('../src/main/system-preferences.js')
const { crashReporter } = await import('../src/main/crash-reporter.js')

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('net', () => {
  it('shapes headers like Node', () => {
    const headers = new Headers([['Content-Type', 'text/plain'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']])
    const { headers: out, rawHeaders } = toNodeHeaders(headers)
    expect(out['content-type']).toBe('text/plain')
    expect(out['set-cookie']).toEqual(['a=1', 'b=2'])
    expect(rawHeaders.length).toBeGreaterThanOrEqual(4)
  })

  it('normalizes request options', () => {
    expect(normalizeRequestOptions('https://x.test/a')).toMatchObject({ url: 'https://x.test/a', method: 'GET' })
    expect(normalizeRequestOptions({ method: 'post', protocol: 'https:', hostname: 'x.test', port: 8443, path: '/p' })).toMatchObject({
      url: 'https://x.test:8443/p',
      method: 'POST',
    })
  })
})

describe('protocol', () => {
  it('maps custom scheme URLs per platform', () => {
    expect(isCustomScheme('app://index.html')).toBe(true)
    expect(isCustomScheme('https://x.test')).toBe(false)
    expect(toNativeSchemeUrl('app://localhost/a/b?c=1', 'win32')).toBe('http://app.localhost/a/b?c=1')
    expect(toNativeSchemeUrl('app://localhost/a', 'linux')).toBe('app://localhost/a')
    expect(fromNativeSchemeUrl('http://app.localhost/a?x', 'app', 'win32')).toBe('app://localhost/a?x')
    expect(fromNativeSchemeUrl('app://localhost/a', 'app', 'linux')).toBe('app://localhost/a')
  })

  it('tracks handled schemes', async () => {
    protocol.handle('unit', () => new Response('ok'))
    expect(await protocol.isProtocolHandled('unit')).toBe(true)
    expect(await protocol.isProtocolHandled('https')).toBe(true)
    expect(() => protocol.handle('unit', () => null)).toThrow()
    protocol.unhandle('unit')
    expect(await protocol.isProtocolHandled('unit')).toBe(false)
  })
})

describe('nativeImage', () => {
  it('reads sizes from image headers', () => {
    const image = nativeImage.createFromDataURL(PNG_1x1)
    expect(image.getSize()).toEqual({ width: 1, height: 1 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0, 0, 0])
    expect(parseImageSize(gif)).toEqual({ width: 3, height: 2 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0])
    expect(parseImageSize(jpeg)).toEqual({ width: 30, height: 20 })
    expect(parseImageSize(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('keeps bitmaps in BGRA', () => {
    const image = nativeImage.createFromBitmap(new Uint8Array([1, 2, 3, 4]), { width: 1, height: 1 })
    expect(image.getSize()).toEqual({ width: 1, height: 1 })
    expect([...image.toBitmap()]).toEqual([1, 2, 3, 4])
  })
})

describe('safeStorage', () => {
  it('reports encryption as unavailable with Electron errors', async () => {
    expect(safeStorage.isEncryptionAvailable()).toBe(false)
    expect(() => safeStorage.encryptString('x')).toThrow(/Encryption is not available/)
    expect(() => safeStorage.decryptString(new Uint8Array())).toThrow(/Decryption is not available/)
    await expect(safeStorage.encryptStringAsync('x')).rejects.toThrow(/Encryption is not available/)
  })
})

describe('session', () => {
  it('maps partitions to webview options', () => {
    expect(partitionWebviewOptions('')).toEqual({})
    expect(partitionWebviewOptions('temp')).toEqual({ incognito: true })
    expect(partitionWebviewOptions('persist:a', 'darwin').dataStoreIdentifier).toHaveLength(16)
    expect(partitionWebviewOptions('persist:a', 'linux')).toEqual({})
    expect(dataStoreIdentifier('a')).toEqual(dataStoreIdentifier('a'))
    expect(dataStoreIdentifier('a')).not.toEqual(dataStoreIdentifier('b'))
  })

  it('caches sessions per partition', async () => {
    expect(session.fromPartition('persist:x')).toBe(session.fromPartition('persist:x'))
    expect(session.fromPartition('persist:x').isPersistent()).toBe(true)
    expect(session.fromPartition('mem').isPersistent()).toBe(false)
    expect(session.fromPartition('')).toBe(session.defaultSession)
    session.defaultSession.setUserAgent('UA/1')
    expect(session.defaultSession._tauriWebviewOptions()).toEqual({ userAgent: 'UA/1' })
    expect(await session.defaultSession.resolveProxy('https://x.test')).toBe('DIRECT')
  })
})

describe('misc modules', () => {
  it('diffs displays', () => {
    const d = (id, width, scaleFactor = 1) => ({ id, label: `D${id}`, bounds: { x: 0, y: 0, width, height: 10 }, workArea: { x: 0, y: 0, width, height: 10 }, scaleFactor, rotation: 0 })
    const events = diffDisplays([d(1, 100), d(2, 100)], [d(1, 200, 2), d(3, 100)])
    expect(events.map((e) => e[0])).toEqual(['display-metrics-changed', 'display-added', 'display-removed'])
    expect(events[0][2]).toEqual(['bounds', 'workArea', 'scaleFactor'])
  })

  it('formats colors', () => {
    expect(rgbToHex('rgb(255, 0, 16)')).toBe('ff0010ff')
    expect(rgbToHex('rgba(0, 0, 0, 0.5)')).toBe('00000080')
  })

  it('crashReporter is a no-op', () => {
    crashReporter.start({ extra: { a: '1' } })
    expect(crashReporter.getUploadedReports()).toEqual([])
    expect(crashReporter.getParameters()).toEqual({ a: '1' })
  })
})
