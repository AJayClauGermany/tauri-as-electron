// Checks for the second layer of Node built-ins (util, events, stream,
// string_decoder, os, child_process, crypto, http). Same shape as checks.js
// and, like it, runs unchanged on Electron and on Tauri (with the "node-os"
// and "node-child-process" features of tauri-plugin-electron).
import { app } from 'electron'
import util, { inspect, format, promisify, inherits, types } from 'node:util'
import { EventEmitter } from 'node:events'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import { exec, execFile, execSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'

const isWindows = process.platform === 'win32'

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

export const layer2Checks = [
  // --- util / events ------------------------------------------------------------------------
  { id: 'util.inspect / util.format', run: () => {
    const shown = inspect({ a: [1, { b: 'two' }], m: new Map([['k', 1]]) })
    assert(shown === "{ a: [ 1, { b: 'two' } ], m: Map(1) { 'k' => 1 } }", shown)
    const text = format('%s has %d items: %j', 'list', 3, { x: 1 })
    assert(text === 'list has 3 items: {"x":1}', text)
    return shown
  } },
  { id: 'util.promisify / util.types', run: async () => {
    const legacy = (value, callback) => setTimeout(() => callback(null, value * 2), 0)
    const doubled = await promisify(legacy)(21)
    assert(doubled === 42, `got ${doubled}`)
    assert(types.isDate(new Date()) && types.isPromise(Promise.resolve()) && !types.isRegExp({}), 'types')
    assert(util.isDeepStrictEqual({ a: [1] }, { a: [1] }), 'isDeepStrictEqual')
    return doubled
  } },
  { id: 'util.inherits + EventEmitter.call (pre-class code)', run: () => {
    function Legacy() {
      EventEmitter.call(this)
    }
    inherits(Legacy, EventEmitter)
    let got
    new Legacy().on('ping', (v) => (got = v)).emit('ping', 'pong')
    assert(got === 'pong', `got ${got}`)
    return got
  } },

  // --- stream / string_decoder ---------------------------------------------------------------
  { id: 'stream pipeline (Readable → Transform → Writable)', run: async () => {
    const out = []
    await pipeline(
      Readable.from(['kit', 'chen']),
      new Transform({ transform: (chunk, _encoding, callback) => callback(null, String(chunk).toUpperCase()) }),
      new Writable({ write: (chunk, _encoding, callback) => callback(null, out.push(String(chunk))) }),
    )
    assert(out.join('') === 'KITCHEN', out.join(''))
    return out.join('')
  } },
  { id: 'string_decoder (split UTF-8)', run: () => {
    const decoder = new StringDecoder('utf8')
    const text = decoder.write(Buffer.from([0xe2, 0x82])) + decoder.write(Buffer.from([0xac])) + decoder.end()
    assert(text === '€', text)
    return text
  } },

  // --- os ------------------------------------------------------------------------------------------
  { id: 'os host facts', run: () => {
    assert(os.platform() === process.platform, os.platform())
    const expected = { linux: 'Linux', darwin: 'Darwin', win32: 'Windows_NT' }[process.platform]
    assert(!expected || os.type() === expected, os.type())
    assert(os.hostname() && os.release() && os.tmpdir() && os.userInfo().username, 'hostname, release, tmpdir, username')
    assert(os.homedir() === app.getPath('home'), `${os.homedir()} vs ${app.getPath('home')}`)
    assert(os.EOL === (isWindows ? '\r\n' : '\n'), 'EOL')
    return `${os.type()} ${os.release()} ${os.arch()}`
  } },
  { id: 'os resources (cpus, memory, uptime, network)', run: () => {
    const cpus = os.cpus()
    assert(cpus.length > 0 && typeof cpus[0].model === 'string' && typeof cpus[0].times.idle === 'number', 'cpus')
    assert(os.totalmem() > 0 && os.freemem() > 0 && os.freemem() <= os.totalmem(), 'memory')
    assert(os.uptime() > 0, 'uptime')
    assert(os.loadavg().length === 3, 'loadavg')
    const loopback = Object.values(os.networkInterfaces()).flat().find((entry) => entry.internal && entry.family === 'IPv4')
    assert(loopback?.address === '127.0.0.1', JSON.stringify(loopback))
    return `${cpus.length} cpus, ${Math.round(os.totalmem() / 2 ** 20)} MB`
  } },

  // --- child_process -----------------------------------------------------------------------------
  { id: 'child_process.execSync', run: () => {
    const out = execSync('echo kitchen', { encoding: 'utf8' }).trim()
    assert(out === 'kitchen', out)
    const status = spawnSync('exit 3', { shell: true }).status
    assert(status === 3, `status ${status}`)
    let failure
    try {
      execSync('exit 2', { stdio: 'pipe' })
    } catch (error) {
      failure = error
    }
    assert(failure?.status === 2 && failure.message.startsWith('Command failed: exit 2'), failure?.message)
    return out
  } },
  { id: 'child_process.execSync (stdin)', run: () => {
    if (isWindows) return 'n/a on Windows'
    const out = execSync('cat', { input: 'from stdin', encoding: 'utf8' })
    assert(out === 'from stdin', out)
    return out
  } },
  { id: 'child_process.exec', run: () => new Promise((resolve, reject) => {
    exec('echo out && echo err 1>&2', (error, stdout, stderr) => {
      if (error) return reject(error)
      if (stdout.trim() !== 'out' || stderr.trim() !== 'err') return reject(new Error(`${JSON.stringify(stdout)} ${JSON.stringify(stderr)}`))
      resolve(stdout.trim())
    })
  }) },
  { id: 'child_process.spawn (stdout, exit, close)', run: () => new Promise((resolve, reject) => {
    const child = isWindows ? spawn('cmd.exe', ['/d', '/c', 'echo spawned']) : spawn('sh', ['-c', 'echo spawned; exit 5'])
    let out = ''
    let exited = null
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (exited = code))
    child.on('close', (code) => {
      if (!isWindows && (code !== 5 || exited !== 5)) return reject(new Error(`close ${code}, exit ${exited}`))
      if (out.trim() !== 'spawned') return reject(new Error(JSON.stringify(out)))
      resolve(`pid ${child.pid > 0 ? 'set' : 'missing'}, code ${code}`)
    })
  }) },
  { id: 'child_process.spawn (stdin → stdout)', run: () => new Promise((resolve, reject) => {
    if (isWindows) return resolve('n/a on Windows')
    const child = spawn('cat')
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('close', () => (out === 'round trip' ? resolve(out) : reject(new Error(JSON.stringify(out)))))
    child.stdin.write('round ')
    child.stdin.end('trip')
  }) },
  { id: 'child_process missing program (ENOENT)', run: () => new Promise((resolve, reject) => {
    const child = spawn('kitchen-sink-no-such-program')
    child.on('error', (error) => (error.code === 'ENOENT' && error.syscall === 'spawn kitchen-sink-no-such-program' ? resolve(error.message) : reject(error)))
    child.on('spawn', () => reject(new Error('spawned?')))
  }) },
  { id: 'child_process.execFile (promisified, timeout kill)', run: async () => {
    const { stdout } = await promisify(execFile)(isWindows ? 'cmd.exe' : 'echo', isWindows ? ['/d', '/c', 'echo hi'] : ['hi'])
    assert(stdout.trim() === 'hi', stdout)
    if (isWindows) return 'hi'
    const killed = await promisify(execFile)('sleep', ['5'], { timeout: 100 }).then(() => null, (error) => error)
    assert(killed?.killed === true && killed.signal === 'SIGTERM', `${killed?.killed} ${killed?.signal}`)
    return 'hi; timeout killed with SIGTERM'
  } },

  // --- crypto --------------------------------------------------------------------------------------
  { id: 'crypto hashes, HMAC, PBKDF2', run: () => {
    const sha = crypto.createHash('sha256').update('kitchen').digest('hex')
    assert(sha === '3171d89ad00530ffa19a244f040e9401a657903cbbbca724996b90a56df2c189', sha)
    const mac = crypto.createHmac('sha1', 'key').update('kitchen').digest('base64')
    assert(mac === '0T4tZT7rYh4SUQVAhFap/q0sLgw=', mac)
    const key = crypto.pbkdf2Sync('pw', 'salt', 100, 16, 'sha256').toString('hex')
    assert(key === '2abfac6a729e5abcc10c42850d51f912', key)
    return sha.slice(0, 16)
  } },
  { id: 'crypto random values', run: () => {
    const bytes = crypto.randomBytes(32)
    assert(bytes.length === 32 && Buffer.isBuffer(bytes), 'randomBytes')
    assert(/^[0-9a-f-]{36}$/.test(crypto.randomUUID()), 'randomUUID')
    const n = crypto.randomInt(10)
    assert(n >= 0 && n < 10, `randomInt ${n}`)
    assert(typeof crypto.webcrypto.subtle.digest === 'function', 'webcrypto')
    return `${bytes.length} bytes`
  } },

  // --- http ----------------------------------------------------------------------------------------
  // Node says ECONNREFUSED; on Tauri the transport (plugin-http) reports only
  // "error sending request", so the code is a generic one there.
  { id: 'http.get (unreachable port emits error)', run: () => new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:9/', () => reject(new Error('got a response from port 9?')))
    req.on('error', (error) => (error instanceof Error && /^E[A-Z]+$/.test(error.code) ? resolve(error.code) : reject(new Error(`${error.code}: ${error.message}`))))
  }) },
  { id: 'http.get(http://example.com)', manual: true, run: () => new Promise((resolve, reject) => {
    http.get('http://example.com/', (res) => {
      let size = 0
      res.on('data', (chunk) => (size += chunk.length))
      res.on('end', () => resolve(`${res.statusCode} ${res.headers['content-type']} ${size} bytes`))
    }).on('error', reject)
  }) },
]
