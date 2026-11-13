// `process` under the webpack / rspack plugin. CommonJS, because Node's
// require('process') is the process object itself (`require('process').env`).
module.exports = require('../src/process.js').default
