/**
 * `better-sqlite3` on tauri-plugin-electron's `sqlite` feature (rusqlite,
 * SQLite compiled in). The bundler plugins alias `better-sqlite3` here.
 *
 * Synchronous, like better-sqlite3: every call is a blocking request over
 * the bridge (`node/sqlite/<op>`). The database lives in Rust; a `Statement`
 * keeps its SQL, which Rust runs through the connection's statement cache.
 * Supported: `new Database(file | buffer, { readonly, fileMustExist,
 * timeout, verbose })`, `prepare` (`run`, `get`, `all`, `iterate`, `pluck`,
 * `expand`, `raw`, `bind`, `columns`, `safeIntegers`), `exec`, `pragma`,
 * `transaction` (and `.deferred` / `.immediate` / `.exclusive`), `backup`,
 * `serialize`, `function`, `defaultSafeIntegers`, `close`, and the `open`,
 * `inTransaction`, `name`, `memory`, `readonly` properties.
 *
 * Differences: `iterate()` reads every row before yielding the first;
 * `function()`'s JavaScript runs between runs of the statement, once per
 * distinct argument list (results are memoised for that statement call; see
 * sqlite.rs), so deterministic functions behave as in better-sqlite3, and
 * functions with side effects or random results do not; `aggregate`,
 * `table` and `loadExtension` throw. SQLite is libsqlite3-sys's build
 * (FTS5, JSON, R*Tree; foreign keys on, double-quoted strings off, as in
 * better-sqlite3's).
 */
import { Buffer } from '../node/buffer.js'
import { NotImplementedError } from '../internal/runtime.js'
import { encodeValue, decodeValue, resolveFilename, sqliteSync, sqliteAsync } from './sqlite-common.js'

const PKG = 'better-sqlite3'

/** better-sqlite3's error for SQLite failures: `code` is the (extended) result code's name. */
export class SqliteError extends Error {
  constructor(message, code) {
    if (typeof code !== 'string') throw new TypeError('Expected second argument to be a string')
    super(message)
    this.code = code
  }
}
Object.defineProperty(SqliteError.prototype, 'name', { value: 'SqliteError', writable: true, configurable: true })

function toError(body) {
  switch (body?.kind) {
    case 'SqliteError':
      return new SqliteError(body.message, body.code)
    case 'TypeError':
      return new TypeError(body.message)
    case 'RangeError':
      return new RangeError(body.message)
    default:
      return new Error(body?.message ?? String(body))
  }
}

function booleanOption(options, key) {
  const value = key in options ? options[key] : false
  if (typeof value !== 'boolean') throw new TypeError(`Expected the "${key}" option to be a boolean`)
  return value
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** better-sqlite3's parameters: arrays spread, one plain object of named values, the rest positional. */
function collectParameters(args) {
  const positional = []
  let named = null
  const add = (value) => {
    if (isPlainObject(value)) {
      if (named) throw new TypeError('You cannot specify named parameters in two different objects')
      named = Object.fromEntries(Object.entries(value).map(([key, v]) => [key, encodeValue(v)]))
    } else {
      positional.push(encodeValue(value))
    }
  }
  for (const arg of args) {
    if (Array.isArray(arg)) arg.forEach(add)
    else add(arg)
  }
  return { positional, named }
}

const MODES = new Set(['normal', 'pluck', 'expand', 'raw'])

export class Statement {
  constructor(db, source, pragmaMode = false) {
    const info = db._call('prepare', 'prepare', { sql: source })
    Object.defineProperties(this, {
      database: { value: db, enumerable: true },
      source: { value: source, enumerable: true },
      reader: { value: Boolean(info.reader || pragmaMode), enumerable: true },
      readonly: { value: Boolean(info.readonly), enumerable: true },
      busy: { value: false, enumerable: true },
      _info: { value: info },
      _mode: { value: 'normal', writable: true },
      _safe: { value: db._safe, writable: true },
      _bound: { value: null, writable: true },
    })
  }

  _setMode(mode, toggle, method) {
    if (!this.reader) throw new TypeError(`The ${method}() method is only for statements that return data`)
    this._mode = toggle === undefined || toggle ? mode : this._mode === mode ? 'normal' : this._mode
    return this
  }

  pluck(toggle) {
    return this._setMode('pluck', toggle, 'pluck')
  }

  expand(toggle) {
    return this._setMode('expand', toggle, 'expand')
  }

  raw(toggle) {
    return this._setMode('raw', toggle, 'raw')
  }

  safeIntegers(toggle) {
    this._safe = toggle === undefined ? true : Boolean(toggle)
    return this
  }

  columns() {
    if (!this.reader) throw new TypeError('The columns() method is only for statements that return data')
    return this._info.columns.map((c) => ({ name: c.name, column: c.column ?? null, table: c.table ?? null, database: c.database ?? null, type: c.type ?? null }))
  }

  bind(...args) {
    if (this._bound) throw new TypeError('The bind() method can only be invoked once per statement object')
    this._bound = collectParameters(args)
    return this
  }

  _params(args) {
    if (this._bound) {
      if (args.length) throw new TypeError('This statement already has bound parameters')
      return this._bound
    }
    return collectParameters(args)
  }

  _needsData() {
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead')
  }

  _row(columns, values) {
    switch (this._mode) {
      case 'raw':
        return values.map((v) => decodeValue(v, this._safe))
      case 'pluck':
        return decodeValue(values[0], this._safe)
      case 'expand': {
        const row = {}
        values.forEach((value, i) => {
          const table = this._info.columns[i]?.table ?? '$'
          row[table] ??= {}
          row[table][columns[i]] = decodeValue(value, this._safe)
        })
        return row
      }
      default: {
        const row = {}
        values.forEach((value, i) => {
          row[columns[i]] = decodeValue(value, this._safe)
        })
        return row
      }
    }
  }

  _query(args, first) {
    const params = this._params(args)
    const answer = this.database._execute('query', { sql: this.source, params, safe: this._safe, first })
    return answer.rows.map((values) => this._row(answer.columns, values))
  }

  run(...args) {
    const params = this._params(args)
    const answer = this.database._execute('run', { sql: this.source, params, safe: this._safe })
    return { changes: answer.changes, lastInsertRowid: decodeValue(answer.lastInsertRowid, this._safe) }
  }

  get(...args) {
    this._needsData()
    return this._query(args, true)[0]
  }

  all(...args) {
    this._needsData()
    return this._query(args, false)
  }

  /** All rows are read first (the statement does not stay open between rows). */
  iterate(...args) {
    this._needsData()
    const rows = this._query(args, false)
    return (function* rowsOf() {
      yield* rows
    })()
  }
}

// --- transactions (better-sqlite3's lib/methods/transaction.js) ------------------------------------

const BEGIN = { default: 'BEGIN', deferred: 'BEGIN DEFERRED', immediate: 'BEGIN IMMEDIATE', exclusive: 'BEGIN EXCLUSIVE' }

function wrapTransaction(fn, db, begin) {
  return function sqliteTransaction(...args) {
    const nested = db.inTransaction
    db.exec(nested ? 'SAVEPOINT `\t_bs3.\t`' : begin)
    try {
      const result = fn.apply(this, args)
      if (result && typeof result.then === 'function') throw new TypeError('Transaction function cannot return a promise')
      db.exec(nested ? 'RELEASE `\t_bs3.\t`' : 'COMMIT')
      return result
    } catch (error) {
      if (db.inTransaction) {
        db.exec(nested ? 'ROLLBACK TO `\t_bs3.\t`' : 'ROLLBACK')
        if (nested) db.exec('RELEASE `\t_bs3.\t`')
      }
      throw error
    }
  }
}

// --- the database ----------------------------------------------------------------------------------

export default function Database(filenameGiven, options) {
  if (new.target == null) return new Database(filenameGiven, options)
  if (filenameGiven == null) filenameGiven = ''
  if (options == null) options = {}
  let buffer = null
  if (Buffer.isBuffer(filenameGiven) || filenameGiven instanceof Uint8Array) {
    buffer = filenameGiven
    filenameGiven = ':memory:'
  }
  if (typeof filenameGiven !== 'string') throw new TypeError('Expected first argument to be a string')
  if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object')
  if ('readOnly' in options) throw new TypeError('Misspelled option "readOnly" should be "readonly"')
  if ('memory' in options) throw new TypeError('Option "memory" was removed in v7.0.0 (use ":memory:" filename instead)')

  const filename = filenameGiven.trim()
  const anonymous = filename === '' || filename === ':memory:'
  const readonly = booleanOption(options, 'readonly')
  const fileMustExist = booleanOption(options, 'fileMustExist')
  const timeout = 'timeout' in options ? options.timeout : 5000
  const verbose = 'verbose' in options ? options.verbose : null
  if (readonly && anonymous && !buffer) throw new TypeError('In-memory/temporary databases cannot be readonly')
  if (!Number.isInteger(timeout) || timeout < 0) throw new TypeError('Expected the "timeout" option to be a positive integer')
  if (timeout > 0x7fffffff) throw new RangeError('Option "timeout" cannot be greater than 2147483647')
  if (verbose != null && typeof verbose !== 'function') throw new TypeError('Expected the "verbose" option to be a function')

  Object.defineProperties(this, {
    name: { value: filename, enumerable: true },
    memory: { value: anonymous, enumerable: true },
    readonly: { value: readonly, enumerable: true },
    _safe: { value: false, writable: true },
    _verbose: { value: verbose },
    _functions: { value: new Map() },
    _id: { value: null, writable: true },
  })
  const request = { flavor: PKG, filename: resolveFilename(filename), readonly, fileMustExist, timeout }
  if (buffer) request.data = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('base64')
  this._id = sqliteSync('new Database()', PKG, 'open', request, toError).id
}

Object.defineProperties(Database.prototype, {
  open: {
    get() {
      return this._id !== null
    },
  },
  inTransaction: {
    get() {
      if (this._id === null) return false
      return Boolean(this._call('inTransaction', 'status', {}).inTransaction)
    },
  },
})

Object.assign(Database.prototype, {
  /** A blocking call for this database. */
  _call(api, op, request, binary = false) {
    if (this._id === null) throw new TypeError('The database connection is not open')
    return sqliteSync(`Database.${api}`, PKG, op, { ...request, id: this._id }, toError, binary)
  },

  /** `run` / `query` / `exec`, computing the user functions SQLite asked for (see sqlite.rs). */
  _execute(op, request) {
    this._verbose?.(request.sql)
    let answer = this._call(op, op, request)
    for (let round = 1; answer?.needs; round++) {
      if (round > 64) throw new Error('User-defined functions kept asking for new values (more than 64 rounds)')
      const memo = answer.needs.map(({ name, args, key }) => {
        const entry = this._functions.get(name)
        if (!entry) throw new Error(`User-defined function ${name}() is not registered`)
        const safe = entry.safeIntegers ?? this._safe
        const result = entry.fn.apply(null, args.map((a) => decodeValue(a, safe)))
        return { key, value: encodeValue(result, { message: `User-defined function ${name}() returned an invalid value` }) }
      })
      answer = this._call(op, op, { ...request, retry: true, memo })
    }
    return answer
  },

  prepare(sql, _db, pragmaMode = false) {
    if (typeof sql !== 'string') throw new TypeError('Expected first argument to be a string')
    return new Statement(this, sql, pragmaMode === true)
  },

  exec(sql) {
    if (typeof sql !== 'string') throw new TypeError('Expected first argument to be a string')
    this._execute('exec', { sql })
    return this
  },

  pragma(source, options) {
    if (options == null) options = {}
    if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string')
    if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object')
    const simple = booleanOption(options, 'simple')
    const stmt = this.prepare(`PRAGMA ${source}`, this, true)
    return simple ? stmt.pluck().get() : stmt.all()
  },

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function')
    const variants = Object.fromEntries(Object.entries(BEGIN).map(([kind, begin]) => [kind, wrapTransaction(fn, this, begin)]))
    const properties = {
      default: { value: variants.default },
      deferred: { value: variants.deferred },
      immediate: { value: variants.immediate },
      exclusive: { value: variants.exclusive },
      database: { value: this, enumerable: true },
    }
    for (const variant of Object.values(variants)) Object.defineProperties(variant, properties)
    return variants.default
  },

  async backup(filename, options) {
    if (options == null) options = {}
    if (typeof filename !== 'string') throw new TypeError('Expected first argument to be a string')
    if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object')
    filename = filename.trim()
    const attached = 'attached' in options ? options.attached : 'main'
    const progress = 'progress' in options ? options.progress : null
    if (!filename) throw new TypeError('Backup filename cannot be an empty string')
    if (filename === ':memory:') throw new TypeError('Invalid backup filename ":memory:"')
    if (typeof attached !== 'string') throw new TypeError('Expected the "attached" option to be a string')
    if (!attached) throw new TypeError('The "attached" option cannot be an empty string')
    if (progress != null && typeof progress !== 'function') throw new TypeError('Expected the "progress" option to be a function')
    if (this._id === null) throw new TypeError('The database connection is not open')
    const result = await sqliteAsync('Database.backup', PKG, 'backup', { id: this._id, destination: resolveFilename(filename), attached }, toError)
    progress?.({ totalPages: result.totalPages, remainingPages: result.remainingPages })
    return result
  },

  serialize(options) {
    if (options == null) options = {}
    if (typeof options !== 'object') throw new TypeError('Expected first argument to be an options object')
    const attached = 'attached' in options ? options.attached : 'main'
    if (typeof attached !== 'string') throw new TypeError('Expected the "attached" option to be a string')
    if (!attached) throw new TypeError('The "attached" option cannot be an empty string')
    const bytes = this._call('serialize', 'serialize', { attached }, true)
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  },

  function(name, options, fn) {
    if (options == null) options = {}
    if (typeof options === 'function') {
      fn = options
      options = {}
    }
    if (typeof name !== 'string') throw new TypeError('Expected first argument to be a string')
    if (typeof fn !== 'function') throw new TypeError('Expected last argument to be a function')
    if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object')
    if (!name) throw new TypeError('User-defined function name cannot be an empty string')
    const safeIntegers = 'safeIntegers' in options ? booleanOption(options, 'safeIntegers') : null
    const deterministic = booleanOption(options, 'deterministic')
    const directOnly = booleanOption(options, 'directOnly')
    const varargs = booleanOption(options, 'varargs')
    let args = -1
    if (!varargs) {
      args = fn.length
      if (!Number.isInteger(args) || args < 0) throw new TypeError('Expected function.length to be a positive integer')
      if (args > 100) throw new RangeError('User-defined functions cannot have more than 100 arguments')
    }
    this._call('function', 'function', { name, args, deterministic, directOnly, varargs })
    this._functions.set(name, { fn, safeIntegers })
    return this
  },

  aggregate(name) {
    throw new NotImplementedError(`Database.aggregate('${name}')`, {
      reason: 'unsupported',
      hint: 'SQLite runs in Rust while the calling page waits, so it cannot call back into JavaScript for every row. Compute the aggregate in JavaScript over all(), or with SQL.',
    })
  },

  table(name) {
    throw new NotImplementedError(`Database.table('${name}')`, {
      reason: 'unsupported',
      hint: 'Virtual tables written in JavaScript need SQLite to call back into the page while it waits.',
    })
  },

  loadExtension() {
    throw new NotImplementedError('Database.loadExtension', { reason: 'unimplemented', hint: 'SQLite extensions are not loaded by tauri-plugin-electron.' })
  },

  defaultSafeIntegers(toggle) {
    this._safe = toggle === undefined ? true : Boolean(toggle)
    return this
  },

  unsafeMode(toggle) {
    // Rows are read whole, so the database is never busy between rows: nothing to relax.
    void toggle
    return this
  },

  close() {
    if (this._id !== null) {
      this._call('close', 'close', {})
      this._id = null
    }
    return this
  },
})

Database.SqliteError = SqliteError
