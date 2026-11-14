/**
 * Node's `stream`, from readable-stream (Node's own streams, packaged for
 * browsers). Like `require('stream')` in Node, the default export is the
 * legacy `Stream` constructor carrying `Readable`, `Writable`, … so that
 * `util.inherits(MyStream, require('stream'))` keeps working.
 *
 * readable-stream's own `require('events')` / `require('buffer')` resolve to
 * tauri-electron's `events` and `buffer`, so its streams are the same
 * EventEmitters and emit the same Buffers as the rest of the app.
 */
import Stream from 'readable-stream/lib/stream.js'

export const {
  Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, addAbortSignal, compose, destroy,
  isDestroyed, isDisturbed, isErrored, isReadable, isWritable, setDefaultHighWaterMark, getDefaultHighWaterMark,
} = Stream
export const promises = Stream.promises
export { Stream }

export default Stream
