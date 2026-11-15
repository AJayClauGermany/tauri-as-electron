import { describe, expect, it, vi } from 'vitest'
import nodeUtil from 'node:util'
import util, { inspect, format, promisify, callbackify, inherits, isDeepStrictEqual, types, deprecate } from '../src/node/util.js'
import EventEmitter, { on } from '../src/events.js'

class Foo {
  constructor() {
    this.a = 1
  }
}
const circular = { name: 'x' }
circular.self = circular
const fn = function named() {}
fn.extra = 1

const VALUES = [
  'str', "it's", 'a\nb', 42, -0, 12345678901234567890n, true, undefined, null, Symbol('s'), [], {}, [1, 2, 3],
  { a: 1, 'b-c': [1, { d: 2 }] }, new Foo(), Object.create(null), circular, [1, , 3], new Map([['a', 1], [{ k: 1 }, 'v']]),
  new Set([1, 'two']), new Uint8Array([1, 2, 3]), new ArrayBuffer(3), /re/gi, new Date(0), fn, class Bar {}, async () => {},
  function* gen() {}, { deep: { deeper: { deepest: { gone: 1 } } } }, Array.from({ length: 120 }, (_, i) => i),
  { [Symbol('k')]: 1 }, new WeakMap(), [undefined, null], { get g() { return 1 }, set s(v) {} }, new Number(3), new String('ab'),
  Object.assign([1], { extra: true }), { a: 'a'.repeat(40), b: 'b'.repeat(40) }, Array(30).fill('word'),
  { a: { b: { c: {} } } }, { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], nested: { x: [{ y: 1 }] } }, new Uint8Array(40),
]

describe('util', () => {
  it('inspects values exactly like Node', () => {
    for (const value of VALUES) expect(inspect(value)).toBe(nodeUtil.inspect(value))
    expect(inspect({ a: { b: { c: { d: 1 } } } }, { depth: 0 })).toBe(nodeUtil.inspect({ a: { b: { c: { d: 1 } } } }, { depth: 0 }))
    expect(inspect({ a: [1] }, { compact: false })).toBe(nodeUtil.inspect({ a: [1] }, { compact: false }))
    expect(inspect({ [inspect.custom]: () => 'custom!' })).toBe('custom!')
  })

  it('formats like Node', () => {
    for (const args of [
      ['%s=%d', 'a', 1], ['%s', { a: 1 }], ['%j', { a: [1] }], ['%o', [1]], ['%O', { a: { b: { c: { d: 1 } } } }],
      ['%i %f', '42.5px', '1.5e3'], ['%% %s', 'x', 'extra', 2], [1, 'a', { b: 2 }], ['%c%s', 'css', 'v'], ['%s', 2n], ['no args'],
    ]) {
      expect(format(...args)).toBe(nodeUtil.format(...args))
    }
  })

  it('compares deeply and strictly like Node', () => {
    for (const [a, b] of [
      [{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }], [new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]])], [new Set([{ a: 1 }]), new Set([{ a: 1 }])],
      [[1, 2], [1, '2']], [new Date(1), new Date(1)], [NaN, NaN], [0, -0], [{ a: undefined }, {}], [circular, circular], [new Foo(), { a: 1 }],
    ]) {
      expect(isDeepStrictEqual(a, b)).toBe(nodeUtil.isDeepStrictEqual(a, b))
    }
  })

  it('promisifies, callbackifies and inherits', async () => {
    const legacy = (x, cb) => setTimeout(() => (x ? cb(null, x * 2) : cb(new Error('no'))), 0)
    expect(await promisify(legacy)(2)).toBe(4)
    await expect(promisify(legacy)(0)).rejects.toThrow('no')
    const custom = () => {}
    custom[promisify.custom] = () => Promise.resolve('custom')
    expect(await promisify(custom)()).toBe('custom')
    const result = await new Promise((resolve) => callbackify(async (x) => x + 1)(1, (e, v) => resolve([e, v])))
    expect(result).toEqual([null, 2])
    const falsy = await new Promise((resolve) => callbackify(() => Promise.reject(null))((e) => resolve(e)))
    expect(falsy.code).toBe('ERR_FALSY_VALUE_REJECTION')
    function Legacy() {
      EventEmitter.call(this)
    }
    inherits(Legacy, EventEmitter)
    const instance = new Legacy()
    expect(Legacy.super_).toBe(EventEmitter)
    expect(instance).toBeInstanceOf(EventEmitter)
    let got
    instance.on('x', (v) => (got = v)).emit('x', 5)
    expect(got).toBe(5)
  })

  it('warns once for deprecated functions and exposes util/types', () => {
    const warn = vi.spyOn(globalThis.process, 'emitWarning').mockImplementation(() => {})
    const old = deprecate((x) => x + 1, 'old() is deprecated', 'DEP_TEST')
    expect(old(1) + old(2)).toBe(5)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    expect(types.isPromise(Promise.resolve())).toBe(true)
    expect(types.isUint8Array(new Uint8Array())).toBe(true)
    expect(types.isAsyncFunction(async () => {})).toBe(true)
    expect(types.isBoxedPrimitive(Object(1))).toBe(true)
    for (const name of Object.keys(nodeUtil.types)) {
      if (typeof types[name] !== 'function') continue
      for (const value of [new Map(), new Set(), /x/, new Date(), Promise.resolve(), new Uint16Array(), new DataView(new ArrayBuffer(1)), new Error(), function* () {}, Object(1n)]) {
        expect(types[name](value), `${name}(${nodeUtil.inspect(value)})`).toBe(nodeUtil.types[name](value))
      }
    }
    expect(util.TextEncoder).toBe(globalThis.TextEncoder)
  })
})

describe('events', () => {
  it('EventEmitter can be called the pre-class way, and iterated with events.on', async () => {
    expect(() => EventEmitter()).toThrow(TypeError)
    expect(EventEmitter.captureRejectionSymbol).toBe(Symbol.for('nodejs.rejection'))
    const emitter = new EventEmitter()
    expect(Object.keys(emitter)).toEqual([])
    for (const key in emitter) throw new Error(`enumerable: ${key}`)
    const iterator = on(emitter, 'tick')
    emitter.emit('tick', 1)
    emitter.emit('tick', 2)
    expect((await iterator.next()).value).toEqual([1])
    expect((await iterator.next()).value).toEqual([2])
    await iterator.return()
    expect(emitter.listenerCount('tick')).toBe(0)
    expect(EventEmitter.listenerCount(emitter, 'x')).toBe(0)
  })
})

describe('EventEmitter aliases', () => {
  it('on/addListener and off/removeListener are one function, as in Node (readable-stream overrides one name)', () => {
    expect(EventEmitter.prototype.addListener).toBe(EventEmitter.prototype.on)
    expect(EventEmitter.prototype.removeListener).toBe(EventEmitter.prototype.off)
    class Wrapped extends EventEmitter {}
    // What readable-stream does to Readable.prototype:
    Wrapped.prototype.removeListener = function (name, fn) {
      return EventEmitter.prototype.removeListener.call(this, name, fn)
    }
    Wrapped.prototype.off = Wrapped.prototype.removeListener
    const emitter = new Wrapped()
    const listener = () => {}
    emitter.on('x', listener).off('x', listener)
    expect(emitter.listenerCount('x')).toBe(0)
    const seen = []
    class Hooked extends EventEmitter {
      _newListener(name) {
        seen.push(name)
      }
    }
    new Hooked().addListener('a', listener).once('b', listener).prependListener('c', listener)
    expect(seen).toEqual(['a', 'b', 'c'])
  })
})
