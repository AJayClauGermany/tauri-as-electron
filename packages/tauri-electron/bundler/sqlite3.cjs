// `sqlite3` under the webpack / rspack plugin. CommonJS, because the package's
// export is one object whose VERSION & co. are read lazily
// (`require('sqlite3').verbose()`, `require('sqlite3').VERSION`).
module.exports = require('../src/native/sqlite3.js').default
