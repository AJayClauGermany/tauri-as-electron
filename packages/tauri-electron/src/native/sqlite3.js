/**
 * `sqlite3` (node-sqlite3) on tauri-plugin-electron's `sqlite` feature
 * (rusqlite, SQLite compiled in). The bundler plugins alias `sqlite3` here.
 *
 * The asynchronous callback API: `new Database(file, [mode], [callback])`
 * (`'open'` / `'error'` / `'close'` events), `run` (`this.lastID`,
 * `this.changes`), `get`, `all`, `each`, `map`, `exec`, `prepare` →
 * `Statement` (`bind`, `reset`, `finalize`, `run`, `get`, `all`, `each`,
 * `map`), `serialize` / `parallelize`, `configure('busyTimeout')`,
 * `interrupt`, `wait`, `close`, `verbose()`, `cached.Database`, the `OPEN_*`
 * flags and result codes. Operations run off the main thread through the
 * `sqlite` command, one after another per database: `parallelize()` is
 * accepted, and every order node-sqlite3 allows in parallel mode is one it
 * could produce. Errors read like node-sqlite3's (`SQLITE_CONSTRAINT:
 * UNIQUE constraint failed: t.x`, with `errno` and `code`).
 *
 * Not available: the `'change'` event (no update hook is forwarded),
 * `loadExtension`, and `Backup`.
 */
import { EventEmitter } from '../internal/emitter.js'
import { NotImplementedError, warnOnce } from '../internal/runtime.js'
import { encodeValue, decodeValue, resolveFilename, sqliteAsync, sqliteSync } from './sqlite-common.js'

const PKG = 'sqlite3'

export const OPEN_READONLY = 0x00000001
export const OPEN_READWRITE = 0x00000002
export const OPEN_CREATE = 0x00000004
export const OPEN_URI = 0x00000040
export const OPEN_FULLMUTEX = 0x00010000
export const OPEN_SHAREDCACHE = 0x00020000
export const OPEN_PRIVATECACHE = 0x00040000

export const OK = 0
export const ERROR = 1
export const INTERNAL = 2
export const PERM = 3
export const ABORT = 4
export const BUSY = 5
export const LOCKED = 6
export const NOMEM = 7
export const READONLY = 8
export const INTERRUPT = 9
export const IOERR = 10
export const CORRUPT = 11
export const NOTFOUND = 12
export const FULL = 13
export const CANTOPEN = 14
export const PROTOCOL = 15
export const EMPTY = 16
export const SCHEMA = 17
export const TOOBIG = 18
export const CONSTRAINT = 19
export const MISMATCH = 20
export const MISUSE = 21
export const NOLFS = 22
export const AUTH = 23
export const FORMAT = 24
export const RANGE = 25
export const NOTADB = 26

function sqliteError(code, errno, message) {
  const error = new Error(`${code}: ${message}`)
  error.errno = errno
  error.code = code
  return error
}

const closedError = () => sqliteError('SQLITE_MISUSE', MISUSE, 'Database is closed')

function toError(body) {
  if (body?.kind === 'SqliteError') return sqliteError(body.primary, body.errno, body.message)
  if (body?.message === 'The database connection is not open') return closedError()
  return sqliteError('SQLITE_ERROR', ERROR, body?.message ?? String(body))
}

function isNamed(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return !(ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp)
}

/** node-sqlite3's parameters: one array, one object of names (`$a`, `:a`, `@a`, or indexes), or the values themselves. */
function normalizeParams(params) {
  const encode = (value) => encodeValue(value, { strict: false })
  if (params.length === 1 && Array.isArray(params[0])) return { positional: params[0].map(encode) }
  if (params.length === 1 && isNamed(params[0])) {
    return { named: Object.fromEntries(Object.entries(params[0]).map(([key, value]) => [key, encode(value)])) }
  }
  return { positional: params.map(encode) }
}

/** Split trailing callbacks (`count` of them at most) from the parameters. */
function splitCallbacks(args, count = 1) {
  const list = [...args]
  const callbacks = []
  while (callbacks.length < count && typeof list[list.length - 1] === 'function') callbacks.unshift(list.pop())
  return { params: list, callbacks }
}

function rowObject(columns, values) {
  const row = {}
  columns.forEach((name, i) => {
    row[name] = decodeValue(values[i], false)
  })
  return row
}

export function Statement(db, sql, errBack) {
  if (!(this instanceof Statement)) return new Statement(db, sql, errBack)
  if (!(db instanceof Database)) throw new TypeError('Database object expected')
  if (typeof sql !== 'string') throw new TypeError('SQL query expected')
  EventEmitter.call(this)
  this.sql = sql
  this.lastID = undefined
  this.changes = undefined
  this._db = db
  this._params = { positional: [] }
  this._finalized = false
  this._errBack = typeof errBack === 'function' ? errBack : null
  // Statements of the database's own run / get / … are not prepared separately.
  this._prepared = errBack === DIRECT ? Promise.resolve() : db._enqueue(() => db._op('prepare', { sql }))
  if (errBack !== DIRECT) {
    this._prepared.catch((error) => {
      this._failure = error
      if (this._errBack) this._errBack.call(this, error)
      else this._report(error)
    })
  }
}
Object.setPrototypeOf(Statement.prototype, EventEmitter.prototype)

const DIRECT = Symbol('direct statement')

Object.assign(Statement.prototype, {
  _report(error, callback) {
    if (callback) return callback.call(this, error)
    if (this.listenerCount('error')) return this.emit('error', error)
    if (this._db.listenerCount('error')) return this._db.emit('error', error)
    console.error('[tauri-electron] sqlite3:', error)
  },

  /** Queue `task` after the prepare; `callback` gets its error or calls `done`. */
  _schedule(callback, task, done) {
    const db = this._db
    db._enqueue(async () => {
      await this._prepared.catch(() => {})
      if (this._failure) {
        // Already reported to the database method's callback.
        if (!this._errBack) this._report(this._failure, callback)
        return
      }
      if (this._finalized) return this._report(sqliteError('SQLITE_MISUSE', MISUSE, 'Statement is already finalized'), callback)
      let result
      try {
        result = await task()
      } catch (error) {
        return this._report(error, callback)
      }
      done(result)
    })
    return this
  },

  _withParams(args) {
    if (args.length) this._params = normalizeParams(args)
    return this._params
  },

  bind(...args) {
    const { params, callbacks } = splitCallbacks(args)
    const callback = callbacks[0]
    this._withParams(params)
    return this._schedule(callback, async () => null, () => callback?.call(this, null))
  },

  reset(callback) {
    return this._schedule(callback, async () => null, () => callback?.call(this, null))
  },

  finalize(callback) {
    const db = this._db
    db._enqueue(async () => {
      this._finalized = true
      callback?.call(this, null)
    })
    return db
  },

  run(...args) {
    const { params, callbacks } = splitCallbacks(args)
    const callback = callbacks[0]
    const bound = this._withParams(params)
    return this._schedule(
      callback,
      () => this._db._op('run', { sql: this.sql, params: bound }),
      (answer) => {
        this.lastID = Number(decodeValue(answer.lastInsertRowid, false))
        this.changes = answer.changes
        callback?.call(this, null)
      },
    )
  },

  get(...args) {
    const { params, callbacks } = splitCallbacks(args)
    const callback = callbacks[0]
    const bound = this._withParams(params)
    return this._schedule(
      callback,
      () => this._db._op('query', { sql: this.sql, params: bound, first: true }),
      (answer) => callback?.call(this, null, answer.rows.length ? rowObject(answer.columns, answer.rows[0]) : undefined),
    )
  },

  all(...args) {
    const { params, callbacks } = splitCallbacks(args)
    const callback = callbacks[0]
    const bound = this._withParams(params)
    return this._schedule(
      callback,
      () => this._db._op('query', { sql: this.sql, params: bound }),
      (answer) => callback?.call(this, null, answer.rows.map((values) => rowObject(answer.columns, values))),
    )
  },

  each(...args) {
    const { params, callbacks } = splitCallbacks(args, 2)
    const [onRow, onComplete] = callbacks
    const bound = this._withParams(params)
    // Errors go to the row callback, as in node-sqlite3.
    return this._schedule(
      onRow ?? onComplete,
      () => this._db._op('query', { sql: this.sql, params: bound }),
      (answer) => {
        for (const values of answer.rows) onRow?.call(this, null, rowObject(answer.columns, values))
        onComplete?.call(this, null, answer.rows.length)
      },
    )
  },

  map(...args) {
    const { params, callbacks } = splitCallbacks(args)
    const callback = callbacks[0]
    return this.all(...params, (error, rows) => {
      if (error) return callback?.call(this, error)
      const result = {}
      if (rows.length) {
        const keys = Object.keys(rows[0])
        const [key, value] = keys
        for (const row of rows) result[row[key]] = keys.length > 2 ? row : row[value]
      }
      callback?.call(this, null, result)
    })
  },
})

export function Database(filename, mode, callback) {
  if (!(this instanceof Database)) return new Database(filename, mode, callback)
  if (typeof filename !== 'string') throw new TypeError('Filename expected')
  if (typeof mode === 'function') {
    callback = mode
    mode = undefined
  }
  if (mode !== undefined && mode !== null && typeof mode !== 'number') throw new TypeError('Mode must be an integer')
  EventEmitter.call(this)
  this.filename = filename
  this.mode = mode ?? (OPEN_READWRITE | OPEN_CREATE | OPEN_FULLMUTEX)
  this.open = false
  this._id = null
  this._tail = Promise.resolve()
  this._enqueue(async () => {
    try {
      const { id } = await sqliteAsync('new sqlite3.Database()', PKG, 'open', { flavor: PKG, filename: resolveFilename(filename), mode: this.mode }, toError)
      this._id = id
      this.open = true
    } catch (error) {
      if (typeof callback === 'function') callback.call(this, error)
      else this.emit('error', error)
      return
    }
    if (typeof callback === 'function') callback.call(this, null)
    this.emit('open')
  })
}
Object.setPrototypeOf(Database.prototype, EventEmitter.prototype)

const TRACED = new Set(['trace', 'profile', 'change'])

Object.assign(Database.prototype, {
  /** Run `task` after everything queued before it. */
  _enqueue(task) {
    const run = this._tail.then(task)
    this._tail = run.catch(() => {})
    return run
  },

  /** One operation on the open database (called from the queue). */
  async _op(op, request) {
    if (this._id === null) throw closedError()
    const sql = request.sql
    if (sql !== undefined && op !== 'prepare' && this.listenerCount('trace')) this.emit('trace', sql)
    const started = Date.now()
    const answer = await sqliteAsync(`Database.${op}`, PKG, op, { ...request, id: this._id }, toError)
    if (sql !== undefined && op !== 'prepare' && this.listenerCount('profile')) this.emit('profile', sql, Date.now() - started)
    return answer
  },

  /** node-sqlite3's database methods: a one-off statement that reports errors to the callback. */
  _direct(method, sql, args) {
    new Statement(this, sql, DIRECT)[method](...args)
    return this
  },

  run(sql, ...args) {
    return this._direct('run', sql, args)
  },

  get(sql, ...args) {
    return this._direct('get', sql, args)
  },

  all(sql, ...args) {
    return this._direct('all', sql, args)
  },

  each(sql, ...args) {
    return this._direct('each', sql, args)
  },

  map(sql, ...args) {
    return this._direct('map', sql, args)
  },

  prepare(sql, ...args) {
    const { params, callbacks } = splitCallbacks(args)
    const statement = new Statement(this, sql, callbacks[0] ? (error) => callbacks[0].call(statement, error) : undefined)
    if (params.length || callbacks.length) statement.bind(...params, (error) => !error && callbacks[0]?.call(statement, null))
    return statement
  },

  exec(sql, callback) {
    this._enqueue(async () => {
      try {
        await this._op('exec', { sql })
      } catch (error) {
        if (callback) return callback.call(this, error)
        if (this.listenerCount('error')) return this.emit('error', error)
        return console.error('[tauri-electron] sqlite3:', error)
      }
      callback?.call(this, null)
    })
    return this
  },

  serialize(callback) {
    callback?.()
    return this
  },

  parallelize(callback) {
    callback?.()
    return this
  },

  configure(option, value) {
    if (option === 'busyTimeout') {
      this._enqueue(() => this._op('busyTimeout', { ms: Number(value) || 0 }).catch((error) => this.emit('error', error)))
    } else if (option === 'change') {
      warnOnce('sqlite3 change', "sqlite3: the 'change' event is not emitted on Tauri (no update hook).")
    }
    return this
  },

  on(name, listener) {
    EventEmitter.prototype.on.call(this, name, listener)
    if (TRACED.has(name)) this.configure(name, true)
    return this
  },

  interrupt() {
    if (this._id !== null) sqliteAsync('Database.interrupt', PKG, 'interrupt', { id: this._id }, toError).catch(() => {})
    return this
  },

  wait(callback) {
    this._enqueue(async () => callback?.call(this, null))
    return this
  },

  loadExtension(path, callback) {
    const error = new NotImplementedError('sqlite3 Database#loadExtension', { reason: 'unimplemented', hint: 'SQLite extensions are not loaded by tauri-plugin-electron.' })
    this._enqueue(async () => {
      if (callback) callback.call(this, error)
      else this.emit('error', error)
    })
    return this
  },

  close(callback) {
    this._enqueue(async () => {
      if (this._id === null) {
        const error = closedError()
        if (callback) return callback.call(this, error)
        return this.emit('error', error)
      }
      try {
        await this._op('close', {})
      } catch (error) {
        if (callback) return callback.call(this, error)
        return this.emit('error', error)
      }
      this._id = null
      this.open = false
      callback?.call(this, null)
      this.emit('close')
    })
    return this
  },
})
Database.prototype.addListener = Database.prototype.on

/** `sqlite3.cached.Database(file)`: one Database per file name. */
const cachedObjects = {}
export const cached = {
  Database(file, mode, callback) {
    if (file === '' || file === ':memory:') return new Database(file, mode, callback)
    if (typeof mode === 'function') {
      callback = mode
      mode = undefined
    }
    let db = cachedObjects[file]
    if (!db) {
      db = cachedObjects[file] = new Database(file, mode, callback)
    } else if (typeof callback === 'function') {
      const report = () => callback.call(db, null)
      if (db.open) queueMicrotask(report)
      else db.once('open', report)
    }
    return db
  },
  objects: cachedObjects,
}

let versionInfo = null
function version() {
  versionInfo ??= sqliteSync('sqlite3.VERSION', PKG, 'version', {}, toError)
  return versionInfo
}

const sqlite3 = {
  Database,
  Statement,
  cached,
  OPEN_READONLY,
  OPEN_READWRITE,
  OPEN_CREATE,
  OPEN_URI,
  OPEN_FULLMUTEX,
  OPEN_SHAREDCACHE,
  OPEN_PRIVATECACHE,
  OK, ERROR, INTERNAL, PERM, ABORT, BUSY, LOCKED, NOMEM, READONLY, INTERRUPT, IOERR, CORRUPT, NOTFOUND, FULL,
  CANTOPEN, PROTOCOL, EMPTY, SCHEMA, TOOBIG, CONSTRAINT, MISMATCH, MISUSE, NOLFS, AUTH, FORMAT, RANGE, NOTADB,
  /** Long stack traces in node-sqlite3; here the module itself. */
  verbose() {
    return sqlite3
  },
}
Object.defineProperties(sqlite3, {
  VERSION: { enumerable: true, get: () => version().version },
  VERSION_NUMBER: { enumerable: true, get: () => version().number },
  SOURCE_ID: { enumerable: true, get: () => version().sourceId },
})

export function verbose() {
  return sqlite3
}

export default sqlite3
