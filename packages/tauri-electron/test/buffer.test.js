import { describe, expect, it } from 'vitest'
import buffer, { Buffer, isUtf8, isAscii, constants } from '../src/node/buffer.js'
import { encode, decode } from '../src/internal/serialize.js'

describe('buffer', () => {
  it('is a Uint8Array subclass with Node\'s encodings', () => {
    const b = Buffer.from('héllo')
    expect(b).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(b)).toBe(true)
    expect(b.toString('hex')).toBe('68c3a96c6c6f')
    expect(Buffer.from('aGk=', 'base64').toString()).toBe('hi')
    expect(Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString('latin1')).toBe('ab')
    expect(buffer.Buffer).toBe(Buffer)
    expect(constants.MAX_LENGTH).toBeGreaterThan(0)
    expect(isUtf8(Buffer.from([0xc3, 0xa9]))).toBe(true)
    expect(isUtf8(Buffer.from([0xff]))).toBe(false)
    expect(isAscii(Buffer.from('abc'))).toBe(true)
  })

  it('crosses IPC as bytes, like in Electron', () => {
    const out = decode(JSON.parse(JSON.stringify(encode([Buffer.from('xy')]))))
    expect(out[0]).toBeInstanceOf(Uint8Array)
    expect([...out[0]]).toEqual([0x78, 0x79])
  })
})
