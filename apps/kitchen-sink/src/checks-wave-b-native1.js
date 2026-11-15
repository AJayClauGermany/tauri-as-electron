// Checks for roadmap wave B items B3 and B4 (docs/ROADMAP.md): safeStorage
// with a keychain key, and fs.watch / fs.watchFile / fs.promises.watch with
// chokidar (v3 and v4) on top. Same shape as checks.js and, like it, runs
// unchanged on Electron and on Tauri.
import { safeStorage } from 'electron'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import chokidar from 'chokidar'
import chokidar3 from 'chokidar3'

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** A fresh temporary folder (real path: macOS reports /private/var/…), removed after `fn`. */
async function inTempDir(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-wave-b-')))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve once `predicate()` holds, or fail after `ms`. */
async function waitFor(predicate, what, ms = 5000) {
  const until = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await delay(25)
  }
}

/** chokidar's add / change / unlink for one file, with either major version. */
async function chokidarRoundTrip(lib) {
  return inTempDir(async (dir) => {
    const events = []
    const watcher = lib.watch(dir, { ignoreInitial: true })
    watcher.on('all', (event, file) => events.push(`${event} ${path.relative(dir, file)}`))
    try {
      await new Promise((resolve, reject) => {
        watcher.once('ready', resolve)
        watcher.once('error', reject)
      })
      const file = path.join(dir, 'note.txt')
      fs.writeFileSync(file, 'one')
      await waitFor(() => events.includes('add note.txt'), "'add'")
      await delay(50)
      fs.writeFileSync(file, 'two, longer')
      await waitFor(() => events.includes('change note.txt'), "'change'")
      fs.unlinkSync(file)
      await waitFor(() => events.includes('unlink note.txt'), "'unlink'")
      fs.mkdirSync(path.join(dir, 'sub'))
      await waitFor(() => events.includes('addDir sub'), "'addDir'")
    } finally {
      await watcher.close()
    }
    return [...new Set(events)].join(', ')
  })
}

export const waveBNative1Checks = [
  // --- B3: safeStorage ----------------------------------------------------------------------------
  { id: 'safeStorage encryptString / decryptString', run: async () => {
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os keychain'
    if (!safeStorage.isEncryptionAvailable()) {
      // Linux without a Secret Service (CI): Electron's basic_text backend.
      assert(process.platform === 'linux', 'encryption is available outside Linux')
      assert(backend === 'basic_text', `backend ${backend}`)
      let threw = false
      try {
        safeStorage.encryptString('x')
      } catch (error) {
        threw = /Error while encrypting the text provided to safeStorage\.encryptString/.test(error.message)
      }
      assert(threw, 'encryptString throws Electron\'s error without a keychain')
      safeStorage.setUsePlainTextEncryption(true)
      assert(safeStorage.isEncryptionAvailable(), 'plain-text encryption makes it available')
    }
    const secret = 'pässwörd 🔑'
    const sealed = safeStorage.encryptString(secret)
    assert(Buffer.isBuffer(sealed) && !sealed.toString('latin1').includes('pässwörd'), 'ciphertext is a Buffer, not the text')
    assert(safeStorage.decryptString(sealed) === secret, 'round trip')
    if (typeof safeStorage.encryptStringAsync === 'function') {
      const sealedAsync = await safeStorage.encryptStringAsync(secret)
      const { result } = await safeStorage.decryptStringAsync(sealedAsync)
      assert(result === secret, 'async round trip')
      assert(safeStorage.decryptString(sealedAsync) === secret, 'async and sync ciphertext interoperate')
    }
    return `backend ${safeStorage.getSelectedStorageBackend()}`
  } },

  // --- B4: fs.watch & co. -------------------------------------------------------------------------
  { id: 'fs.watch (directory): rename and change', run: () => inTempDir(async (dir) => {
    const events = []
    const watcher = fs.watch(dir, (type, name) => events.push(`${type} ${name}`))
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
      await waitFor(() => events.includes('rename a.txt'), "'rename a.txt'")
      fs.appendFileSync(path.join(dir, 'a.txt'), 'y')
      await waitFor(() => events.includes('change a.txt'), "'change a.txt'")
    } finally {
      watcher.close()
    }
    let code
    try {
      fs.watch(path.join(dir, 'missing'))
    } catch (error) {
      code = `${error.code}/${error.syscall}`
    }
    assert(code === 'ENOENT/watch', `missing path throws ENOENT, got ${code}`)
    return [...new Set(events)].join(', ')
  }) },
  { id: 'fs.watch (recursive)', run: () => inTempDir(async (dir) => {
    if (process.platform === 'linux' && Number(process.versions.node?.split('.')[0]) < 20) return 'Node < 20: no recursive watch on Linux'
    fs.mkdirSync(path.join(dir, 'sub'))
    const names = []
    const watcher = fs.watch(dir, { recursive: true }, (_type, name) => names.push(String(name).replace(/\\/g, '/')))
    try {
      await delay(100)
      fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x')
      await waitFor(() => names.includes('sub/deep.txt'), "'sub/deep.txt'")
    } finally {
      watcher.close()
    }
    return 'sub/deep.txt'
  }) },
  { id: 'fs.promises.watch (async iterator, AbortSignal)', run: () => inTempDir(async (dir) => {
    const controller = new AbortController()
    setTimeout(() => fs.writeFileSync(path.join(dir, 'b.txt'), 'x'), 100)
    let first
    try {
      for await (const event of fsPromises.watch(dir, { signal: controller.signal })) {
        first ??= event
        controller.abort()
      }
    } catch (error) {
      assert(error.name === 'AbortError', `ends with AbortError, got ${error.name}`)
    }
    assert(first?.filename === 'b.txt', `first event ${JSON.stringify(first)}`)
    return `${first.eventType} ${first.filename}`
  }) },
  { id: 'fs.watchFile / unwatchFile', run: () => inTempDir(async (dir) => {
    const file = path.join(dir, 'polled.txt')
    fs.writeFileSync(file, 'one')
    const changes = []
    const listener = (curr, prev) => changes.push([curr.size, prev.size])
    fs.watchFile(file, { interval: 50 }, listener)
    try {
      await delay(150)
      fs.writeFileSync(file, 'three')
      await waitFor(() => changes.some(([curr, prev]) => curr === 5 && prev === 3), 'a (curr, prev) change')
    } finally {
      fs.unwatchFile(file, listener)
    }
    return JSON.stringify(changes[0])
  }) },
  { id: 'chokidar 4 (add / change / unlink / addDir)', run: () => chokidarRoundTrip(chokidar) },
  { id: 'chokidar 3 (add / change / unlink / addDir)', run: () => chokidarRoundTrip(chokidar3) },
]
