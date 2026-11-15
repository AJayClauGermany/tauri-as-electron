/**
 * Node's `string_decoder`, from the `string_decoder` npm package (the one
 * readable-stream uses), imported by file so the bundler alias for the bare
 * `string_decoder` specifier (which points here) does not apply to it.
 */
import stringDecoder from 'string_decoder/lib/string_decoder.js'

export const { StringDecoder } = stringDecoder

export default { StringDecoder }
