/**
 * webpack / rspack loader: rewrites `__dirname`, `__filename`,
 * `import.meta.dirname|filename` and `fileURLToPath(import.meta.url)` in
 * project source to project-relative paths (see shared.cjs), so
 * `win.loadFile(path.join(__dirname, 'index.html'))` keeps working.
 * Added by TauriElectronPlugin as an `enforce: 'pre'` rule.
 */
'use strict'
const path = require('node:path')
const { rewritePathGlobals, mentionsPathGlobals } = require('./shared.cjs')

module.exports = function pathGlobalsLoader(code, map) {
  if (!mentionsPathGlobals(code)) return this.callback(null, code, map)
  const { root } = this.getOptions()
  const relative = '/' + path.relative(root, this.resourcePath).split(path.sep).join('/')
  this.callback(null, rewritePathGlobals(code, path.posix.dirname(relative), relative), map)
}
