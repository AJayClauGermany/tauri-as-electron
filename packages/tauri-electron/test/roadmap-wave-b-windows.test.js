import { beforeEach, describe, expect, it, vi } from 'vitest'

// Roadmap wave B: downloads (B6), permission handlers (B7) and setProxy
// (B13), with tauri-plugin-electron replaced by a scripted fake.
const state = vi.hoisted(() => ({ commands: [], onCommand: null, created: [], plugin: true }))

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn(async (input, init) => ({ input, init })) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn(async () => null), message: vi.fn() }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    constructor(label, options) {
      this.label = label
      this.options = options
      this.listeners = {}
      state.created.push({ label, options })
    }
    once(event, handler) { (this.listeners[event] ??= []).push(handler) }
    emit(event, payload) { for (const handler of this.listeners[event] ?? []) handler({ event, payload }) }
  },
}))
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

const { onDownloadEvent, downloadURL, configureDownloads } = await import('../src/main/downloads.js')
const { onPermissionRequest } = await import('../src/main/permissions.js')
const { parseProxyConfig, describeProxy } = await import('../src/main/proxy.js')
const { createWebviewWindow } = await import('../src/main/native-window.js')
const { session } = await import('../src/main/session.js')
const httpFetch = (await import('@tauri-apps/plugin-http')).fetch

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  state.commands = []
  state.onCommand = null
  state.created = []
  state.plugin = true
})

describe('createWebviewWindow', () => {
  it('creates the window in Rust and reports it like WebviewWindow', async () => {
    const win = createWebviewWindow('w1', { url: 'index.html', parent: { label: 'p' } }, { permissionHandler: true })
    const created = vi.fn()
    win.once('tauri://created', created)
    await flush()
    expect(state.created[0]).toEqual({ label: 'w1', options: { url: 'index.html', parent: { label: 'p' }, skip: true } })
    expect(state.commands[0]).toEqual({ command: 'create_window', args: { options: { url: 'index.html', parent: 'p', label: 'w1' }, extras: { permissionHandler: true } } })
    expect(created).toHaveBeenCalled()
  })

  it('reports a failure as tauri://error and falls back to WebviewWindow without the plugin', async () => {
    state.onCommand = () => Promise.reject(new Error('nope'))
    const failed = vi.fn()
    createWebviewWindow('w2', {}).once('tauri://error', failed)
    await flush()
    expect(failed.mock.calls[0][0].payload.message).toBe('nope')
    state.plugin = false
    state.commands = []
    createWebviewWindow('w3', { url: 'x' })
    expect(state.commands).toEqual([])
    expect(state.created.at(-1)).toEqual({ label: 'w3', options: { url: 'x' } })
  })
})

describe('downloads', () => {
  it('emits will-download, progress and done, then moves the file to the save path', async () => {
    const ses = session.defaultSession
    const seen = []
    const onWill = (event, item, webContents) => {
      seen.push(['will-download', item.getFilename(), item.getURL(), item.getMimeType(), item.getTotalBytes(), webContents])
      item.setSavePath('/tmp/out/report.pdf')
      item.on('updated', (_e, state) => seen.push(['updated', state, item.getReceivedBytes(), item.getPercentComplete()]))
      item.on('done', (_e, state) => seen.push(['done', state, item.getSavePath(), item.getState()]))
    }
    ses.on('will-download', onWill)
    state.onCommand = (command, args) => (command === 'download_commit' ? args.path : undefined)
    onDownloadEvent({ event: 'started', id: 7, label: 'nowhere', url: 'https://x.test/r.pdf', filename: 'r.pdf', mimeType: 'application/pdf', totalBytes: 10, canPause: true })
    onDownloadEvent({ event: 'progress', id: 7, receivedBytes: 5, totalBytes: 10 })
    onDownloadEvent({ event: 'done', id: 7, state: 'completed', receivedBytes: 10, totalBytes: 10 })
    await flush()
    ses.removeListener('will-download', onWill)
    expect(seen).toEqual([
      ['will-download', 'r.pdf', 'https://x.test/r.pdf', 'application/pdf', 10, null],
      ['updated', 'progressing', 5, 50],
      ['done', 'completed', '/tmp/out/report.pdf', 'completed'],
    ])
    expect(state.commands).toContainEqual({ command: 'download_commit', args: { id: 7, path: '/tmp/out/report.pdf' } })
  })

  it('cancels on preventDefault and on item.cancel(); pause only for HTTP transfers', async () => {
    const ses = session.defaultSession
    const prevent = (event) => event.preventDefault()
    ses.once('will-download', prevent)
    onDownloadEvent({ event: 'started', id: 8, label: 'x', url: 'https://x.test/a', filename: 'a' })
    expect(state.commands).toContainEqual({ command: 'download_control', args: { id: 8, action: 'cancel' } })

    let item
    ses.once('will-download', (_e, i) => { item = i; i.setSavePath('/tmp/b') })
    onDownloadEvent({ event: 'started', id: 9, label: 'x', url: 'https://x.test/b', filename: 'b', canPause: false })
    item.pause()
    expect(item.isPaused()).toBe(false)
    const done = vi.fn()
    item.on('done', done)
    item.cancel()
    expect(done.mock.calls[0][1]).toBe('cancelled')
    expect(item.getState()).toBe('cancelled')
    // A late 'done' from Rust changes nothing.
    onDownloadEvent({ event: 'done', id: 9, state: 'completed' })
    expect(done).toHaveBeenCalledTimes(1)

    ses.once('will-download', (_e, i) => { item = i; i.setSavePath('/tmp/c') })
    onDownloadEvent({ event: 'started', id: 10, label: 'x', url: 'https://x.test/c', filename: 'c', canPause: true })
    item.pause()
    expect(item.isPaused()).toBe(true)
    expect(item.canResume()).toBe(true)
    item.resume()
    expect(state.commands.filter((c) => c.command === 'download_control' && c.args.id === 10).map((c) => c.args.action)).toEqual(['pause', 'resume'])
  })

  it('asks with a save dialog when the handler sets no path', async () => {
    const saveDialog = vi.fn(async () => ({ canceled: false, filePath: '/home/me/Downloads/d.zip' }))
    configureDownloads({ saveDialog, getDownloadsPath: () => '/home/me/Downloads' })
    let item
    session.defaultSession.once('will-download', (_e, i) => (item = i))
    onDownloadEvent({ event: 'started', id: 11, label: 'x', url: 'https://x.test/d.zip', filename: 'd.zip' })
    await flush()
    expect(saveDialog.mock.calls[0][0]).toEqual({ defaultPath: '/home/me/Downloads/d.zip' })
    expect(item.getSavePath()).toBe('/home/me/Downloads/d.zip')
  })

  it('downloadURL sends the URL, headers and a tag that routes the item to the session', async () => {
    const ses = session.fromPartition('downloads-test')
    downloadURL(ses, null, 'https://x.test/e', { headers: { Authorization: 'Bearer t' } })
    const { args } = state.commands.find((c) => c.command === 'download_url')
    expect(args).toMatchObject({ label: 'electron-main', url: 'https://x.test/e', headers: [['Authorization', 'Bearer t']] })
    const will = vi.fn((_e, item) => item.setSavePath('/tmp/e'))
    ses.once('will-download', will)
    onDownloadEvent({ event: 'started', id: 12, label: 'electron-main', tag: args.tag, url: 'https://x.test/e', filename: 'e' })
    expect(will).toHaveBeenCalled()
  })
})

describe('permission requests', () => {
  it('grants without a handler, as Electron does', async () => {
    onPermissionRequest({ id: 3, label: 'x', permission: 'geolocation', url: 'https://a.test/p' })
    expect(state.commands).toEqual([{ command: 'permission_respond', args: { id: 3, label: 'x', url: 'https://a.test/p', permission: 'geolocation', granted: true } }])
  })

  it('runs the session handler and answers with its (possibly late) callback', async () => {
    const calls = []
    let answer
    session.defaultSession._handlers.permissionRequest = (webContents, permission, callback, details) => {
      calls.push([webContents, permission, details])
      answer = callback
    }
    onPermissionRequest({ id: 4, label: 'x', permission: 'media', mediaTypes: ['audio'], url: 'https://a.test/p' })
    expect(calls).toEqual([[null, 'media', { requestingUrl: 'https://a.test/p', securityOrigin: 'https://a.test', embeddingOrigin: 'https://a.test', isMainFrame: true, mediaTypes: ['audio'] }]])
    expect(state.commands).toEqual([])
    answer(false)
    answer(true)
    expect(state.commands).toEqual([{ command: 'permission_respond', args: { id: 4, label: 'x', url: 'https://a.test/p', permission: 'media', granted: false } }])
    session.defaultSession._handlers.permissionRequest = null
  })
})

describe('setProxy', () => {
  it('parses proxyRules into the one proxy a webview takes', () => {
    expect(parseProxyConfig({ proxyRules: 'proxy.test:8080' })).toEqual({ url: 'http://proxy.test:8080', type: 'http', host: 'proxy.test', port: 8080 })
    expect(parseProxyConfig({ proxyRules: 'socks5://s.test' })?.url).toBe('socks5://s.test:1080')
    expect(parseProxyConfig({ proxyRules: 'http=h.test:1;https=s.test:2' })?.url).toBe('http://s.test:2')
    expect(parseProxyConfig({ proxyRules: 'ftp=f.test:3;foo.test:4,bar.test:5' })?.url).toBe('http://foo.test:4')
    expect(parseProxyConfig({ mode: 'direct', proxyRules: 'x:1' })).toBeNull()
    expect(parseProxyConfig({ mode: 'system' })).toBeNull()
    expect(parseProxyConfig({ pacScript: 'http://pac' })).toBeNull()
    expect(parseProxyConfig({})).toBeNull()
    expect(describeProxy(parseProxyConfig({ proxyRules: 'socks5://s.test:9' }), 'https://a')).toBe('SOCKS5 s.test:9')
    expect(describeProxy(null, 'https://a')).toBe('DIRECT')
  })

  it('applies to new windows of the session, resolveProxy and fetch', async () => {
    const ses = session.fromPartition('persist:proxy-test')
    await ses.setProxy({ proxyRules: 'p.test:3128' })
    expect(ses._tauriWebviewOptions().proxyUrl).toBe('http://p.test:3128')
    expect(await ses.resolveProxy('https://example.com')).toBe('PROXY p.test:3128')
    await ses.fetch('https://example.com/', { method: 'GET' })
    expect(httpFetch).toHaveBeenLastCalledWith('https://example.com/', { method: 'GET', proxy: { all: 'http://p.test:3128' } })
    await ses.setProxy({ mode: 'direct' })
    expect(ses._tauriWebviewOptions().proxyUrl).toBeUndefined()
    expect(await ses.resolveProxy('https://example.com')).toBe('DIRECT')
  })

  it('the default session proxy also covers net.fetch', async () => {
    const { netFetch } = await import('../src/main/net.js')
    await session.defaultSession.setProxy({ proxyRules: 'd.test:1' })
    await netFetch('https://example.com/')
    expect(httpFetch).toHaveBeenLastCalledWith('https://example.com/', { proxy: { all: 'http://d.test:1' } })
    await session.defaultSession.setProxy({})
    await netFetch('https://example.com/')
    expect(httpFetch).toHaveBeenLastCalledWith('https://example.com/', undefined)
  })
})
