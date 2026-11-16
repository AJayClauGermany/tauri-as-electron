// `better-sqlite3` under the webpack / rspack plugin. CommonJS, because the
// package's export is the Database constructor itself
// (`new (require('better-sqlite3'))(file)`); `import { SqliteError }` still
// works (Database.SqliteError).
module.exports = require('../src/native/better-sqlite3.js').default
