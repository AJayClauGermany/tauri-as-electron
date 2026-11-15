// Checks for roadmap wave A (docs/ROADMAP.md): fs descriptors and streams,
// a synchronous getCursorScreenPoint, menu-bar visibility, nativeImage
// editing and disk paths, session.cookies, file:// in net.fetch,
// powerSaveBlocker and clipboard.readHTML. Same shape as checks.js and,
// like it, runs unchanged on Electron and on Tauri.
import { BrowserWindow, clipboard, nativeImage, net, powerSaveBlocker, screen, session } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const isElectron = Boolean(process.versions.electron)

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** A fresh temporary folder, removed after `fn`. */
async function inTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-wave-a-'))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** A 4×2 PNG: red on the left half, blue on the right. */
function testPng() {
  const bgra = new Uint8Array(4 * 2 * 4)
  for (let i = 0; i < 8; i++) bgra.set(i % 4 < 2 ? [0, 0, 255, 255] : [255, 0, 0, 255], i * 4)
  return nativeImage.createFromBitmap(Buffer.from(bgra), { width: 4, height: 2 }).toPNG()
}

export const waveAChecks = [
  // --- A1: fs file descriptors ------------------------------------------------------------------
  { id: 'fs.openSync/writeSync/readSync/fstatSync/fsyncSync/closeSync', run: () => inTempDir((dir) => {
    const file = path.join(dir, 'fd.txt')
    const fd = fs.openSync(file, 'w+')
    assert(fs.writeSync(fd, 'hello world') === 11, 'writeSync returns the bytes written')
    fs.writeSync(fd, Buffer.from('H'), 0, 1, 0)
    fs.fsyncSync(fd)
    assert(fs.fstatSync(fd).size === 11, 'fstat size')
    const buffer = Buffer.alloc(5)
    assert(fs.readSync(fd, buffer, 0, 5, 0) === 5 && buffer.toString() === 'Hello', 'positioned read')
    fs.ftruncateSync(fd, 5)
    fs.closeSync(fd)
    assert(fs.readFileSync(file, 'utf8') === 'Hello', 'file content')
    let code
    try {
      fs.closeSync(fd)
    } catch (error) {
      code = error.code
    }
    assert(code === 'EBADF', 'closing twice: EBADF')
    return 'ok'
  }) },
  { id: 'fs.open/write/read/close (callbacks)', run: () => inTempDir(async (dir) => {
    const file = path.join(dir, 'cb.txt')
    const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (error, ...values) => (error ? reject(error) : resolve(values))))
    const [fd] = await call(fs.open, file, 'w')
    const [written] = await call(fs.write, fd, 'abc')
    await call(fs.close, fd)
    const [readFd] = await call(fs.open, file, 'r')
    const [bytesRead, buffer] = await call(fs.read, readFd, Buffer.alloc(8), 0, 8, null)
    await call(fs.close, readFd)
    assert(written === 3 && buffer.toString('utf8', 0, bytesRead) === 'abc', 'round trip')
    return 'ok'
  }) },
  { id: 'fs.promises.open → FileHandle', run: () => inTempDir(async (dir) => {
    const handle = await fs.promises.open(path.join(dir, 'handle.txt'), 'w+')
    await handle.write('kitchen sink')
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(7), 0, 7, 0)
    assert(buffer.toString('utf8', 0, bytesRead) === 'kitchen', 'read back')
    assert((await handle.stat()).size === 12, 'stat')
    await handle.sync()
    await handle.close()
    return `fd ${handle.fd} after close`
  }) },

  // --- A2: streams --------------------------------------------------------------------------------
  { id: 'fs.createWriteStream → createReadStream (start/end)', run: () => inTempDir(async (dir) => {
    const file = path.join(dir, 'stream.txt')
    const out = fs.createWriteStream(file)
    for (let i = 0; i < 10; i++) out.write(`${i}`)
    await new Promise((resolve, reject) => out.on('error', reject).end(resolve))
    let text = ''
    for await (const chunk of fs.createReadStream(file, { start: 2, end: 6, encoding: 'utf8', highWaterMark: 2 })) text += chunk
    assert(text === '23456', `read ${text}`)
    const copy = path.join(dir, 'copy.txt')
    await pipeline(fs.createReadStream(file), fs.createWriteStream(copy))
    assert(fs.readFileSync(copy, 'utf8') === '0123456789', 'pipeline copy')
    return text
  }) },

  // --- A3: synchronous cursor position ------------------------------------------------------------
  { id: 'screen.getCursorScreenPoint (synchronous)', run: () => {
    const point = screen.getCursorScreenPoint()
    assert(!(point instanceof Promise), 'not a Promise')
    assert(Number.isInteger(point.x) && Number.isInteger(point.y), 'integers')
    return JSON.stringify(point)
  } },

  // --- A4: menu-bar visibility ----------------------------------------------------------------------
  { id: 'BrowserWindow menu-bar visibility / autoHideMenuBar', run: async () => {
    const win = new BrowserWindow({ show: false, width: 300, height: 200 })
    try {
      win.setMenuBarVisibility(false)
      assert(!win.isMenuBarVisible(), 'hidden')
      win.setMenuBarVisibility(true)
      assert(win.isMenuBarVisible(), 'visible again')
      win.setAutoHideMenuBar(true)
      assert(win.isMenuBarAutoHide() && win.autoHideMenuBar, 'auto-hide')
      return 'ok'
    } finally {
      win.destroy()
    }
  } },

  // --- A5: nativeImage ---------------------------------------------------------------------------------
  { id: 'nativeImage resize / crop', run: () => {
    const image = nativeImage.createFromBuffer(testPng())
    const small = image.resize({ width: 2 })
    assert(small.getSize().width === 2 && small.getSize().height === 1, `resized to ${JSON.stringify(small.getSize())}`)
    const right = image.crop({ x: 2, y: 0, width: 2, height: 2 })
    const bgra = right.toBitmap()
    assert(bgra[0] === 255 && bgra[2] === 0, 'the cropped half is blue')
    return JSON.stringify(right.getSize())
  } },
  { id: 'nativeImage.createFromPath (absolute path on disk)', run: () => inTempDir((dir) => {
    const file = path.join(dir, 'icon.png')
    fs.writeFileSync(file, testPng())
    const image = nativeImage.createFromPath(file)
    assert(!image.isEmpty(), 'not empty')
    assert(image.getSize().width === 4, 'size')
    assert(nativeImage.createFromPath(path.join(dir, 'missing.png')).isEmpty(), 'missing file → empty')
    return JSON.stringify(image.getSize())
  }) },
  { id: 'nativeImage.createThumbnailFromPath', run: () => {
    if (isElectron && process.platform === 'linux') return 'not on Linux in Electron'
    return inTempDir(async (dir) => {
      const file = path.join(dir, 'thumb.png')
      fs.writeFileSync(file, testPng())
      const thumbnail = await nativeImage.createThumbnailFromPath(file, { width: 2, height: 2 })
      assert(!thumbnail.isEmpty() && thumbnail.getSize().width <= 2, 'fits')
      return JSON.stringify(thumbnail.getSize())
    })
  } },

  // --- A6: cookies ---------------------------------------------------------------------------------------
  { id: 'session.cookies set / get / remove', run: async () => {
    const cookies = session.defaultSession.cookies
    const url = 'https://kitchen-sink.test/'
    const changes = []
    const onChanged = (event, cookie, cause, removed) => changes.push(`${cookie.name}:${removed ? 'removed' : 'added'}`)
    cookies.on('changed', onChanged)
    try {
      await cookies.set({ url, name: 'ks', value: 'v1', expirationDate: Math.floor(Date.now() / 1000) + 3600 })
      const [cookie] = await cookies.get({ url, name: 'ks' })
      assert(cookie?.value === 'v1', `got ${JSON.stringify(cookie)}`)
      await cookies.remove(url, 'ks')
      assert((await cookies.get({ url, name: 'ks' })).length === 0, 'removed')
      assert(changes.includes('ks:added') && changes.includes('ks:removed'), `changed events ${changes}`)
      return changes.join(', ')
    } finally {
      cookies.removeListener('changed', onChanged)
    }
  } },

  // --- A7: file-backed protocols -------------------------------------------------------------------------
  { id: "net.fetch('file://…')", run: () => inTempDir(async (dir) => {
    const file = path.join(dir, 'page.html')
    fs.writeFileSync(file, '<h1>kitchen</h1>')
    const url = new URL(`file://${file.startsWith('/') ? '' : '/'}${file.replace(/\\/g, '/')}`).href
    const response = await net.fetch(url)
    assert(response.ok, `status ${response.status}`)
    assert((await response.text()) === '<h1>kitchen</h1>', 'body')
    return response.headers.get('content-type')
  }) },

  // --- A8: clipboard.readHTML -------------------------------------------------------------------------------
  { id: 'clipboard.readHTML', run: async () => {
    clipboard.write({ html: '<b>kitchen html</b>', text: 'kitchen html' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const html = await clipboard.readHTML()
    assert(html.includes('kitchen html'), `read ${html}`)
    return html
  } },

  // --- A9: powerSaveBlocker --------------------------------------------------------------------------------
  { id: 'powerSaveBlocker.start / isStarted / stop', run: () => {
    const id = powerSaveBlocker.start('prevent-app-suspension')
    assert(powerSaveBlocker.isStarted(id), 'started')
    powerSaveBlocker.stop(id)
    assert(!powerSaveBlocker.isStarted(id), 'stopped')
    return `id ${id}`
  } },
]
