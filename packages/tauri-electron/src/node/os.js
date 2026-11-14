/**
 * Node's `os`, backed by tauri-plugin-electron (Cargo feature `node-os`).
 *
 * Every function is synchronous, as in Node. Facts that do not change
 * (host name, kernel, user, folders) are asked for once over the
 * synchronous bridge and cached; memory, load, uptime, CPUs and network
 * interfaces are measured on each call. `platform`, `arch`, `EOL`,
 * `endianness`, `devNull`, `availableParallelism` and `constants` need no
 * native code.
 */
import { platform as currentPlatform, arch as currentArch } from '../process.js'
import { nodeCallSync, parseJson } from '../internal/node-bridge.js'
import { signals } from '../internal/signals.js'

const FEATURE = 'node-os'
const isWindows = currentPlatform === 'win32'

const DESCRIPTIONS = { EACCES: 'permission denied', EPERM: 'operation not permitted', ESRCH: 'no such process', EINVAL: 'invalid argument' }

/** Node's ERR_SYSTEM_ERROR, for the few os calls that can fail. */
function systemError({ code, errno, syscall, message }) {
  const error = new Error(`A system error occurred: ${syscall} returned ${code} (${DESCRIPTIONS[code] ?? message})`)
  error.name = 'SystemError'
  error.code = 'ERR_SYSTEM_ERROR'
  error.errno = errno
  error.syscall = syscall
  error.info = { errno, code, message: DESCRIPTIONS[code] ?? message, syscall }
  return error
}

function call(api, op, args) {
  return parseJson(nodeCallSync({ api, module: 'os', feature: FEATURE, op, args, toError: systemError }))
}

let cached = null
function info(api) {
  cached ??= call(api, 'info')
  return cached
}

export const EOL = isWindows ? '\r\n' : '\n'
export const devNull = isWindows ? '\\\\.\\nul' : '/dev/null'

export function platform() {
  return currentPlatform
}

export function arch() {
  return currentArch
}

export function endianness() {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 'LE' : 'BE'
}

export function availableParallelism() {
  const count = globalThis.navigator?.hardwareConcurrency
  return typeof count === 'number' && count > 0 ? count : Math.max(1, cpus().length)
}

export const hostname = () => info('os.hostname').hostname
export const homedir = () => info('os.homedir').homedir
export const tmpdir = () => info('os.tmpdir').tmpdir
export const type = () => info('os.type').type
export const release = () => info('os.release').release
export const version = () => info('os.version').version
export const machine = () => info('os.machine').machine

/** `os.userInfo([{ encoding }])`. */
export function userInfo(options) {
  const user = { ...info('os.userInfo').user }
  if ((typeof options === 'string' ? options : options?.encoding) === 'buffer') {
    const encoder = new TextEncoder()
    for (const key of ['username', 'homedir', 'shell']) if (typeof user[key] === 'string') user[key] = encoder.encode(user[key])
  }
  return user
}

export const totalmem = () => call('os.totalmem', 'memory').total
export const freemem = () => call('os.freemem', 'memory').free
export const uptime = () => call('os.uptime', 'uptime')
export const loadavg = () => call('os.loadavg', 'loadavg')
export const cpus = () => call('os.cpus', 'cpus')
export const networkInterfaces = () => call('os.networkInterfaces', 'networkInterfaces')

/** `os.getPriority([pid])`. */
export function getPriority(pid = 0) {
  return call('os.getPriority', 'getPriority', { pid })
}

/** `os.setPriority([pid,] priority)`. */
export function setPriority(pid, priority) {
  if (priority === undefined) {
    priority = pid
    pid = 0
  }
  call('os.setPriority', 'setPriority', { pid, priority })
}

const ERRNO = {
  E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97, EAGAIN: 11, EALREADY: 114, EBADF: 9,
  EBUSY: 16, ECANCELED: 125, ECHILD: 10, ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104, EDEADLK: 35,
  EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 106, EISDIR: 21,
  ELOOP: 40, EMFILE: 24, EMLINK: 31, ENAMETOOLONG: 36, ENETDOWN: 100, ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105,
  ENODEV: 19, ENOENT: 2, ENOEXEC: 8, ENOMEM: 12, ENOSPC: 28, ENOSYS: 38, ENOTCONN: 107, ENOTDIR: 20, ENOTEMPTY: 39,
  ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6, EPERM: 1, EPIPE: 32, ERANGE: 34, EROFS: 30, ESPIPE: 29, ESRCH: 3,
  ETIMEDOUT: 110, ETXTBSY: 26, EXDEV: 18,
}

export const constants = Object.freeze({
  signals,
  errno: Object.freeze({ ...ERRNO }), // Linux numbering
  priority: Object.freeze({ PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }),
  dlopen: Object.freeze({}),
  UV_UDP_REUSEADDR: 4,
})

const os = {
  EOL, devNull, constants, platform, arch, endianness, availableParallelism, hostname, homedir, tmpdir, type, release,
  version, machine, userInfo, totalmem, freemem, uptime, loadavg, cpus, networkInterfaces, getPriority, setPriority,
}

export default os
