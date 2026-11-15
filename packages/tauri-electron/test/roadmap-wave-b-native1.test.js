import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Roadmap wave B: safeStorage (B3) and fs.watch / watchFile / promises.watch
// (B4). tauri-plugin-electron is replaced by a scripted fake of its
// synchronous bridge and commands.
const state = vi.hoisted(() => ({ sync: [], commands: [], onSync: null, onCommand: null, channels: [] }))

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal()
  class Channel {
    constructor() {
      this.onmessage = () => {}
      state.channels.push(this)
    }
  }
  return { ...actual, Channel }
})
vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true, isMainProcess: true }))
vi.mock('../src/process.js', async (importOriginal) => ({ ...(await importOriginal()), platform: 'linux' }))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  const json = (value) => new TextEncoder().encode(JSON.stringify(value))
  return {
    ...actual,
    hasFeature: () => true,
    syncRequestBytes(path, { query, body } = {}) {
      state.sync.push({ path, query, body })
      const { status = 200, value, bytes } = state.onSync?.(path, query, body) ?? {}
      return { status, bytes: bytes ?? json(value ?? null) }
    },
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand?.(command, args)
    },
  }
})

const fs = (await import('../src/node/fs.js')).default
const fsPromises = (await import('../src/node/fs-promises.js')).default
const { safeStorage } = await import('../src/main/safe-storage.js')
const { Buffer } = await import('../src/node/buffer.js')

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  state.sync = []
  state.commands = []
  state.channels = []
  state.onSync = null
  state.onCommand = null
})

afterEach(() => vi.useRealTimers())

describe('fs.watch', () => {
  const watchBridge = (path, query) => {
    if (path !== 'node/fs/watch') return undefined
    const args = JSON.parse(decodeURIComponent(query.replace(/^a=/, '')))
    if (args.path === '/missing') {
      return { status: 400, value: { code: 'ENOENT', errno: -2, syscall: 'watch', path: '/missing', message: 'not found' } }
    }
    return { value: { id: 7 } }
  }

  it('creates the watcher synchronously and streams change / rename events', async () => {
    state.onSync = watchBridge
    state.onCommand = () => true
    const events = []
    const watcher = fs.watch('/dir', { recursive: true }, (type, name) => events.push([type, name]))
    expect(JSON.parse(decodeURIComponent(state.sync[0].query.slice(2)))).toEqual({ path: '/dir', recursive: true })
    expect(state.commands[0]).toMatchObject({ command: 'fs_watch', args: { id: 7 } })
    const channel = state.commands[0].args.onEvent
    channel.onmessage({ type: 'rename', filename: 'a.txt' })
    channel.onmessage({ type: 'change', filename: 'sub/b.txt' })
    expect(events).toEqual([['rename', 'a.txt'], ['change', 'sub/b.txt']])
    const closed = new Promise((resolve) => watcher.on('close', resolve))
    expect(watcher.ref()).toBe(watcher)
    watcher.close()
    await closed
    channel.onmessage({ type: 'change', filename: 'late' })
    expect(events).toHaveLength(2)
    expect(state.commands.at(-1)).toEqual({ command: 'fs_unwatch', args: { id: 7 } })
  })

  it('throws ENOENT like Node, and honours encoding and AbortSignal', async () => {
    state.onSync = watchBridge
    let thrown
    try {
      fs.watch('/missing')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'ENOENT', syscall: 'watch', message: "ENOENT: no such file or directory, watch '/missing'" })

    const controller = new AbortController()
    const names = []
    const watcher = fs.watch('/dir', { encoding: 'buffer', signal: controller.signal }, (_t, name) => names.push(name))
    state.commands[0].args.onEvent.onmessage({ type: 'change', filename: 'x' })
    expect(Buffer.isBuffer(names[0]) && names[0].toString()).toBe('x')
    const closed = new Promise((resolve) => watcher.on('close', resolve))
    controller.abort()
    await closed
  })

  it('reports watcher errors and closes', async () => {
    state.onSync = watchBridge
    const watcher = fs.watch('/dir')
    const error = new Promise((resolve) => watcher.on('error', resolve))
    state.commands[0].args.onEvent.onmessage({ type: 'error', error: { code: 'ENOSPC', errno: -28, syscall: 'watch', path: '/dir', message: 'x' } })
    expect(await error).toMatchObject({ code: 'ENOSPC', syscall: 'watch' })
  })

  it('fs.promises.watch is an async iterator that stops on abort', async () => {
    state.onSync = watchBridge
    const controller = new AbortController()
    const iterator = fsPromises.watch('/dir', { signal: controller.signal })
    const first = iterator.next()
    await tick()
    state.commands[0].args.onEvent.onmessage({ type: 'rename', filename: 'new.txt' })
    expect((await first).value).toEqual({ eventType: 'rename', filename: 'new.txt' })
    const second = iterator.next()
    controller.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    expect(state.commands.at(-1)).toEqual({ command: 'fs_unwatch', args: { id: 7 } })
  })
})

describe('fs.watchFile', () => {
  it('polls with stat and calls listeners with (curr, prev) on change', async () => {
    vi.useFakeTimers()
    let size = 1
    let exists = true
    state.onCommand = (command, frame) => {
      expect(command).toBe('node_fs')
      if (!exists) throw { code: 'ENOENT', errno: -2, syscall: 'stat', path: '/f', message: 'x' }
      return new TextEncoder().encode(JSON.stringify({ size, mode: 0o100644, mtimeMs: size * 1000 })).buffer
    }
    const calls = []
    const listener = (curr, prev) => calls.push([curr.size, prev.size])
    fs.watchFile('/f', { interval: 100 }, listener)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])
    size = 5
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toEqual([[5, 1]])
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(1)
    exists = false
    await vi.advanceTimersByTimeAsync(100)
    expect(calls.at(-1)).toEqual([0, 5])
    fs.unwatchFile('/f', listener)
    const before = state.commands.length
    await vi.advanceTimersByTimeAsync(500)
    expect(state.commands.length).toBe(before)
  })
})

describe('safeStorage', () => {
  it('encrypts and decrypts over the synchronous bridge', () => {
    state.onSync = (path, _query, body) => {
      if (path === 'safe-storage/status') return { value: { available: true, backend: 'gnome_libsecret' } }
      if (path === 'safe-storage/encrypt') return { bytes: new Uint8Array([116, 101, 118, 49, ...body]) }
      if (path === 'safe-storage/decrypt') return { bytes: body.slice(4) }
      return { status: 404 }
    }
    expect(safeStorage.isEncryptionAvailable()).toBe(true)
    expect(safeStorage.getSelectedStorageBackend()).toBe('gnome_libsecret')
    const sealed = safeStorage.encryptString('héllo')
    expect(Buffer.isBuffer(sealed) || sealed instanceof Uint8Array).toBe(true)
    expect(safeStorage.decryptString(sealed)).toBe('héllo')
    expect(() => safeStorage.decryptString('text')).toThrow(TypeError)
  })

  it('without a keychain: unavailable and basic_text, with Electron errors', () => {
    state.onSync = (path, query) => {
      if (path === 'safe-storage/status') return { value: { available: false, backend: 'basic_text', error: 'no secret service' } }
      if (path === 'safe-storage/encrypt') return { status: 500, bytes: new TextEncoder().encode('Encryption is not available: no secret service') }
      if (path === 'safe-storage/plain-text') return { value: query }
      return { status: 404 }
    }
    // A fresh module would not have cached a keychain; this one did (previous test).
    expect(() => safeStorage.encryptString('x')).toThrow(/^Error while encrypting the text provided to safeStorage\.encryptString\. Encryption is not available/)
    safeStorage.setUsePlainTextEncryption(true)
    expect(state.sync.at(-1)).toMatchObject({ path: 'safe-storage/plain-text', query: 'on=true' })
  })

  it('async variants use commands', async () => {
    state.onCommand = (command, args) => {
      if (command === 'safe_storage_status') return { available: true }
      if (command === 'safe_storage_encrypt') return new Uint8Array([1, 2, 3]).buffer
      if (command === 'safe_storage_decrypt') return `plain:${args.data}`
    }
    expect(await safeStorage.isAsyncEncryptionAvailable()).toBe(true)
    expect([...(await safeStorage.encryptStringAsync('x'))]).toEqual([1, 2, 3])
    expect(await safeStorage.decryptStringAsync(Buffer.from([1, 2, 3]))).toEqual({ shouldReEncrypt: false, result: 'plain:AQID' })
  })
})
