// `stream` under the webpack / rspack plugin. CommonJS, because Node's
// require('stream') is the legacy Stream constructor itself
// (`util.inherits(MyStream, require('stream'))`), carrying Readable & co.
module.exports = require('../src/node/stream.js').default
