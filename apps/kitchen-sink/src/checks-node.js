// Checks for the Node built-ins tauri-electron implements (fs, fs/promises,
// Buffer). Same shape as checks.js and, like it, runs unchanged on Electron
// and on Tauri (with tauri-plugin-electron's "node-fs" feature).
import { app } from 'electron'
import fs from 'node:fs'
import { readFileSync, promises as fsPromisesFromFs } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Buffer as ImportedBuffer } from 'node:buffer'

const dirname = import.meta.dirname

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let workDir
/** A fresh folder under app.getPath('temp'), created on first use. */
function work() {
  workDir ??= fs.mkdtempSync(path.join(app.getPath('temp'), 'kitchen-fs-'))
  return workDir
}

function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected an error')
}

export const nodeChecks = [
  { id: 'fs.writeFileSync/readFileSync (text)', run: () => {
    const file = path.join(work(), 'text.txt')
    fs.writeFileSync(file, 'héllo wörld')
    const text = readFileSync(file, 'utf8')
    assert(text === 'héllo wörld', `read "${text}"`)
    return text
  } },
  { id: 'fs.writeFileSync/readFileSync (binary)', run: () => {
    const file = path.join(work(), 'bytes.bin')
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    fs.writeFileSync(file, bytes)
    const read = fs.readFileSync(file)
    assert(Buffer.isBuffer(read) && read.length === 256, `length ${read.length}`)
    assert(read.every((byte, i) => byte === i), 'every byte round-trips')
    return `${read.length} bytes`
  } },
  { id: 'fs.appendFileSync/statSync', run: () => {
    const file = path.join(work(), 'log.txt')
    fs.writeFileSync(file, 'a')
    fs.appendFileSync(file, 'bc')
    const stats = fs.statSync(file)
    assert(stats.isFile() && !stats.isDirectory(), 'a file')
    assert(stats.size === 3, `size ${stats.size}`)
    assert(stats.mtime instanceof Date && Math.abs(stats.mtimeMs - Date.now()) < 600_000, `mtime ${stats.mtime}`)
    return `size ${stats.size}, mode ${(stats.mode & 0o777).toString(8)}`
  } },
  { id: 'fs.mkdirSync/readdirSync', run: () => {
    const nested = path.join(work(), 'tree', 'a', 'b')
    const first = fs.mkdirSync(nested, { recursive: true })
    assert(first === path.join(work(), 'tree'), `first created: ${first}`)
    fs.writeFileSync(path.join(work(), 'tree', 'file.txt'), 'x')
    const entries = fs.readdirSync(path.join(work(), 'tree'), { withFileTypes: true }).map((e) => `${e.name}:${e.isDirectory() ? 'dir' : 'file'}`).sort()
    assert(entries.join() === 'a:dir,file.txt:file', entries.join())
    const all = fs.readdirSync(path.join(work(), 'tree'), { recursive: true }).map((p) => p.split(path.sep).join('/')).sort()
    assert(all.join() === 'a,a/b,file.txt', all.join())
    return entries.join(' ')
  } },
  { id: 'fs errors (ENOENT)', run: () => {
    const missing = path.join(work(), 'missing.txt')
    const error = caught(() => fs.readFileSync(missing))
    assert(error.code === 'ENOENT' && error.syscall === 'open' && error.path === missing, `${error.code} ${error.syscall} ${error.path}`)
    assert(error.message === `ENOENT: no such file or directory, open '${missing}'`, error.message)
    assert(fs.existsSync(missing) === false, 'existsSync')
    assert(fs.statSync(missing, { throwIfNoEntry: false }) === undefined, 'throwIfNoEntry: false')
    const exists = caught(() => fs.mkdirSync(work()))
    assert(exists.code === 'EEXIST', exists.code)
    return error.message.replace(work(), '<tmp>')
  } },
  { id: 'fs.renameSync/copyFileSync/unlinkSync', run: () => {
    const a = path.join(work(), 'a.txt')
    const b = path.join(work(), 'b.txt')
    const c = path.join(work(), 'c.txt')
    fs.writeFileSync(a, 'moved')
    fs.renameSync(a, b)
    fs.copyFileSync(b, c)
    assert(!fs.existsSync(a) && fs.readFileSync(c, 'utf8') === 'moved', 'rename + copy')
    const excl = caught(() => fs.copyFileSync(b, c, fs.constants.COPYFILE_EXCL))
    assert(excl.code === 'EEXIST', excl.code)
    fs.unlinkSync(b)
    fs.unlinkSync(c)
    assert(!fs.existsSync(b) && !fs.existsSync(c), 'unlinked')
    return 'ok'
  } },
  { id: 'fs.promises (write, read, stat, readdir, rm)', run: async () => {
    assert(fsp.readFile === fsPromisesFromFs.readFile, 'fs/promises is fs.promises')
    const dir = path.join(work(), 'promises')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'p.json'), JSON.stringify({ ok: true }))
    const value = JSON.parse(await fsp.readFile(path.join(dir, 'p.json'), 'utf8'))
    const stats = await fsp.stat(path.join(dir, 'p.json'))
    const names = await fsp.readdir(dir)
    await fsp.rm(dir, { recursive: true })
    const gone = await fsp.access(dir).then(() => false, (error) => error.code === 'ENOENT')
    assert(value.ok && stats.size === 11 && names.join() === 'p.json' && gone, `${JSON.stringify(value)} ${stats.size} ${names} ${gone}`)
    return 'ok'
  } },
  { id: 'fs callback API', run: () => new Promise((resolve, reject) => {
    const file = path.join(work(), 'callback.txt')
    fs.writeFile(file, 'cb', (error) => {
      if (error) return reject(error)
      fs.readFile(file, 'utf8', (readError, text) => {
        if (readError) return reject(readError)
        fs.stat(path.join(work(), 'nope'), (statError) => {
          if (statError?.code !== 'ENOENT') return reject(new Error(`expected ENOENT, got ${statError?.code}`))
          resolve(text)
        })
      })
    })
  }) },
  { id: 'fs reads app files (path.join(__dirname, …))', run: () => {
    const data = JSON.parse(fs.readFileSync(path.join(dirname, 'fixtures', 'kitchen-data.json'), 'utf8'))
    assert(data.name === 'kitchen-sink', JSON.stringify(data))
    return data.name
  } },
  { id: 'app.getAppPath() with fs', run: () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
    assert(pkg.name === 'kitchen-sink', pkg.name)
    return pkg.name
  } },
  { id: 'Buffer global', run: () => {
    assert(typeof Buffer === 'function' && Buffer === ImportedBuffer, 'global Buffer is buffer.Buffer')
    const b = Buffer.from('kitchen')
    assert(b instanceof Uint8Array && b.toString('base64') === 'a2l0Y2hlbg==', b.toString('base64'))
    return b.toString('hex')
  } },
  { id: 'fs.rmSync (recursive)', run: () => {
    const dir = work()
    fs.rmSync(dir, { recursive: true, force: true })
    workDir = undefined
    assert(!fs.existsSync(dir), 'removed')
    return 'removed'
  } },
]
