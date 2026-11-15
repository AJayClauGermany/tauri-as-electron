import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nodeVm from 'node:vm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker as NodeWorker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Roadmap wave C: C2 (worker_threads on Web Workers) and C4 (vm on iframe
// realms). vm's iframes are faked with Node's own vm contexts (separate
// realms with their own eval and Function). A worker runs the real worker
// side (src/worker/bootstrap.js + runtime.js) in a Node worker thread made
// to look like a dedicated Web Worker (fixtures/web-worker-host.mjs); the
// window's Tauri internals are faked here.
const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const shared = require('../bundler/shared.cjs')

const vm = (await import('../src/node/vm.js')).default
const workerThreads = await import('../src/node/worker-threads.js')
const ports = await import('../src/internal/worker-ports.js')
const { NotImplementedError } = await import('../src/internal/runtime.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A temporary folder, removed when the file's tests are done. */
const temporary = []
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true })
})
const once = (emitter, event) => new Promise((resolve) => emitter.once(event, (...args) => resolve(args)))

// --- vm ---------------------------------------------------------------------------------------------

/** A document whose iframes are Node vm contexts. `locked` is non-configurable on each, like `window.document`. */
function fakeDocument() {
  const frames = []
  return {
    frames,
    createElement: () => ({ style: {}, tabIndex: 0, setAttribute() {}, remove() { this.removed = true } }),
    body: {
      appendChild(frame) {
        const context = nodeVm.createContext({})
        frame.contentWindow = nodeVm.runInContext('globalThis', context)
        Object.defineProperty(frame.contentWindow, 'locked', { value: 'the realm', configurable: false, enumerable: true })
        frames.push(frame)
        return frame
      },
    },
  }
}

describe('vm (C4)', () => {
  let document
  beforeEach(() => {
    document = fakeDocument()
    globalThis.document = document
  })
  afterEach(() => {
    delete globalThis.document
  })

  it('runInNewContext reads and writes the object, and copies created globals back', () => {
    const sandbox = { count: 2, items: [1] }
    const result = vm.runInNewContext('count += 1; items.push(2); var made = "yes"; implicit = count * 10; function twice(n) { return n * 2 } twice(count)', sandbox)
    expect(result).toBe(6)
    expect(sandbox).toMatchObject({ count: 3, made: 'yes', implicit: 30 })
    expect(sandbox.items).toEqual([1, 2])
    expect(sandbox.twice(5)).toBe(10)
    expect(document.frames).toHaveLength(1)
    // A separate realm: its Array is not this one's.
    const array = vm.runInNewContext('[1, 2]')
    expect(array instanceof Array).toBe(false)
    expect(Array.isArray(array)).toBe(true)
    expect(vm.runInNewContext('typeof outerOnly', {})).toBe('undefined')
  })

  it('keeps a context between runs: live object properties, let/const/class, deletions', () => {
    const context = vm.createContext({ base: 5 })
    expect(vm.isContext(context)).toBe(true)
    expect(vm.isContext({})).toBe(false)
    expect(() => vm.isContext(1)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    expect(vm.createContext(context)).toBe(context)
    vm.runInContext('let counter = base; const fixed = 1; class Point { constructor() { this.x = counter } }', context)
    expect(vm.runInContext('counter += 1; counter + fixed', context)).toBe(7)
    expect(vm.runInContext('new Point().x', context)).toBe(6)
    context.base = 100
    expect(vm.runInContext('base', context)).toBe(100)
    vm.runInContext('globalThis.later = 1; delete base', context)
    expect(context.later).toBe(1)
    expect('base' in context).toBe(false)
    delete context.later
    expect(vm.runInContext('typeof later', context)).toBe('undefined')
    expect(() => vm.runInContext('1', {})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
  })

  it('shadows globals the realm will not let go (window, document, …) with a scope', () => {
    expect(vm.runInNewContext('locked')).toBe('the realm')
    expect(vm.runInNewContext('locked + "!"', { locked: 'mine' })).toBe('mine!')
    const sandbox = { locked: 1 }
    vm.runInNewContext('locked = 2', sandbox)
    expect(sandbox.locked).toBe(2)
  })

  it('Script: syntax checked when created, run anywhere, cached data reported unused', () => {
    expect(() => new vm.Script('this is ( not code')).toThrow(SyntaxError)
    const script = new vm.Script('value * 2', { filename: 'double.js' })
    expect(script.runInNewContext({ value: 4 })).toBe(8)
    expect(script.runInContext(vm.createContext({ value: 5 }))).toBe(10)
    globalThis.wavecValue = 21
    expect(new vm.Script('wavecValue * 2').runInThisContext()).toBe(42)
    delete globalThis.wavecValue
    expect(new vm.Script('#!/usr/bin/env node\n1 + 1').runInThisContext()).toBe(2)
    const cached = new vm.Script('1', { cachedData: new Uint8Array(4), produceCachedData: true })
    expect(cached.cachedDataRejected).toBe(true)
    expect(cached.createCachedData().length).toBe(0)
    expect(new vm.Script('1\n//# sourceMappingURL=a.js.map').sourceMapURL).toBe('a.js.map')
  })

  it('runInThisContext keeps top-level let / const / class in the page, like a Script', () => {
    vm.runInThisContext('let wavecLet = 1; const wavecRe = /[{]/.test("{") ? 2 : 0; class WavecClass { m() { return `${wavecLet}}` } }')
    expect(vm.runInThisContext('wavecLet + wavecRe')).toBe(3)
    expect(vm.runInThisContext('new WavecClass().m()')).toBe('1}')
    // Strict-mode code keeps its declarations to itself, as eval does.
    expect(vm.runInThisContext('"use strict"; let wavecStrict = 1; wavecStrict')).toBe(1)
    expect(vm.runInThisContext('typeof wavecStrict')).toBe('undefined')
    // Declarations inside blocks and loops are left alone.
    expect(vm.runInThisContext('for (let i = 0; i < 2; i++) {} { let wavecBlock = 1 } typeof wavecBlock')).toBe('undefined')
  })

  it('compileFunction: parameters, context extensions, a parsing context', () => {
    expect(vm.compileFunction('return a + b', ['a', 'b'])(1, 2)).toBe(3)
    expect(vm.compileFunction('return a + b + c + d', ['a', 'b'], { contextExtensions: [{ c: 10 }, { d: 100 }] })(1, 2)).toBe(113)
    const context = vm.createContext({ base: 7 })
    const fn = vm.compileFunction('return base * 2', [], { parsingContext: context })
    expect(fn()).toBe(14)
    expect(fn instanceof Function).toBe(false) // made in the context's realm
  })

  it('names the file in stack traces and ignores `timeout` with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let error
    try {
      vm.runInNewContext('throw new Error("boom")', {}, { filename: 'wave-c.vm.js', timeout: 10 })
    } catch (e) {
      error = e
    }
    expect(error.message).toBe('boom')
    expect(error instanceof Error).toBe(false) // another realm's Error, as in Node
    expect(warn.mock.calls.flat().join(' ')).toMatch(/timeout/)
    warn.mockRestore()
  })

  it("names the file in JavaScriptCore's location-less eval frames", () => {
    const context = vm.createContext({})
    document.frames[0].contentWindow.eval = () => {
      const error = new Error('jsc')
      error.stack = 'inner@\neval code@\neval@[native code]\nrunInContext@tauri://localhost/assets/a.js:1:2'
      error.line = 3
      error.column = 4
      throw error
    }
    let error
    try {
      vm.runInContext('x', context, { filename: 'script.js' })
    } catch (e) {
      error = e
    }
    expect(error.stack).toBe('inner@script.js:3:4\neval code@script.js\neval@[native code]\nrunInContext@tauri://localhost/assets/a.js:1:2')
  })

  it('explains a Content-Security-Policy without unsafe-eval, and that workers have no contexts', () => {
    const context = vm.createContext({})
    document.frames[0].contentWindow.eval = () => {
      throw new EvalError('Refused to evaluate a string as JavaScript')
    }
    expect(() => vm.runInContext('1', context)).toThrow(/unsafe-eval/)
    delete globalThis.document
    expect(() => vm.createContext({})).toThrow(NotImplementedError)
    expect(vm.runInThisContext('1 + 1')).toBe(2)
  })

  it('DONT_CONTEXTIFY returns the context global itself; vm modules are unsupported', () => {
    const global = vm.createContext(vm.constants.DONT_CONTEXTIFY)
    vm.runInContext('var x = 4', global)
    expect(global.x).toBe(4)
    expect(() => new vm.SourceTextModule('export default 1')).toThrow(NotImplementedError)
  })
})

// --- MessagePort / MessageChannel ------------------------------------------------------------------

describe('worker_threads ports (C2)', () => {
  it('queue messages until a listener, deliver values, and close both ends', async () => {
    const { port1, port2 } = new ports.MessageChannel()
    expect(port1).toBeInstanceOf(workerThreads.MessagePort)
    port2.postMessage({ n: 1 })
    port2.postMessage({ n: 2 })
    await sleep(20)
    const received = []
    port1.on('message', (value) => received.push(value))
    await sleep(20)
    expect(received).toEqual([{ n: 1 }, { n: 2 }])
    const closed = Promise.all([once(port1, 'close'), once(port2, 'close')])
    port2.close()
    await closed
  })

  it('receiveMessageOnPort takes a waiting message synchronously', async () => {
    const { port1, port2 } = new ports.MessageChannel()
    port2.postMessage('first')
    port2.postMessage('second')
    await sleep(20)
    expect(ports.receiveMessageOnPort(port1)).toEqual({ message: 'first' })
    expect(ports.receiveMessageOnPort(port1)).toEqual({ message: 'second' })
    expect(ports.receiveMessageOnPort(port1)).toBeUndefined()
    expect(() => ports.receiveMessageOnPort({})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    port1.close()
  })

  it('transfers ports inside messages and wraps them on arrival', async () => {
    const outer = new ports.MessageChannel()
    const inner = new ports.MessageChannel()
    const arrived = once(outer.port1, 'message')
    outer.port2.postMessage({ nested: [inner.port2] }, [inner.port2])
    const [{ nested }] = await arrived
    expect(nested[0]).toBeInstanceOf(workerThreads.MessagePort)
    expect(nested[0]).not.toBe(inner.port2)
    expect(inner.port2.postMessage('ignored')).toBeUndefined() // detached here
    const echoed = once(inner.port1, 'message')
    nested[0].postMessage('through the transferred port')
    expect((await echoed)[0]).toBe('through the transferred port')
    expect(() => outer.port2.postMessage(1, [outer.port2])).toThrow(/source port/)
    const buffer = new ArrayBuffer(4)
    workerThreads.markAsUntransferable(buffer)
    expect(workerThreads.isMarkedAsUntransferable(buffer)).toBe(true)
    expect(() => outer.port2.postMessage(buffer, [buffer])).toThrow(/untransferable/)
    for (const port of [outer.port1, outer.port2, inner.port1, nested[0]]) port.close()
  })

  it('has the EventTarget side too (addEventListener, onmessage) and counts active ports', async () => {
    const { port1, port2 } = new ports.MessageChannel()
    const before = ports.activePortCount()
    const events = []
    port1.onmessage = (event) => events.push(['onmessage', event.data])
    const listener = (event) => events.push(['listener', event.data])
    port1.addEventListener('message', listener)
    await sleep(0)
    expect(ports.activePortCount()).toBe(before + 1)
    port1.unref()
    expect(ports.activePortCount()).toBe(before)
    expect(port1.hasRef()).toBe(false)
    port1.ref()
    port2.postMessage('x')
    await sleep(20)
    expect(events).toEqual([['onmessage', 'x'], ['listener', 'x']])
    port1.removeEventListener('message', listener)
    port1.onmessage = null
    expect(ports.activePortCount()).toBe(before)
    expect(() => new workerThreads.MessagePort()).toThrow(TypeError)
    port1.close()
  })

  it('environment data and the main thread view', () => {
    expect(workerThreads.isMainThread).toBe(true)
    expect(workerThreads.parentPort).toBeNull()
    expect(workerThreads.workerData).toBeNull()
    expect(workerThreads.threadId).toBe(0)
    workerThreads.setEnvironmentData('k', { v: 1 })
    expect(workerThreads.getEnvironmentData('k')).toEqual({ v: 1 })
    workerThreads.setEnvironmentData('k', undefined)
    expect(workerThreads.getEnvironmentData('k')).toBeUndefined()
    expect(typeof workerThreads.BroadcastChannel.prototype.unref).toBe('function')
  })
})

describe('worker script paths', () => {
  const { workerScriptPath } = workerThreads
  it('accepts what Node accepts, as project paths', () => {
    expect(workerScriptPath('/src/worker.js')).toBe('/src/worker.js')
    expect(workerScriptPath('./src/./a/../worker.js')).toBe('/src/worker.js')
    expect(workerScriptPath(new URL('file:///src/worker.js'))).toBe('/src/worker.js')
    expect(workerScriptPath('file:///C:/app/worker.js')).toBe('C:/app/worker.js')
    expect(() => workerScriptPath('worker.js')).toThrow(expect.objectContaining({ code: 'ERR_WORKER_PATH' }))
    expect(() => workerScriptPath(42)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    expect(() => workerScriptPath('https://example.com/w.js')).toThrow(expect.objectContaining({ code: 'ERR_WORKER_PATH' }))
  })
})

// --- Worker, end to end ------------------------------------------------------------------------------

const HOST = path.join(here, 'fixtures', 'web-worker-host.mjs')
const ENTRIES = ['/echo.mjs', '/once.mjs']

/** The DOM Worker the window would create: the host harness in a Node worker thread. */
class FakeWebWorker extends EventTarget {
  constructor() {
    super()
    this.node = new NodeWorker(HOST, { workerData: { entries: ENTRIES } })
    this.node.on('message', (message) => {
      if (message.closed) return
      this.dispatchEvent(new MessageEvent('message', { data: message.data, ports: message.ports }))
    })
    this.node.on('error', (error) => {
      const event = new Event('error')
      event.error = error
      event.message = error.message
      this.dispatchEvent(event)
    })
    FakeWebWorker.all.add(this)
  }
  postMessage(data, transfer = []) {
    this.node.postMessage({ data, ports: transfer.filter((t) => t instanceof MessagePort) }, transfer)
  }
  terminate() {
    this.node.terminate()
  }
}
FakeWebWorker.all = new Set()

/** The window's Tauri internals: commands answered by `onInvoke`, callbacks kept in `callbacks`. */
const tauri = {
  calls: [],
  callbacks: new Map(),
  next: 1,
  onInvoke: null,
}

function installWindow() {
  globalThis.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'electron-main' }, currentWebview: { label: 'electron-main' } },
    plugins: { path: { sep: '/' } },
    convertFileSrc: (file, protocol = 'asset') => `${protocol}://localhost/${encodeURIComponent(file)}`,
    transformCallback(callback) {
      const id = tauri.next++
      tauri.callbacks.set(id, callback)
      return id
    },
    unregisterCallback(id) {
      tauri.callbacks.delete(id)
    },
    async invoke(cmd, args, options) {
      tauri.calls.push({ cmd, args, options })
      return tauri.onInvoke?.(cmd, args)
    },
  }
  globalThis.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: 'linux', arch: 'x86_64', eol: '\n', version: '6', family: 'unix', os_type: 'linux', exe_extension: '' }
  globalThis.__TAURI_ELECTRON_WORKERS__ = { url: null, type: 'module', entries: ENTRIES, aliases: { '/echo.js': '/echo.mjs' }, dev: false, create: () => new FakeWebWorker() }
}

/** A Worker of the echo fixture; `call(op, args)` asks it something. */
function echoWorker(options) {
  const worker = new workerThreads.Worker('/echo.js', options)
  const pending = new Map()
  let id = 1
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.on('message', (message) => {
      if (message?.ready) return resolve()
      const entry = pending.get(message?.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new Error(message.error))
    })
  })
  const call = (op, args, transfer) =>
    new Promise((resolve, reject) => {
      const n = id++
      pending.set(n, { resolve, reject })
      worker.postMessage({ id: n, op, args }, transfer)
    })
  return { worker, ready, call }
}

describe('Worker (C2), end to end', () => {
  beforeEach(() => {
    installWindow()
    tauri.calls = []
    tauri.callbacks.clear()
    tauri.onInvoke = null
  })
  afterEach(() => {
    delete globalThis.__TAURI_ELECTRON_WORKERS__
  })
  afterAll(async () => {
    for (const fake of FakeWebWorker.all) await fake.node.terminate()
    delete globalThis.__TAURI_INTERNALS__
    delete globalThis.__TAURI_OS_PLUGIN_INTERNALS__
  })

  it('starts a worker with workerData, env, argv and environment data', async () => {
    workerThreads.setEnvironmentData('answer', 42)
    const online = vi.fn()
    const { worker, ready, call } = echoWorker({
      workerData: { text: 'hi', bytes: new Uint8Array([1, 2]), map: new Map([['a', 1]]), when: new Date(5) },
      env: { HARNESS: 'yes' },
      argv: ['one', 2],
    })
    worker.on('online', online)
    await ready
    workerThreads.setEnvironmentData('answer', undefined)
    const hello = await call('hello')
    expect(hello).toMatchObject({ isMainThread: false, threadId: worker.threadId, env: 'yes', argv: ['one', '2'], environment: 42, hasRequire: true, bufferGlobal: true })
    expect(hello.workerData.bytes).toEqual(new Uint8Array([1, 2]))
    expect(hello.workerData.map.get('a')).toBe(1)
    expect(hello.workerData.when.getTime()).toBe(5)
    expect(online).toHaveBeenCalledTimes(1)
    const exit = once(worker, 'exit')
    expect(await worker.terminate()).toBe(1)
    expect((await exit)[0]).toBe(1)
    expect(worker.threadId).toBe(-1) // as in Node, once exited
  }, 20000)

  it('reaches the synchronous bridge with the window URL, and relays commands and Channels', async () => {
    tauri.onInvoke = (cmd, args) => {
      if (cmd === 'plugin:electron|node_fs') {
        const length = new DataView(args.buffer, args.byteOffset).getUint32(0, true)
        const header = JSON.parse(new TextDecoder().decode(args.subarray(4, 4 + length)))
        expect(header).toEqual({ op: 'read', args: { path: '/tmp/wave-c.txt' } })
        return new TextEncoder().encode('from the window')
      }
      if (cmd === 'plugin:test|stream') {
        const id = Number(/^__CHANNEL__:(\d+)$/.exec(args.onEvent)[1])
        const send = tauri.callbacks.get(id)
        setTimeout(() => {
          send({ index: 1, message: 'second' })
          send({ index: 0, message: 'first' })
          send({ index: 2, end: true })
        }, 5)
        return null
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const { worker, ready, call } = echoWorker()
    await ready
    expect(await call('hostname')).toBe('harness-host')
    expect((await call('bridgeRequests'))[0]).toMatch(/^tauri-electron:\/\/localhost\/node%2Fos%2Finfo\?a=/)
    expect(await call('readAsync', { file: '/tmp/wave-c.txt' })).toBe('from the window')
    expect(await call('stream')).toEqual(['first', 'second'])
    // The worker's Channel ended: its relay callback in the window is gone too.
    await sleep(50)
    expect(tauri.callbacks.size).toBe(0)
    expect(tauri.calls.map((c) => c.cmd)).toEqual(['plugin:electron|node_fs', 'plugin:test|stream'])
    await worker.terminate()
  }, 20000)

  it('passes MessagePorts both ways and forwards console output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { worker, ready, call } = echoWorker({ stdout: true })
    await ready
    const { port1, port2 } = new workerThreads.MessageChannel()
    expect(await call('port', { port: port2 }, [port2])).toBe('listening')
    const reply = once(port1, 'message')
    port1.postMessage(7)
    expect((await reply)[0]).toEqual({ echoed: 7 })
    port1.close()
    let out = ''
    worker.stdout.on('data', (chunk) => (out += chunk))
    await call('log', { text: 'hello' })
    await sleep(50)
    expect(out).toBe('hello\n') // stdout: true → the stream only
    expect(log).not.toHaveBeenCalledWith('hello')
    expect(error).toHaveBeenCalledWith('err:hello') // stderr not asked for → this thread's console
    log.mockRestore()
    error.mockRestore()
    await worker.terminate()
  }, 20000)

  it("ends on process.exit(code), on an uncaught error ('error' then 'exit' 1), and by itself", async () => {
    const exiting = echoWorker()
    await exiting.ready
    const exitCode = once(exiting.worker, 'exit')
    exiting.worker.postMessage({ id: 0, op: 'exit', args: { code: 3 } })
    expect((await exitCode)[0]).toBe(3)

    const failing = echoWorker()
    await failing.ready
    const order = []
    failing.worker.on('error', (e) => order.push(['error', e.message]))
    const failed = once(failing.worker, 'exit')
    await failing.call('throwLater', { message: 'boom' })
    order.push(['exit', (await failed)[0]])
    expect(order).toEqual([['error', 'boom'], ['exit', 1]])

    const lone = new workerThreads.Worker('/once.mjs', { workerData: 4 })
    const message = once(lone, 'message')
    const ended = once(lone, 'exit')
    expect((await message)[0]).toEqual({ doubled: 8 })
    expect((await ended)[0]).toBe(0)
  }, 20000)

  it('stays alive while parentPort has a listener, ends once it has none', async () => {
    const { worker, ready, call } = echoWorker()
    await ready
    const exited = vi.fn()
    worker.on('exit', exited)
    await sleep(300)
    expect(exited).not.toHaveBeenCalled()
    await call('stop')
    await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(0), { timeout: 5000 })
  }, 20000)

  it('runs eval: true code as CommonJS with require()', async () => {
    const worker = new workerThreads.Worker("const { parentPort, workerData } = require('worker_threads'); parentPort.postMessage([workerData, __filename, typeof module.exports])", { eval: true, workerData: 'data' })
    const [value] = await once(worker, 'message')
    expect(value).toEqual(['data', '[worker eval]', 'object'])
    expect((await once(worker, 'exit'))[0]).toBe(0)
  }, 20000)

  it("reports scripts that were not bundled, and a missing worker runtime", async () => {
    const worker = new workerThreads.Worker('/not-bundled.js')
    const [error] = await once(worker, 'error')
    expect(error.code).toBe('ERR_MODULE_NOT_FOUND')
    expect(error.message).toMatch(/workers` option/)
    delete globalThis.__TAURI_ELECTRON_WORKERS__
    expect(() => new workerThreads.Worker('/echo.mjs')).toThrow(NotImplementedError)
  })
})

// --- the bundler plugins ---------------------------------------------------------------------------

function tempProject(files) {
  const root = tempDir('wave-c-workers-')
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

describe('finding worker scripts', () => {
  const root = tempProject({
    'src/main.js': [
      "const { Worker: NodeWorker } = require('node:worker_threads')",
      "import { Worker } from 'worker_threads'",
      "const workerPath = path.join(__dirname, 'workers', 'c.mjs')",
      "new Worker(path.join(__dirname, 'a.js'), { workerData: 1 })",
      "new NodeWorker(path.resolve(import.meta.dirname, 'b.js'))",
      'new Worker(workerPath)',
      "new Worker(new URL('./d.js', import.meta.url), { type: 'module' })",
      'new Worker(`${__dirname}/e.js`)',
      "new Worker(require.resolve('./a'))",
      "new Worker(someFunction(), {})",
      "new Worker('console.log(1)', { eval: true })",
      "new Worker('./src/a.js')",
    ].join('\n'),
    'src/a.js': '',
    'src/b.ts': '',
    'src/workers/c.mjs': '',
    'src/d.js': '',
    'src/e.js': '',
    'src/web.js': "new Worker(new URL('./d.js', import.meta.url))", // a Web Worker: no worker_threads here
    'node_modules/dep/index.js': "require('worker_threads'); new Worker(path.join(__dirname, 'w.js'))",
  })

  it('collects static script paths of new Worker(...) in files using worker_threads', () => {
    const found = shared.workerThreads(root, undefined)
    expect(found.entries.map((e) => e.path).sort()).toEqual(['/src/a.js', '/src/b.ts', '/src/d.js', '/src/e.js', '/src/workers/c.mjs'])
    expect(found.entries.find((e) => e.path === '/src/b.ts').file).toBe(path.join(root, 'src/b.ts'))
    expect(found.aliases).toEqual({ '/src/b.js': '/src/b.ts', '/src/a': '/src/a.js' })
  })

  it('honours the workers option', () => {
    expect(shared.workerThreads(root, false)).toBeNull()
    expect(shared.workerThreads(root, ['src/e.js']).entries.some((e) => e.path === '/src/e.js')).toBe(true)
    const empty = tempProject({ 'src/main.js': 'console.log(1)' })
    expect(shared.workerThreads(empty, undefined)).toBeNull()
    expect(shared.workerThreads(empty, true)).toEqual({ entries: [], aliases: {} })
    // Using worker_threads at all (eval workers) builds the runtime, even without scripts.
    const evalOnly = tempProject({ 'src/main.js': "const { Worker } = require('worker_threads'); new Worker('1', { eval: true })" })
    expect(shared.workerThreads(evalOnly, undefined)).toEqual({ entries: [], aliases: {} })
  })

  it('rewrites new URL(…, import.meta.url) and require.resolve(…) worker paths to project paths', () => {
    const file = path.join(root, 'src/main.js')
    const code = "const { Worker } = require('worker_threads'); new Worker(new URL('./d.js', import.meta.url), {}); new Worker(require.resolve('./a'))"
    expect(shared.rewriteWorkerUrls(code, file, root)).toBe(
      `const { Worker } = require('worker_threads'); new Worker(new URL("file:///src/d.js"), {}); new Worker("/src/a")`,
    )
    const web = "new Worker(new URL('./d.js', import.meta.url))"
    expect(shared.rewriteWorkerUrls(web, file, root)).toBe(web)
  })

  it('generates the lazy entries module of the worker bundle', () => {
    const source = shared.workerEntriesSource([{ path: '/src/a.js', file: path.join(root, 'src/a.js') }])
    expect(source).toContain(`"/src/a.js": () => import(${JSON.stringify(path.join(root, 'src/a.js').split(path.sep).join('/'))})`)
    expect(source).not.toMatch(/^import /m)
  })
})

describe('Vite plugin: worker threads', () => {
  const tauriElectron = async () => (await import('../vite.js')).default
  const fixture = path.join(here, 'fixtures', 'worker-app')

  async function hooks(options, { dev = false } = {}) {
    const p = (await tauriElectron())({ rendererNode: false, ...options })
    const config = p.config({ root: fixture })
    p.configResolved({ root: fixture, command: dev ? 'serve' : 'build', worker: { format: 'iife' } })
    return { p, config }
  }

  it('registers the worker bundle on the main page and lists the scripts', async () => {
    const { p, config } = await hooks({})
    expect(typeof config.worker.plugins).toBe('function')
    expect(config.worker.plugins()[0]).toMatchObject({ name: 'tauri-electron:worker', enforce: 'pre' })
    const main = p.load(p.resolveId('virtual:tauri-electron/main'))
    expect(main).toContain('import "virtual:tauri-electron/workers"')
    const registry = p.load(p.resolveId('virtual:tauri-electron/workers'))
    expect(registry).toMatch(/import url from ".*bundler\/worker-entry\.js\?worker&url"/)
    expect(registry).toContain('"type":"classic"')
    expect(registry).toMatch(/"entries":\["\/src\/(?:url-)?worker\.js","\/src\/(?:url-)?worker\.js"\]/)
    const entries = p.load(path.join(path.dirname(require.resolve('../vite.js')), 'bundler', 'worker-entries.js'))
    expect(entries).toContain('"/src/worker.js": () => import(')
  })

  it('in dev, loads any project file by URL', async () => {
    const { p } = await hooks({}, { dev: true })
    const registry = p.load(p.resolveId('virtual:tauri-electron/workers'))
    expect(registry).toMatch(/import url from "\/@fs\/.*worker-entry\.js\?worker&url"/)
    expect(registry).toContain('"entries":null')
    expect(registry).toContain('"type":"module"')
    const entries = p.load(path.join(path.dirname(require.resolve('../vite.js')), 'bundler', 'worker-entries.js'))
    expect(entries).toContain('self.location.origin')
  })

  it('leaves apps without worker threads alone', async () => {
    const { p } = await hooks({ workers: false })
    expect(p.load(p.resolveId('virtual:tauri-electron/main'))).not.toContain('workers')
  })

  it('builds a worker bundle with the Node layer and the scripts as lazy chunks', async () => {
    const { build } = await import('vite')
    const outDir = tempDir('wave-c-vite-')
    await build({ root: fixture, logLevel: 'silent', configFile: false, plugins: [(await tauriElectron())({ rendererNode: false })], build: { outDir, emptyOutDir: true, minify: false } })
    const assets = fs.readdirSync(path.join(outDir, 'assets'))
    const workerFile = assets.find((f) => f.startsWith('worker-entry'))
    expect(workerFile).toBeDefined()
    const worker = fs.readFileSync(path.join(outDir, 'assets', workerFile), 'utf8')
    expect(worker).toContain('WORKER_SCRIPT_MARKER')
    expect(worker).toContain('URL_WORKER_MARKER')
    expect(worker).toContain('this worker script was not bundled') // the worker runtime (and the Node layer) is in it
    const main = assets.filter((f) => f.endsWith('.js') && f !== workerFile).map((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8')).join('\n')
    expect(main).toContain(workerFile)
    expect(main).toMatch(/[`"]\/src\/worker\.js[`"]/)
    expect(main).toContain('file:///src/url-worker.js') // not a Vite Web Worker
    expect(main).not.toContain('WORKER_SCRIPT_MARKER')
  }, 60000)
})

describe.each([
  ['webpack', () => require('webpack')],
  ['rspack', () => require('@rspack/core').rspack],
])('TauriElectronPlugin with %s: worker threads', (name, load) => {
  const fixture = path.join(here, 'fixtures', 'worker-app')
  it('emits the worker bundle with the scripts and registers it on the main page', async () => {
    const { TauriElectronPlugin } = require('../webpack.cjs')
    const outDir = tempDir(`wave-c-${name}-`)
    const stats = await new Promise((resolve, reject) =>
      load()(
        { mode: 'development', devtool: false, context: fixture, target: 'electron-main', output: { path: outDir, publicPath: '/' }, plugins: [new TauriElectronPlugin({ main: './src/main.js' })], infrastructureLogging: { level: 'error' } },
        (error, result) => (error ? reject(error) : result.hasErrors() ? reject(new Error(result.toString({ all: false, errors: true }))) : resolve(result)),
      ),
    )
    expect(stats.hasErrors()).toBe(false)
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.js'))
    const all = files.map((f) => [f, fs.readFileSync(path.join(outDir, f), 'utf8')])
    const main = all.find(([f]) => f === 'electron-main.js')[1]
    expect(main).toContain('__TAURI_ELECTRON_WORKERS__')
    expect(main).toContain('"/src/worker.js"')
    expect(main).toContain('file:///src/url-worker.js')
    expect(main).not.toContain('WORKER_SCRIPT_MARKER')
    // The worker bundle and its lazy chunks hold the scripts and the Node layer.
    const workerSide = all.filter(([f]) => f !== 'electron-main.js').map(([, code]) => code).join('\n')
    expect(workerSide).toContain('WORKER_SCRIPT_MARKER')
    expect(workerSide).toContain('URL_WORKER_MARKER')
    expect(workerSide).toContain('this worker script was not bundled')
  }, 60000)
})
