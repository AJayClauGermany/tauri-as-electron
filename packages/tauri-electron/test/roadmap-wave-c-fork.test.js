import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Roadmap wave C, C3: child_process.fork and utilityProcess.fork.
//
// tauri-plugin-electron is replaced by a fake that does what its
// `child_spawn` / `child_send` / `child_disconnect` commands do with Node's
// own child_process (a socket at descriptor 3, NODE_CHANNEL_FD or
// TAURI_ELECTRON_IPC, JSON lines forwarded as `{ type: 'ipc', lines }`), so
// the main-process side, the child bootstrap and the bundled fork entries run
// end to end in real Node.js children. `state.scripted` replaces it for the
// request-shape and error cases.
const state = vi.hoisted(() => ({ calls: [], scripted: null, real: null }))

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal()),
  Channel: class {
    constructor() {
      this.onmessage = null
    }
  },
}))
vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true, isMainProcess: true }))
vi.mock('../src/internal/native.js', async (importOriginal) => ({
  ...(await importOriginal()),
  hasFeature: () => true,
  async native(command, args) {
    state.calls.push({ command, args })
    return state.scripted ? state.scripted(command, args) : state.real(command, args)
  },
}))

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures/fork-app')
const shared = require('../bundler/shared.cjs')
const forkShared = require('../bundler/fork.cjs')
const { buildForks } = await import('../bundler/fork-vite.js')
const { forkWebpackConfig, runForkBuild } = require('../bundler/fork-webpack.cjs')
const cp = await import('../src/node/child-process.js')
const { utilityProcess } = await import('../src/main/utility-process.js')
const { MessageChannelMain } = await import('../src/main/message-ports.js')
const electronIndex = await import('../src/index.js')

/** Temporary folders, removed after the tests. */
const temporary = []
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

const once = (emitter, event, timeout = 10000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeout)
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })

// --- the fake tauri-plugin-electron -------------------------------------------------------------

const SIGNALS = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }
const running = new Map()
let nextId = 1

/** What `Children::spawn` + `node_fork` do, with Node's child_process. */
function realRust(command, args) {
  if (command === 'child_spawn') {
    const { options, onEvent } = args
    const emit = (event) => onEvent.onmessage?.(event)
    const file = options.node ? options.file || process.execPath : options.file
    const stdio = options.stdio.map((mode) => (mode === 'inherit' ? 'ignore' : mode))
    const env = { ...(options.env ?? process.env) }
    if (options.ipc) {
      while (stdio.length < options.ipc.fd) stdio.push('ignore')
      stdio[options.ipc.fd] = 'pipe'
      if (options.ipc.kind === 'node') Object.assign(env, { NODE_CHANNEL_FD: String(options.ipc.fd), NODE_CHANNEL_SERIALIZATION_MODE: 'json' })
      else env.TAURI_ELECTRON_IPC = `utility:fd:${options.ipc.fd}`
    }
    const child = nodeSpawn(file, options.args, { cwd: options.cwd ?? undefined, env, stdio })
    const id = nextId++
    for (const fd of [1, 2]) {
      const stream = child.stdio[fd]
      if (!stream) continue
      stream.on('data', (chunk) => emit({ type: 'data', fd, data: chunk.toString('base64') }))
      stream.on('end', () => emit({ type: 'end', fd }))
    }
    let socket = null
    let ipcClosed = Promise.resolve()
    if (options.ipc) {
      socket = child.stdio[options.ipc.fd]
      let pending = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop()
        if (lines.length) emit({ type: 'ipc', lines: lines.filter(Boolean) })
      })
      ipcClosed = new Promise((resolve) => socket.on('close', resolve)).then(() => emit({ type: 'ipc-end' }))
    }
    child.on('exit', async (code, signal) => {
      await Promise.race([ipcClosed, new Promise((resolve) => setTimeout(resolve, 250))])
      socket?.end()
      running.delete(id)
      emit({ type: 'exit', code, signal: signal ? SIGNALS[signal] : null })
    })
    return new Promise((resolve, reject) => {
      child.once('spawn', () => {
        running.set(id, { child, socket })
        resolve({ id, pid: child.pid, file })
      })
      child.once('error', (error) => reject({ code: error.code, errno: error.errno, syscall: `spawn ${file}`, path: file, message: error.message }))
    })
  }
  const entry = running.get(args.id)
  if (command === 'child_send') {
    if (!entry?.socket || entry.socket.destroyed || entry.socket.writableEnded) return false
    entry.socket.write(args.data)
    return true
  }
  if (command === 'child_disconnect') return void entry?.socket?.end()
  if (command === 'child_kill') return entry ? entry.child.kill(args.signal) : false
  if (command === 'child_write') return entry ? entry.child.stdin.write(Buffer.from(args.data, 'base64')) : false
  if (command === 'child_end') return void entry?.child.stdin?.end()
  throw new Error(`unexpected command ${command}`)
}

// --- the fixture's fork entries, built once -----------------------------------------------------

let outDir
let plan

beforeAll(async () => {
  outDir = tempDir('tauri-electron-fork-')
  plan = forkShared.forkPlan(fixture, undefined, shared.scanSources(fixture))
  await buildForks({ root: fixture, plan, outDir, dev: true })
  globalThis.__TAURI_ELECTRON_APP__ = {
    root: fixture,
    entries: ['src', 'package.json'],
    fork: forkShared.forkManifest(plan, { dev: true, outDir }),
  }
}, 60000)

afterAll(() => {
  for (const { child } of running.values()) child.kill('SIGKILL')
  delete globalThis.__TAURI_ELECTRON_APP__
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  state.calls = []
  state.scripted = null
  state.real = realRust
})

// --- bundler: finding and building fork entries -----------------------------------------------

describe('fork entry points', () => {
  const evaluate = (text, code) => forkShared.evaluatePathExpression(text, '/src/main/index.js', code)?.path

  it('evaluates the static paths apps pass to fork()', () => {
    expect(evaluate("path.join(__dirname, 'worker.js')")).toBe('/src/main/worker.js')
    expect(evaluate("path.resolve(import.meta.dirname, '..', 'workers', 'w.ts')")).toBe('/src/workers/w.ts')
    expect(evaluate("__dirname + '/w.js'")).toBe('/src/main/w.js')
    expect(evaluate('`${__dirname}/w.js`')).toBe('/src/main/w.js')
    expect(evaluate("fileURLToPath(new URL('../w.js', import.meta.url))")).toBe('/src/w.js')
    expect(evaluate("require.resolve('./w')")).toBe('/src/main/w')
    expect(evaluate("join(dirname, 'x.cjs')", 'const dirname = import.meta.dirname\nrun()')).toBe('/src/main/x.cjs')
    expect(evaluate('workerPath', "const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'w.js')")).toBe('/src/main/w.js')
    // Not static: left to the `fork` option.
    expect(evaluate('someVariable')).toBeUndefined()
    expect(evaluate("path.join(app.getAppPath(), 'w.js')")).toBeUndefined()
    expect(evaluate("'./relative-to-cwd.js'")).toBeUndefined()
  })

  it('finds the fixture entries, a .js path finding its .ts source', () => {
    const scan = shared.scanSources(fixture)
    expect(scan.forkCalls).toBe(true)
    expect([...scan.forks]).toEqual([
      ['/src/utility.js', path.join(fixture, 'src/utility.ts')],
      ['/src/workers/child.js', path.join(fixture, 'src/workers/child.js')],
    ])
    expect(forkShared.mentionsFork("import { fork } from 'child_process'\nfork(p)")).toBe(true)
    expect(forkShared.mentionsFork('git.fork(repo)')).toBe(false)
  })

  it('plans entries from the scan and the `fork` option, and describes them for the runtime', () => {
    const extra = forkShared.forkPlan(fixture, ['src/shared.ts'], { forks: new Map(), forkCalls: false })
    expect(extra.entries.map((e) => [e.key, e.name])).toEqual([
      ['/src/shared.ts', 'src/shared'],
      ['/src/shared.js', 'src/shared'],
    ])
    expect(forkShared.forkPlan(fixture, false, () => ({ forks: new Map([['/a.js', '/x/a.js']]) }))).toEqual({ entries: [], needed: false })
    expect(forkShared.forkManifest(plan, { dev: false, outDir: '/somewhere' })).toEqual({
      dir: null,
      bootstrap: 'bootstrap.cjs',
      entries: { '/src/utility.js': 'src/utility.cjs', '/src/workers/child.js': 'src/workers/child.cjs' },
    })
    // A build ships fork files only through src-tauri/electron-resources.
    expect(forkShared.forkOutDir(fixture, false)).toBeNull()
    expect(forkShared.forkOutDir(fixture, true)).toBe(path.join(fixture, 'node_modules/.tauri-electron/fork'))
  })

  it('bundles each entry for Node with the bootstrap, electron aliased and __dirname mapped', () => {
    const files = fs.readdirSync(outDir, { recursive: true }).map((f) => f.split(path.sep).join('/'))
    expect(files).toEqual(expect.arrayContaining(['bootstrap.cjs', 'src/utility.cjs', 'src/workers/child.cjs']))
    const utility = fs.readFileSync(path.join(outDir, 'src/utility.cjs'), 'utf8')
    expect(utility).toContain('process.env.TAURI_ELECTRON_APP_ROOT || "") + "/src"')
    expect(utility).not.toMatch(/__dirname/)
    expect(utility).toContain('function describe(kind)') // ./shared.ts bundled in
    expect(fs.readFileSync(path.join(outDir, 'bootstrap.cjs'), 'utf8')).toContain('require("node:net")')
  })
})

describe('the Vite plugin', () => {
  it('builds fork entries into src-tauri/electron-resources/fork and describes them in the main page', async () => {
    const root = tempDir('tauri-electron-fork-app-')
    fs.cpSync(fixture, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'src-tauri/electron-resources'), { recursive: true })
    const tauriElectron = (await import('../vite.js')).default
    const plugin = tauriElectron({ schemes: false, resources: false })
    plugin.configResolved({ root, command: 'build', build: { outDir: 'dist' }, logger: { info() {}, warn() {} } })
    await plugin.buildStart.call({ info() {} })
    const forkDir = path.join(root, 'src-tauri/electron-resources/fork')
    expect(fs.existsSync(path.join(forkDir, 'bootstrap.cjs'))).toBe(true)
    expect(fs.existsSync(path.join(forkDir, 'src/utility.cjs'))).toBe(true)
    const main = plugin.load(plugin.resolveId('virtual:tauri-electron/main'))
    const config = JSON.parse(/__TAURI_ELECTRON_APP__ = (.*)/.exec(main)[1])
    expect(config.fork).toEqual({ dir: null, bootstrap: 'bootstrap.cjs', entries: { '/src/utility.js': 'src/utility.cjs', '/src/workers/child.js': 'src/workers/child.cjs' } })
    // `fork: false`: nothing built, nothing described.
    const off = tauriElectron({ schemes: false, fork: false })
    off.configResolved({ root, command: 'build', build: { outDir: 'dist' }, logger: { info() {}, warn() {} } })
    expect(off.load(off.resolveId('virtual:tauri-electron/main'))).not.toContain('"fork"')
  }, 60000)
})

/** Run a built entry the way Node's fork would (real IPC), returning its first reply. */
async function forkBuilt(dir, entry, message) {
  const child = nodeSpawn(process.execPath, ['--require', path.join(dir, 'bootstrap.cjs'), path.join(dir, entry), 'x'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TAURI_ELECTRON_APP_ROOT: '/app' },
  })
  child.send(message)
  const [reply] = await once(child, 'message')
  child.disconnect()
  await once(child, 'exit')
  return reply
}

describe.each([
  ['webpack', () => require('webpack')],
  ['rspack', () => require('@rspack/core').rspack],
])('the %s fork compiler', (name, load) => {
  it('builds the entries for Node', async () => {
    const bundler = load()
    const dir = tempDir(`tauri-electron-fork-${name}-`)
    // TypeScript through the app's own rule (rspack's built-in SWC loader); webpack gets the JS entry only.
    const entries = name === 'rspack' ? plan.entries : plan.entries.filter((e) => e.file.endsWith('.js'))
    const config = name === 'rspack'
      ? { resolve: { extensions: ['.ts', '.js'] }, module: { rules: [{ test: /\.ts$/, loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' } } } }] } }
      : {}
    await runForkBuild(bundler, forkWebpackConfig({ context: fixture, plan: { entries }, outDir: dir, dev: true, config }))
    const child = fs.readFileSync(path.join(dir, 'src/workers/child.cjs'), 'utf8')
    expect(child).toContain('process.env.TAURI_ELECTRON_APP_ROOT || "") + "/src/workers"')
    expect(await forkBuilt(dir, 'src/workers/child.cjs', 'ping')).toMatchObject({ got: 'ping', argv: ['x'], dirname: '/app/src/workers', connected: true })
    if (name === 'rspack') expect(fs.readFileSync(path.join(dir, 'src/utility.cjs'), 'utf8')).toContain('utility started')
  }, 60000)
})

// --- the child bootstrap over loopback (the Windows transport) -----------------------------------

describe('the child bootstrap over TCP', () => {
  async function overTcp(kind, entry) {
    const token = 'a'.repeat(32)
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const connected = new Promise((resolve) => server.once('connection', resolve))
    const child = nodeSpawn(process.execPath, ['--require', path.join(outDir, 'bootstrap.cjs'), path.join(outDir, entry)], {
      stdio: 'ignore',
      env: { ...process.env, TAURI_ELECTRON_IPC: `${kind}:tcp:${server.address().port}:${token}`, TAURI_ELECTRON_APP_ROOT: '/app' },
    })
    const socket = await connected
    socket.setEncoding('utf8')
    const lines = []
    let pending = ''
    let wake = () => {}
    socket.on('data', (chunk) => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop()
      lines.push(...parts)
      wake()
    })
    const next = async () => {
      while (!lines.length) await new Promise((resolve) => (wake = resolve))
      return lines.shift()
    }
    return { child, socket, next, close: () => server.close() }
  }

  it('gives a utility process process.parentPort', async () => {
    const { encode, decode } = await import('../src/internal/serialize.js')
    const { child, socket, next, close } = await overTcp('utility', 'src/utility.cjs')
    expect(await next()).toBe('a'.repeat(32))
    socket.write(JSON.stringify({ t: 'm', d: encode({ type: 'hello', value: 1 }), p: [] }) + '\n')
    const reply = decode(JSON.parse(await next()).d)
    expect(reply).toMatchObject({ processType: 'utility', dirname: '/app/src', echo: 1 })
    // The main process going away ends the utility process.
    socket.end()
    expect((await once(child, 'exit'))[0]).toBe(0)
    close()
  })

  it("emulates Node's process.send for a forked child", async () => {
    const { child, socket, next, close } = await overTcp('node', 'src/workers/child.cjs')
    expect(await next()).toBe('a'.repeat(32))
    socket.write('"over tcp"\n')
    expect(JSON.parse(await next())).toMatchObject({ got: 'over tcp', connected: true })
    socket.write('"exit"\n') // the child calls process.disconnect()
    expect((await once(child, 'exit'))[0]).toBe(0)
    close()
  })
})

// --- utilityProcess, end to end --------------------------------------------------------------------

describe('utilityProcess.fork', () => {
  it('is exported by electron', () => {
    expect(typeof electronIndex.utilityProcess.fork).toBe('function')
  })

  it('runs the bundled entry with process.parentPort and structured-clone messages', async () => {
    const child = utilityProcess.fork('/src/utility.js', ['--flag'], { stdio: 'pipe' })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    await once(child, 'spawn')
    expect(child.pid).toBeGreaterThan(0)
    const request = state.calls.find((c) => c.command === 'child_spawn').args.options
    expect(request).toMatchObject({ node: true, file: '', stdio: ['ignore', 'pipe', 'pipe'], ipc: { kind: 'utility', fd: 3 } })
    expect(request.args).toEqual(['--require', path.join(outDir, 'bootstrap.cjs'), path.join(outDir, 'src/utility.cjs'), '--flag'])
    expect(request.env.TAURI_ELECTRON_APP_ROOT).toBe(fixture)

    child.postMessage({ type: 'hello', value: new Map([[1, new Uint8Array([7])]]) })
    const [reply] = await once(child, 'message')
    expect(reply).toMatchObject({ reply: 'utility in Node.js', argv: ['--flag'], dirname: `${fixture}/src`, fetch: 'function', processType: 'utility' })
    expect(reply.echo).toBeInstanceOf(Map)
    expect(reply.echo.get(1)).toEqual(new Uint8Array([7]))

    child.postMessage({ type: 'electron-app' })
    expect((await once(child, 'message'))[0].reply).toMatch(/electron\.app is not available in a utility process/)

    const exited = once(child, 'exit')
    child.postMessage({ type: 'exit', value: 3 })
    expect(await exited).toEqual([3])
    expect(out).toContain('utility started')
    expect(child.pid).toBeUndefined()
    expect(child.kill()).toBe(false)
  })

  it('bridges a transferred MessagePortMain both ways and closes it when the child exits', async () => {
    const child = utilityProcess.fork('/src/utility.js')
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ type: 'port' }, [port2])
    expect((await once(child, 'message'))[0]).toEqual({ reply: 'port ready' })
    port1.start()
    const doubled = once(port1, 'message')
    port1.postMessage(21)
    expect((await doubled)[0].data).toBe(42)
    const closed = once(port1, 'close')
    expect(child.kill()).toBe(true)
    expect(await once(child, 'exit')).toEqual([15])
    await closed
    expect(() => child.postMessage('x', [{}])).toThrow(/MessagePortMain/)
  })

  it('validates stdio like Electron and needs the bootstrap', () => {
    expect(() => utilityProcess.fork('/src/utility.js', [], { stdio: ['pipe', 'pipe', 'pipe'] })).toThrow('stdin value other than ignore is not supported.')
    const saved = globalThis.__TAURI_ELECTRON_APP__
    globalThis.__TAURI_ELECTRON_APP__ = { root: fixture, entries: ['src'] }
    try {
      expect(() => utilityProcess.fork('/src/utility.js')).toThrow(expect.objectContaining({ name: 'NotImplementedError', message: expect.stringMatching(/fork bootstrap/) }))
    } finally {
      globalThis.__TAURI_ELECTRON_APP__ = saved
    }
  })

  it('reports a child that cannot start (no Node.js runtime) with an exit', async () => {
    state.scripted = (command) => {
      if (command === 'child_spawn') throw { code: 'ENOENT', errno: -2, syscall: 'spawn node', path: 'node', message: 'no Node.js runtime to fork with: bundle one as a sidecar' }
      return true
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const child = utilityProcess.fork('/src/utility.js')
    const fatal = vi.fn()
    child.on('error', fatal)
    expect(await once(child, 'exit')).toEqual([-2])
    expect(fatal).toHaveBeenCalledWith('FatalError', path.join(outDir, 'src/utility.cjs'), expect.stringMatching(/no Node\.js runtime to fork with/))
    expect(String(errors.mock.calls[0][0])).toMatch(/utilityProcess\.fork/)
    errors.mockRestore()
  })
})

// --- child_process.fork, end to end ----------------------------------------------------------------

describe('child_process.fork', () => {
  it("runs the bundled entry with Node's own IPC channel", async () => {
    const child = cp.fork('/src/workers/child.js', ['a', 'b'], { silent: true })
    expect(child).toBeInstanceOf(cp.ChildProcess)
    expect(child.connected).toBe(true)
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    const order = []
    child.on('disconnect', () => order.push('disconnect'))
    child.on('exit', (code) => order.push(`exit ${code}`))
    const closed = once(child, 'close')
    const sent = vi.fn()
    expect(child.send('hi', sent)).toBe(true)
    const [reply] = await once(child, 'message')
    expect(reply).toEqual({ got: 'hi', argv: ['a', 'b'], dirname: `${fixture}/src/workers`, connected: true })
    expect(sent).toHaveBeenCalledWith(null)
    expect(child.spawnfile).toBe(process.execPath)
    const request = state.calls.find((c) => c.command === 'child_spawn').args.options
    expect(request).toMatchObject({ node: true, stdio: ['pipe', 'pipe', 'pipe'], ipc: { kind: 'node', fd: 3, tcp: false } })
    child.send('exit') // the child disconnects; nothing keeps it alive
    expect(await closed).toEqual([0, null])
    expect(order).toEqual(['disconnect', 'exit 0'])
    expect(child.connected).toBe(false)
    expect(out).toBe('child started\n')
    const late = vi.fn()
    expect(child.send('late', late)).toBe(false)
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_IPC_CHANNEL_CLOSED' })))
  })

  it('keeps many messages in order and disconnects from the parent side', async () => {
    const child = cp.fork('/src/workers/child.js', { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const replies = []
    child.on('message', (message) => replies.push(message.got))
    for (let i = 0; i < 200; i++) child.send(i)
    await vi.waitFor(() => expect(replies).toHaveLength(200), { timeout: 10000 })
    expect(replies).toEqual([...Array(200).keys()])
    // Fewer child_send calls than messages: the queued lines go together.
    expect(state.calls.filter((c) => c.command === 'child_send').length).toBeLessThan(200)
    const disconnected = once(child, 'disconnect')
    child.disconnect()
    expect(child.connected).toBe(false)
    await disconnected
    expect((await once(child, 'exit'))[0]).toBe(0)
  })
})

describe('child_process.fork requests', () => {
  let spawned
  beforeEach(() => {
    spawned = null
    state.scripted = (command, args) => {
      if (command === 'child_spawn') {
        spawned = args
        return { id: 3, pid: 99, file: '/opt/node' }
      }
      return true
    }
  })
  const lines = () => state.calls.filter((c) => c.command === 'child_send').map((c) => c.args.data).join('')

  it('starts the runtime with the bootstrap, the mapped module, execArgv, env and cwd', async () => {
    const child = cp.fork(path.join(fixture, 'src/workers/child.js'), ['x'], { execArgv: ['--no-warnings'], env: { A: '1', B: undefined }, cwd: '/tmp' })
    await once(child, 'spawn')
    expect(spawned.options).toMatchObject({
      file: '',
      node: true,
      cwd: '/tmp',
      stdio: ['inherit', 'inherit', 'inherit'],
      args: ['--no-warnings', '--require', path.join(outDir, 'bootstrap.cjs'), path.join(outDir, 'src/workers/child.cjs'), 'x'],
      env: { A: '1', TAURI_ELECTRON_APP_ROOT: fixture },
    })
    expect(child.spawnargs[0]).toBe('/opt/node')
    // A path the bundler did not build runs as it is (app-relative ones from the app root).
    cp.fork('/src/other.js', { execPath: '/usr/local/bin/node' })
    await vi.waitFor(() => expect(spawned.options.file).toBe('/usr/local/bin/node'))
    expect(spawned.options.args.at(-1)).toBe(path.join(fixture, 'src/other.js'))
  })

  it("rejects what Node's fork rejects or the webview cannot do", () => {
    expect(() => cp.fork('/x.js', { stdio: ['pipe', 'pipe', 'pipe'] })).toThrow(expect.objectContaining({ code: 'ERR_CHILD_PROCESS_IPC_REQUIRED' }))
    expect(() => cp.fork('/x.js', { serialization: 'advanced' })).toThrow(expect.objectContaining({ name: 'NotImplementedError' }))
    expect(() => cp.fork(42)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    const child = cp.fork('/x.js')
    expect(() => child.send(undefined)).toThrow(expect.objectContaining({ code: 'ERR_MISSING_ARGS' }))
    expect(() => child.send('m', {})).toThrow(expect.objectContaining({ name: 'NotImplementedError' }))
  })

  it('sends JSON lines in order, emits messages and keeps Node-internal ones apart', async () => {
    const child = cp.fork('/x.js')
    child.send({ a: 1 })
    child.send('two')
    await vi.waitFor(() => expect(lines()).toBe('{"a":1}\n"two"\n'))
    const messages = []
    const internal = []
    child.on('message', (m) => messages.push(m))
    child.on('internalMessage', (m) => internal.push(m))
    spawned.onEvent.onmessage({ type: 'ipc', lines: ['{"b":2}', 'not json', '{"cmd":"NODE_HANDLE_ACK"}', '[1]'] })
    expect(messages).toEqual([{ b: 2 }, [1]])
    expect(internal).toEqual([{ cmd: 'NODE_HANDLE_ACK' }])
    child.disconnect()
    await vi.waitFor(() => expect(state.calls.at(-1)).toEqual({ command: 'child_disconnect', args: { id: 3 } }))
    const errors = []
    child.on('error', (e) => errors.push(e.code))
    child.disconnect()
    expect(errors).toEqual(['ERR_IPC_DISCONNECTED'])
  })

  it("'close' waits for the IPC channel as well as the exit", async () => {
    const child = cp.fork('/x.js')
    await once(child, 'spawn')
    const close = vi.fn()
    child.on('close', close)
    spawned.onEvent.onmessage({ type: 'exit', code: 0, signal: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(close).not.toHaveBeenCalled()
    spawned.onEvent.onmessage({ type: 'ipc-end' })
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(0, null))
  })

  it("spawn: an 'ipc' stdio entry, and Electron's ELECTRON_RUN_AS_NODE", async () => {
    cp.spawn('node', ['w.js'], { stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ipc'] })
    await vi.waitFor(() => expect(spawned.options.ipc).toEqual({ kind: 'node', fd: 4, tcp: false }))
    expect(spawned.options.node).toBe(false)
    expect(() => cp.spawn('node', [], { stdio: ['ipc', 'pipe', 'pipe'] })).toThrow(/descriptor 3 or higher/)
    expect(() => cp.spawn('node', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc', 'ipc'] })).toThrow(expect.objectContaining({ code: 'ERR_IPC_ONE_PIPE' }))
    const { processInfo } = await import('../src/internal/native.js')
    const execPath = processInfo()?.execPath || globalThis.process.execPath
    const saved = (await import('../src/process.js')).default.execPath
    ;(await import('../src/process.js')).default.execPath = execPath
    try {
      cp.spawn(execPath, ['--inspect', '/src/workers/child.js'], { env: { ELECTRON_RUN_AS_NODE: '1' } })
      await vi.waitFor(() => expect(spawned.options.node).toBe(true))
      expect(spawned.options.args).toEqual(['--inspect', path.join(outDir, 'src/workers/child.cjs')])
    } finally {
      ;(await import('../src/process.js')).default.execPath = saved
    }
  })

  it('explains a missing Node.js runtime', async () => {
    state.scripted = (command) => {
      if (command === 'child_spawn') throw { code: 'ENOENT', errno: -2, syscall: 'spawn node', path: 'node', message: 'no Node.js runtime to fork with: bundle one as a sidecar' }
      return true
    }
    const child = cp.fork('/x.js')
    const [error] = await once(child, 'error')
    expect(error.message).toBe('spawn node ENOENT (no Node.js runtime to fork with: bundle one as a sidecar)')
    expect(child.connected).toBe(false)
  })
})
