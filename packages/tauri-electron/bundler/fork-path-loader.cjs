/**
 * webpack / rspack loader for fork entries (see fork.cjs): `__dirname` & co.
 * in the app's sources become the app's folder in the Node.js child
 * (`TAURI_ELECTRON_APP_ROOT` + the project-relative path).
 */
'use strict'
const path = require('node:path')
const { rewritePathGlobals, mentionsPathGlobals } = require('./shared.cjs')
const { appPathExpression } = require('./fork.cjs')

module.exports = function forkPathLoader(code, map) {
  if (!mentionsPathGlobals(code)) return this.callback(null, code, map)
  const { root } = this.getOptions()
  const relative = '/' + path.relative(root, this.resourcePath).split(path.sep).join('/')
  this.callback(null, rewritePathGlobals(code, path.posix.dirname(relative), relative, appPathExpression), map)
}
