/**
 * Node's `fs` for Electron main-process code, backed by tauri-plugin-electron
 * (Cargo feature `node-fs`).
 *
 * - `*Sync` functions block on the synchronous bridge
 *   (`tauri-electron://…/node/fs/<op>`), as they block in Node.
 * - `fs.promises.*` and the callback API use the plugin's `node_fs` command
 *   and never block the page.
 *
 * Both reach the same Rust code, so results and errors are identical. Errors
 * are shaped like Node's (`code`, `errno`, `syscall`, `path`, `dest`, and the
 * `ENOENT: no such file or directory, open '/x'` message).
 *
 * Paths: app-relative paths (`path.join(__dirname, 'data.json')`, with the
 * project-relative `__dirname` the bundler plugins provide) are mapped to the
 * app's files, see ../internal/app-files.js. Writing to them fails with EROFS
 * in a build, as writing into an Electron app's asar does.
 *
 * File descriptors (`open`, `read`, `write`, `fstat`, `fsync`, …,
 * `fs.promises.open`'s FileHandle) name files Rust keeps open; they are
 * numbers from 3 up, valid until closed (or until the app exits), and only
 * mean something to this module. Writes to 1 and 2 reach the app's stdout
 * and stderr. `createReadStream` / `createWriteStream` are readable-stream
 * streams over them.
 *
 * Not implemented yet (they throw NotImplementedError): `watch`,
 * `watchFile`, `cp`, `opendir`, `link`, `chown`.
 */
import { Buffer } from './buffer.js'
import { native, hasFeature, featureError } from '../internal/native.js'
import { nodeCallSync, nodeFailure, noTauri, parseJson, plainBytes, encodeFrame, responseBytes } from '../internal/node-bridge.js'
import { inTauri, isPackagedBuild, explainError, NotImplementedError } from '../internal/runtime.js'
import { resolveAppPath } from '../internal/app-files.js'
import { platform } from '../process.js'
import { fileURLToPath } from '../url.js'
import { EventEmitter } from '../internal/emitter.js'
import { Readable, Writable } from './stream.js'

const FEATURE = 'node-fs'
const isWindows = platform === 'win32'

// --- constants ----------------------------------------------------------------------------------

export const F_OK = 0
export const R_OK = 4
export const W_OK = 2
export const X_OK = 1

export const constants = Object.freeze({
  F_OK, R_OK, W_OK, X_OK,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  UV_FS_COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4,
  UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512,
  O_APPEND: 1024, O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_SYNC: 1052672, O_DSYNC: 4096, O_NONBLOCK: 2048,
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFCHR: 0o020000, S_IFBLK: 0o060000,
  S_IFIFO: 0o010000, S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
  S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
  S_IRWXG: 0o070, S_IRGRP: 0o040, S_IWGRP: 0o020, S_IXGRP: 0o010,
  S_IRWXO: 0o007, S_IROTH: 0o004, S_IWOTH: 0o002, S_IXOTH: 0o001,
})
const { S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFBLK, S_IFIFO, S_IFLNK, S_IFSOCK } = constants

// --- errors ---------------------------------------------------------------------------------------

/** libuv's descriptions, which Node puts in its messages. */
const DESCRIPTIONS = {
  EACCES: 'permission denied',
  EBADF: 'bad file descriptor',
  EBUSY: 'resource busy or locked',
  EEXIST: 'file already exists',
  EINVAL: 'invalid argument',
  EIO: 'i/o error',
  EISDIR: 'illegal operation on a directory',
  ELOOP: 'too many symbolic links encountered',
  EMFILE: 'too many open files',
  EMLINK: 'too many links',
  ENAMETOOLONG: 'name too long',
  ENFILE: 'file table overflow',
  ENOENT: 'no such file or directory',
  ENOSPC: 'no space left on device',
  ENOSYS: 'function not implemented',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  ENOTSUP: 'operation not supported on socket',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
  ETXTBSY: 'text file is busy',
  EXDEV: 'cross-device link not permitted',
  EOF: 'end of file',
}

/** An Error shaped like the ones Node's fs throws, from what Rust reports. */
export function nodeError({ code, errno, syscall, path, dest, message }) {
  let text
  if (String(code).startsWith('ERR_')) {
    text = message
  } else {
    text = `${code}: ${DESCRIPTIONS[code] ?? message ?? 'unknown error'}, ${syscall}`
    if (path !== undefined && path !== null) text += ` '${path}'`
    if (dest !== undefined && dest !== null) text += ` -> '${dest}'`
  }
  const error = new Error(text)
  if (String(code).startsWith('ERR_')) error.name = 'SystemError'
  error.errno = errno
  error.code = code
  error.syscall = syscall
  if (path !== undefined && path !== null) error.path = path
  if (dest !== undefined && dest !== null) error.dest = dest
  return error
}

function describe(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return `function ${value.name || '<anonymous>'}`
  if (typeof value === 'object') return value.constructor?.name ? `an instance of ${value.constructor.name}` : String(value)
  let shown = typeof value === 'string' ? `'${value.length > 25 ? `${value.slice(0, 25)}...` : value}'` : String(value)
  if (typeof value === 'bigint') shown += 'n'
  return `type ${typeof value} (${shown})`
}

function argError(Ctor, code, message) {
  const error = new Ctor(message)
  error.code = code
  return error
}

function invalidArgType(name, expected, value) {
  return argError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${expected}. Received ${describe(value)}`)
}

function invalidArgValue(name, value, reason = 'is invalid') {
  return argError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument '${name}' ${reason}. Received ${typeof value === 'string' ? `'${value}'` : String(value)}`)
}

function unavailable(api, reason, hint) {
  return new NotImplementedError(api, { reason, hint })
}

/** Turn a failed bridge or command call into what the caller should see. */
function failure(api, status, body) {
  return nodeFailure({ api, module: 'fs', feature: FEATURE, status, body, toError: nodeError })
}

// --- transport ----------------------------------------------------------------------------------------

const utf8 = new TextDecoder()
const encoder = new TextEncoder()

/** Blocking call over the synchronous bridge. */
function callSync(api, op, args, data) {
  const bytes = nodeCallSync({ api, module: 'fs', feature: FEATURE, op, args, body: data, toError: nodeError })
  return returnsBytes(op) ? bytes : parseJson(bytes)
}

const returnsBytes = (op) => op === 'read' || op === 'fdRead'

export { encodeFrame }

/** Non-blocking call over the `node_fs` command. */
async function callAsync(api, op, args, data) {
  if (!inTauri) throw noTauri(api, 'fs', FEATURE)
  if (!hasFeature(FEATURE)) throw featureError(api, FEATURE)
  let result
  try {
    result = await native('node_fs', encodeFrame(op, args, data))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw failure(api, 400, error)
    throw explainError(api, error)
  }
  const bytes = responseBytes(result)
  return returnsBytes(op) ? bytes : parseJson(bytes)
}

// --- arguments ---------------------------------------------------------------------------------------

function toPathString(value, name = 'path') {
  let p
  if (typeof value === 'string') {
    p = value
  } else if (value instanceof URL) {
    if (value.protocol !== 'file:') throw argError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file')
    p = fileURLToPath(value)
    if (isWindows && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\')
  } else if (value instanceof Uint8Array) {
    p = utf8.decode(value)
  } else {
    throw invalidArgType(name, 'of type string or an instance of Buffer or URL', value)
  }
  if (p.includes('\u0000')) {
    throw invalidArgValue(name, p, 'must be a string, Uint8Array, or URL without null bytes')
  }
  return p
}

let resourceDir
/** The resource directory, asked for synchronously when fs runs before the app is ready. */
function fetchResourceDir() {
  if (resourceDir !== undefined) return resourceDir
  try {
    resourceDir = inTauri ? callSync('fs', 'resourceDir', {}) : null
  } catch {
    resourceDir = null
  }
  return resourceDir
}

/**
 * The real path for a path argument. With `write`, app-relative paths are
 * refused in a build (EROFS), like writes into an Electron app's asar.
 */
function target(value, { name = 'path', write = false, syscall } = {}) {
  const p = toPathString(value, name)
  const { path, app } = resolveAppPath(p, fetchResourceDir)
  if (write && app && isPackagedBuild()) {
    throw nodeError({ code: 'EROFS', errno: isWindows ? -4043 : -30, syscall, path: p })
  }
  return path
}

function getOptions(options, defaults = {}) {
  if (options === null || options === undefined || typeof options === 'function') return { ...defaults }
  if (typeof options === 'string') return { ...defaults, encoding: options }
  if (typeof options === 'object') return { ...defaults, ...options }
  throw invalidArgType('options', 'one of type string or an instance of Object', options)
}

function checkEncoding(encoding) {
  if (encoding !== null && encoding !== undefined && encoding !== 'buffer' && !Buffer.isEncoding(encoding)) {
    throw invalidArgValue('encoding', encoding, 'is invalid encoding')
  }
}

function toBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function dataBytes(data, encoding) {
  if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8')
  if (ArrayBuffer.isView(data)) return plainBytes(data)
  throw invalidArgType('data', 'of type string or an instance of Buffer, TypedArray, or DataView', data)
}

function writeFlag(flag) {
  const f = String(flag ?? 'w')
  const exclusive = f.includes('x') ? 'x' : ''
  if (f.includes('a')) return `a${exclusive}`
  if (f.includes('w')) return `w${exclusive}`
  throw invalidArgValue('flag', flag, 'is invalid for writing a file')
}

function toMode(mode, fallback) {
  if (mode === undefined || mode === null) return fallback
  if (typeof mode === 'string' && /^[0-7]+$/.test(mode)) return parseInt(mode, 8)
  if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 0) return mode
  throw invalidArgType('mode', 'of type number or an octal string', mode)
}

function toSeconds(time, name) {
  if (time instanceof Date) return time.getTime() / 1000
  if (typeof time === 'number' && Number.isFinite(time)) return time
  if (typeof time === 'string' && time.trim() !== '' && Number.isFinite(Number(time))) return Number(time)
  if (typeof time === 'bigint') return Number(time)
  throw invalidArgType(name, 'of type number or an instance of Date', time)
}

function outOfRange(name, range, value) {
  return argError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be ${range}. Received ${value}`)
}

function toFd(fd) {
  if (typeof fd !== 'number') throw invalidArgType('fd', 'of type number', fd)
  if (!Number.isInteger(fd)) throw outOfRange('fd', 'an integer', fd)
  if (fd < 0 || fd > 2147483647) throw outOfRange('fd', '>= 0 && <= 2147483647', fd)
  return fd
}

const isFd = (value) => typeof value === 'number'

/** A file position: null (the current one) or a byte offset. -1 means current, as in Node. */
function toPosition(position) {
  if (position === null || position === undefined) return null
  if (typeof position === 'bigint') position = Number(position)
  if (typeof position !== 'number') throw invalidArgType('position', 'of type number or bigint', position)
  if (!Number.isInteger(position)) throw outOfRange('position', 'an integer', position)
  if (position === -1) return null
  if (position < 0) throw outOfRange('position', '>= -1 && <= 9007199254740991', position)
  return position
}

function toLength(value, name, max) {
  if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value)
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value)
  if (value < 0 || value > max) throw outOfRange(name, `>= 0 && <= ${max}`, value)
  return value
}

const R = { read: true }
const RW = { read: true, write: true }
const W = { write: true, create: true, truncate: true }
const WX = { ...W, exclusive: true }
const A = { append: true, create: true }
const AX = { ...A, exclusive: true }
/** Node's string flags, as what Rust opens the file with. */
const FLAGS = {
  r: R, rs: R, sr: R,
  'r+': RW, 'rs+': RW, 'sr+': RW,
  w: W, wx: WX, xw: WX,
  'w+': { ...W, read: true }, 'wx+': { ...WX, read: true }, 'xw+': { ...WX, read: true },
  a: A, as: A, sa: A, ax: AX, xa: AX,
  'a+': { ...A, read: true }, 'as+': { ...A, read: true }, 'sa+': { ...A, read: true },
  'ax+': { ...AX, read: true }, 'xa+': { ...AX, read: true },
}

/** `'r+'`, `'wx'`, `O_WRONLY | O_CREAT` (with this module's `constants`), … → open options. */
export function parseFlags(flags) {
  if (flags === undefined || flags === null) return { ...R }
  if (typeof flags === 'number' && Number.isInteger(flags)) {
    const access = flags & 3
    const append = Boolean(flags & constants.O_APPEND)
    return {
      read: access === 0 || access === 2,
      write: access === 1 || access === 2 || append,
      append,
      create: Boolean(flags & constants.O_CREAT),
      truncate: Boolean(flags & constants.O_TRUNC),
      exclusive: Boolean(flags & constants.O_EXCL),
    }
  }
  const parsed = typeof flags === 'string' ? FLAGS[flags] : undefined
  if (!parsed) throw invalidArgValue('flags', flags)
  return { ...parsed }
}

/** `read(fd, buffer, offset, length, position)` and its options forms. */
function readArgs(buffer, offset, length, position) {
  if (buffer !== null && typeof buffer === 'object' && !ArrayBuffer.isView(buffer)) {
    ;({ buffer = Buffer.alloc(16384), offset = 0, length, position = null } = buffer)
  } else if (buffer === undefined) {
    buffer = Buffer.alloc(16384)
  } else if (offset !== null && typeof offset === 'object') {
    ;({ offset = 0, length, position = null } = offset)
  }
  if (!ArrayBuffer.isView(buffer)) throw invalidArgType('buffer', 'an instance of Buffer, TypedArray, or DataView', buffer)
  offset = toLength(offset ?? 0, 'offset', buffer.byteLength)
  length = toLength(length ?? buffer.byteLength - offset, 'length', buffer.byteLength - offset)
  return { buffer, offset, length, position: toPosition(position) }
}

/** `write(fd, buffer, offset, length, position)`, `write(fd, buffer, options)`, `write(fd, string, position, encoding)`. */
function writeArgs(data, a, b, c) {
  if (typeof data === 'string') {
    const encoding = typeof b === 'string' ? b : typeof a === 'string' ? a : 'utf8'
    checkEncoding(encoding)
    return { bytes: Buffer.from(data, encoding), position: toPosition(typeof a === 'number' || typeof a === 'bigint' ? a : null), value: data }
  }
  if (!ArrayBuffer.isView(data)) {
    throw invalidArgType('buffer', 'of type string or an instance of Buffer, TypedArray, or DataView', data)
  }
  let [offset, length, position] = [a, b, c]
  if (offset !== null && typeof offset === 'object') ({ offset = 0, length, position = null } = offset)
  offset = toLength(offset ?? 0, 'offset', data.byteLength)
  length = toLength(length ?? data.byteLength - offset, 'length', data.byteLength - offset)
  return { bytes: new Uint8Array(data.buffer, data.byteOffset + offset, length), position: toPosition(position), value: data }
}

// --- Stats and Dirent --------------------------------------------------------------------------------

const STAT_FIELDS = ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']

class StatsBase {
  isFile() {
    return (Number(this.mode) & S_IFMT) === S_IFREG
  }

  isDirectory() {
    return (Number(this.mode) & S_IFMT) === S_IFDIR
  }

  isSymbolicLink() {
    return (Number(this.mode) & S_IFMT) === S_IFLNK
  }

  isBlockDevice() {
    return (Number(this.mode) & S_IFMT) === S_IFBLK
  }

  isCharacterDevice() {
    return (Number(this.mode) & S_IFMT) === S_IFCHR
  }

  isFIFO() {
    return (Number(this.mode) & S_IFMT) === S_IFIFO
  }

  isSocket() {
    return (Number(this.mode) & S_IFMT) === S_IFSOCK
  }
}

/** fs.Stats. */
export class Stats extends StatsBase {
  constructor(raw = {}) {
    super()
    for (const key of STAT_FIELDS) this[key] = Number(raw[key] ?? 0)
    this.atime = new Date(this.atimeMs)
    this.mtime = new Date(this.mtimeMs)
    this.ctime = new Date(this.ctimeMs)
    this.birthtime = new Date(this.birthtimeMs)
  }
}

/** fs.BigIntStats (`{ bigint: true }`). */
export class BigIntStats extends StatsBase {
  constructor(raw = {}) {
    super()
    for (const key of STAT_FIELDS) this[key] = BigInt(Math.trunc(Number(raw[key] ?? 0)))
    for (const time of ['atime', 'mtime', 'ctime', 'birthtime']) {
      const ms = Number(raw[`${time}Ms`] ?? 0)
      this[`${time}Ns`] = BigInt(Math.round(ms * 1e6))
      this[time] = new Date(ms)
    }
  }
}

const kType = Symbol('type')

/** fs.Dirent. */
export class Dirent {
  constructor(name, type, parentPath) {
    this.name = name
    this.parentPath = parentPath
    this.path = parentPath
    this[kType] = type
  }

  isFile() {
    return this[kType] === 'file'
  }

  isDirectory() {
    return this[kType] === 'dir'
  }

  isSymbolicLink() {
    return this[kType] === 'symlink'
  }

  isBlockDevice() {
    return this[kType] === 'block'
  }

  isCharacterDevice() {
    return this[kType] === 'char'
  }

  isFIFO() {
    return this[kType] === 'fifo'
  }

  isSocket() {
    return this[kType] === 'socket'
  }
}

const makeStats = (raw, bigint) => (bigint ? new BigIntStats(raw) : new Stats(raw))

// --- operations ------------------------------------------------------------------------------------
//
// Each operation validates its arguments and returns a plan: the Rust
// operation with its arguments, how to turn the result into Node's return
// value, and optionally which errors become a value instead (`recover`
// returns the value or rethrows). The sync,
// promise and callback variants run the same plans.

const isNotFound = (error) => error?.code === 'ENOENT'

const plans = {
  readFile(path, options) {
    const { encoding } = getOptions(options, { encoding: null, flag: 'r' })
    checkEncoding(encoding)
    return {
      // With a descriptor: from its current position to the end, like Node.
      ...(isFd(path) ? { op: 'fdRead', args: { fd: toFd(path), position: null } } : { op: 'read', args: { path: target(path) } }),
      finish: (bytes) => {
        const buffer = toBuffer(bytes)
        return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer
      },
    }
  },

  writeFile(path, data, options, defaultFlag = 'w') {
    const { encoding, mode, flag } = getOptions(options, { encoding: 'utf8', mode: 0o666, flag: defaultFlag })
    checkEncoding(encoding)
    if (isFd(path)) {
      // At the descriptor's current position, like Node.
      return { op: 'fdWrite', args: { fd: toFd(path), position: null }, data: dataBytes(data, encoding), finish: () => undefined }
    }
    return {
      op: 'write',
      args: { path: target(path, { write: true, syscall: 'open' }), flag: writeFlag(flag), mode: toMode(mode, 0o666) },
      data: dataBytes(data, encoding),
    }
  },

  appendFile(path, data, options) {
    return plans.writeFile(path, data, options, 'a')
  },

  stat(path, options, op = 'stat') {
    const { bigint = false, throwIfNoEntry = true } = getOptions(options)
    return {
      op,
      args: { path: target(path) },
      finish: (raw) => makeStats(raw, bigint),
      recover: throwIfNoEntry ? undefined : (error) => {
        if (isNotFound(error)) return undefined
        throw error
      },
    }
  },

  lstat(path, options) {
    return plans.stat(path, options, 'lstat')
  },

  exists(path) {
    return { op: 'exists', args: { path: target(path) } }
  },

  access(path, mode = F_OK) {
    return { op: 'access', args: { path: target(path), mode: toMode(mode, F_OK) } }
  },

  mkdir(path, options) {
    const { recursive = false, mode = 0o777 } = typeof options === 'number' || typeof options === 'string' ? { mode: options } : getOptions(options)
    return {
      op: 'mkdir',
      args: { path: target(path, { write: true, syscall: 'mkdir' }), recursive: Boolean(recursive), mode: toMode(mode, 0o777) },
      finish: (first) => (recursive ? (first ?? undefined) : undefined),
    }
  },

  readdir(path, options) {
    const { encoding, withFileTypes, recursive } = getOptions(options, { encoding: 'utf8', withFileTypes: false, recursive: false })
    checkEncoding(encoding)
    const shown = toPathString(path)
    const nameSep = isWindows ? '\\' : '/'
    const dirSep = /\\|^[a-zA-Z]:/.test(shown) ? '\\' : '/'
    return {
      op: 'readdir',
      args: { path: target(path), recursive: Boolean(recursive) },
      finish: (entries) =>
        entries.map(({ name, parent, type }) => {
          const parts = parent ? parent.split(/[\\/]/) : []
          if (withFileTypes) {
            const parentPath = parts.length ? [shown.replace(/[\\/]+$/, ''), ...parts].join(dirSep) : shown
            return new Dirent(encoding === 'buffer' ? Buffer.from(name) : name, type, parentPath)
          }
          const relative = [...parts, name].join(nameSep)
          return encoding === 'buffer' ? Buffer.from(relative) : relative
        }),
    }
  },

  rm(path, options) {
    const { recursive = false, force = false } = getOptions(options)
    return { op: 'rm', args: { path: target(path, { write: true, syscall: 'rm' }), recursive: Boolean(recursive), force: Boolean(force) } }
  },

  unlink(path) {
    return { op: 'unlink', args: { path: target(path, { write: true, syscall: 'unlink' }) } }
  },

  rmdir(path, options) {
    const { recursive = false } = getOptions(options)
    return { op: 'rmdir', args: { path: target(path, { write: true, syscall: 'rmdir' }), recursive: Boolean(recursive) } }
  },

  rename(oldPath, newPath) {
    return {
      op: 'rename',
      args: {
        path: target(oldPath, { name: 'oldPath', write: true, syscall: 'rename' }),
        dest: target(newPath, { name: 'newPath', write: true, syscall: 'rename' }),
      },
    }
  },

  copyFile(src, dest, mode = 0) {
    return {
      op: 'copyFile',
      args: { path: target(src, { name: 'src' }), dest: target(dest, { name: 'dest', write: true, syscall: 'copyfile' }), mode: toMode(mode, 0) },
    }
  },

  realpath(path, options) {
    const { encoding } = getOptions(options, { encoding: 'utf8' })
    checkEncoding(encoding)
    return { op: 'realpath', args: { path: target(path) }, finish: (real) => (encoding === 'buffer' ? Buffer.from(real) : real) }
  },

  mkdtemp(prefix, options) {
    const { encoding } = getOptions(options, { encoding: 'utf8' })
    checkEncoding(encoding)
    if (typeof prefix !== 'string') throw invalidArgType('prefix', 'of type string', prefix)
    return {
      op: 'mkdtemp',
      args: { prefix: target(prefix, { name: 'prefix', write: true, syscall: 'mkdtemp' }) },
      finish: (dir) => (encoding === 'buffer' ? Buffer.from(dir) : dir),
    }
  },

  truncate(path, len = 0) {
    if (isFd(path)) return plans.ftruncate(path, len)
    if (typeof len !== 'number' || !Number.isInteger(len)) throw invalidArgType('len', 'of type number', len)
    return { op: 'truncate', args: { path: target(path, { write: true, syscall: 'open' }), len: Math.max(0, len) } }
  },

  chmod(path, mode) {
    if (mode === undefined || mode === null) throw invalidArgType('mode', 'of type number or an octal string', mode)
    return { op: 'chmod', args: { path: target(path, { write: true, syscall: 'chmod' }), mode: toMode(mode, undefined) } }
  },

  utimes(path, atime, mtime) {
    return {
      op: 'utimes',
      args: { path: target(path, { write: true, syscall: 'utime' }), atime: toSeconds(atime, 'atime'), mtime: toSeconds(mtime, 'mtime') },
    }
  },

  readlink(path, options) {
    const { encoding } = getOptions(options, { encoding: 'utf8' })
    checkEncoding(encoding)
    return { op: 'readlink', args: { path: target(path) }, finish: (link) => (encoding === 'buffer' ? Buffer.from(link) : link) }
  },

  // --- file descriptors ---

  open(path, flags = 'r', mode = 0o666) {
    const options = parseFlags(flags)
    const writes = options.write || options.append || options.create || options.truncate
    return {
      op: 'open',
      args: { path: target(path, { write: writes, syscall: 'open' }), flags: options, mode: toMode(mode, 0o666) },
    }
  },

  close(fd) {
    return { op: 'close', args: { fd: toFd(fd) } }
  },

  read(fd, buffer, offset, length, position) {
    fd = toFd(fd)
    const args = readArgs(buffer, offset, length, position)
    const spread = (bytesRead) => [bytesRead, args.buffer]
    if (args.length === 0) return { constant: 0, spread }
    return {
      op: 'fdRead',
      args: { fd, length: args.length, position: args.position },
      finish: (bytes) => {
        new Uint8Array(args.buffer.buffer, args.buffer.byteOffset + args.offset, bytes.byteLength).set(bytes)
        return bytes.byteLength
      },
      spread,
    }
  },

  write(fd, data, a, b, c) {
    fd = toFd(fd)
    const { bytes, position, value } = writeArgs(data, a, b, c)
    return { op: 'fdWrite', args: { fd, position }, data: bytes, spread: (written) => [written, value] }
  },

  fstat(fd, options) {
    const { bigint = false } = getOptions(options)
    return { op: 'fstat', args: { fd: toFd(fd) }, finish: (raw) => makeStats(raw, bigint) }
  },

  fsync(fd) {
    return { op: 'fsync', args: { fd: toFd(fd) } }
  },

  fdatasync(fd) {
    return { op: 'fdatasync', args: { fd: toFd(fd) } }
  },

  ftruncate(fd, len = 0) {
    if (typeof len !== 'number' || !Number.isInteger(len)) throw invalidArgType('len', 'of type number', len)
    return { op: 'ftruncate', args: { fd: toFd(fd), len: Math.max(0, len) } }
  },

  symlink(targetPath, path, type) {
    const link = toPathString(targetPath, 'target')
    return {
      op: 'symlink',
      args: { target: link, path: target(path, { write: true, syscall: 'symlink' }), ...(type ? { type: String(type) } : {}) },
    }
  },
}

function runSync(api, plan) {
  if ('constant' in plan) return plan.constant
  let result
  try {
    result = callSync(api, plan.op, plan.args, plan.data)
  } catch (error) {
    if (!plan.recover) throw error
    return plan.recover(error)
  }
  return plan.finish ? plan.finish(result) : result === null ? undefined : result
}

async function runAsync(api, plan) {
  if ('constant' in plan) return plan.constant
  let result
  try {
    result = await callAsync(api, plan.op, plan.args, plan.data)
  } catch (error) {
    if (!plan.recover) throw error
    return plan.recover(error)
  }
  return plan.finish ? plan.finish(result) : result === null ? undefined : result
}

const syncVariant = (name) =>
  function (...args) {
    return runSync(`fs.${name}Sync`, plans[name](...args))
  }

const promiseVariant = (name) =>
  async function (...args) {
    return runAsync(`fs.promises.${name}`, plans[name](...args))
  }

/**
 * Node's callback form: the callback runs asynchronously, also on immediate
 * failure. A plan's `spread` gives the callback several values (`fs.read`'s
 * `bytesRead, buffer`). With `optional`, the callback may be left out (`fs.close`).
 */
const callbackVariant = (name, { optional = false } = {}) =>
  function (...args) {
    let callback = args.at(-1)
    if (typeof callback === 'function') args.pop()
    else if (optional) callback = () => {}
    else throw invalidArgType('cb', 'of type function', callback)
    Promise.resolve()
      .then(async () => {
        const plan = plans[name](...args)
        const value = await runAsync(`fs.${name}`, plan)
        return plan.spread ? plan.spread(value) : [value]
      })
      .then(
        (values) => queueMicrotask(() => callback(null, ...values)),
        (error) => queueMicrotask(() => callback(error)),
      )
  }

// --- the sync API --------------------------------------------------------------------------------------

export const readFileSync = syncVariant('readFile')
export const writeFileSync = syncVariant('writeFile')
export const appendFileSync = syncVariant('appendFile')
export const statSync = syncVariant('stat')
export const lstatSync = syncVariant('lstat')
export const accessSync = syncVariant('access')
export const mkdirSync = syncVariant('mkdir')
export const readdirSync = syncVariant('readdir')
export const rmSync = syncVariant('rm')
export const unlinkSync = syncVariant('unlink')
export const rmdirSync = syncVariant('rmdir')
export const renameSync = syncVariant('rename')
export const copyFileSync = syncVariant('copyFile')
export const realpathSync = Object.assign(syncVariant('realpath'), { native: syncVariant('realpath') })
export const mkdtempSync = syncVariant('mkdtemp')
export const truncateSync = syncVariant('truncate')
export const chmodSync = syncVariant('chmod')
export const utimesSync = syncVariant('utimes')
export const readlinkSync = syncVariant('readlink')
export const symlinkSync = syncVariant('symlink')
export const openSync = syncVariant('open')
export const closeSync = syncVariant('close')
export const readSync = syncVariant('read')
export const writeSync = syncVariant('write')
export const fstatSync = syncVariant('fstat')
export const fsyncSync = syncVariant('fsync')
export const fdatasyncSync = syncVariant('fdatasync')
export const ftruncateSync = syncVariant('ftruncate')

/** Never throws for a missing or invalid path, like Node; a misconfigured app still hears about it. */
export function existsSync(path) {
  try {
    return Boolean(runSync('fs.existsSync', plans.exists(path)))
  } catch (error) {
    if (error instanceof NotImplementedError) throw error
    return false
  }
}

// --- fs.promises ---------------------------------------------------------------------------------------

function notYet(api, hint) {
  return () => {
    throw unavailable(api, 'unimplemented', hint)
  }
}

// --- FileHandle (fs.promises.open) ------------------------------------------------------------------------

const kFd = Symbol('fd')
const kClosing = Symbol('closing')

function closedError(syscall) {
  return nodeError({ code: 'EBADF', errno: isWindows ? -4083 : -9, syscall })
}

/** Node's `FileHandle`, as `fs.promises.open` resolves to. */
export class FileHandle extends EventEmitter {
  constructor(fd) {
    super()
    this[kFd] = fd
    this[kClosing] = null
  }

  get fd() {
    return this[kFd]
  }

  getAsyncId() {
    return this[kFd]
  }

  _run(name, syscall, ...args) {
    if (this[kFd] < 0) return Promise.reject(closedError(syscall))
    return runAsync(`filehandle.${name}`, plans[syscall](this[kFd], ...args))
  }

  async read(buffer, offset, length, position) {
    if (this[kFd] < 0) throw closedError('read')
    const plan = plans.read(this[kFd], buffer, offset, length, position)
    const bytesRead = await runAsync('filehandle.read', plan)
    return { bytesRead, buffer: plan.spread(bytesRead)[1] }
  }

  async write(data, a, b, c) {
    if (this[kFd] < 0) throw closedError('write')
    const plan = plans.write(this[kFd], data, a, b, c)
    const bytesWritten = await runAsync('filehandle.write', plan)
    return { bytesWritten, buffer: plan.spread(bytesWritten)[1] }
  }

  readFile(options) {
    return this._run('readFile', 'readFile', options)
  }

  writeFile(data, options) {
    return this._run('writeFile', 'writeFile', data, options)
  }

  appendFile(data, options) {
    return this._run('appendFile', 'appendFile', data, options)
  }

  stat(options) {
    return this._run('stat', 'fstat', options)
  }

  sync() {
    return this._run('sync', 'fsync')
  }

  datasync() {
    return this._run('datasync', 'fdatasync')
  }

  truncate(len = 0) {
    return this._run('truncate', 'ftruncate', len)
  }

  createReadStream(options) {
    return new ReadStream(undefined, { ...getOptions(options), fd: this })
  }

  createWriteStream(options) {
    return new WriteStream(undefined, { ...getOptions(options), fd: this })
  }

  close() {
    if (this[kFd] < 0) return this[kClosing] ?? Promise.resolve()
    const fd = this[kFd]
    this[kClosing] ??= runAsync('filehandle.close', plans.close(fd)).then(() => {
      this[kFd] = -1
      this.emit('close')
    }, (error) => {
      this[kClosing] = null
      throw error
    })
    return this[kClosing]
  }

  [Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose')]() {
    return this.close()
  }
}

// --- streams -----------------------------------------------------------------------------------------------

/** What a stream's `fd` option holds: a descriptor, a FileHandle, or nothing yet. */
function streamFd(stream) {
  return stream.fd instanceof FileHandle ? stream.fd.fd : stream.fd
}

function checkStart(start, end) {
  if (start !== undefined) toLength(start, 'start', Number.MAX_SAFE_INTEGER)
  if (end !== undefined && end !== Infinity) toLength(end, 'end', Number.MAX_SAFE_INTEGER)
  if (start !== undefined && end !== undefined && start > end) {
    throw outOfRange('start', `<= "end" (here: ${end})`, start)
  }
}

/** Open the stream's file unless it was given a descriptor. */
function openStream(stream, api, callback) {
  if (stream.fd !== null && stream.fd !== undefined) {
    callback()
    return
  }
  let plan
  try {
    plan = plans.open(stream.path, stream.flags, stream.mode)
  } catch (error) {
    callback(error)
    return
  }
  runAsync(api, plan).then((fd) => {
    stream.fd = fd
    callback()
    stream.emit('open', fd)
    stream.emit('ready')
  }, callback)
}

/** Close the stream's file when it owns it (`autoClose`). */
function closeStream(stream, api, error, callback) {
  const fd = stream.fd
  if (fd === null || fd === undefined || !stream.autoClose) {
    callback(error)
    return
  }
  const closing = fd instanceof FileHandle ? fd.close() : runAsync(api, plans.close(fd))
  stream.fd = null
  closing.then(() => callback(error), (closeError) => callback(error ?? closeError))
}

/** fs.ReadStream: reads `start`…`end` (inclusive) in `highWaterMark` chunks. */
export class ReadStream extends Readable {
  constructor(path, options) {
    options = getOptions(options)
    const fd = options.fd ?? null
    if (fd !== null && !(fd instanceof FileHandle)) toFd(fd)
    checkStart(options.start, options.end)
    super({
      highWaterMark: options.highWaterMark ?? 64 * 1024,
      encoding: options.encoding ?? null,
      emitClose: options.emitClose ?? true,
      autoDestroy: options.autoDestroy ?? true,
      signal: options.signal,
    })
    this.fd = fd
    this.path = fd === null ? toPathString(path) : path
    this.flags = options.flags ?? 'r'
    this.mode = options.mode ?? 0o666
    this.start = options.start
    this.end = options.end ?? Infinity
    this.pos = options.start
    this.bytesRead = 0
    this.autoClose = options.autoClose ?? true
  }

  get pending() {
    return this.fd === null
  }

  _construct(callback) {
    openStream(this, 'fs.createReadStream', callback)
  }

  _read(size) {
    const remaining = this.end === Infinity ? size : Math.min(size, this.end - (this.pos ?? this.bytesRead) + 1)
    if (remaining <= 0) {
      this.push(null)
      return
    }
    const fd = streamFd(this)
    if (fd === undefined || fd < 0) {
      this.destroy(closedError('read'))
      return
    }
    callAsync('fs.ReadStream', 'fdRead', { fd, length: remaining, position: this.pos ?? null }).then((bytes) => {
      if (this.pos !== undefined) this.pos += bytes.byteLength
      this.bytesRead += bytes.byteLength
      this.push(bytes.byteLength ? toBuffer(bytes) : null)
    }, (error) => this.destroy(error))
  }

  _destroy(error, callback) {
    closeStream(this, 'fs.ReadStream', error, callback)
  }

  close(callback) {
    if (typeof callback === 'function') {
      if (this.closed) queueMicrotask(callback)
      else this.once('close', callback)
    }
    this.destroy()
  }
}

/** fs.WriteStream: writes at `start` (or the descriptor's position) in order. */
export class WriteStream extends Writable {
  constructor(path, options) {
    options = getOptions(options)
    const fd = options.fd ?? null
    if (fd !== null && !(fd instanceof FileHandle)) toFd(fd)
    if (options.start !== undefined) toLength(options.start, 'start', Number.MAX_SAFE_INTEGER)
    const encoding = options.encoding ?? options.defaultEncoding ?? 'utf8'
    checkEncoding(encoding)
    super({
      highWaterMark: options.highWaterMark,
      decodeStrings: true,
      defaultEncoding: encoding,
      emitClose: options.emitClose ?? true,
      autoDestroy: options.autoDestroy ?? true,
      signal: options.signal,
    })
    this.fd = fd
    this.path = fd === null ? toPathString(path) : path
    this.flags = options.flags ?? 'w'
    this.mode = options.mode ?? 0o666
    this.start = options.start
    this.pos = options.start
    this.bytesWritten = 0
    this.autoClose = options.autoClose ?? true
    this.flush = Boolean(options.flush)
  }

  get pending() {
    return this.fd === null
  }

  _construct(callback) {
    openStream(this, 'fs.createWriteStream', callback)
  }

  _write(chunk, encoding, callback) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    const fd = streamFd(this)
    if (fd === undefined || fd < 0) {
      callback(closedError('write'))
      return
    }
    callAsync('fs.WriteStream', 'fdWrite', { fd, position: this.pos ?? null }, bytes).then((written) => {
      if (this.pos !== undefined) this.pos += written
      this.bytesWritten += written
      callback()
    }, callback)
  }

  _final(callback) {
    const fd = streamFd(this)
    if (!this.flush || fd === null || fd === undefined || fd < 0) {
      callback()
      return
    }
    runAsync('fs.WriteStream', plans.fsync(fd)).then(() => callback(), callback)
  }

  _destroy(error, callback) {
    closeStream(this, 'fs.WriteStream', error, callback)
  }

  close(callback) {
    if (typeof callback === 'function') {
      if (this.closed) {
        queueMicrotask(callback)
        return
      }
      this.once('close', callback)
    }
    if (!this.autoClose) this.once('finish', () => this.destroy())
    this.end()
  }

  destroySoon() {
    this.end()
  }
}

export function createReadStream(path, options) {
  return new ReadStream(path, options)
}

export function createWriteStream(path, options) {
  return new WriteStream(path, options)
}

export const promises = {
  readFile: promiseVariant('readFile'),
  writeFile: promiseVariant('writeFile'),
  appendFile: promiseVariant('appendFile'),
  stat: promiseVariant('stat'),
  lstat: promiseVariant('lstat'),
  access: promiseVariant('access'),
  mkdir: promiseVariant('mkdir'),
  readdir: promiseVariant('readdir'),
  rm: promiseVariant('rm'),
  unlink: promiseVariant('unlink'),
  rmdir: promiseVariant('rmdir'),
  rename: promiseVariant('rename'),
  copyFile: promiseVariant('copyFile'),
  realpath: promiseVariant('realpath'),
  mkdtemp: promiseVariant('mkdtemp'),
  truncate: promiseVariant('truncate'),
  chmod: promiseVariant('chmod'),
  utimes: promiseVariant('utimes'),
  readlink: promiseVariant('readlink'),
  symlink: promiseVariant('symlink'),
  async open(path, flags, mode) {
    return new FileHandle(await runAsync('fs.promises.open', plans.open(path, flags, mode)))
  },
  constants,
}
for (const [name, hint] of [
  ['opendir', 'fs.opendir is not implemented yet: use readdir.'],
  ['cp', 'fs.cp is not implemented yet: use copyFile, mkdir and readdir.'],
  ['watch', 'fs.watch is not implemented yet.'],
  ['link', 'Hard links are not implemented yet.'],
  ['chown', 'chown is not implemented yet.'],
  ['lchown', 'lchown is not implemented yet.'],
  ['lchmod', 'lchmod is not implemented yet.'],
  ['lutimes', 'lutimes is not implemented yet.'],
  ['statfs', 'statfs is not implemented yet.'],
]) {
  const fail = notYet(`fs.promises.${name}`, hint)
  promises[name] = async (...args) => fail(...args)
}

// --- the callback API --------------------------------------------------------------------------------------

export const readFile = callbackVariant('readFile')
export const writeFile = callbackVariant('writeFile')
export const appendFile = callbackVariant('appendFile')
export const stat = callbackVariant('stat')
export const lstat = callbackVariant('lstat')
export const access = callbackVariant('access')
export const mkdir = callbackVariant('mkdir')
export const readdir = callbackVariant('readdir')
export const rm = callbackVariant('rm')
export const unlink = callbackVariant('unlink')
export const rmdir = callbackVariant('rmdir')
export const rename = callbackVariant('rename')
export const copyFile = callbackVariant('copyFile')
export const realpath = Object.assign(callbackVariant('realpath'), { native: callbackVariant('realpath') })
export const mkdtemp = callbackVariant('mkdtemp')
export const truncate = callbackVariant('truncate')
export const chmod = callbackVariant('chmod')
export const utimes = callbackVariant('utimes')
export const readlink = callbackVariant('readlink')
export const symlink = callbackVariant('symlink')
export const open = callbackVariant('open')
export const close = callbackVariant('close', { optional: true })
export const read = callbackVariant('read')
export const write = callbackVariant('write')
export const fstat = callbackVariant('fstat')
export const fsync = callbackVariant('fsync')
export const fdatasync = callbackVariant('fdatasync')
export const ftruncate = callbackVariant('ftruncate')

/** Deprecated in Node, still common: the callback gets a boolean only. */
export function exists(path, callback) {
  if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback)
  Promise.resolve()
    .then(() => runAsync('fs.exists', plans.exists(path)))
    .then(
      (value) => queueMicrotask(() => callback(Boolean(value))),
      () => queueMicrotask(() => callback(false)),
    )
}

// --- not implemented yet ---------------------------------------------------------------------------------------

export const watch = notYet('fs.watch', 'fs.watch is not implemented yet.')
export const watchFile = notYet('fs.watchFile', 'fs.watchFile is not implemented yet.')
export const unwatchFile = notYet('fs.unwatchFile', 'fs.watchFile is not implemented yet.')
export const cpSync = notYet('fs.cpSync', 'fs.cp is not implemented yet: use copyFileSync, mkdirSync and readdirSync.')
export const cp = notYet('fs.cp', 'fs.cp is not implemented yet: use copyFile, mkdir and readdir.')
export const opendirSync = notYet('fs.opendirSync', 'fs.opendir is not implemented yet: use readdirSync.')
export const opendir = notYet('fs.opendir', 'fs.opendir is not implemented yet: use readdir.')
export const linkSync = notYet('fs.linkSync', 'Hard links are not implemented yet.')
export const link = notYet('fs.link', 'Hard links are not implemented yet.')
export const chownSync = notYet('fs.chownSync', 'chown is not implemented yet.')
export const chown = notYet('fs.chown', 'chown is not implemented yet.')

// --- default export: the module object, as require('fs') returns it -------------------------------------

const fs = {
  constants, F_OK, R_OK, W_OK, X_OK, Stats, BigIntStats, Dirent, ReadStream, WriteStream, FileHandle, promises,
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync, accessSync, mkdirSync,
  readdirSync, rmSync, unlinkSync, rmdirSync, renameSync, copyFileSync, realpathSync, mkdtempSync,
  truncateSync, chmodSync, utimesSync, readlinkSync, symlinkSync,
  readFile, writeFile, appendFile, exists, stat, lstat, access, mkdir, readdir, rm, unlink, rmdir, rename,
  copyFile, realpath, mkdtemp, truncate, chmod, utimes, readlink, symlink,
  openSync, open, closeSync, close, readSync, read, writeSync, write, fstatSync, fstat, fsyncSync, fsync,
  fdatasyncSync, fdatasync, ftruncateSync, ftruncate, createReadStream, createWriteStream, watch, watchFile, unwatchFile, cpSync, cp,
  opendirSync, opendir, linkSync, link, chownSync, chown,
}

export default fs
