// Checks for roadmap wave C, C1 (docs/ROADMAP.md): WebContentsView,
// BrowserView, BrowserWindow#contentView and the <webview> tag. Same shape
// as checks.js and, like it, runs unchanged on Electron and on Tauri (where
// these need tauri-plugin-electron's `child-webviews` feature, enabled in
// src-tauri/Cargo.toml).
import { BaseWindow, BrowserWindow, BrowserView, WebContentsView, ipcMain, webContents } from 'electron'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { withLocalServer } from './checks-wave-c-local-origins.js'

const dirname = import.meta.dirname
const childHtml = path.join(dirname, '../child.html')
const preload = path.join(dirname, 'preload.mjs')

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function waitFor(emitter, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeout)
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `fn` until it returns something truthy. */
async function until(fn, what, timeout = 10000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** A visible window showing child.html (views are laid out in shown windows). */
async function withWindow(fn, webPreferences = {}) {
  const win = new BrowserWindow({ width: 640, height: 480, webPreferences: { preload, sandbox: false, ...webPreferences } })
  const views = []
  try {
    await win.loadFile(childHtml)
    return await fn(win, views)
  } finally {
    for (const view of views) if (!view.webContents.isDestroyed()) view.webContents.close()
    if (!win.isDestroyed()) win.destroy()
  }
}

const isElectron = Boolean(process.versions.electron)

/**
 * A local page without the renderer bootstrap (a "remote" page). On
 * `localhost`: the kitchen sink trusts `http://127.0.0.1:*` (see
 * checks-wave-c-local-origins.js), whose pages get the bootstrap.
 */
async function withServer(fn) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Remote kitchen page</title><p>Served by the main process.</p>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://localhost:${server.address().port}/`)
  } finally {
    server.close()
  }
}

export const waveCViewsChecks = [
  { id: 'WebContentsView: addChildView + setBounds + loadFile', run: () => withWindow(async (win, views) => {
    const view = new WebContentsView({ webPreferences: { preload, sandbox: false } })
    views.push(view)
    win.contentView.addChildView(view)
    view.setBounds({ x: 20, y: 30, width: 300, height: 200 })
    await view.webContents.loadFile(childHtml, { query: { view: '1' } })
    assert(win.contentView.children.includes(view), 'contentView.children')
    assert(webContents.fromId(view.webContents.id) === view.webContents, 'webContents.fromId')
    assert(webContents.getAllWebContents().includes(view.webContents), 'getAllWebContents')
    assert(view.webContents !== win.webContents, 'own webContents')
    const title = await view.webContents.executeJavaScript('document.title')
    assert(title === 'Kitchen Sink Child', `title ${title}`)
    // The page is laid out at the view's size, not the window's.
    const size = await until(async () => {
      const [width, height] = await view.webContents.executeJavaScript('[innerWidth, innerHeight]')
      return width === 300 && height === 200 && [width, height]
    }, 'the view at 300 x 200', 5000)
    view.setBounds({ x: 0, y: 0, width: 240, height: 160 })
    await until(async () => (await view.webContents.executeJavaScript('innerWidth')) === 240, 'the view resized to 240 wide', 5000)
    assert(JSON.stringify(view.getBounds()) === JSON.stringify({ x: 0, y: 0, width: 240, height: 160 }), 'getBounds')
    win.contentView.removeChildView(view)
    assert(!win.contentView.children.includes(view), 'removeChildView')
    return `${size.join(' x ')}, then 240 wide`
  }) },
  { id: 'WebContentsView: IPC with event.sender', run: () => withWindow(async (win, views) => {
    const view = new WebContentsView({ webPreferences: { preload, sandbox: false } })
    views.push(view)
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 200, height: 120 })
    await view.webContents.loadFile(childHtml)
    const pong = waitFor(ipcMain, 'kitchen:child-pong')
    view.webContents.send('kitchen:child-ping', 'from-main')
    const [event, value] = await pong
    assert(value === 'from-main', `value ${value}`)
    assert(event.sender === view.webContents, 'event.sender is the view')
    assert(BrowserWindow.fromWebContents(view.webContents) === win, 'fromWebContents')
    const destroyed = waitFor(view.webContents, 'destroyed')
    view.webContents.close()
    await destroyed
    return 'pong from the view'
  }) },
  { id: 'WebContentsView: remote page, executeJavaScript with a promise', run: () => withServer((url) => withWindow(async (win, views) => {
    const view = new WebContentsView()
    views.push(view)
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 320, height: 240 })
    const navigated = waitFor(view.webContents, 'did-navigate')
    await view.webContents.loadURL(url)
    const [, navigatedUrl] = await navigated
    assert(navigatedUrl === url, `did-navigate ${navigatedUrl}`)
    const title = await view.webContents.executeJavaScript('document.title')
    assert(title === 'Remote kitchen page', `title ${title}`)
    const later = await view.webContents.executeJavaScript('new Promise((resolve) => setTimeout(() => resolve({ answer: 42 }), 50))')
    assert(later?.answer === 42, `promise ${JSON.stringify(later)}`)
    const error = await view.webContents.executeJavaScript('missingFunction()').then(() => null, (e) => e)
    assert(error, 'a throwing script rejects')
    return `${title}, ${JSON.stringify(later)}`
  })) },
  { id: 'WebContentsView on a trusted origin: preload and IPC; elsewhere none', run: () => withLocalServer(({ port, nextReport }) => withWindow(async (win, views) => {
    const view = new WebContentsView({ webPreferences: { preload, sandbox: false } })
    views.push(view)
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 320, height: 240 })
    await view.webContents.loadURL(`http://127.0.0.1:${port}/view`)
    const report = await nextReport()
    assert(report.preload === true, `the view's page has the preload: ${JSON.stringify(report)}`)
    if (!isElectron) assert(report.bridge === 200 && report.command === 'allowed', `IPC allowed: ${JSON.stringify(report)}`)
    const echoed = await view.webContents.executeJavaScript(`window.kitchen.invoke('kitchen:echo', 'view')`)
    assert(JSON.stringify(echoed) === '["view"]', `invoke: ${JSON.stringify(echoed)}`)
    const sync = await view.webContents.executeJavaScript(`window.kitchen.sendSync('kitchen:sync')`)
    assert(sync === 'sync-ok', `sendSync: ${sync}`)
    const pong = waitFor(ipcMain, 'kitchen:child-pong')
    await view.webContents.executeJavaScript('window.kitchen.onChildPing((value) => window.kitchen.childPong(value)), true')
    view.webContents.send('kitchen:child-ping', 'to-view')
    const [event, value] = await pong
    assert(value === 'to-view' && event.sender === view.webContents, `round trip: ${value}`)
    // `localhost` is not on the list: no preload, and Tauri refuses its IPC.
    await view.webContents.loadURL(`http://localhost:${port}/other`)
    const away = await nextReport()
    if (!isElectron) {
      assert(away.preload === false, `no preload on localhost: ${JSON.stringify(away)}`)
      assert(away.bridge !== 200 && away.command === 'refused', `IPC refused on localhost: ${JSON.stringify(away)}`)
    }
    return `ok (port ${port})`
  })) },
  { id: 'BaseWindow + two WebContentsViews side by side', run: async () => {
    const win = new BaseWindow({ width: 600, height: 300 })
    const left = new WebContentsView({ webPreferences: { preload, sandbox: false } })
    const right = new WebContentsView({ webPreferences: { preload, sandbox: false } })
    try {
      win.contentView.addChildView(left)
      win.contentView.addChildView(right)
      left.setBounds({ x: 0, y: 0, width: 300, height: 300 })
      right.setBounds({ x: 300, y: 0, width: 300, height: 300 })
      await Promise.all([left.webContents.loadFile(childHtml, { query: { side: 'left' } }), right.webContents.loadFile(childHtml, { query: { side: 'right' } })])
      assert(win.contentView.children.length === 2 && win.contentView.children[1] === right, 'children in order')
      const sides = await Promise.all([left, right].map((view) => view.webContents.executeJavaScript('new URLSearchParams(location.search).get("side")')))
      assert(sides.join() === 'left,right', `pages ${sides}`)
      const widths = await until(async () => {
        const values = await Promise.all([left, right].map((view) => view.webContents.executeJavaScript('innerWidth')))
        return values.every((w) => w === 300) && values
      }, 'both views 300 wide', 5000)
      // Re-adding a view puts it on top.
      win.contentView.addChildView(left)
      assert(win.contentView.children[1] === left, 're-added on top')
      return `widths ${widths.join(', ')}`
    } finally {
      for (const view of [left, right]) if (!view.webContents.isDestroyed()) view.webContents.close()
      win.destroy()
    }
  } },
  { id: 'BrowserView: setBrowserView / setAutoResize', run: () => withWindow(async (win) => {
    const view = new BrowserView({ webPreferences: { preload, sandbox: false } })
    try {
      win.setBrowserView(view)
      view.setBounds({ x: 0, y: 0, width: 320, height: 200 })
      view.setAutoResize({ width: true })
      assert(win.getBrowserView() === view, 'getBrowserView')
      assert(win.getBrowserViews().length === 1, 'getBrowserViews')
      assert(BrowserWindow.fromBrowserView(view) === win, 'fromBrowserView')
      await view.webContents.loadFile(childHtml)
      const title = await view.webContents.executeJavaScript('document.title')
      assert(title === 'Kitchen Sink Child', `title ${title}`)
      win.removeBrowserView(view)
      assert(win.getBrowserViews().length === 0, 'removeBrowserView')
      return title
    } finally {
      view.webContents.close()
    }
  }) },
  { id: '<webview>: will-attach-webview, did-attach-webview, sendToHost', run: () => withWindow(async (win) => {
    const attachedParams = []
    win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
      attachedParams.push({ src: params.src, sandbox: webPreferences.sandbox })
    })
    const attached = waitFor(win.webContents, 'did-attach-webview')
    // Electron loads the guest's preload from its attribute; tauri-electron's bundler
    // puts the app's preload in every app page.
    await win.webContents.executeJavaScript(`(() => {
      const webview = document.createElement('webview')
      webview.setAttribute('src', 'child.html?guest=1')
      webview.setAttribute('preload', ${JSON.stringify(pathToFileURL(preload).href)})
      webview.setAttribute('webpreferences', 'sandbox=no')
      webview.style.cssText = 'width: 320px; height: 200px'
      webview.addEventListener('ipc-message', (event) => { window.__kitchenWebviewIpc = [event.channel, ...event.args] })
      webview.addEventListener('dom-ready', () => { window.__kitchenWebviewReady = true })
      document.body.prepend(webview)
      window.__kitchenWebview = webview
      return true
    })()`)
    const [, guest] = await attached
    assert(attachedParams[0]?.src?.includes('child.html?guest=1'), `params.src ${attachedParams[0]?.src}`)
    assert(guest.getType() === 'webview', `type ${guest.getType()}`)
    assert(guest.hostWebContents === win.webContents, 'hostWebContents')
    assert(webContents.fromId(guest.id) === guest, 'webContents.fromId')
    await until(() => win.webContents.executeJavaScript('Boolean(window.__kitchenWebviewReady)'), "the element's dom-ready")
    const title = await guest.executeJavaScript('document.title')
    assert(title === 'Kitchen Sink Child', `title ${title}`)
    const width = await until(async () => {
      const value = await guest.executeJavaScript('innerWidth')
      return value === 320 && value
    }, 'the guest at 320 wide', 5000)
    const fromElement = await win.webContents.executeJavaScript(`(async () => {
      const webview = window.__kitchenWebview
      return { id: webview.getWebContentsId(), url: webview.getURL(), sum: await webview.executeJavaScript('1 + 1') }
    })()`)
    assert(fromElement.id === guest.id, `getWebContentsId ${fromElement.id}`)
    assert(fromElement.url.includes('child.html'), `getURL ${fromElement.url}`)
    assert(fromElement.sum === 2, `executeJavaScript ${fromElement.sum}`)
    await guest.executeJavaScript("window.kitchen.sendToHost('kitchen:to-host', 7, { ok: true })")
    const message = await until(() => win.webContents.executeJavaScript('window.__kitchenWebviewIpc'), "the element's ipc-message")
    assert(message[0] === 'kitchen:to-host' && message[1] === 7 && message[2]?.ok === true, `ipc-message ${JSON.stringify(message)}`)
    const removed = waitFor(guest, 'destroyed', 3000).then(() => 'destroyed with its element', () => 'kept after removal')
    await win.webContents.executeJavaScript('window.__kitchenWebview.remove(), true')
    const gone = await removed
    return `guest ${guest.id}, ${width} wide, ipc-message ${JSON.stringify(message)}, ${gone}`
  }, { webviewTag: true }) },
  { id: '<webview> needs webPreferences.webviewTag', run: () => withWindow(async (win) => {
    let attached = false
    win.webContents.once('did-attach-webview', () => (attached = true))
    const hasApi = await win.webContents.executeJavaScript(`(() => {
      const webview = document.createElement('webview')
      webview.setAttribute('src', 'child.html')
      document.body.appendChild(webview)
      return typeof webview.getWebContentsId === 'function'
    })()`)
    await sleep(500)
    assert(!hasApi, 'the element has the WebviewTag API')
    assert(!attached, 'a guest was attached')
    return 'a plain element'
  }) },
]
