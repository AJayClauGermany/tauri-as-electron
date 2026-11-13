// What `import fs from 'fs'` / `require('node:fs')` resolve to under the
// webpack / rspack plugin: every member throws a NotImplementedError naming
// the Tauri replacement when called. The built-in's name is the resource
// query (`node-builtin.cjs?fs`), so each built-in is its own module.
// CommonJS, so named imports (`import { readFileSync } from 'fs'`) reach the stub too.
module.exports = require('../src/require.js').nodeBuiltin(__resourceQuery.slice(1))
