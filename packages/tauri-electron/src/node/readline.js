/**
 * Node's `readline`, for line-oriented input from a stream (a child's
 * stdout, a file stream, any Readable): `createInterface({ input })` with
 * 'line' and 'close' events, `question()`, `prompt()` and async iteration.
 * There is no terminal in a webview, so `terminal` is always false: no
 * history, completion or keypress events. The cursor helpers write ANSI
 * sequences to the given stream.
 */
import { EventEmitter } from '../internal/emitter.js'

const LINE_BREAK = /\r\n|\n|\r/

export class Interface extends EventEmitter {
  constructor(input, output, completer, terminal) {
    super()
    const options = input && typeof input.on === 'function' && !('input' in input) ? { input, output, completer, terminal } : input ?? {}
    this.input = options.input
    this.output = options.output
    this.terminal = false
    this.line = ''
    this.cursor = 0
    this.history = []
    this.closed = false
    this.crlfDelay = Math.max(100, options.crlfDelay ?? 100)
    this._prompt = options.prompt ?? '> '
    this._buffer = ''
    this._questions = []
    this._paused = false
    this._decoder = new TextDecoder()
    this._onData = (chunk) => this._receive(typeof chunk === 'string' ? chunk : this._decoder.decode(chunk, { stream: true }))
    this._onEnd = () => {
      const rest = this._buffer + this._decoder.decode()
      this._buffer = ''
      if (rest) this._emitLine(rest)
      this.close()
    }
    if (this.input) {
      this.input.on('data', this._onData)
      this.input.on('end', this._onEnd)
      this.input.resume?.()
    }
    if (options.signal) {
      if (options.signal.aborted) queueMicrotask(() => this.close())
      else options.signal.addEventListener('abort', () => this.close(), { once: true })
    }
  }

  _receive(text) {
    // A chunk ending in \r may be the first half of \r\n split across chunks.
    if (this._afterCR && text.startsWith('\n')) text = text.slice(1)
    this._afterCR = text.endsWith('\r')
    this._buffer += text
    const parts = this._buffer.split(LINE_BREAK)
    this._buffer = parts.pop()
    for (const line of parts) this._emitLine(line)
  }

  _emitLine(line) {
    if (this.closed) return
    const question = this._questions.shift()
    if (question) question(line)
    else this.emit('line', line)
  }

  getPrompt() {
    return this._prompt
  }

  setPrompt(prompt) {
    this._prompt = prompt
  }

  prompt() {
    if (this.closed) throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' })
    this.output?.write?.(this._prompt)
  }

  question(query, options, callback) {
    if (typeof options === 'function') callback = options
    if (this.closed) throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' })
    this.output?.write?.(query)
    this._questions.push(callback)
  }

  /** Like typing `data`: complete lines are emitted. */
  write(data) {
    if (this.closed) throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' })
    if (typeof data === 'string') this._receive(data)
  }

  pause() {
    if (this._paused) return this
    this._paused = true
    this.input?.pause?.()
    this.emit('pause')
    return this
  }

  resume() {
    if (!this._paused) return this
    this._paused = false
    this.input?.resume?.()
    this.emit('resume')
    return this
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.input?.removeListener?.('data', this._onData)
    this.input?.removeListener?.('end', this._onEnd)
    this.emit('close')
  }

  getCursorPos() {
    return { rows: 0, cols: this.cursor }
  }

  /** Lines until 'close', buffered from the moment the iterator is created. */
  [Symbol.asyncIterator]() {
    const queue = []
    const waiting = []
    let done = this.closed
    const onLine = (line) => (waiting.length ? waiting.shift()({ value: line, done: false }) : queue.push(line))
    const onClose = () => {
      done = true
      while (waiting.length) waiting.shift()({ value: undefined, done: true })
    }
    this.on('line', onLine)
    this.once('close', onClose)
    const stop = () => {
      this.off('line', onLine)
      this.off('close', onClose)
    }
    return {
      next: () => {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
        if (done) {
          stop()
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => waiting.push(resolve))
      },
      return: () => {
        stop()
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
}

export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal)
}

function writeTo(stream, sequence, callback) {
  if (!stream || typeof stream.write !== 'function') {
    if (callback) queueMicrotask(callback)
    return true
  }
  return stream.write(sequence, callback)
}

export function clearLine(stream, dir, callback) {
  return writeTo(stream, dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K', callback)
}

export function clearScreenDown(stream, callback) {
  return writeTo(stream, '\x1b[0J', callback)
}

export function cursorTo(stream, x, y, callback) {
  if (typeof y === 'function') [callback, y] = [y, undefined]
  return writeTo(stream, typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`, callback)
}

export function moveCursor(stream, dx, dy, callback) {
  let sequence = ''
  if (dx < 0) sequence += `\x1b[${-dx}D`
  else if (dx > 0) sequence += `\x1b[${dx}C`
  if (dy < 0) sequence += `\x1b[${-dy}A`
  else if (dy > 0) sequence += `\x1b[${dy}B`
  return writeTo(stream, sequence, callback)
}

export function emitKeypressEvents() {}

/** `readline/promises`' Interface: `question()` returns a promise. */
export class PromisesInterface extends Interface {
  question(query, options = {}) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      super.question(query, resolve)
    })
  }
}

/** `readline/promises`' Readline: queued cursor actions, written on `commit()`. */
export class Readline {
  constructor(stream) {
    this._stream = stream
    this._pending = ''
  }

  clearLine(dir) {
    this._pending += dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K'
    return this
  }

  clearScreenDown() {
    this._pending += '\x1b[0J'
    return this
  }

  cursorTo(x, y) {
    this._pending += typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`
    return this
  }

  moveCursor(dx, dy) {
    if (dx) this._pending += dx < 0 ? `\x1b[${-dx}D` : `\x1b[${dx}C`
    if (dy) this._pending += dy < 0 ? `\x1b[${-dy}A` : `\x1b[${dy}B`
    return this
  }

  commit() {
    const text = this._pending
    this._pending = ''
    return new Promise((resolve) => writeTo(this._stream, text, resolve))
  }

  rollback() {
    this._pending = ''
    return this
  }
}

export const promises = {
  Interface: PromisesInterface,
  Readline,
  createInterface: (input, output, completer, terminal) => new PromisesInterface(input, output, completer, terminal),
}

export default { Interface, createInterface, clearLine, clearScreenDown, cursorTo, moveCursor, emitKeypressEvents, promises }
