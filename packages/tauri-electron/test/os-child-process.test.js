import { beforeEach, describe, expect, it, vi } from 'vitest'
import nodeOs from 'node:os'

// os and child_process talk to Rust over the synchronous bridge and (spawn)
// the child_* commands with a Channel; both are scripted here.
const state = vi.hoisted(() => ({ features: ['node-os', 'node-child-process'], sync: [], calls: [], answer: null, channel: null }))

vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true }))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal()),
  Channel: class {
    constructor() {
      this.onmessage = null
    }
  },
}))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    hasFeature: (name) => state.features.includes(name),
    syncRequestBytes(path, { query, body }) {
      const args = JSON.parse(decodeURIComponent(query.replace(/^a=/, '')))
      state.sync.push({ path, args, body })
      const { status = 200, value, bytes } = state.answer(path, args, body) ?? {}
      return { status, bytes: bytes ?? new TextEncoder().encode(JSON.stringify(value ?? null)) }
    },
    async native(command, args) {
      state.calls.push({ command, args })
      if (command === 'child_spawn') {
        state.channel = args.onEvent
        if (args.options.file === '/missing') throw { code: 'ENOENT', errno: -2, syscall: 'spawn /missing', path: '/missing', message: 'No such file' }
        return { id: 7, pid: 4242 }
      }
      return true
    },
  }
})

const os = (await import('../src/node/os.js')).default
const cp = await import('../src/node/child-process.js')
const { Buffer } = await import('../src/node/buffer.js')

/** A spawnSync answer frame, as Rust builds it. */
function frame({ status = 0, signal = null, pid = 1, stdout = '', stderr = '', error }) {
  const out = Buffer.from(stdout)
  const err = Buffer.from(stderr)
  const header = Buffer.from(JSON.stringify({ pid, status, signal, stdout: out.length, stderr: err.length, ...(error ? { error } : {}) }))
  const length = Buffer.alloc(4)
  length.writeUInt32LE(header.length)
  return { bytes: new Uint8Array(Buffer.concat([length, header, out, err])) }
}

beforeEach(() => {
  state.features = ['node-os', 'node-child-process']
  state.sync = []
  state.calls = []
  state.answer = () => null
})

describe('os', () => {
  it('asks Rust once for fixed facts and every time for live ones', () => {
    state.answer = (path) =>
      path === 'node/os/info'
        ? { value: { hostname: 'box', homedir: '/home/me', tmpdir: '/tmp', type: 'Linux', release: '6.0', version: '#1', machine: 'x86_64', user: { uid: 1, gid: 1, username: 'me', homedir: '/home/me', shell: '/bin/sh' } } }
        : path === 'node/os/memory'
          ? { value: { total: 1000, free: 400 } }
          : { value: [1, 2, 3] }
    expect([os.hostname(), os.homedir(), os.tmpdir(), os.type()]).toEqual(['box', '/home/me', '/tmp', 'Linux'])
    expect(os.userInfo().username).toBe('me')
    expect(os.userInfo({ encoding: 'buffer' }).username).toBeInstanceOf(Uint8Array)
    expect(state.sync.filter((c) => c.path === 'node/os/info')).toHaveLength(1)
    expect([os.totalmem(), os.freemem(), os.totalmem()]).toEqual([1000, 400, 1000])
    expect(state.sync.filter((c) => c.path === 'node/os/memory')).toHaveLength(3)
    expect(os.loadavg()).toEqual([1, 2, 3])
  })

  it('needs no Rust for platform facts and constants', () => {
    state.answer = () => {
      throw new Error('should not be called')
    }
    expect(os.platform()).toBe(process.platform)
    expect(os.EOL).toBe(nodeOs.EOL)
    expect(os.endianness()).toBe(nodeOs.endianness())
    expect(os.constants.signals.SIGTERM).toBe(15)
    expect(os.constants.priority).toEqual(nodeOs.constants.priority)
    expect(os.availableParallelism()).toBeGreaterThan(0)
  })

  it('explains a disabled feature', () => {
    state.answer = () => ({ status: 501, value: { code: 'ERR_FEATURE_DISABLED', feature: 'node-os' } })
    expect(() => os.cpus()).toThrow(expect.objectContaining({ reason: 'feature', message: expect.stringMatching(/"node-os"/) }))
  })
})

describe('child_process sync', () => {
  it('runs commands through a shell and returns stdout', () => {
    state.answer = () => frame({ stdout: 'hi\n' })
    expect(cp.execSync('echo hi').toString()).toBe('hi\n')
    expect(state.sync[0].args).toMatchObject({ file: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', stdio: ['pipe', 'pipe', 'inherit'] })
    expect(cp.execSync('echo hi', { encoding: 'utf8', input: 'in' })).toBe('hi\n')
    expect(new TextDecoder().decode(state.sync[1].body)).toBe('in')
  })

  it('throws like Node when the command fails', () => {
    state.answer = () => frame({ status: 3, stdout: 'out\n', stderr: 'err\n' })
    const error = (() => {
      try {
        cp.execSync('exit 3', { stdio: 'pipe' })
      } catch (e) {
        return e
      }
    })()
    expect(error.message).toBe('Command failed: exit 3\nerr\n')
    expect(Object.keys(error)).toEqual(['status', 'signal', 'output', 'pid', 'stdout', 'stderr'])
    expect(error.status).toBe(3)
  })

  it('reports spawn errors and timeouts on spawnSync results', () => {
    state.answer = () => frame({ status: null, error: { code: 'ENOENT', errno: -2, syscall: 'spawnSync /nope', path: '/nope' } })
    const result = cp.spawnSync('/nope', ['a'])
    expect(result.error).toMatchObject({ message: 'spawnSync /nope ENOENT', code: 'ENOENT', errno: -2, path: '/nope', spawnargs: ['a'] })
    expect(Object.keys(result)[0]).toBe('error')
    state.answer = () => frame({ status: null, signal: 15, error: { code: 'ETIMEDOUT', errno: -110, syscall: 'spawnSync /bin/sh', path: '/bin/sh' } })
    expect(cp.spawnSync('sleep', ['9'], { timeout: 10 })).toMatchObject({ signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } })
    expect(state.sync.at(-1).args.timeout).toBe(10)
    expect(() => cp.fork('worker.js')).toThrow(/no Node\.js is shipped/)
  })
})

describe('child_process async', () => {
  const send = (event) => state.channel.onmessage(event)
  const b64 = (text) => Buffer.from(text).toString('base64')

  it('streams output and emits exit then close', async () => {
    const child = cp.spawn('ls', ['-l'], { cwd: '/tmp' })
    const order = []
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('spawn', () => order.push('spawn'))
    child.on('exit', (code) => order.push(`exit ${code}`))
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve([code, signal])))
    await vi.waitFor(() => expect(child.pid).toBe(4242))
    expect(state.calls[0].args.options).toMatchObject({ file: 'ls', args: ['-l'], cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'] })
    send({ type: 'data', fd: 1, data: b64('total 0\n') })
    send({ type: 'exit', code: 0, signal: null })
    send({ type: 'end', fd: 1 })
    send({ type: 'end', fd: 2 })
    expect(await closed).toEqual([0, null])
    expect(order).toEqual(['spawn', 'exit 0'])
    expect(out).toBe('total 0\n')
  })

  it('writes stdin and kills with a signal number', async () => {
    const child = cp.spawn('cat')
    child.stdin.end('input')
    await vi.waitFor(() => expect(state.calls.map((c) => c.command)).toEqual(expect.arrayContaining(['child_write', 'child_end'])))
    expect(Buffer.from(state.calls.find((c) => c.command === 'child_write').args.data, 'base64').toString()).toBe('input')
    expect(child.kill('SIGKILL')).toBe(true)
    await vi.waitFor(() => expect(state.calls.at(-1)).toMatchObject({ command: 'child_kill', args: { id: 7, signal: 9 } }))
  })

  it('emits a Node-shaped error when the program is missing', async () => {
    const child = cp.spawn('/missing')
    const error = await new Promise((resolve) => child.on('error', resolve))
    expect(error).toMatchObject({ message: 'spawn /missing ENOENT', code: 'ENOENT', syscall: 'spawn /missing', path: '/missing' })
  })

  it('exec buffers output and fails like Node', async () => {
    const promise = new Promise((resolve) => cp.exec('echo hi; exit 4', (error, stdout, stderr) => resolve({ error, stdout, stderr })))
    await vi.waitFor(() => expect(state.channel).toBeTruthy())
    await vi.waitFor(() => expect(state.calls.length).toBe(1))
    await new Promise((r) => setTimeout(r, 0))
    send({ type: 'data', fd: 1, data: b64('hi\n') })
    send({ type: 'end', fd: 1 })
    send({ type: 'end', fd: 2 })
    send({ type: 'exit', code: 4, signal: null })
    const { error, stdout } = await promise
    expect(stdout).toBe('hi\n')
    expect(error).toMatchObject({ message: 'Command failed: echo hi; exit 4\n', code: 4, killed: false, signal: null, cmd: 'echo hi; exit 4' })
  })

  it('throws for a disabled feature', () => {
    state.features = []
    expect(() => cp.spawn('ls')).toThrow(expect.objectContaining({ reason: 'feature' }))
  })
})
