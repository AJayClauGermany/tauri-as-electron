/**
 * The Node built-ins tauri-electron implements beyond path / process /
 * events / url, and `installNodeLayer()`, which registers them for
 * `require()` and adds the globals Node code expects (`Buffer`, `global`,
 * `setImmediate`). The main page installs them on load (./index.js);
 * renderer windows created with `nodeIntegration` or `sandbox: false` do
 * through ../renderer/node.js.
 */
import fs from './fs.js'
import processShim from '../process.js'
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
import timers, { installTimerGlobals, setImmediate, clearImmediate } from './timers.js'
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
import net from './net.js'
import tls from './tls.js'
import dgram from './dgram.js'
import dns from './dns.js'
import dnsPromises from './dns-promises.js'
import vm from './vm.js'
import workerThreads from './worker-threads.js'
import { registerNodeModule } from '../require.js'

export const nodeModules = {
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
  net,
  tls,
  dgram,
  dns,
  'dns/promises': dnsPromises,
  vm,
  worker_threads: workerThreads,
}

const NODE_VERSION = '22.0.0'

let installed = false

/**
 * Register the modules for `require()` and install the globals. `timers`:
 * also replace setTimeout & co. with Node's (Timeout objects), as in Node's
 * main process; Electron renderers keep the browser's and only gain
 * setImmediate.
 */
export function installNodeLayer({ timers: nodeTimers = true } = {}) {
  if (installed) return
  installed = true
  for (const [name, exports] of Object.entries(nodeModules)) registerNodeModule(name, exports)
  if (typeof globalThis.global === 'undefined') globalThis.global = globalThis
  if (nodeTimers) installTimerGlobals(globalThis)
  else if (typeof globalThis.setImmediate !== 'function') Object.assign(globalThis, { setImmediate, clearImmediate })
  if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer
  // The Node API level the shims follow. Libraries parse it (readdirp 3,
  // under chokidar 3, at import time); only pages with the Node layer get it.
  // (globalThis.process is this shim in a webview; under real Node it is left alone.)
  if (!processShim.versions.node) {
    processShim.versions.node = NODE_VERSION
    processShim.version = `v${NODE_VERSION}`
  }
}
