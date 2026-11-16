/**
 * webpack / rspack loader: rewrites `__dirname`, `__filename`,
 * `import.meta.dirname|filename` and `fileURLToPath(import.meta.url)` in
 * project source to project-relative paths (see shared.cjs), so
 * `win.loadFile(path.join(__dirname, 'index.html'))` keeps working, and
 * `new Worker(new URL('./w.js', import.meta.url))` of worker_threads to the
 * script's project path (bundled into the worker runtime, not as a Web Worker).
 * Added by TauriElectronPlugin as an `enforce: 'pre'` rule.
 */
'use strict'
const path = require('node:path')
const { rewritePathGlobals, mentionsPathGlobals, rewriteWorkerUrls, mentionsWorkerThreads } = require('./shared.cjs')

module.exports = function pathGlobalsLoader(source, map) {
  const { root } = this.getOptions()
  const code = mentionsWorkerThreads(source) ? rewriteWorkerUrls(source, this.resourcePath, root) : source
  if (!mentionsPathGlobals(code)) return this.callback(null, code, map)
  const relative = '/' + path.relative(root, this.resourcePath).split(path.sep).join('/')
  this.callback(null, rewritePathGlobals(code, path.posix.dirname(relative), relative), map)
}
