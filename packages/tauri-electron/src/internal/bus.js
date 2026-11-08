import { EventEmitter } from './emitter.js'

/** Internal event bus so modules can talk without circular imports. */
export const bus = new EventEmitter()
