// `assert` under the webpack / rspack plugin. CommonJS, because Node's
// require() of it is the module value itself (callable or a plain object),
// not an ES module namespace.
module.exports = require('../src/node/assert.js').default
