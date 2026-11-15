import { describe, expect, it, vi } from 'vitest'
import nodeAssert from 'node:assert'
import nodeQuerystring from 'node:querystring'
import nodeZlib from 'node:zlib'
import nodeModule from 'node:module'

// module.js serves require(); the electron module behind it is not needed here.
vi.mock('../src/index.js', () => ({ app: {} }))

const assert = (await import('../src/node/assert.js')).default
const querystring = await import('../src/node/querystring.js')
const punycode = (await import('../src/node/punycode.js')).default
const timers = await import('../src/node/timers.js')
const timersPromises = await import('../src/node/timers-promises.js')
const { performance, createHistogram, monitorEventLoopDelay } = await import('../src/node/perf-hooks.js')
const consumers = await import('../src/node/stream-consumers.js')
const zlib = (await import('../src/node/zlib.js')).default
const { Console } = await import('../src/node/console.js')
const Module = (await import('../src/node/module.js')).default
const readline = await import('../src/node/readline.js')
const { AsyncLocalStorage, AsyncResource } = await import('../src/node/async-hooks.js')
const diagnostics = await import('../src/node/diagnostics-channel.js')
const domain = await import('../src/node/domain.js')
const tty = await import('../src/node/tty.js')
const { Readable, PassThrough } = await import('../src/node/stream.js')
const { Buffer } = await import('../src/node/buffer.js')
const { rewriteBuiltinRequires } = (await import('../bundler/shared.cjs')).default

const failure = (run) => {
  try {
    run()
    return null
  } catch (e) {
    return { message: e.message, operator: e.operator, generatedMessage: e.generatedMessage, code: e.code, name: e.name }
  }
}

describe('assert', () => {
  it('fails with Node\'s messages and error shape', () => {
    for (const run of [
      (a) => a.strictEqual(1, 2), (a) => a.equal(1, 2), (a) => a.notStrictEqual(1, 1), (a) => a.deepStrictEqual({ a: 1, b: [1, 2] }, { a: 2, b: [1, 2] }),
      (a) => a.deepEqual({ a: 1 }, { a: 2 }), (a) => a.throws(() => {}), (a) => a.throws(() => {}, TypeError), (a) => a.match('abc', /x/), (a) => a.fail(),
      (a) => a.ifError(new Error('boom')), (a) => a.notDeepStrictEqual({ a: 1 }, { a: 1 }), (a) => a.doesNotThrow(() => { throw new Error('x') }),
      (a) => a.strictEqual(1, 2, 'custom'), (a) => a.deepStrictEqual([1, 2, 3], [1, 2, 4]), (a) => a.throws(() => { throw new TypeError('bad') }, { message: 'other' }),
      (a) => a.strict.equal(1, '1'), (a) => a.deepEqual(1, '1'), (a) => a.notEqual(1, '1'), (a) => a.doesNotMatch('abc', /b/),
      (a) => a.deepStrictEqual(new Map([[1, 2]]), new Map([[1, 3]])),
    ]) {
      expect(failure(() => run(assert)), String(run)).toEqual(failure(() => run(nodeAssert)))
    }
  })

  it('passes what Node passes', async () => {
    assert(true)
    assert.deepEqual({ a: 1 }, { a: '1' })
    assert.throws(() => { throw new TypeError('bad') }, /bad/)
    assert.throws(() => { throw new TypeError('bad') }, TypeError)
    assert.throws(() => { throw new TypeError('bad') }, { name: 'TypeError', message: /ba/ })
    await assert.rejects(Promise.reject(new Error('no')), /no/)
    await assert.doesNotReject(Promise.resolve(1))
    expect(new assert.AssertionError({ message: 'x' })).toBeInstanceOf(Error)
  })
})

describe('querystring and punycode', () => {
  it('parse and stringify like Node', () => {
    for (const text of ['a=1&a=2&b', 'x=%E2%82%AC+y&z=%ZZ', '', 'k=v&k', '=x&&y=']) {
      expect({ ...querystring.parse(text) }).toEqual({ ...nodeQuerystring.parse(text) })
    }
    expect(Object.getPrototypeOf(querystring.parse('a=1'))).toBe(null)
    expect(querystring.parse('a:1;b:2', ';', ':')).toEqual(Object.assign(Object.create(null), { a: '1', b: '2' }))
    const value = { a: [1, 'two'], b: true, c: 'é &', d: null, e: NaN, f: 3n }
    expect(querystring.stringify(value)).toBe(nodeQuerystring.stringify(value))
    expect(querystring.escape("a b'()!*")).toBe(nodeQuerystring.escape("a b'()!*"))
  })

  it('converts domain names', () => {
    expect(punycode.toASCII('mañana.com')).toBe('xn--maana-pta.com')
    expect(punycode.toUnicode('xn--maana-pta.com')).toBe('mañana.com')
  })
})

describe('timers', () => {
  it('returns Timeout objects that clearTimeout and refresh understand', async () => {
    const calls = []
    const timeout = timers.setTimeout((x) => calls.push(x), 5, 'a')
    expect(timeout.unref()).toBe(timeout)
    expect(timeout.hasRef()).toBe(false)
    expect(typeof +timeout).toBe('number')
    const cancelled = timers.setTimeout(() => calls.push('never'), 5)
    timers.clearTimeout(cancelled)
    const order = []
    timers.setImmediate(() => order.push('immediate'))
    await timersPromises.setTimeout(30)
    expect(calls).toEqual(['a'])
    expect(order).toEqual(['immediate'])
  })

  it('timers/promises resolves values and honours AbortSignal', async () => {
    expect(await timersPromises.setTimeout(1, 'v')).toBe('v')
    expect(await timersPromises.setImmediate('i')).toBe('i')
    const controller = new AbortController()
    const pending = timersPromises.setTimeout(1000, 'late', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    let ticks = 0
    for await (const value of timersPromises.setInterval(2, 'tick')) {
      expect(value).toBe('tick')
      if (++ticks === 3) break
    }
  })
})

describe('perf_hooks', () => {
  it('times functions and records histograms', async () => {
    expect(performance.now()).toBeGreaterThan(0)
    const doubled = performance.timerify((x) => x * 2)
    expect(doubled(2)).toBe(4)
    const histogram = createHistogram()
    for (const v of [1, 2, 3, 4]) histogram.record(v)
    expect([histogram.min, histogram.max, histogram.mean, histogram.percentile(50)]).toEqual([1, 4, 2.5, 2])
    const delay = monitorEventLoopDelay({ resolution: 5 })
    expect(delay.enable()).toBe(true)
    await new Promise((r) => setTimeout(r, 40))
    delay.disable()
    expect(delay.count).toBeGreaterThan(0)
  })
})

describe('stream/consumers', () => {
  it('reads Node streams, web streams and iterables whole', async () => {
    expect(await consumers.text(Readable.from(['a', 'b']))).toBe('ab')
    expect(await consumers.json(Readable.from(['{"x":', '1}']))).toEqual({ x: 1 })
    expect(Buffer.isBuffer(await consumers.buffer(Readable.from([Buffer.from('z')])))).toBe(true)
    const web = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode('web')), c.close()) })
    expect(await consumers.text(web)).toBe('web')
  })
})

describe('zlib', () => {
  const text = 'tauri '.repeat(500)

  it('interoperates with Node\'s zlib in both directions', () => {
    for (const [compress, decompress] of [['gzipSync', 'gunzipSync'], ['deflateSync', 'inflateSync'], ['deflateRawSync', 'inflateRawSync']]) {
      expect(nodeZlib[decompress](zlib[compress](text)).toString()).toBe(text)
      expect(zlib[decompress](nodeZlib[compress](text, { level: 9 })).toString()).toBe(text)
    }
    expect(zlib.unzipSync(nodeZlib.gzipSync(text)).toString()).toBe(text)
    expect(zlib.crc32('hello')).toBe(nodeZlib.crc32('hello'))
    for (const bad of [() => zlib.gunzipSync(Buffer.from('nope')), () => zlib.gunzipSync(nodeZlib.gzipSync('hello').subarray(0, 10))]) {
      const ours = (() => { try { bad() } catch (e) { return [e.code, e.errno, e.message] } })()
      const theirs = (() => { try { bad.toString().includes('subarray') ? nodeZlib.gunzipSync(nodeZlib.gzipSync('hello').subarray(0, 10)) : nodeZlib.gunzipSync(Buffer.from('nope')) } catch (e) { return [e.code, e.errno, e.message] } })()
      expect(ours).toEqual(theirs)
    }
    expect(() => zlib.brotliCompressSync('x')).toThrow(/Brotli/)
  })

  it('streams and calls back', async () => {
    const gzip = zlib.createGzip()
    const chunks = []
    gzip.on('data', (c) => chunks.push(c))
    await new Promise((resolve) => {
      gzip.on('end', resolve)
      gzip.write(text)
      gzip.end(text)
    })
    expect(nodeZlib.gunzipSync(Buffer.concat(chunks)).toString()).toBe(text + text)
    const result = await new Promise((resolve, reject) => zlib.deflate(text, (e, r) => (e ? reject(e) : resolve(r))))
    expect(nodeZlib.inflateSync(result).toString()).toBe(text)
  })
})

describe('console, module, tty', () => {
  it('Console writes formatted lines to any stream', () => {
    const lines = []
    const out = { write: (text) => lines.push(text) }
    const logger = new Console(out)
    logger.log('%s=%d', 'a', 1)
    logger.group('group')
    logger.error({ b: 2 })
    logger.groupEnd()
    const { log } = logger
    log('detached')
    expect(lines).toEqual(['a=1\n', 'group\n', '  { b: 2 }\n', 'detached\n'])
    expect(globalThis.console.Console).toBe(Console)
  })

  it('lists Node\'s built-ins and creates require()', () => {
    expect(Module.builtinModules).toEqual(nodeModule.builtinModules.filter((name) => !name.startsWith('_')))
    expect(Module.isBuiltin('node:fs')).toBe(true)
    expect(Module.isBuiltin('left-pad')).toBe(false)
    const require = Module.createRequire('/src/main.js')
    expect(require('path').join('a', 'b')).toBe('a/b')
    expect(tty.isatty(1)).toBe(false)
  })
})

describe('readline', () => {
  it('splits input into lines, across chunks and \\r\\n', async () => {
    const input = new PassThrough()
    const rl = readline.createInterface({ input })
    const lines = []
    rl.on('line', (line) => lines.push(line))
    const closed = new Promise((resolve) => rl.on('close', resolve))
    input.write('one\r')
    input.write('\ntwo\nthr')
    input.end('ee')
    await closed
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('answers questions and iterates', async () => {
    const input = new PassThrough()
    const written = []
    const rl = readline.createInterface({ input, output: { write: (t) => written.push(t) } })
    const answer = new Promise((resolve) => rl.question('name? ', resolve))
    input.write('Ada\n')
    expect(await answer).toBe('Ada')
    expect(written).toEqual(['name? '])
    // As in Node, the iterator buffers lines from its creation on.
    const lines = rl[Symbol.asyncIterator]()
    input.end('a\nb\n')
    const seen = []
    for await (const line of { [Symbol.asyncIterator]: () => lines }) seen.push(line)
    expect(seen).toEqual(['a', 'b'])
    const promised = readline.promises.createInterface({ input: Readable.from(['yes\n']), output: { write() {} } })
    expect(await promised.question('ok? ')).toBe('yes')
  })
})

describe('async_hooks, diagnostics_channel, domain', () => {
  it('AsyncLocalStorage holds its store during run()', () => {
    const storage = new AsyncLocalStorage()
    expect(storage.run({ id: 1 }, () => storage.getStore())).toEqual({ id: 1 })
    expect(storage.getStore()).toBeUndefined()
    expect(new AsyncResource('X').runInAsyncScope((a) => a + 1, null, 1)).toBe(2)
  })

  it('publishes to subscribers and traces calls', () => {
    const seen = []
    diagnostics.subscribe('kitchen', (message, name) => seen.push([name, message]))
    diagnostics.channel('kitchen').publish({ n: 1 })
    expect(diagnostics.hasSubscribers('kitchen')).toBe(true)
    const traced = diagnostics.tracingChannel('op')
    traced.subscribe({ start: () => seen.push('start'), end: () => seen.push('end'), error: () => seen.push('error') })
    expect(traced.traceSync((x) => x * 3, {}, null, 2)).toBe(6)
    expect(seen).toEqual([['kitchen', { n: 1 }], 'start', 'end'])
  })

  it('domain.run routes a thrown error to the domain', () => {
    const d = domain.create()
    const errors = []
    d.on('error', (e) => errors.push(e.message))
    d.run(() => {
      throw new Error('caught')
    })
    expect(errors).toEqual(['caught'])
  })
})

describe('require() rewrite for Vite builds', () => {
  it('makes CommonJS require() of a shim return the module itself', () => {
    expect(rewriteBuiltinRequires("const a = require('assert'); require('left-pad'); // require('fs')")).toBe(
      "const a = ((m) => (m && m.default) || m)(require('assert')); require('left-pad'); // require('fs')",
    )
    expect(rewriteBuiltinRequires('const s = "require(\'zlib\')"')).toBe('const s = "require(\'zlib\')"')
  })
})
