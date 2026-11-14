/**
 * Node's `stream/consumers`: read a whole Node stream, web ReadableStream or
 * async iterable as text, JSON, bytes or a Blob.
 */
import { Buffer } from './buffer.js'

async function chunks(stream) {
  const out = []
  const iterable = typeof stream?.getReader === 'function' && !stream[Symbol.asyncIterator]
    ? (async function* () {
        const reader = stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          yield value
        }
      })()
    : stream
  for await (const chunk of iterable) out.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return out
}

export async function buffer(stream) {
  return Buffer.concat((await chunks(stream)).map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c.buffer ?? c, c.byteOffset ?? 0, c.byteLength))))
}

export async function arrayBuffer(stream) {
  const all = await buffer(stream)
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)
}

export async function text(stream) {
  return new TextDecoder().decode(await buffer(stream))
}

export async function json(stream) {
  return JSON.parse(await text(stream))
}

export async function blob(stream) {
  return new Blob(await chunks(stream))
}

export default { arrayBuffer, blob, buffer, json, text }
