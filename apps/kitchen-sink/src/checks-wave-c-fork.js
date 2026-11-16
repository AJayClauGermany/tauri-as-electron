// Checks for roadmap wave C item C3: utilityProcess.fork and
// child_process.fork. Same shape as checks.js and, like it, runs unchanged on
// Electron and on Tauri (where the child is a Node.js from a bundled sidecar
// or, in development builds, from PATH).
import { utilityProcess, MessageChannelMain } from 'electron'
import { fork } from 'node:child_process'
import path from 'node:path'

const dirname = import.meta.dirname
// A static path, so tauri-electron's bundler plugin finds and builds the entry.
const WORKER = path.join(dirname, 'fork-worker.cjs')

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function waitFor(emitter, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeout)
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

/** The next 'message' of a utility process or forked child; fails with the child's error or exit. */
function reply(child, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("timed out waiting for 'message'")), timeout)
    const onMessage = (message) => done(null, message)
    const onError = (error, location, report) => done(new Error(`child error: ${report ?? error?.message ?? error}`))
    const onExit = (code) => done(new Error(`child exited (${code}) before answering`))
    function done(error, message) {
      clearTimeout(timer)
      child.off('message', onMessage).off('error', onError).off('exit', onExit)
      if (error) reject(error)
      else resolve(message)
    }
    child.on('message', onMessage).on('error', onError).on('exit', onExit)
  })
}

/** Wait for a utility process to start; fails with its error or exit. */
function spawned(child, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("timed out waiting for 'spawn'")), timeout)
    const onSpawn = () => done(null)
    const onError = (type, location, report) => done(new Error(`child error: ${report ?? type}`))
    const onExit = (code) => done(new Error(`child exited (${code}) before 'spawn'`))
    function done(error) {
      clearTimeout(timer)
      child.off('spawn', onSpawn).off('error', onError).off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    child.on('spawn', onSpawn).on('error', onError).on('exit', onExit)
  })
}

/** Run `fn(child)` on a fresh utility process and always kill it. */
async function withUtility(fn, args = [], options = {}) {
  const child = utilityProcess.fork(WORKER, args, options)
  try {
    await spawned(child)
    return await fn(child)
  } finally {
    child.kill()
  }
}

export const waveCForkChecks = [
  { id: 'utilityProcess.fork: spawn and postMessage round trip', run: () => withUtility(async (child) => {
    assert(Number.isInteger(child.pid) && child.pid > 0, `pid ${child.pid}`)
    child.postMessage({ type: 'hello', value: 42 })
    const answer = await reply(child)
    assert(answer.pong === 42, `pong ${answer.pong}`)
    assert(answer.utility === true, 'process.parentPort in the child')
    assert(JSON.stringify(answer.argv) === '["--kitchen"]', `argv ${JSON.stringify(answer.argv)}`)
    assert(answer.dirname === 'src', `__dirname ends in src (${answer.dirname})`)
    return `pid ${child.pid}, Node ${answer.node}`
  }, ['--kitchen']) },

  { id: 'utilityProcess: MessagePortMain transferred to the child', run: () => withUtility(async (child) => {
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ type: 'port' }, [port2])
    assert((await reply(child)).ready === true, 'the child took the port')
    port1.start()
    const answer = waitFor(port1, 'message')
    port1.postMessage(21)
    const [event] = await answer
    assert(event.data.doubled === 42, `doubled ${JSON.stringify(event.data)}`)
    port1.close()
    return 'port messages both ways'
  }) },

  { id: "utilityProcess: stdout 'pipe' and the exit code", run: async () => {
    const child = utilityProcess.fork(WORKER, [], { stdio: 'pipe' })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    await spawned(child)
    child.postMessage({ type: 'stdout', value: 'kitchen sink stdout' })
    await reply(child)
    const exited = waitFor(child, 'exit')
    child.postMessage({ type: 'exit', code: 7 })
    const [code] = await exited
    assert(code === 7, `exit code ${code}`)
    assert(out.includes('kitchen sink stdout'), `stdout ${JSON.stringify(out)}`)
    return `exit ${code}`
  } },

  { id: "utilityProcess: require('electron').net in the child", run: () => withUtility(async (child) => {
    child.postMessage({ type: 'electron' })
    const answer = await reply(child)
    assert(answer.net === 'function', `net.fetch is ${answer.net}`)
    return 'net.fetch available'
  }) },

  { id: 'child_process.fork: send / message / disconnect', run: async () => {
    const child = fork(WORKER, ['--child'], { env: { ...process.env, KITCHEN_FORK_ENV: 'forked' } })
    const exited = waitFor(child, 'exit')
    assert(child.connected === true, 'connected')
    child.send({ type: 'hello', value: 'ping' })
    const answer = await reply(child)
    assert(answer.pong === 'ping', `pong ${answer.pong}`)
    assert(answer.utility === false, 'no parentPort in a forked child')
    assert(answer.env === 'forked', `env ${answer.env}`)
    assert(JSON.stringify(answer.argv) === '["--child"]', `argv ${JSON.stringify(answer.argv)}`)
    // Closing the channel lets the child exit on its own.
    const disconnected = waitFor(child, 'disconnect')
    child.disconnect()
    await disconnected
    const [code] = await exited
    assert(code === 0, `exit code ${code}`)
    return `pid ${child.pid}, exit ${code}`
  } },

  { id: 'child_process.fork: silent stdout and a child-side disconnect', run: async () => {
    const child = fork(WORKER, [], { silent: true })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    const closed = waitFor(child, 'close')
    child.send({ type: 'stdout', value: 'quiet child' })
    await reply(child)
    child.send({ type: 'disconnect' })
    const [code] = await closed
    assert(code === 0, `exit code ${code}`)
    assert(out.includes('quiet child'), `stdout ${JSON.stringify(out)}`)
    assert(child.connected === false, 'disconnected')
    return 'closed'
  } },
]
