// `events` under the webpack / rspack plugin. CommonJS, because Node's
// require('events') is the EventEmitter class itself (webpack-dev-server's
// client does `new (require('events'))()`); `import { EventEmitter } from
// 'events'` still works (EventEmitter.EventEmitter).
module.exports = require('../src/events.js').default
