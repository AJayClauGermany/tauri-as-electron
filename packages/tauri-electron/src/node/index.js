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
import assert, { strict as assertStrict } from './assert.js'
import querystring from './querystring.js'
import punycode from './punycode.js'
import timers, { installTimerGlobals } from './timers.js'
import timersPromises from './timers-promises.js'
import perfHooks from './perf-hooks.js'
import streamWeb from './stream-web.js'
import streamConsumers from './stream-consumers.js'
import zlib from './zlib.js'
import constants from './constants.js'
import nodeConsole from './console.js'
import Module from './module.js'
import readline from './readline.js'
import readlinePromises from './readline-promises.js'
import asyncHooks from './async-hooks.js'
import diagnosticsChannel from './diagnostics-channel.js'
import tty from './tty.js'
import domain from './domain.js'
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
  assert,
  'assert/strict': assertStrict,
  querystring,
  punycode,
  timers,
  'timers/promises': timersPromises,
  perf_hooks: perfHooks,
  'stream/web': streamWeb,
  'stream/consumers': streamConsumers,
  zlib,
  constants,
  console: nodeConsole,
  module: Module,
  readline,
  'readline/promises': readlinePromises,
  async_hooks: asyncHooks,
  diagnostics_channel: diagnosticsChannel,
  tty,
  domain,
})) {
  registerNodeModule(name, exports)
}

// The globals of Node's main process: `global`, setImmediate, and timers
// returning Timeout objects (`setTimeout(...).unref()` is common in Node code).
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis
installTimerGlobals(globalThis)

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer
