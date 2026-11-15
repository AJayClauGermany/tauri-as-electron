import { beforeEach, describe, expect, it, vi } from 'vitest'

// Roadmap wave C, C1: WebContentsView / BrowserView / BrowserWindow#contentView
// and the <webview> tag, with tauri-plugin-electron and Tauri's window API
// replaced by scripted fakes.
const state = vi.hoisted(() => ({
  commands: [],
  onCommand: null,
  natives: [],
  emitted: [],
  invoked: [],
  features: ['child-webviews'],
  posted: [],
  fetched: [],
}))

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn(async () => null), message: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async (label, event, payload) => {
    state.emitted.push({ label, event, payload })
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command, args) => {
    state.invoked.push({ command, args })
  }),
  convertFileSrc: (path, scheme) => `${scheme}://localhost/${encodeURIComponent(path)}`,
}))
vi.mock('@tauri-apps/api/webviewWindow', () => {
  class WebviewWindow {
    constructor(label, options) {
      this.label = label
      this.options = options
      this.handlers = {}
      state.natives.push(this)
    }
    on(event, handler, once = false) {
      ;(this.handlers[event] ??= []).push({ handler, once })
      return Promise.resolve(() => {})
    }
    once(event, handler) { return this.on(event, handler, true) }
    listen(event, handler) { return this.on(event, handler) }
    emit(event, payload) {
      const list = this.handlers[event] ?? []
      this.handlers[event] = list.filter((entry) => !entry.once)
      for (const { handler } of list) handler({ event, payload })
      return Promise.resolve()
    }
    onResized(handler) { return this.on('tauri://resize', handler) }
    onMoved(handler) { return this.on('tauri://move', handler) }
    onScaleChanged(handler) { return this.on('tauri://scale-change', handler) }
    onFocusChanged(handler) { return this.on('tauri://focus', handler) }
    onCloseRequested(handler) { return this.on('tauri://close-requested', handler) }
    scaleFactor() { return Promise.resolve(1) }
    outerPosition() { return Promise.resolve({ x: 0, y: 0 }) }
    outerSize() { return Promise.resolve(this.size ?? { width: 800, height: 600 }) }
    innerSize() { return Promise.resolve(this.size ?? { width: 800, height: 600 }) }
    isMaximized() { return Promise.resolve(false) }
    isMinimized() { return Promise.resolve(false) }
    isFullscreen() { return Promise.resolve(false) }
    isVisible() { return Promise.resolve(true) }
    setZoom() { return Promise.resolve() }
    destroy() { return this.emit('tauri://destroyed') }
    close() { return this.destroy() }
  }
  return { WebviewWindow, getCurrentWebviewWindow: () => new WebviewWindow('electron-main', {}) }
})
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    hasNativePlugin: () => true,
    hasFeature: (name) => state.features.includes(name),
    processInfo: () => ({ pid: 7, execPath: '/app', env: {} }),
    bridgeUrl: (path) => `tauri-electron://localhost/${encodeURIComponent(path)}`,
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand?.(command, args)
    },
  }
})
vi.mock('../src/renderer/ipc-renderer.js', () => ({
  postToMain: async (message) => {
    state.posted.push(message)
  },
  commandHandlers: {},
}))

const { BrowserWindow, webContents, onPageLoad } = await import('../src/main/browser-window.js')
const { View, WebContentsView, BrowserView, GuestWebContents, evalScript, pollScript, parseWebPreferences, webviewPreferences, tauriColor } = await import('../src/main/views.js')
const { encode, decode } = await import('../src/internal/serialize.js')
const { upgrade } = await import('../src/renderer/webview-tag.js')
const { commandHandlers } = await import('../src/renderer/ipc-renderer.js')

const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const commands = (name) => state.commands.filter((c) => c.command === name)
const toEmbedder = (label, name) => state.emitted.filter((e) => e.label === label && e.payload.type === 'command' && e.payload.name === name).map((e) => e.payload)

beforeEach(() => {
  state.commands = []
  state.onCommand = null
  state.emitted = []
  state.invoked = []
  state.features = ['child-webviews']
  state.posted = []
})

/** A BrowserWindow whose native window exists. */
async function makeWindow(options = {}) {
  const win = new BrowserWindow({ show: false, ...options })
  win.loadURL('index.html')
  await flush()
  return win
}

describe('WebContentsView', () => {
  it('creates its webview once it is in a window, then moves, hides and raises it', async () => {
    const view = new WebContentsView({ webPreferences: { partition: 'temp' } })
    const loaded = view.webContents.loadURL('https://example.com/')
    expect(view.webContents.getType()).toBe('browserView')
    expect(webContents.fromId(view.webContents.id)).toBe(view.webContents)
    expect(webContents.getAllWebContents()).toContain(view.webContents)
    await flush()
    expect(commands('view_create')).toEqual([]) // not in a window yet

    const win = await makeWindow()
    view.setBounds({ x: 10, y: 20, width: 300, height: 200 })
    win.contentView.addChildView(view)
    expect(win.contentView.children).toEqual([view])
    expect(win.contentView.webContents).toBe(win.webContents)
    await flush()
    const [create] = commands('view_create')
    expect(create.args.window).toBe(win._label)
    expect(create.args.options).toMatchObject({ label: `electron-view-${view.webContents.id}`, url: 'https://example.com/', x: 10, y: 20, width: 300, height: 200, focus: false, incognito: true })
    expect(create.args.extras).toMatchObject({ bounds: { x: 10, y: 20, width: 300, height: 200 }, visible: true })
    const config = commands('set_window_config').find((c) => c.args.label === view.webContents._label)
    expect(config.args.config).toMatchObject({ guest: 'browserView', contextIsolation: true, sandbox: true, node: false })
    expect(BrowserWindow.fromWebContents(view.webContents)).toBe(win)
    // Raised once created (Linux keeps views in tree order).
    expect(commands('view_update').some((c) => c.args.update.top)).toBe(true)

    // Page loads come from Rust like a window's; the load promise resolves.
    const seen = []
    for (const name of ['did-start-loading', 'did-navigate', 'did-finish-load', 'dom-ready']) view.webContents.on(name, () => seen.push(name))
    onPageLoad({ label: view.webContents._label, url: 'https://example.com/', event: 'started' })
    onPageLoad({ label: view.webContents._label, url: 'https://example.com/', event: 'finished' })
    await loaded
    expect(seen).toEqual(['did-start-loading', 'did-navigate', 'dom-ready', 'did-finish-load'])
    expect(view.webContents.getURL()).toBe('https://example.com/')

    state.commands = []
    view.setBounds({ x: 0, y: 0, width: 640, height: 480 })
    view.setVisible(false)
    await flush()
    expect(commands('view_update').map((c) => c.args.update)).toEqual([{ bounds: { x: 0, y: 0, width: 640, height: 480 } }, { visible: false }])

    state.commands = []
    view.setVisible(true)
    win.contentView.removeChildView(view)
    expect(win.contentView.children).toEqual([])
    await flush()
    expect(commands('view_update').map((c) => c.args.update)).toEqual([{ visible: true }, { visible: false }])
    expect(commands('view_close')).toEqual([])

    // Navigating a created view goes through Rust (remote pages have no bootstrap).
    view.webContents.loadURL('https://example.org/').catch(() => {}) // rejected when the view is closed below
    await flush()
    expect(commands('view_navigate').at(-1).args).toEqual({ label: view.webContents._label, url: 'https://example.org/' })

    const destroyed = vi.fn()
    view.webContents.on('destroyed', destroyed)
    view.webContents.close()
    expect(destroyed).toHaveBeenCalled()
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(commands('view_close').at(-1).args).toEqual({ label: view.webContents._label })
    expect(webContents.fromId(view.webContents.id)).toBeUndefined()
    win.destroy()
  })

  it('places nested views relative to their parents and in another window when moved', async () => {
    const win = await makeWindow()
    const other = await makeWindow()
    const container = new View()
    container.setBounds({ x: 100, y: 50, width: 400, height: 400 })
    const view = new WebContentsView()
    view.setBounds({ x: 5, y: 6, width: 50, height: 60 })
    container.addChildView(view)
    win.contentView.addChildView(container)
    await flush()
    expect(commands('view_create')[0].args.extras.bounds).toEqual({ x: 105, y: 56, width: 50, height: 60 })

    state.commands = []
    container.setBounds({ x: 0, y: 0, width: 400, height: 400 })
    await flush()
    expect(commands('view_update').map((c) => c.args.update)).toEqual([{ bounds: { x: 5, y: 6, width: 50, height: 60 } }])

    state.commands = []
    other.contentView.addChildView(view)
    expect(container.children).toEqual([])
    await flush()
    expect(commands('view_update').some((c) => c.args.update.window === other._label)).toBe(true)
    expect(BrowserWindow.fromWebContents(view.webContents)).toBe(other)
    expect(() => view.addChildView(view)).toThrow()
    win.destroy()
    other.destroy()
  })

  it('evaluates script in pages without the bootstrap, awaiting promises by polling', async () => {
    const win = await makeWindow()
    const view = new WebContentsView()
    win.contentView.addChildView(view)
    await flush()
    const answers = ['{"pending":true}', '{"pending":true}', '{"ok":true,"value":{"n":2}}']
    state.onCommand = (command) => (command === 'view_eval' ? answers.shift() : undefined)
    await expect(view.webContents.executeJavaScript('Promise.resolve({ n: 2 })')).resolves.toEqual({ n: 2 })
    const scripts = commands('view_eval').map((c) => c.args.script)
    expect(scripts[0]).toContain('Promise.resolve({ n: 2 })')
    expect(scripts[1]).toContain('__tauriElectronEval')

    state.onCommand = (command) => (command === 'view_eval' ? '{"ok":false,"error":{"name":"TypeError","message":"nope"}}' : undefined)
    await expect(view.webContents.executeJavaScript('x()')).rejects.toThrow('nope')
    state.onCommand = (command) => (command === 'view_eval' ? '' : undefined)
    await expect(view.webContents.executeJavaScript('x()')).rejects.toThrow('Script failed to execute')

    // history.go and stop run as script too.
    state.onCommand = () => '{"ok":true,"undef":true}'
    view.webContents._url = 'https://example.com/'
    view.webContents.navigationHistory._entries = [{ url: 'a' }, { url: 'b' }]
    view.webContents.navigationHistory._index = 1
    view.webContents.goBack()
    view.webContents.stop()
    await flush()
    expect(commands('view_eval').slice(-2).map((c) => c.args.script)).toEqual([expect.stringContaining('history.go(-1)'), expect.stringContaining('window.stop()')])
    win.destroy()
  })

  it('needs the child-webviews feature', () => {
    state.features = []
    expect(() => new WebContentsView()).toThrow(expect.objectContaining({ name: 'NotImplementedError', reason: 'feature' }))
    expect(() => new BrowserView()).toThrow(expect.objectContaining({ reason: 'feature' }))
    // A plain View is only a rectangle.
    expect(new View().getBounds()).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('forgets webviews whose window closed and re-creates them when re-added', async () => {
    const win = await makeWindow()
    const view = new WebContentsView()
    win.contentView.addChildView(view)
    await flush()
    const label = view.webContents._label
    view.webContents._url = 'https://example.com/'
    win.destroy()
    await flush()
    expect(view.webContents.isDestroyed()).toBe(false)
    const other = await makeWindow()
    state.commands = []
    other.contentView.addChildView(view)
    await flush()
    const [create] = commands('view_create')
    expect(create.args.options.url).toBe('https://example.com/')
    expect(create.args.options.label).not.toBe(label)
    other.destroy()
  })
})

describe('BrowserView', () => {
  it('attaches to windows the legacy way and follows window resizes', async () => {
    const win = await makeWindow()
    const view = new BrowserView()
    win.setBrowserView(view)
    expect(win.getBrowserView()).toBe(view)
    expect(win.getBrowserViews()).toEqual([view])
    expect(BrowserWindow.fromBrowserView(view)).toBe(win)
    expect(view.webContents.getType()).toBe('browserView')
    view.setBounds({ x: 0, y: 100, width: 800, height: 500 })
    view.setAutoResize({ width: true, height: true })
    const second = new BrowserView()
    win.addBrowserView(second)
    expect(() => win.getBrowserView()).toThrow(/multiple/)
    win.setTopBrowserView(view)
    expect(win.getBrowserViews()).toEqual([second, view])
    win.removeBrowserView(second)
    expect(win.getBrowserViews()).toEqual([view])

    // The window grows by 200 x 100.
    win._state.contentWidth = 1000
    win._state.contentHeight = 700
    win.emit('resize')
    expect(view.getBounds()).toEqual({ x: 0, y: 100, width: 1000, height: 600 })
    view.setAutoResize({ horizontal: true, vertical: true })
    win._state.contentWidth = 500
    win._state.contentHeight = 350
    win.emit('resize')
    expect(view.getBounds()).toEqual({ x: 0, y: 50, width: 500, height: 300 })
    win.setBrowserView(null)
    expect(win.getBrowserViews()).toEqual([])
    win.destroy()
  })
})

describe('<webview>: main process', () => {
  async function embedderWindow(webPreferences = { webviewTag: true }) {
    const win = await makeWindow({ webPreferences })
    win.webContents._onLifecycle('did-finish-load', { url: 'tauri://localhost/index.html', title: '' })
    return win
  }

  it('attaches a guest with will-attach-webview / did-attach-webview and forwards its events', async () => {
    const win = await embedderWindow()
    const events = []
    win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
      events.push(['will-attach-webview', { ...webPreferences }, params])
      // The main process may change them (Electron applies the embedder's rules before the event).
      webPreferences.devTools = false
    })
    let guest
    win.webContents.on('did-attach-webview', (_event, contents) => {
      guest = contents
      events.push(['did-attach-webview', contents.getType(), contents.hostWebContents === win.webContents])
    })
    win.webContents._onLifecycle('webview-attach', {
      instance: 'p-1',
      params: { src: 'https://chat.example/', partition: 'persist:chat', allowpopups: false, nodeintegration: true },
      bounds: { x: 10, y: 40, width: 600, height: 400 },
      visible: true,
    })
    await flush()
    expect(events[0][1]).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, disablePopups: true, partition: 'persist:chat' })
    expect(events[0][2]).toMatchObject({ src: 'https://chat.example/' })
    expect(events[1]).toEqual(['did-attach-webview', 'webview', true])
    expect(guest).toBeInstanceOf(GuestWebContents)
    expect(BrowserWindow.fromWebContents(guest)).toBe(win)
    expect(guest._win._options.webPreferences.devTools).toBe(false)
    expect(guest.session.isPersistent()).toBe(true)
    const [create] = commands('view_create')
    expect(create.args.extras).toMatchObject({ embedder: win._label, instance: 'p-1', bounds: { x: 10, y: 40, width: 600, height: 400 } })
    expect(create.args.options.url).toBe('https://chat.example/')
    expect(toEmbedder(win._label, 'webview-attached')).toEqual([expect.objectContaining({ instance: 'p-1', id: guest.id })])

    onPageLoad({ label: guest._label, url: 'https://chat.example/', event: 'finished' })
    const forwarded = toEmbedder(win._label, 'webview-event').map((e) => e.event)
    expect(forwarded).toEqual(['load-commit', 'did-navigate', 'dom-ready', 'did-finish-load', 'did-stop-loading'])
    const last = toEmbedder(win._label, 'webview-event').at(-1)
    expect(last.state).toMatchObject({ url: 'https://chat.example/', loading: false, canGoBack: false })

    // ipcRenderer.sendToHost() from the guest: 'ipc-message' on the element.
    guest._sendToHost('unread', encode([3, { from: 'guest' }]))
    const ipc = toEmbedder(win._label, 'webview-event').at(-1)
    expect(ipc.event).toBe('ipc-message')
    expect(decode(ipc.props)).toMatchObject({ channel: 'unread' })
    expect(decode(ipc.args)).toEqual([3, { from: 'guest' }])

    // Element methods run on the guest's webContents.
    state.onCommand = (command) => (command === 'view_eval' ? '{"ok":true,"value":"Chat"}' : undefined)
    win.webContents._onLifecycle('webview-call', { instance: 'p-1', method: 'executeJavaScript', args: encode(['document.title']), id: 5 })
    await flush()
    const result = toEmbedder(win._label, 'webview-result').at(-1)
    expect(result).toMatchObject({ instance: 'p-1', id: 5, ok: true })
    expect(decode(result.result)).toBe('Chat')
    win.webContents._onLifecycle('webview-call', { instance: 'p-1', method: 'destroy', args: encode([]), id: 6 })
    await flush()
    expect(toEmbedder(win._label, 'webview-result').at(-1)).toMatchObject({ id: 6, ok: false })

    // window.close() in the guest: the element's 'close'.
    guest._onLifecycle('guest-close', {})
    expect(toEmbedder(win._label, 'webview-event').at(-1).event).toBe('close')

    // The element left the page: the guest goes.
    win.webContents._onLifecycle('webview-detach', { instance: 'p-1' })
    expect(guest.isDestroyed()).toBe(true)
    expect(commands('view_close').at(-1).args.label).toBe(guest._label)
    win.destroy()
  })

  it('honours preventDefault and webviewTag, and drops guests when the embedder navigates', async () => {
    const plain = await embedderWindow({})
    plain.webContents._onLifecycle('webview-attach', { instance: 'a', params: {}, bounds: { x: 0, y: 0, width: 1, height: 1 } })
    await flush()
    expect(commands('view_create')).toEqual([])
    expect(toEmbedder(plain._label, 'webview-detached')[0]).toMatchObject({ instance: 'a' })

    const win = await embedderWindow()
    win.webContents.once('will-attach-webview', (event) => event.preventDefault())
    win.webContents._onLifecycle('webview-attach', { instance: 'b', params: {}, bounds: { x: 0, y: 0, width: 1, height: 1 } })
    await flush()
    expect(commands('view_create')).toEqual([])
    expect(toEmbedder(win._label, 'webview-detached').at(-1)).toMatchObject({ instance: 'b', reason: 'prevented' })

    let guest
    win.webContents.once('did-attach-webview', (_event, contents) => (guest = contents))
    win.webContents._onLifecycle('webview-attach', { instance: 'c', params: {}, bounds: { x: 0, y: 0, width: 10, height: 10 } })
    await flush()
    onPageLoad({ label: win._label, url: 'tauri://localhost/other.html', event: 'started' })
    expect(guest.isDestroyed()).toBe(true)
    plain.destroy()
    win.destroy()
  })

  it('builds guest webPreferences as Electron does', () => {
    expect(parseWebPreferences('contextIsolation=no, spellcheck, zoomFactor=1.5, partition=x')).toEqual({ contextIsolation: false, spellcheck: true, zoomFactor: 1.5, partition: 'x' })
    // An embedder with Node and no isolation lets the guest choose.
    const free = webviewPreferences({ nodeIntegration: true, contextIsolation: false, sandbox: false }, { nodeintegration: true, allowpopups: true, webpreferences: 'contextIsolation=no' })
    expect(free).toMatchObject({ nodeIntegration: true, contextIsolation: false, disablePopups: false })
    // A sandboxed, isolated embedder forces both on its guests.
    const strict = webviewPreferences({}, { nodeintegration: true, webpreferences: 'contextIsolation=no, sandbox=no' })
    expect(strict).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true })
  })
})

describe('helpers', () => {
  it('converts colors and runs the evaluation scripts', async () => {
    expect(tauriColor('#abc')).toBe('#aabbcc')
    expect(tauriColor('#80112233')).toBe('#11223380')
    expect(tauriColor('red')).toBeNull()

    const window = {}
    const run = (script) => new Function('window', `return ${script}`)(window)
    expect(run(evalScript(1, '1 + 2'))).toEqual({ ok: true, value: 3 })
    expect(run(evalScript(2, 'undefined'))).toEqual({ ok: true, undef: true })
    expect(run(evalScript(3, 'null.x'))).toMatchObject({ ok: false, error: { name: 'TypeError' } })
    expect(run(evalScript(4, 'Promise.resolve(5)'))).toEqual({ pending: true })
    expect(run(pollScript(4))).toEqual({ pending: true })
    await flush()
    expect(run(pollScript(4))).toEqual({ ok: true, value: 5 })
    expect(run(pollScript(4))).toEqual({ gone: true })
  })
})

describe('<webview>: the element', () => {
  function fakeElement(attributes = {}) {
    const attrs = new Map(Object.entries(attributes))
    const events = []
    const element = {
      nodeType: 1,
      localName: 'webview',
      isConnected: true,
      rect: { left: 10, top: 20, width: 300, height: 200 },
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      hasAttribute: (name) => attrs.has(name),
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: (name) => attrs.delete(name),
      getBoundingClientRect() { return this.rect },
      checkVisibility: () => true,
      dispatchEvent: (event) => events.push(event),
      events,
    }
    return element
  }

  it('attaches through the main process, tracks its box and relays methods and events', async () => {
    const frames = []
    globalThis.requestAnimationFrame = (fn) => frames.push(fn)
    globalThis.cancelAnimationFrame = () => {}
    globalThis.MutationObserver = class { observe() {} }
    globalThis.document = { baseURI: 'tauri://localhost/index.html', visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
    globalThis.fetch = vi.fn(async (url, init) => {
      state.fetched.push({ url, body: JSON.parse(init.body) })
      return { ok: true }
    })

    const element = upgrade(fakeElement({ src: 'guest.html', partition: 'persist:a', allowpopups: '' }))
    expect(element.src).toBe('tauri://localhost/guest.html')
    expect(element.allowpopups).toBe(true)
    expect(element.nodeintegration).toBe(false)
    const attach = state.posted.at(-1)
    expect(attach).toMatchObject({ type: 'lifecycle', name: 'webview-attach' })
    expect(attach.data.params).toMatchObject({ src: 'tauri://localhost/guest.html', partition: 'persist:a', allowpopups: true, nodeintegration: false })
    expect(attach.data.bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    const instance = attach.data.instance
    expect(() => element.getWebContentsId()).toThrow(/attached/)

    commandHandlers['webview-attached']({ instance, id: 42 })
    expect(element.getWebContentsId()).toBe(42)
    expect(element.events.at(-1).type).toBe('did-attach')

    // Its box moved: reported to Rust on the next frame.
    element.rect = { left: 0, top: 0, width: 320, height: 240 }
    frames.shift()()
    await flush()
    expect(state.fetched.at(-1)).toEqual({ url: 'tauri-electron://localhost/view%2Fbounds', body: { instance, seq: 1, x: 0, y: 0, width: 320, height: 240, visible: true } })
    frames.shift()()
    expect(state.fetched.length).toBe(1) // unchanged: nothing sent

    commandHandlers['webview-event']({ instance, event: 'did-navigate', props: encode({ url: 'tauri://localhost/guest.html', httpResponseCode: 200 }), state: { url: 'tauri://localhost/guest.html', canGoBack: true, title: 'Guest' } })
    const navigated = element.events.at(-1)
    expect(navigated.type).toBe('did-navigate')
    expect(navigated.url).toBe('tauri://localhost/guest.html')
    expect(element.getURL()).toBe('tauri://localhost/guest.html')
    expect(element.canGoBack()).toBe(true)
    expect(element.getTitle()).toBe('Guest')

    commandHandlers['webview-event']({ instance, event: 'ipc-message', props: encode({ channel: 'hi', frameId: [1, 1] }), args: encode(['there']) })
    expect(element.events.at(-1)).toMatchObject({ type: 'ipc-message', channel: 'hi', args: ['there'] })

    const result = element.executeJavaScript('1 + 1')
    const call = state.posted.at(-1)
    expect(call).toMatchObject({ name: 'webview-call', data: { instance, method: 'executeJavaScript' } })
    commandHandlers['webview-result']({ instance, id: call.data.id, ok: true, result: encode(2) })
    await expect(result).resolves.toBe(2)

    element.send('ping', { n: 1 }).catch(() => {}) // rejected when the element is removed below
    expect(decode(state.posted.at(-1).data.args)).toEqual(['ping', { n: 1 }])
    expect(element.findInPage('x')).toBe(1)

    // Removed from the page: the guest is detached.
    element.isConnected = false
    element._disconnected()
    expect(state.posted.at(-1)).toMatchObject({ name: 'webview-detach', data: { instance } })
    expect(() => element.reload()).toThrow(/attached/)
  })
})
