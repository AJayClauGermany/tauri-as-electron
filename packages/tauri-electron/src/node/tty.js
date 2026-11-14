/**
 * Node's `tty`: there is no terminal in a webview. `isatty()` is false for
 * every descriptor; the stream classes cannot be created.
 */
import { NotImplementedError } from '../internal/runtime.js'

export function isatty() {
  return false
}

const noTerminal = (name) =>
  class {
    constructor() {
      throw new NotImplementedError(`new tty.${name}`, { reason: 'unsupported', hint: 'There is no terminal in a webview: tty.isatty() is always false.' })
    }
  }

export const ReadStream = noTerminal('ReadStream')
export const WriteStream = noTerminal('WriteStream')

export default { isatty, ReadStream, WriteStream }
