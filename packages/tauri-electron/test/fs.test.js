import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nodeFs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'

// fs talks to Rust through the synchronous bridge (*Sync) and the node_fs
// command (promises, callbacks). Both are replaced by a scripted fake here.
const state = vi.hoisted(() => ({ packaged: false, features: ['node-fs'], sync: [], invoke: [], answer: null }))

vi.mock('../src/internal/runtime.js', async (importOriginal) => ({
  ...(await importOriginal()),
  inTauri: true,
  isPackagedBuild: () => state.packaged,
}))

vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  const json = (value) => new TextEncoder().encode(JSON.stringify(value))
  return {
    ...actual,
    hasFeature: (name) => state.features.includes(name),
    syncRequestBytes(path, { query, body }) {
      const op = path.replace('node/fs/', '')
      const args = JSON.parse(decodeURIComponent(query.replace(/^a=/, '')))
      state.sync.push({ op, args, body })
      const { status = 200, value, bytes } = state.answer?.(op, args, body) ?? {}
      return { status, bytes: bytes ?? json(value ?? null) }
    },
    async native(command, frame) {
      expect(command).toBe('node_fs')
      const length = new DataView(frame.buffer).getUint32(0, true)
      const { op, args } = JSON.parse(new TextDecoder().decode(frame.slice(4, 4 + length)))
      const body = frame.slice(4 + length)
      state.invoke.push({ op, args, body })
      const { status = 200, value, bytes } = state.answer?.(op, args, body) ?? {}
      if (status !== 200) throw value
      return (bytes ?? json(value ?? null)).buffer
    },
  }
})

const fs = await import('../src/node/fs.js')
const fsPromises = (await import('../src/node/fs-promises.js')).default
const { setResourceRoot } = await import('../src/internal/app-files.js')
const { Buffer } = await import('../src/node/buffer.js')

const ENOENT = { code: 'ENOENT', errno: -2, syscall: 'open', path: '/nope', message: 'No such file or directory (os error 2)' }

/** What Node itself throws for `run`, to compare shapes with. */
function nodeThrows(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('did not throw')
}

beforeEach(() => {
  state.packaged = false
  state.features = ['node-fs']
  state.sync = []
  state.invoke = []
  state.answer = null
  globalThis.__TAURI_ELECTRON_APP__ = undefined
  setResourceRoot(null)
})

afterEach(() => {
  delete globalThis.__TAURI_ELECTRON_APP__
})

describe('fs sync API', () => {
  it('reads bytes as a Buffer, or text with an encoding', () => {
    state.answer = () => ({ bytes: new Uint8Array([0x68, 0x69, 0xff]) })
    const buffer = fs.readFileSync('/tmp/a.bin')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer).toBeInstanceOf(Uint8Array)
    expect([...buffer]).toEqual([0x68, 0x69, 0xff])
    expect(state.sync[0]).toEqual({ op: 'read', args: { path: '/tmp/a.bin' }, body: undefined })
    state.answer = () => ({ bytes: new TextEncoder().encode('héllo') })
    expect(fs.readFileSync('/tmp/a.txt', 'utf8')).toBe('héllo')
    expect(fs.readFileSync('/tmp/a.txt', { encoding: 'base64' })).toBe(Buffer.from('héllo').toString('base64'))
    expect(fs.readFileSync(new URL('file:///tmp/a%20b.txt'), 'utf8')).toBe('héllo')
    expect(state.sync.at(-1).args.path).toBe('/tmp/a b.txt')
  })

  it('writes strings in any encoding and binary data as the request body', () => {
    fs.writeFileSync('/tmp/w', 'héllo')
    expect(state.sync[0].args).toEqual({ path: '/tmp/w', flag: 'w', mode: 0o666 })
    expect(new TextDecoder().decode(state.sync[0].body)).toBe('héllo')
    fs.writeFileSync('/tmp/w', '6869', { encoding: 'hex', flag: 'wx', mode: 0o600 })
    expect(state.sync[1].args).toEqual({ path: '/tmp/w', flag: 'wx', mode: 0o600 })
    expect([...state.sync[1].body]).toEqual([0x68, 0x69])
    fs.appendFileSync('/tmp/w', new Uint16Array([1]))
    expect(state.sync[2].args.flag).toBe('a')
    expect(state.sync[2].body.byteLength).toBe(2)
    expect(fs.writeFileSync('/tmp/w', '')).toBeUndefined()
  })

  it('throws errors shaped like Node\'s', () => {
    state.answer = () => ({ status: 400, value: ENOENT })
    const error = nodeThrows(() => fs.readFileSync('/nope'))
    const real = nodeThrows(() => nodeFs.readFileSync('/nope'))
    expect(error.message).toBe(real.message)
    expect({ code: error.code, errno: error.errno, syscall: error.syscall, path: error.path }).toEqual({
      code: real.code,
      errno: real.errno,
      syscall: real.syscall,
      path: real.path,
    })
    expect(error).toBeInstanceOf(Error)
    state.answer = () => ({ status: 400, value: { code: 'ENOENT', errno: -2, syscall: 'rename', path: '/a', dest: '/b' } })
    expect(() => fs.renameSync('/a', '/b')).toThrow("ENOENT: no such file or directory, rename '/a' -> '/b'")
    state.answer = () => ({ status: 400, value: { code: 'ERR_FS_EISDIR', errno: 21, syscall: 'rm', path: '/d', message: 'Path is a directory: rm returned EISDIR (is a directory) /d' } })
    expect(() => fs.rmSync('/d')).toThrow(/^Path is a directory/)
  })

  it('validates arguments like Node, before any call', () => {
    for (const [ours, theirs] of [
      [() => fs.readFileSync({}), () => nodeFs.readFileSync({})],
      [() => fs.readFileSync('/x', 'bogus'), () => nodeFs.readFileSync('/x', 'bogus')],
      [() => fs.writeFileSync('/x', 5), () => nodeFs.writeFileSync(nodePath.join(os.tmpdir(), 'never'), 5)],
    ]) {
      const [a, b] = [nodeThrows(ours), nodeThrows(theirs)]
      expect(a.code).toBe(b.code)
      expect(a.message).toBe(b.message)
    }
    expect(() => fs.readFileSync('/a\u0000b')).toThrow(/without null bytes/)
    expect(() => fs.readFileSync(3)).toThrow(/File descriptors are not implemented yet/)
    expect(state.sync).toEqual([])
  })

  it('returns Stats and Dirents', () => {
    state.answer = (op) =>
      op === 'readdir'
        ? { value: [{ name: 'a', parent: '', type: 'file' }, { name: 'd', parent: '', type: 'dir' }, { name: 'b', parent: 'd', type: 'symlink' }] }
        : { value: { mode: 0o100644, size: 3, mtimeMs: 1000, atimeMs: 2000, ctimeMs: 1000, birthtimeMs: 500, nlink: 1, ino: 9 } }
    const stats = fs.statSync('/f')
    expect(stats).toBeInstanceOf(fs.Stats)
    expect([stats.isFile(), stats.isDirectory(), stats.isSymbolicLink()]).toEqual([true, false, false])
    expect(stats.mtime.getTime()).toBe(1000)
    expect(stats.size).toBe(3)
    expect(fs.statSync('/f', { bigint: true }).size).toBe(3n)
    expect(fs.readdirSync('/root', { recursive: true })).toEqual(['a', 'd', 'd/b'])
    const dirents = fs.readdirSync('/root/', { withFileTypes: true, recursive: true })
    expect(dirents.map((d) => [d.name, d.parentPath, d.isFile(), d.isDirectory(), d.isSymbolicLink()])).toEqual([
      ['a', '/root/', true, false, false],
      ['d', '/root/', false, true, false],
      ['b', '/root/d', false, false, true],
    ])
    expect(state.sync.map((c) => c.args)).toContainEqual({ path: '/root', recursive: true })
  })

  it('stat with throwIfNoEntry: false and existsSync do not throw for a missing path', () => {
    state.answer = () => ({ status: 400, value: { ...ENOENT, syscall: 'stat' } })
    expect(fs.statSync('/nope', { throwIfNoEntry: false })).toBeUndefined()
    expect(() => fs.statSync('/nope')).toThrow(/ENOENT/)
    state.answer = () => ({ value: false })
    expect(fs.existsSync('/nope')).toBe(false)
    expect(fs.existsSync({})).toBe(false)
    state.answer = () => ({ value: true })
    expect(fs.existsSync('/yes')).toBe(true)
  })

  it('returns what mkdir, mkdtemp, realpath and readlink return', () => {
    state.answer = (op) => ({ value: { mkdir: '/a', mkdtemp: '/tmp/x-AbC123', realpath: '/real', readlink: 'target' }[op] ?? null })
    expect(fs.mkdirSync('/a/b/c', { recursive: true })).toBe('/a')
    expect(fs.mkdirSync('/a', 0o700)).toBeUndefined()
    expect(state.sync.at(-1).args).toEqual({ path: '/a', recursive: false, mode: 0o700 })
    expect(fs.mkdtempSync('/tmp/x-')).toBe('/tmp/x-AbC123')
    expect(fs.realpathSync('/link')).toBe('/real')
    expect(fs.realpathSync.native('/link')).toBe('/real')
    expect(fs.readlinkSync('/link')).toBe('target')
    fs.utimesSync('/f', new Date(5000), 6)
    expect(state.sync.at(-1).args).toEqual({ path: '/f', atime: 5, mtime: 6 })
    fs.chmodSync('/f', '755')
    expect(state.sync.at(-1).args).toEqual({ path: '/f', mode: 0o755 })
    fs.copyFileSync('/a', '/b', fs.constants.COPYFILE_EXCL)
    expect(state.sync.at(-1)).toMatchObject({ op: 'copyFile', args: { path: '/a', dest: '/b', mode: 1 } })
  })

  it('explains a disabled feature, a renderer caller and a missing plugin', () => {
    state.answer = () => ({ status: 501, value: { code: 'ERR_FEATURE_DISABLED', feature: 'node-fs' } })
    const feature = nodeThrows(() => fs.readFileSync('/x'))
    expect(feature.name).toBe('NotImplementedError')
    expect(feature.reason).toBe('feature')
    expect(feature.message).toMatch(/"node-fs"/)
    expect(() => fs.existsSync('/x')).toThrow(/node-fs/) // a misconfigured app hears about it
    state.answer = () => ({ status: 403, value: { code: 'ERR_ACCESS_DENIED', message: 'only in the main process' } })
    expect(nodeThrows(() => fs.statSync('/x'))).toMatchObject({ reason: 'permission' })
    state.answer = () => ({ status: 404, bytes: new Uint8Array() })
    expect(nodeThrows(() => fs.statSync('/x'))).toMatchObject({ reason: 'plugin' })
  })

  it('leaves descriptors, streams and watchers unimplemented, with a hint', () => {
    for (const fn of [fs.openSync, fs.createReadStream, fs.watch, fs.cpSync]) {
      expect(nodeThrows(() => fn('/x'))).toMatchObject({ name: 'NotImplementedError', reason: 'unimplemented' })
    }
  })
})

describe('app-relative paths', () => {
  it('maps /<project entry>/… to the project folder in development', () => {
    globalThis.__TAURI_ELECTRON_APP__ = { root: '/home/me/app', entries: ['src', 'package.json'] }
    fs.existsSync('/src/data.json')
    fs.existsSync('/package.json')
    fs.existsSync('/tmp/data.json')
    fs.existsSync('relative.json')
    expect(state.sync.map((c) => c.args.path)).toEqual(['/home/me/app/src/data.json', '/home/me/app/package.json', '/tmp/data.json', 'relative.json'])
    fs.writeFileSync('/src/out.json', '{}') // like `electron .`: the project folder is writable
    expect(state.sync.at(-1).args.path).toBe('/home/me/app/src/out.json')
  })

  it('maps them to <resources>/app in a build, read-only like an asar', () => {
    globalThis.__TAURI_ELECTRON_APP__ = { root: null, entries: ['src'] }
    state.packaged = true
    setResourceRoot('/opt/App/resources')
    fs.existsSync('/src/data.json')
    expect(state.sync.at(-1).args.path).toBe('/opt/App/resources/app/src/data.json')
    const error = nodeThrows(() => fs.writeFileSync('/src/data.json', 'x'))
    expect(error).toMatchObject({ code: 'EROFS', syscall: 'open', path: '/src/data.json' })
    expect(error.message).toBe("EROFS: read-only file system, open '/src/data.json'")
  })

  it('asks Rust for the resource folder when fs runs before the app is ready', () => {
    globalThis.__TAURI_ELECTRON_APP__ = { root: null, entries: ['assets'] }
    state.answer = (op) => ({ value: op === 'resourceDir' ? 'C:\\Program Files\\App' : true })
    fs.existsSync('/assets/logo.png')
    expect(state.sync.map((c) => c.op)).toEqual(['resourceDir', 'exists'])
    expect(state.sync.at(-1).args.path).toBe('C:\\Program Files\\App\\app\\assets\\logo.png')
  })
})

describe('fs.promises and callbacks', () => {
  it('use the node_fs command with the same operations', async () => {
    state.answer = (op) => (op === 'read' ? { bytes: new TextEncoder().encode('data') } : { value: null })
    expect(await fs.promises.readFile('/f', 'utf8')).toBe('data')
    expect(fsPromises.readFile).toBe(fs.promises.readFile)
    await fs.promises.writeFile('/f', Buffer.from('xy'))
    expect(state.invoke.map(({ op, args }) => [op, args])).toEqual([['read', { path: '/f' }], ['write', { path: '/f', flag: 'w', mode: 0o666 }]])
    expect(new TextDecoder().decode(state.invoke[1].body)).toBe('xy')
    expect(state.sync).toEqual([])
  })

  it('reject with Node-shaped errors, and call back asynchronously, error first', async () => {
    state.answer = () => ({ status: 400, value: ENOENT })
    await expect(fs.promises.readFile('/nope')).rejects.toMatchObject({ code: 'ENOENT', syscall: 'open', path: '/nope' })
    await expect(fs.promises.readFile({})).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    let sync = true
    const result = await new Promise((resolve) => {
      fs.readFile('/nope', (error, data) => resolve({ error, data, sync }))
      sync = false
    })
    expect(result.sync).toBe(false)
    expect(result.error.code).toBe('ENOENT')
    expect(() => fs.readFile('/nope')).toThrow(/"cb" argument must be of type function/)
    state.answer = () => ({ value: true })
    expect(await new Promise((resolve) => fs.exists('/yes', resolve))).toBe(true)
    state.answer = () => ({ value: '/made' })
    expect(await new Promise((resolve) => fs.mkdir('/made/x', { recursive: true }, (e, first) => resolve(first)))).toBe('/made')
  })

  it('report a disabled feature without calling Rust', async () => {
    state.features = []
    await expect(fs.promises.stat('/x')).rejects.toMatchObject({ name: 'NotImplementedError', reason: 'feature' })
    expect(state.invoke).toEqual([])
  })
})

describe('fs module shape', () => {
  it('has named exports and a default export that is the same module object', () => {
    for (const name of ['readFileSync', 'writeFileSync', 'existsSync', 'promises', 'constants', 'Stats', 'Dirent', 'readFile']) {
      expect(fs.default[name], name).toBe(fs[name])
    }
    expect(fs.constants.F_OK).toBe(nodeFs.constants.F_OK)
    expect(fs.constants.COPYFILE_EXCL).toBe(nodeFs.constants.COPYFILE_EXCL)
    expect(fs.constants.S_IFDIR).toBe(nodeFs.constants.S_IFDIR)
  })
})
