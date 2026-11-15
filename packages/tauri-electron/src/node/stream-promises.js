/**
 * Node's `stream/promises`: `pipeline` and `finished` returning promises.
 * Taken from `Stream.promises` so readable-stream is loaded through one entry.
 */
import Stream from './stream.js'

const streamPromises = Stream.promises

export const { pipeline, finished } = streamPromises

export default streamPromises
