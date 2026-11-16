// Checks for roadmap wave C items C8 (webContents.printToPDF / capturePage)
// and C9 (desktopCapturer, setDisplayMediaRequestHandler, desktop
// getUserMedia) in docs/ROADMAP.md. Same shape as checks.js and, like it,
// runs unchanged on Electron and on Tauri.
import { BrowserWindow, desktopCapturer, screen, session } from 'electron'
import path from 'node:path'

const dirname = import.meta.dirname
const isElectron = Boolean(process.versions.electron)

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

/** A window showing child.html (shown: capturing needs something on screen); `fn(win)`, then closed. */
async function withWindow(fn, { show = true, width = 360, height = 260, title } = {}) {
  const win = new BrowserWindow({ show, width, height, title, x: 40, y: 40 })
  // Keep the given title (Electron windows take the page's title otherwise).
  if (title) win.on('page-title-updated', (event) => event.preventDefault())
  try {
    const loaded = waitFor(win.webContents, 'did-finish-load')
    win.loadFile(path.join(dirname, '../child.html'))
    await loaded
    if (title) win.setTitle(title)
    return await fn(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** Number of pages and the first page's size (points) of a PDF made by Chromium (Skia) or WebKit (cairo / Core Graphics). */
function pdfInfo(buffer) {
  const text = Buffer.from(buffer).toString('latin1')
  const pages = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
  const box = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(text)
  const rotate = Number(/\/Rotate\s+(\d+)/.exec(text)?.[1] ?? 0)
  let [width, height] = box ? [Number(box[3]) - Number(box[1]), Number(box[4]) - Number(box[2])] : [0, 0]
  if (rotate % 180 === 90) [width, height] = [height, width]
  return { pages, width: Math.round(width), height: Math.round(height) }
}

/** Three pages of content (each one A4 page tall, with page breaks between them). */
const THREE_PAGES = `(() => {
  document.body.innerHTML = [1, 2, 3].map((n) => '<section style="height: 9in; break-after: page; page-break-after: always; background: #c33">Page ' + n + '</section>').join('')
  return document.body.children.length
})()`

/** A screen-capture request from the page; resolves with how it ended. */
const pageRequest = (code) => `new Promise((resolve) => {
  const md = navigator.mediaDevices
  if (!md || typeof md.getDisplayMedia !== 'function') return resolve('no getDisplayMedia')
  setTimeout(() => resolve('timeout'), 8000)
  ${code}.then((stream) => { stream.getTracks().forEach((t) => t.stop()); resolve('granted') }, (error) => resolve('rejected: ' + error.name))
})`

function unsupported(message) {
  const error = new Error(message)
  error.name = 'NotImplementedError'
  return error
}

export const waveCCaptureChecks = [
  // --- C8: printToPDF ------------------------------------------------------------------------------------
  { id: 'webContents.printToPDF (A4, page ranges)', run: () => withWindow(async (win) => {
    await win.webContents.executeJavaScript(THREE_PAGES)
    const all = pdfInfo(await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true }))
    const second = pdfInfo(await win.webContents.printToPDF({ pageSize: 'A4', pageRanges: '2' }))
    assert(all.pages >= 3, `${all.pages} pages`)
    assert(second.pages === 1, `pageRanges '2': ${second.pages} pages`)
    // A4 is 595 × 842 points.
    assert(Math.abs(all.width - 595) <= 2 && Math.abs(all.height - 842) <= 2, `page ${all.width} × ${all.height}`)
    return `${all.pages} pages of ${all.width} × ${all.height} pt; pageRanges '2' → 1 page`
  }, { show: false }) },
  { id: 'webContents.printToPDF (landscape, margins, scale)', run: () => withWindow(async (win) => {
    const pdf = await win.webContents.printToPDF({ pageSize: 'Letter', landscape: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, scale: 0.5 })
    assert(Buffer.from(pdf).subarray(0, 5).toString() === '%PDF-', 'PDF header')
    const info = pdfInfo(pdf)
    assert(info.width > info.height, `landscape: ${info.width} × ${info.height}`)
    assert(Math.abs(info.width - 792) <= 2 && Math.abs(info.height - 612) <= 2, `Letter landscape: ${info.width} × ${info.height}`)
    return `${pdf.length} bytes, ${info.width} × ${info.height} pt`
  }, { show: false }) },

  // --- C8: capturePage -----------------------------------------------------------------------------------
  { id: 'webContents.capturePage', run: () => withWindow(async (win) => {
    await win.webContents.executeJavaScript(`document.body.innerHTML = ''; document.documentElement.style.background = document.body.style.background = 'rgb(255, 0, 0)'; 1`)
    await sleep(300)
    const image = await win.webContents.capturePage()
    assert(!image.isEmpty(), 'empty image')
    const size = image.getSize()
    // The visible page: the viewport (the menu bar, if any, is not part of it).
    const [viewWidth, viewHeight] = await win.webContents.executeJavaScript('[innerWidth, innerHeight]')
    assert(Math.abs(size.width - viewWidth) <= 2 && Math.abs(size.height - viewHeight) <= 2, `size ${size.width} × ${size.height}, viewport ${viewWidth} × ${viewHeight}`)
    // BGRA, like Electron.
    const bitmap = image.toBitmap()
    const pixel = image.getSize(1).width * Math.floor(image.getSize(1).height / 2) * 4 + Math.floor(image.getSize(1).width / 2) * 4
    const [b, g, r] = bitmap.subarray(pixel, pixel + 3)
    assert(r > 200 && g < 60 && b < 60, `centre pixel rgb(${r}, ${g}, ${b})`)
    const part = await win.capturePage({ x: 10, y: 10, width: 50, height: 40 })
    assert(part.getSize().width === 50 && part.getSize().height === 40, `rect: ${JSON.stringify(part.getSize())}`)
    return `${size.width} × ${size.height}, red; rect → 50 × 40`
  }) },

  { id: 'webContents.capturePage (hidden window)', run: () => withWindow(async (win) => {
    await win.webContents.executeJavaScript(`document.body.innerHTML = ''; document.documentElement.style.background = document.body.style.background = 'rgb(0, 0, 255)'; 1`)
    await sleep(300)
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw unsupported('the webview gives no snapshot of a hidden window')
    const size = image.getSize()
    return `${size.width} × ${size.height}`
  }, { show: false }) },

  // --- C9: desktopCapturer --------------------------------------------------------------------------------
  { id: 'desktopCapturer.getSources (screen)', run: async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 120 } })
    assert(sources.length >= 1, 'no screen')
    const displays = screen.getAllDisplays().map((d) => String(d.id))
    for (const source of sources) {
      assert(/^screen:/.test(source.id), `id ${source.id}`)
      assert(displays.includes(source.display_id), `display_id ${source.display_id} not in ${displays}`)
    }
    const first = sources[0]
    const thumb = first.thumbnail.getSize()
    if (first.thumbnail.isEmpty()) {
      // Wayland: no thumbnails (and macOS without the Screen Recording permission on Electron).
      return `${sources.length} screen(s), no thumbnail here`
    }
    assert(thumb.width <= 160 && thumb.height <= 120 && (thumb.width === 160 || thumb.height === 120), `thumbnail ${thumb.width} × ${thumb.height}`)
    return `${sources.map((s) => `${s.id} "${s.name}"`).join(', ')}; thumbnail ${thumb.width} × ${thumb.height}`
  } },
  { id: 'desktopCapturer.getSources (window, fetchWindowIcons)', run: () => withWindow(async () => {
    await sleep(300)
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 120, height: 120 }, fetchWindowIcons: true })
    const mine = sources.find((s) => s.name === 'Kitchen capture check')
    if (!sources.length && process.platform === 'linux' && process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) throw unsupported('no window list under Wayland')
    assert(mine, `own window not among ${sources.length}: ${sources.map((s) => s.name).join(' | ')}`)
    assert(/^window:/.test(mine.id) && mine.display_id === '', `id ${mine.id} / display_id '${mine.display_id}'`)
    assert(!mine.thumbnail.isEmpty(), 'empty thumbnail')
    const size = mine.thumbnail.getSize()
    assert(size.width <= 120 && size.height <= 120, `thumbnail ${size.width} × ${size.height}`)
    return `${sources.length} window(s); ${mine.id}, thumbnail ${size.width} × ${size.height}, icon ${mine.appIcon && !mine.appIcon.isEmpty() ? JSON.stringify(mine.appIcon.getSize()) : 'none'}`
  }, { title: 'Kitchen capture check' }) },

  // --- C9: screen sharing ------------------------------------------------------------------------------------
  // WebKitGTK looks for a screen-capture service (the desktop portal with PipeWire) before asking: without
  // one, getDisplayMedia() fails at once and no handler runs. The smoke sets TAURI_ELECTRON_MOCK_CAPTURE
  // (WebKit's mock screens) so the requests reach the handlers.
  { id: 'session.setDisplayMediaRequestHandler (getDisplayMedia)', run: async () => {
    const ses = session.defaultSession
    const requests = []
    let answer = () => ({})
    ses.setDisplayMediaRequestHandler((request, callback) => {
      requests.push({ video: request.videoRequested, audio: request.audioRequested, origin: request.securityOrigin, frame: Boolean(request.frame) })
      callback(answer())
    })
    try {
      return await withWindow(async (win) => {
        const denied = await win.webContents.executeJavaScript(pageRequest('md.getDisplayMedia({ video: true })'), true)
        if (denied === 'no getDisplayMedia') throw unsupported('this webview has no getDisplayMedia()')
        if (!requests.length && denied !== 'granted') throw unsupported(`getDisplayMedia() ended (${denied}) without asking: no screen-capture service here (desktop portal with PipeWire on Linux)`)
        assert(requests.length === 1 && requests[0].video === true && requests[0].frame, `handler calls ${JSON.stringify(requests)}`)
        assert(denied.startsWith('rejected'), `callback({}): ${denied}`)
        const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        answer = () => ({ video: source })
        const granted = await win.webContents.executeJavaScript(pageRequest('md.getDisplayMedia({ video: true })'), true)
        assert(requests.length === 2, `handler calls ${JSON.stringify(requests)}`)
        assert(granted === 'granted', `callback({ video }): ${granted}`)
        return `handler asked (${JSON.stringify(requests[0])}); callback({}) → ${denied}, callback({ video }) → ${granted}`
      })
    } finally {
      ses.setDisplayMediaRequestHandler(null)
    }
  } },
  { id: "getUserMedia({ chromeMediaSource: 'desktop' })", run: async () => {
    const ses = session.defaultSession
    const asked = []
    const display = []
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      asked.push({ permission, mediaTypes: details.mediaTypes })
      callback(true)
    })
    ses.setDisplayMediaRequestHandler((request, callback) => {
      display.push(request)
      callback({})
    })
    try {
      const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      return await withWindow(async (win) => {
        const constraints = { audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 1280, maxHeight: 720 } } }
        const result = await win.webContents.executeJavaScript(pageRequest(`md.getUserMedia(${JSON.stringify(constraints)})`), true)
        if (result === 'no getDisplayMedia') throw unsupported('this webview has no getDisplayMedia()')
        if (!asked.length && !display.length && result !== 'granted') throw unsupported(`the capture ended (${result}) without asking: no screen-capture service here (desktop portal with PipeWire on Linux)`)
        assert(display.length === 0, 'the display media handler is not asked for chromeMediaSource requests')
        assert(result === 'granted', `page: ${result}`)
        // Electron grants it without asking the permission handler; tauri-electron asks it ('media').
        assert(isElectron || (asked.length === 1 && asked[0].permission === 'media'), `permission handler calls ${JSON.stringify(asked)}`)
        return `${source.id} → ${result}${asked.length ? `; permission '${asked[0].permission}' ${JSON.stringify(asked[0].mediaTypes)}` : ''}`
      })
    } finally {
      ses.setPermissionRequestHandler(null)
      ses.setDisplayMediaRequestHandler(null)
    }
  } },
]
