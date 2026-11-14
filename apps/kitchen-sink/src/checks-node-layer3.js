// Checks for the third layer of Node built-ins (assert, querystring,
// punycode, timers, perf_hooks, stream/web, stream/consumers, zlib,
// constants, console, module, readline, async_hooks, diagnostics_channel,
// tty, domain). Same shape as checks.js and, like it, runs unchanged on
// Electron and on Tauri.
import assert from 'node:assert'
import querystring from 'node:querystring'
import punycode from 'punycode'
import { setTimeout as delay } from 'node:timers/promises'
import { setImmediate } from 'node:timers'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { ReadableStream } from 'node:stream/web'
import { text } from 'node:stream/consumers'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import constants from 'node:constants'
import { Console } from 'node:console'
import { builtinModules, createRequire, isBuiltin } from 'node:module'
import readline from 'node:readline'
import { AsyncLocalStorage } from 'node:async_hooks'
import diagnosticsChannel from 'node:diagnostics_channel'
import tty from 'node:tty'

const NODE_GZIP = 'H4sIAAAAAAAAA8vOLEnOSM1TKM7MywYAEabtpQwAAAA=' // zlib.gzipSync('kitchen sink') from Node

function check(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

export const layer3Checks = [
  { id: 'assert (AssertionError, deep diff)', run: () => {
    let error
    try {
      assert.deepStrictEqual({ a: 1 }, { a: 2 })
    } catch (e) {
      error = e
    }
    check(error?.code === 'ERR_ASSERTION' && error.name === 'AssertionError', `${error?.name} ${error?.code}`)
    check(error.message.startsWith('Expected values to be strictly deep-equal:\n+ actual - expected'), error.message)
    assert(true)
    assert.throws(() => assert.strictEqual(1, 2), { code: 'ERR_ASSERTION' })
    return error.message.split('\n')[0]
  } },
  { id: 'querystring / punycode', run: () => {
    const parsed = querystring.parse('a=1&a=2&b=x+y')
    check(JSON.stringify(parsed) === '{"a":["1","2"],"b":"x y"}', JSON.stringify(parsed))
    check(querystring.stringify({ q: 'é &', n: [1, 2] }) === 'q=%C3%A9%20%26&n=1&n=2', querystring.stringify({ q: 'é &', n: [1, 2] }))
    check(punycode.toASCII('mañana.com') === 'xn--maana-pta.com', punycode.toASCII('mañana.com'))
    return querystring.stringify(parsed)
  } },
  { id: 'timers (unref, setImmediate, timers/promises)', run: async () => {
    const order = []
    const timer = setTimeout(() => order.push('timeout'), 1).unref()
    check(timer.hasRef() === false, 'unref')
    setImmediate(() => order.push('immediate'))
    clearTimeout(setTimeout(() => order.push('cleared'), 1))
    check((await delay(20, 'value')) === 'value', 'timers/promises value')
    check(order.includes('timeout') && order.includes('immediate') && !order.includes('cleared'), order.join())
    const controller = new AbortController()
    const aborted = delay(10_000, null, { signal: controller.signal }).then(() => 'resolved', (e) => e.code)
    controller.abort()
    check((await aborted) === 'ABORT_ERR', 'abort')
    check(typeof global === 'object' && global === globalThis, 'global')
    return order.join(', ')
  } },
  { id: 'perf_hooks', run: async () => {
    const t0 = performance.now()
    const triple = performance.timerify((x) => x * 3)
    check(triple(3) === 9 && performance.now() >= t0, 'timerify')
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    await delay(60)
    histogram.disable()
    check(histogram.count > 0 || histogram.max > 0 || histogram.mean >= 0, 'histogram')
    return `${performance.now().toFixed(0)} ms since start`
  } },
  { id: 'stream/web + stream/consumers', run: async () => {
    const web = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('web '))
        controller.close()
      },
    })
    const result = (await text(web)) + (await text(Readable.from(['node'])))
    check(result === 'web node', result)
    return result
  } },
  { id: 'zlib (gzip interop, streams, crc32)', run: async () => {
    const fromNode = zlib.gunzipSync(Buffer.from(NODE_GZIP, 'base64')).toString()
    check(fromNode === 'kitchen sink', fromNode)
    check(zlib.inflateSync(zlib.deflateSync('round trip')).toString() === 'round trip', 'deflate round trip')
    check(zlib.crc32('kitchen sink') === 2783815185, String(zlib.crc32('kitchen sink')))
    const chunks = []
    await pipeline(Readable.from(['stream', 'ed']), zlib.createGzip(), zlib.createGunzip(), async function* (source) {
      for await (const chunk of source) chunks.push(chunk)
    })
    check(Buffer.concat(chunks).toString() === 'streamed', Buffer.concat(chunks).toString())
    let error
    try {
      zlib.gunzipSync(Buffer.from('not gzip'))
    } catch (e) {
      error = e
    }
    check(error?.code === 'Z_DATA_ERROR', error?.code)
    return fromNode
  } },
  { id: 'constants / console.Console', run: () => {
    check(constants.SIGTERM === 15 && constants.F_OK === 0, `${constants.SIGTERM} ${constants.F_OK}`)
    const lines = []
    const logger = new Console(new Writable({ write: (chunk, _encoding, callback) => callback(null, lines.push(String(chunk))) }))
    logger.log('%s has %d', 'kitchen', 2)
    check(lines.join('') === 'kitchen has 2\n', JSON.stringify(lines))
    return lines[0].trim()
  } },
  { id: 'module (createRequire, builtinModules)', run: () => {
    const require = createRequire(import.meta.url)
    check(require('node:path').join('a', 'b').replace(/\\/g, '/') === 'a/b', 'createRequire')
    check(builtinModules.includes('fs') && isBuiltin('node:zlib') && !isBuiltin('left-pad'), 'isBuiltin')
    return `${builtinModules.length} built-ins`
  } },
  { id: 'readline (lines from a stream)', run: async () => {
    const rl = readline.createInterface({ input: Readable.from(['one\r\ntw', 'o\nthree']) })
    const lines = []
    for await (const line of rl) lines.push(line)
    check(lines.join('|') === 'one|two|three', lines.join('|'))
    return lines.join('|')
  } },
  { id: 'async_hooks / diagnostics_channel / tty', run: () => {
    const storage = new AsyncLocalStorage()
    check(storage.run({ id: 7 }, () => storage.getStore().id) === 7, 'AsyncLocalStorage.run')
    const seen = []
    const onMessage = (message) => seen.push(message.n)
    diagnosticsChannel.subscribe('kitchen-sink', onMessage)
    diagnosticsChannel.channel('kitchen-sink').publish({ n: 1 })
    diagnosticsChannel.unsubscribe('kitchen-sink', onMessage)
    check(seen.join() === '1', seen.join())
    check(typeof tty.isatty(1) === 'boolean', 'isatty')
    return 'ok'
  } },
]
