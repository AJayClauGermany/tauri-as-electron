import { describe, expect, it } from 'vitest'
import nodeCrypto from 'node:crypto'
import Stream, { Readable, Transform, Writable, pipeline } from '../src/node/stream.js'
import streamPromises from '../src/node/stream-promises.js'
import { StringDecoder } from '../src/node/string-decoder.js'
import crypto from '../src/node/crypto.js'
import { Buffer } from '../src/node/buffer.js'

describe('stream', () => {
  it('is Node\'s streams: the legacy Stream constructor carrying Readable & co.', async () => {
    expect(typeof Stream).toBe('function')
    expect(Stream.Readable).toBe(Readable)
    expect(Stream.promises.pipeline).toBe(streamPromises.pipeline)
    const seen = []
    await streamPromises.pipeline(
      Readable.from(['a', 'b', 'c']),
      new Transform({ transform: (chunk, _encoding, callback) => callback(null, String(chunk).toUpperCase()) }),
      new Writable({ write: (chunk, _encoding, callback) => callback(null, seen.push(String(chunk))) }),
    )
    expect(seen.join('')).toBe('ABC')
    await new Promise((resolve, reject) => pipeline(Readable.from(['x']), new Writable({ write: (c, e, cb) => cb() }), (error) => (error ? reject(error) : resolve())))
    const chunks = []
    for await (const chunk of Readable.from([Buffer.from('it'), Buffer.from('er')])) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('iter')
  })

  it('decodes multi-byte characters split across chunks', () => {
    // Under vitest the npm string_decoder resolves Node's own Buffer; in an app, the
    // bundler alias gives it tauri-electron's.
    const NodeBuffer = globalThis.Buffer
    const decoder = new StringDecoder('utf8')
    expect(decoder.write(NodeBuffer.from([0xe2, 0x82])) + decoder.write(NodeBuffer.from([0xac])) + decoder.end()).toBe('€')
  })
})

describe('crypto', () => {
  it('hashes, HMACs and derives keys exactly like Node', () => {
    for (const algorithm of crypto.getHashes().filter((name) => !name.startsWith('shake'))) {
      expect(crypto.createHash(algorithm).update('héllo').update(new Uint8Array([1, 2])).digest('hex'), algorithm).toBe(
        nodeCrypto.createHash(algorithm).update('héllo').update(Buffer.from([1, 2])).digest('hex'),
      )
      expect(crypto.createHmac(algorithm, 'key').update('data').digest('base64')).toBe(nodeCrypto.createHmac(algorithm, 'key').update('data').digest('base64'))
    }
    expect(crypto.createHash('SHA-256').update('x').digest('hex')).toBe(nodeCrypto.createHash('sha256').update('x').digest('hex'))
    expect(crypto.pbkdf2Sync('pw', 'salt', 1000, 32, 'sha512')).toEqual(Buffer.from(nodeCrypto.pbkdf2Sync('pw', 'salt', 1000, 32, 'sha512')))
    expect(Buffer.from(crypto.hkdfSync('sha256', 'ikm', 'salt', 'info', 42)).toString('hex')).toBe(Buffer.from(nodeCrypto.hkdfSync('sha256', 'ikm', 'salt', 'info', 42)).toString('hex'))
    expect(crypto.scryptSync('pw', 'salt', 16, { N: 1024 }).toString('hex')).toBe(nodeCrypto.scryptSync('pw', 'salt', 16, { N: 1024 }).toString('hex'))
    const partial = crypto.createHash('sha1').update('a')
    expect(partial.copy().update('b').digest('hex')).toBe(nodeCrypto.createHash('sha1').update('ab').digest('hex'))
    partial.digest()
    expect(() => partial.digest()).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }))
    expect(() => crypto.createHash('nope')).toThrow(/Digest method not supported/)
  })

  it('works as a stream and makes random values', async () => {
    const digest = await new Promise((resolve) => {
      const hash = crypto.createHash('md5')
      hash.on('data', (d) => resolve(d.toString('hex')))
      hash.end('streamed')
    })
    expect(digest).toBe(nodeCrypto.createHash('md5').update('streamed').digest('hex'))
    expect(crypto.randomBytes(70000)).toHaveLength(70000)
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    for (let i = 0; i < 100; i++) expect(crypto.randomInt(3, 5)).toBeGreaterThanOrEqual(3)
    expect(crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('a'))).toBe(true)
    expect(() => crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('ab'))).toThrow(RangeError)
    expect(await new Promise((resolve) => crypto.randomBytes(4, (e, b) => resolve(b.length)))).toBe(4)
    expect(() => crypto.createCipheriv('aes-256-gcm')).toThrow(/crypto\.subtle/)
  })
})
