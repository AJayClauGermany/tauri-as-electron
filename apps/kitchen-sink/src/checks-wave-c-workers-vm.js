// Checks for roadmap wave C items C2 (worker_threads) and C4 (vm). Same
// shape as checks.js and, like it, runs unchanged on Electron and on Tauri.
// The worker scripts are in ./workers/; on Tauri the bundler plugin finds
// them in the `new Worker(...)` calls below and bundles them with the Node layer.
import { BrowserWindow } from 'electron'
import { Worker, MessageChannel, BroadcastChannel, isMainThread, receiveMessageOnPort, setEnvironmentData } from 'node:worker_threads'
import vm from 'node:vm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const isElectron = Boolean(process.versions.electron)
const dirname = import.meta.dirname

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, what, ms = 15000) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)
    }),
  ])
}

/** The next `event` of `emitter` (its arguments), or a timeout. */
const next = (emitter, event, what = event) => withTimeout(new Promise((resolve) => emitter.once(event, (...args) => resolve(args))), what)

/** Starts ./workers/kitchen-worker.js; `call(op, args)` asks it something. */
function kitchenWorker(options) {
  const worker = new Worker(new URL('./workers/kitchen-worker.js', import.meta.url), options)
  const pending = new Map()
  let nextId = 1
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
    withTimeout(
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, op, args }, transfer)
      }),
      `worker ${op}`,
    )
  return { worker, ready: withTimeout(ready, 'worker ready'), call }
}

/** Opens child.html in a hidden window with `webPreferences`, runs `fn`, always closes it. */
async function withWindow(webPreferences, fn) {
  const win = new BrowserWindow({ show: false, width: 360, height: 240, webPreferences })
  try {
    const loaded = next(win.webContents, 'did-finish-load', 'window load')
    win.loadFile(path.join(dirname, '..', 'child.html'))
    await loaded
    return await fn(win)
  } finally {
    win.destroy()
  }
}

export const waveCWorkersVmChecks = [
  // --- C2: worker_threads --------------------------------------------------------------------------
  { id: 'worker_threads: Worker, workerData, parentPort, env, argv, terminate()', run: async () => {
    assert(isMainThread === true, 'isMainThread in the main process')
    setEnvironmentData('kitchen', 42)
    const online = []
    const { worker, ready, call } = kitchenWorker({
      workerData: { greeting: 'hi', bytes: new Uint8Array([1, 2, 3]), when: new Date(0), map: new Map([['a', 1]]) },
      env: { KITCHEN_WORKER: 'yes' },
      argv: ['one', 'two'],
    })
    worker.on('online', () => online.push('online'))
    try {
      await ready
      const hello = await call('hello')
      assert(hello.isMainThread === false, 'isMainThread in the worker')
      assert(hello.threadId === worker.threadId && worker.threadId > 0, `threadId ${hello.threadId} / ${worker.threadId}`)
      const data = hello.workerData
      assert(data.greeting === 'hi' && data.bytes instanceof Uint8Array && data.bytes[2] === 3, 'workerData (structured clone)')
      assert(data.when instanceof Date && data.map instanceof Map && data.map.get('a') === 1, 'workerData Date / Map')
      assert(hello.env === 'yes', `env ${hello.env}`)
      assert(hello.argv.join() === 'one,two', `argv ${hello.argv}`)
      assert(hello.environment === 42, `getEnvironmentData ${hello.environment}`)
      assert(online.length === 1, "'online' emitted")
    } finally {
      setEnvironmentData('kitchen', undefined)
      const exited = next(worker, 'exit')
      const code = await worker.terminate()
      assert(code === 1, `terminate() resolves 1, got ${code}`)
      assert((await exited)[0] === 1, "'exit' 1")
    }
    return `threadId ${worker.threadId}`
  } },

  { id: 'worker_threads: Node built-ins in a worker (fs, os, crypto, Buffer, child_process)', run: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-worker-'))
    const file = path.join(dir, 'from-main.txt')
    fs.writeFileSync(file, 'written by main')
    const { worker, ready, call } = kitchenWorker()
    try {
      await ready
      assert((await call('readSync', { file })) === 'written by main', 'fs.readFileSync (synchronous bridge)')
      assert((await call('readAsync', { file })) === 'written by main', 'fs.promises.readFile (relayed command)')
      const other = path.join(dir, 'from-worker.txt')
      assert((await call('writeSync', { file: other, text: 'written by the worker' })) === 'written', 'fs.writeFileSync')
      assert(fs.readFileSync(other, 'utf8') === 'written by the worker', 'the main process reads what the worker wrote')
      assert((await call('hostname')) === os.hostname(), 'os.hostname')
      assert((await call('hash', { text: 'kitchen' })) === crypto.createHash('sha256').update('kitchen').digest('hex'), 'crypto.createHash')
      assert((await call('base64', { text: 'hey' })) === 'aGV5', 'Buffer')
      const echoed = await call('exec')
      assert(echoed === 'kitchen', `child_process.exec (relayed Channel): ${echoed}`)
      return 'fs sync + async, os, crypto, Buffer, child_process'
    } finally {
      await worker.terminate()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } },

  { id: 'worker_threads: MessageChannel ports, transferList, receiveMessageOnPort, BroadcastChannel', run: async () => {
    const { worker, ready, call } = kitchenWorker()
    try {
      await ready
      const { port1, port2 } = new MessageChannel()
      assert((await call('port', { port: port2 }, [port2])) === 'listening', 'port transferred')
      const reply = next(port1, 'message', 'port reply')
      port1.postMessage({ n: 7 })
      const [echoed] = await reply
      assert(echoed?.echoed?.n === 7, `echo over the port: ${JSON.stringify(echoed)}`)
      const closed = next(port1, 'close', 'port close')
      port1.close()
      await closed

      const local = new MessageChannel()
      local.port2.postMessage('queued')
      await sleep(50)
      const received = receiveMessageOnPort(local.port1)
      assert(received?.message === 'queued', `receiveMessageOnPort: ${JSON.stringify(received)}`)
      assert(receiveMessageOnPort(local.port1) === undefined, 'nothing left')
      local.port1.close()

      const a = new BroadcastChannel('kitchen-wave-c')
      const b = new BroadcastChannel('kitchen-wave-c')
      const heard = new Promise((resolve) => (b.onmessage = (event) => resolve(event.data)))
      a.postMessage('broadcast')
      assert((await withTimeout(heard, 'broadcast')) === 'broadcast', 'BroadcastChannel')
      a.close()
      b.close()
      return 'ok'
    } finally {
      await worker.terminate()
    }
  } },

  { id: 'worker_threads: eval, process.exit, uncaught errors, ending by itself, stdout', run: async () => {
    // eval: true runs CommonJS with require().
    const evaluated = new Worker(
      "const { parentPort, workerData } = require('worker_threads'); parentPort.postMessage({ platform: require('os').platform(), doubled: workerData * 2 })",
      { eval: true, workerData: 21 },
    )
    const evalExit = next(evaluated, 'exit', 'eval worker exit')
    const [fromEval] = await next(evaluated, 'message', 'eval worker message')
    assert(fromEval.doubled === 42 && fromEval.platform === process.platform, JSON.stringify(fromEval))
    assert((await evalExit)[0] === 0, 'the eval worker ends by itself with 0')

    // A worker with nothing left to do ends by itself ('exit' 0).
    const once = new Worker(path.join(dirname, 'workers', 'kitchen-once-worker.js'), { workerData: 5 })
    const onceExit = next(once, 'exit', 'once worker exit')
    const [fromOnce] = await next(once, 'message', 'once worker message')
    assert(fromOnce.doubled === 10, JSON.stringify(fromOnce))
    assert((await onceExit)[0] === 0, 'ends with 0')

    // process.exit(code) ends the worker only.
    const exiting = kitchenWorker()
    await exiting.ready
    const exitCode = next(exiting.worker, 'exit', 'process.exit')
    exiting.worker.postMessage({ id: 0, op: 'exit', args: { code: 7 } })
    assert((await exitCode)[0] === 7, "process.exit(7) → 'exit' 7")

    // An uncaught error: 'error' on the Worker, then 'exit' 1.
    const failing = kitchenWorker()
    await failing.ready
    const errored = next(failing.worker, 'error', 'worker error')
    const failedExit = next(failing.worker, 'exit', 'exit after error')
    await failing.call('throwLater', { message: 'kitchen boom' })
    const [error] = await errored
    assert(error instanceof Error && error.message === 'kitchen boom', `error: ${error?.message}`)
    assert((await failedExit)[0] === 1, "'exit' 1 after an uncaught error")

    // stdout: true → the worker's console output on worker.stdout.
    const logging = kitchenWorker({ stdout: true })
    try {
      await logging.ready
      let output = ''
      logging.worker.stdout.on('data', (chunk) => (output += chunk))
      await logging.call('log', { text: 'kitchen log line' })
      await withTimeout((async () => {
        while (!output.includes('kitchen log line')) await sleep(20)
      })(), 'worker stdout')
    } finally {
      await logging.worker.terminate()
    }
    return 'ok'
  } },

  { id: 'worker_threads in a nodeIntegration window', run: async () => {
    if (isElectron) return 'n/a: Electron renderers use Web Workers (nodeIntegrationInWorker)'
    return withWindow({ nodeIntegration: true, contextIsolation: false }, async (win) => {
      const host = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const { Worker } = require('worker_threads')
        const worker = new Worker("require('worker_threads').parentPort.postMessage(require('os').hostname())", { eval: true })
        worker.on('message', resolve)
        worker.on('error', (error) => resolve('error: ' + error.message))
        setTimeout(() => resolve('timed out'), 10000)
      })`)
      assert(host === os.hostname(), `os.hostname in the window's worker: ${host}`)
      return 'ok'
    })
  } },

  { id: "a sandboxed window's Web Worker cannot reach Node", run: async () => {
    if (isElectron) return 'n/a: tauri-plugin-electron bridge'
    return withWindow({ sandbox: true }, async (win) => {
      // The bridge identifies a worker's requests by its window: refused like the window's own.
      const status = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const url = window.__TAURI_INTERNALS__.convertFileSrc('node/os/hostname', 'tauri-electron')
        const source = 'const xhr = new XMLHttpRequest(); xhr.open("GET", ' + JSON.stringify(url) + ', false); try { xhr.send(); postMessage(xhr.status) } catch (e) { postMessage("threw: " + e.message) }'
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = (event) => resolve('error: ' + event.message)
        setTimeout(() => resolve('timed out'), 10000)
      })`)
      assert(status === 403, `bridge status from the worker: ${status}`)
      return 'refused (403)'
    })
  } },

  // --- C4: vm ---------------------------------------------------------------------------------------
  { id: 'vm.runInNewContext: sandbox globals read and written back', run: () => {
    const sandbox = { count: 2, items: [1, 2] }
    const result = vm.runInNewContext('count += 1; items.push(3); var created = "yes"; total = count * 10; function twice(n) { return n * 2 } twice(count)', sandbox)
    assert(result === 6, `completion value ${result}`)
    assert(sandbox.count === 3 && sandbox.items.length === 3, 'mutations')
    assert(sandbox.created === 'yes' && sandbox.total === 30 && typeof sandbox.twice === 'function', 'globals copied back')
    assert(sandbox.twice(4) === 8, 'function from the context')
    const arrayInside = vm.runInNewContext('[1, 2]')
    assert(!(arrayInside instanceof Array) && Array.isArray(arrayInside), 'a separate realm (instanceof differs, Array.isArray works)')
    assert(vm.runInNewContext('typeof kitchenOuter') === 'undefined', 'outer globals are not visible')
    return 'ok'
  } },

  { id: 'vm.createContext / runInContext / Script / compileFunction', run: () => {
    const context = vm.createContext({ base: 5 })
    assert(vm.isContext(context) && !vm.isContext({}), 'isContext')
    vm.runInContext('let counter = base; var shared = 1', context)
    assert(vm.runInContext('counter += 1; counter', context) === 6, 'let bindings persist between runs')
    context.base = 100
    assert(vm.runInContext('base + shared', context) === 101, 'outer writes visible inside')

    const script = new vm.Script('value * 2', { filename: 'kitchen-vm-script.js' })
    assert(script.runInNewContext({ value: 4 }) === 8 && script.runInNewContext({ value: 5 }) === 10, 'Script reused in new contexts')
    globalThis.kitchenVmGlobal = 21
    assert(new vm.Script('kitchenVmGlobal * 2').runInThisContext() === 42, 'runInThisContext sees this realm')
    delete globalThis.kitchenVmGlobal

    let syntax = null
    try {
      new vm.Script('this is not javascript (')
    } catch (error) {
      syntax = error
    }
    assert(syntax?.name === 'SyntaxError', `SyntaxError when the Script is created: ${syntax?.name}`)

    let thrown = null
    try {
      new vm.Script('throw new Error("vm boom")', { filename: 'kitchen-vm-file.js' }).runInThisContext()
    } catch (error) {
      thrown = error
    }
    assert(thrown?.message === 'vm boom', 'error from the script')
    assert(String(thrown.stack).includes('kitchen-vm-file.js'), `filename in the stack: ${thrown.stack}`)

    const add = vm.compileFunction('return a + b + c', ['a', 'b'], { contextExtensions: [{ c: 10 }] })
    assert(add(1, 2) === 13, 'compileFunction with params and contextExtensions')
    const inContext = vm.compileFunction('return base * 2', [], { parsingContext: context })
    assert(inContext() === 200, 'compileFunction in a context')
    return 'ok'
  } },
]
