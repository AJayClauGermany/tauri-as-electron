/**
 * `node:events` for Electron code: `const { EventEmitter } = require('events')`
 * is common in main-process code. The EventEmitter tauri-electron's own
 * objects (app, BrowserWindow, ipcMain, …) are built on.
 */
import { EventEmitter } from './internal/emitter.js'

/** Node's `events.once(emitter, name)`: resolves with the event arguments. */
export function once(emitter, name) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      emitter.off?.(name, onEvent)
      reject(error)
    }
    const onEvent = (...args) => {
      if (name !== 'error') emitter.off?.('error', onError)
      resolve(args)
    }
    emitter.once(name, onEvent)
    if (name !== 'error') emitter.once?.('error', onError)
  })
}

EventEmitter.EventEmitter = EventEmitter
EventEmitter.once = once
EventEmitter.defaultMaxListeners = 10

export { EventEmitter }
export default EventEmitter
