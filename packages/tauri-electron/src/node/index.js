/**
 * The Node built-ins tauri-electron implements beyond path / process /
 * events / url, registered for `require()` on the main page (the bundler
 * plugins import this module first there), plus the `Buffer` global Node
 * code expects. Not loaded in renderer pages, like Node's own modules are
 * not available to a sandboxed Electron renderer.
 */
import fs from './fs.js'
import fsPromises from './fs-promises.js'
import buffer, { Buffer } from './buffer.js'
import util from './util.js'
import utilTypes from './util-types.js'
import stringDecoder from './string-decoder.js'
import Stream from './stream.js'
import streamPromises from './stream-promises.js'
import os from './os.js'
import childProcess from './child-process.js'
import crypto from './crypto.js'
import http from './http.js'
import https from './https.js'
import { registerNodeModule } from '../require.js'

for (const [name, exports] of Object.entries({
  fs,
  'original-fs': fs,
  'fs/promises': fsPromises,
  buffer,
  util,
  sys: util,
  'util/types': utilTypes,
  string_decoder: stringDecoder,
  stream: Stream,
  'stream/promises': streamPromises,
  os,
  child_process: childProcess,
  crypto,
  http,
  https,
})) {
  registerNodeModule(name, exports)
}

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer
