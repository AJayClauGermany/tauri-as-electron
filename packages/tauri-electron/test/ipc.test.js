import { describe, expect, it, vi } from 'vitest'

const emitted = []
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async (label, event, payload) => emitted.push({ label, event, payload })) }))

const { encode, decode } = await import('../src/internal/serialize.js')
const { MessageChannelMain, MessagePortMain, transferPorts, onRendererPortMessage } = await import('../src/main/message-ports.js')

const roundTrip = (value) => decode(JSON.parse(JSON.stringify(encode(value))))
const nextMessage = (port) => new Promise((resolve) => port.once('message', (event) => resolve(event.data)))

describe('structured-clone serialization', () => {
  it('keeps the types JSON loses', () => {
    const value = {
      bytes: new Uint8Array([0, 1, 255]),
      floats: new Float64Array([1.5, -2]),
      buffer: new Uint8Array([9, 8]).buffer,
      date: new Date(1234),
      map: new Map([['k', { nested: [1, undefined] }]]),
      set: new Set(['a', 'b']),
      big: 2n ** 70n,
      special: [NaN, Infinity, -Infinity, -0],
      regexp: /a+b/gi,
      missing: undefined,
      tagLike: { $te: 'not a tag' },
    }
    const out = roundTrip(value)
    expect(out.bytes).toBeInstanceOf(Uint8Array)
    expect([...out.bytes]).toEqual([0, 1, 255])
    expect(out.floats).toBeInstanceOf(Float64Array)
    expect([...out.floats]).toEqual([1.5, -2])
    expect(new Uint8Array(out.buffer)).toEqual(new Uint8Array([9, 8]))
    expect(out.date.getTime()).toBe(1234)
    expect(out.map.get('k')).toEqual({ nested: [1, undefined] })
    expect(out.set.has('b')).toBe(true)
    expect(out.big).toBe(2n ** 70n)
    expect(out.special[0]).toBeNaN()
    expect(out.special.slice(1, 3)).toEqual([Infinity, -Infinity])
    expect(Object.is(out.special[3], -0)).toBe(true)
    expect(out.regexp.flags).toBe('gi')
    expect('missing' in out && out.missing === undefined).toBe(true)
    expect(out.tagLike).toEqual({ $te: 'not a tag' })
  })

  it('serializes errors and rejects what structured clone rejects', () => {
    const error = roundTrip(new TypeError('bad'))
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TypeError')
    expect(error.message).toBe('bad')
    expect(() => encode({ fn() {} })).toThrow('could not be cloned')
    const cycle = {}
    cycle.self = cycle
    expect(() => encode(cycle)).toThrow('could not be cloned')
  })

  it('keeps Buffer-like subarrays exact', () => {
    const big = new Uint8Array([1, 2, 3, 4, 5])
    expect([...roundTrip(big.subarray(1, 3))]).toEqual([2, 3])
  })
})

describe('MessageChannelMain', () => {
  it('queues messages until start() and delivers clones', async () => {
    const { port1, port2 } = new MessageChannelMain()
    const payload = { list: [1, 2] }
    port1.postMessage(payload)
    payload.list.push(3)
    const received = nextMessage(port2)
    port2.start()
    expect(await received).toEqual({ list: [1, 2] })
  })

  it('emits close on both ends', async () => {
    const { port1, port2 } = new MessageChannelMain()
    const closed = new Promise((resolve) => port2.once('close', resolve))
    port1.close()
    await closed
    port2.postMessage('ignored') // no throw after close
  })

  it('relays a transferred port over the bridge', async () => {
    emitted.length = 0
    const { port1, port2 } = new MessageChannelMain()
    const [id] = transferPorts([port2], 'electron-window-1')
    expect(id).toMatch(/^main:/)
    port1.postMessage('to renderer')
    await new Promise((r) => setTimeout(r, 5))
    const relayed = emitted.find((e) => e.payload.type === 'port-message')
    expect(relayed).toMatchObject({ label: 'electron-window-1', payload: { port: id } })
    expect(decode(relayed.payload.data)).toBe('to renderer')

    const fromRenderer = nextMessage(port1)
    port1.start()
    onRendererPortMessage({ type: 'port-message', port: id, data: encode('from renderer') })
    expect(await fromRenderer).toBe('from renderer')
    expect(() => transferPorts([port2], 'x')).toThrow()
  })

  it('keeps port messages that reach the renderer before the port itself', async () => {
    const { ipcRenderer, onMessage } = await import('../src/renderer/ipc-renderer.js')
    const received = new Promise((resolve) => {
      ipcRenderer.once('early-port', (event) => {
        const [port] = event.ports
        const messages = []
        port.onmessage = ({ data }) => {
          messages.push(data)
          if (messages.length === 2) resolve({ messages, port })
        }
      })
    })
    // The transfer ('send' with ports) and the port's traffic are separate
    // Tauri events; here the traffic wins the race.
    onMessage({ type: 'port-message', port: 'main:early', data: encode('first') })
    onMessage({ type: 'port-message', port: 'main:early', data: encode('second') })
    onMessage({ type: 'send', channel: 'early-port', args: encode([null]), ports: ['main:early'] })
    const { messages, port } = await received
    expect(messages).toEqual(['first', 'second'])
    // Traffic for a port that was closed afterwards is dropped, not kept.
    onMessage({ type: 'port-close', port: 'main:early' })
    onMessage({ type: 'port-message', port: 'main:early', data: encode('late') })
    port.close()
  })

  it('wraps ports that live in a renderer', async () => {
    emitted.length = 0
    const port = MessagePortMain._fromRenderer('electron-window-2', 'electron-window-2:1')
    const received = nextMessage(port)
    port.start()
    onRendererPortMessage({ type: 'port-message', port: 'electron-window-2:1', data: encode(42) })
    expect(await received).toBe(42)
    port.postMessage('reply')
    expect(emitted.at(-1)).toMatchObject({ label: 'electron-window-2', payload: { type: 'port-message', port: 'electron-window-2:1' } })
  })
})
