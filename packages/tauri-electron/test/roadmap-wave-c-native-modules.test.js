import { beforeEach, describe, expect, it, vi } from 'vitest'
import nodeFs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Roadmap wave C, item C5: keytar, better-sqlite3, sqlite3 and node-pty on
// tauri-plugin-electron's keytar / sqlite / pty features, aliased by the
// bundler plugins. tauri-plugin-electron is replaced by a scripted fake of its
// synchronous bridge and commands; the Rust side has its own unit tests
// (crates/tauri-plugin-electron/src/native_modules/).
const state = vi.hoisted(() => ({ sync: [], commands: [], onSync: null, onCommand: null, channels: [] }))

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal()
  class Channel {
    constructor() {
      this.onmessage = () => {}
      state.channels.push(this)
    }
  }
  return { ...actual, Channel }
})
vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true, isMainProcess: true }))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  const json = (value) => new TextEncoder().encode(JSON.stringify(value))
  return {
    ...actual,
    hasFeature: () => true,
    syncRequestBytes(path, { query, body } = {}) {
      const request = body ? JSON.parse(new TextDecoder().decode(body)) : null
      state.sync.push({ path, request })
      const { status = 200, value, bytes } = state.onSync?.(path, request) ?? {}
      return { status, bytes: bytes ?? json(value ?? null) }
    },
    async native(command, args) {
      state.commands.push({ command, args })
      return state.onCommand?.(command, args)
    },
  }
})

const keytar = await import('../src/native/keytar.js')
const { default: Database, SqliteError } = await import('../src/native/better-sqlite3.js')
const sqlite3 = (await import('../src/native/sqlite3.js')).default
const pty = await import('../src/native/node-pty.js')
const { requireShim } = await import('../src/require.js')
const { default: processShim } = await import('../src/process.js')
const { Buffer } = await import('../src/node/buffer.js')
const shared = createRequire(import.meta.url)('../bundler/shared.cjs')
const { redirect } = createRequire(import.meta.url)('../webpack.cjs')
const tauriElectron = (await import('../vite.js')).default

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick()
}
const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value))

beforeEach(() => {
  state.sync = []
  state.commands = []
  state.channels = []
  state.onSync = null
  state.onCommand = null
  processShim.cwd = () => '/work'
  processShim.platform = 'linux'
})

// --- keytar --------------------------------------------------------------------------------------------

describe('keytar', () => {
  it('passes each call to the keytar command', async () => {
    state.onCommand = (command, { request }) => ({ get: 'hunter2', set: null, delete: true, find: [{ account: 'a', password: 'p' }], findOne: 'p' })[request.op]
    expect(await keytar.getPassword('svc', 'me')).toBe('hunter2')
    expect(await keytar.setPassword('svc', 'me', 'pw')).toBeUndefined()
    expect(await keytar.deletePassword('svc', 'me')).toBe(true)
    expect(await keytar.findCredentials('svc')).toEqual([{ account: 'a', password: 'p' }])
    expect(await keytar.findPassword('svc')).toBe('p')
    expect(state.commands.map((c) => c.args.request)).toEqual([
      { op: 'get', service: 'svc', account: 'me' },
      { op: 'set', service: 'svc', account: 'me', password: 'pw' },
      { op: 'delete', service: 'svc', account: 'me' },
      { op: 'find', service: 'svc' },
      { op: 'findOne', service: 'svc' },
    ])
    expect(state.commands.every((c) => c.command === 'keytar')).toBe(true)
    expect(keytar.default.getPassword).toBe(keytar.getPassword)
  })

  it('checks its arguments synchronously, as keytar does', () => {
    expect(() => keytar.getPassword('', 'me')).toThrow('Service is required.')
    expect(() => keytar.setPassword('svc', 'me', '')).toThrow('Password is required.')
    expect(state.commands).toHaveLength(0)
  })

  it('rejects with the keychain error, and explains refusals', async () => {
    state.onCommand = () => {
      throw { message: 'The name org.freedesktop.secrets was not provided by any .service files' }
    }
    await expect(keytar.getPassword('svc', 'me')).rejects.toThrow(/org\.freedesktop\.secrets/)
    state.onCommand = () => {
      throw { code: 'ERR_FEATURE_DISABLED', feature: 'keytar' }
    }
    const off = await keytar.getPassword('svc', 'me').catch((e) => e)
    expect(off).toMatchObject({ name: 'NotImplementedError', reason: 'feature' })
    expect(off.message).toMatch(/"keytar"/)
    state.onCommand = () => {
      throw { code: 'ERR_ACCESS_DENIED', message: 'Node built-ins … are only available in the main process' }
    }
    const denied = await keytar.findCredentials('svc').catch((e) => e)
    expect(denied).toMatchObject({ reason: 'permission' })
    expect(denied.message).toMatch(/Use keytar in the main process/)
  })
})

// --- better-sqlite3 ---------------------------------------------------------------------------------------

/** A fake database answering better-sqlite3's bridge calls from a script. */
function fakeSqlite(handlers = {}) {
  state.onSync = (path, request) => {
    const op = path.replace('node/sqlite/', '')
    if (handlers[op]) return handlers[op](request)
    if (op === 'open') return { value: { id: 7 } }
    if (op === 'prepare') return { value: { reader: /^\s*(select|pragma)/i.test(request.sql), readonly: /^\s*select/i.test(request.sql), columns: [], params: [] } }
    if (op === 'status') return { value: { inTransaction: false } }
    return { value: null }
  }
}

describe('better-sqlite3', () => {
  it('opens databases like better-sqlite3 (paths from process.cwd(), options checked)', () => {
    fakeSqlite()
    const db = new Database('data/app.db', { fileMustExist: true, timeout: 100 })
    expect(state.sync[0]).toEqual({ path: 'node/sqlite/open', request: { flavor: 'better-sqlite3', filename: '/work/data/app.db', readonly: false, fileMustExist: true, timeout: 100 } })
    expect(db).toMatchObject({ name: 'data/app.db', memory: false, readonly: false, open: true })
    expect(Database(':memory:')).toBeInstanceOf(Database)
    expect(new Database(':memory:').memory).toBe(true)
    expect(() => new Database(':memory:', { readonly: true })).toThrow('In-memory/temporary databases cannot be readonly')
    expect(() => new Database('x.db', { readOnly: true })).toThrow(/Misspelled option "readOnly"/)
    expect(() => new Database('x.db', { timeout: -1 })).toThrow(TypeError)
    // A serialized database (better-sqlite3 8+).
    new Database(Buffer.from([1, 2, 3]))
    expect(state.sync.at(-1).request).toMatchObject({ filename: ':memory:', data: 'AQID' })
  })

  it('prepares statements and binds anonymous, named, BigInt and Buffer parameters', () => {
    fakeSqlite({
      prepare: () => ({ value: { reader: false, readonly: false, columns: [], params: ['@name', null] } }),
      run: () => ({ value: { changes: 1, lastInsertRowid: { $i: '9007199254740993' } } }),
    })
    const db = new Database(':memory:')
    const insert = db.prepare('INSERT INTO t (name, data) VALUES (@name, ?)')
    expect(insert).toMatchObject({ source: 'INSERT INTO t (name, data) VALUES (@name, ?)', reader: false, readonly: false, busy: false, database: db })
    const result = insert.safeIntegers().run({ name: 'x' }, [Buffer.from('hi')])
    expect(result).toEqual({ changes: 1, lastInsertRowid: 9007199254740993n })
    expect(state.sync.at(-1)).toEqual({
      path: 'node/sqlite/run',
      request: { id: 7, sql: insert.source, safe: true, params: { positional: [{ $b: 'aGk=' }], named: { name: 'x' } } },
    })
    insert.run(1.5, 10n, null, undefined, 'text', NaN)
    expect(state.sync.at(-1).request.params.positional).toEqual([1.5, { $i: '10' }, null, null, 'text', { $f: 'NaN' }])
    expect(() => insert.run(true)).toThrow('SQLite3 can only bind numbers, strings, bigints, buffers, and null')
    expect(() => insert.run(2n ** 64n)).toThrow(RangeError)
    expect(() => insert.run({ a: 1 }, { b: 2 })).toThrow('You cannot specify named parameters in two different objects')
    // bind() once, then no more parameters.
    insert.bind('fixed')
    insert.run()
    expect(state.sync.at(-1).request.params).toEqual({ positional: ['fixed'], named: null })
    expect(() => insert.run('x')).toThrow('This statement already has bound parameters')
    expect(() => insert.bind('again')).toThrow('The bind() method can only be invoked once per statement object')
    expect(() => insert.get()).toThrow('This statement does not return data. Use run() instead')
    expect(() => insert.pluck()).toThrow('The pluck() method is only for statements that return data')
  })

  it('shapes rows: objects, pluck, raw, expand, safeIntegers, Buffers, iterate', () => {
    const columns = [
      { name: 'id', column: 'id', table: 'users', database: 'main', type: 'INTEGER' },
      { name: 'avatar', column: 'avatar', table: 'users', database: 'main', type: 'BLOB' },
      { name: 'n', column: null, table: null, database: null, type: null },
    ]
    fakeSqlite({
      prepare: () => ({ value: { reader: true, readonly: true, columns, params: [] } }),
      query: (request) => ({
        value: {
          columns: ['id', 'avatar', 'n'],
          rows: [[request.safe ? { $i: '1' } : 1, { $b: 'AAE=' }, 2.5], [2, null, { $f: 'Infinity' }]].slice(0, request.first ? 1 : 2),
        },
      }),
    })
    const db = new Database(':memory:')
    const stmt = db.prepare('SELECT id, avatar, 1 + 1.5 AS n FROM users')
    expect(stmt.columns()).toEqual(columns)
    const first = stmt.get()
    expect(first.id).toBe(1)
    expect(Buffer.isBuffer(first.avatar) && [...first.avatar]).toEqual([0, 1])
    expect(state.sync.at(-1).request).toMatchObject({ first: true, safe: false })
    expect(stmt.all().map((r) => r.n)).toEqual([2.5, Infinity])
    expect(stmt.pluck().all()).toEqual([1, 2])
    expect(stmt.raw().get()[2]).toBe(2.5)
    expect(stmt.raw(false).get()).toHaveProperty('id', 1)
    expect(stmt.expand().get()).toEqual({ users: { id: 1, avatar: Buffer.from([0, 1]) }, $: { n: 2.5 } })
    expect(stmt.expand(false).safeIntegers().get().id).toBe(1n)
    const iterator = stmt.safeIntegers(false).iterate()
    expect(typeof iterator.return).toBe('function')
    expect([...iterator].map((r) => r.id)).toEqual([1, 2])
    db.defaultSafeIntegers()
    expect(db.prepare('SELECT id FROM users').get().id).toBe(1n)
  })

  it('throws SqliteError with the extended code, and RangeError / TypeError like better-sqlite3', () => {
    fakeSqlite({
      prepare: (request) =>
        request.sql === 'SELECT 1; SELECT 2'
          ? { status: 400, value: { kind: 'RangeError', message: 'The supplied SQL string contains more than one statement' } }
          : { value: { reader: false, readonly: false, columns: [], params: [] } },
      run: () => ({ status: 400, value: { kind: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE', primary: 'SQLITE_CONSTRAINT', errno: 19, message: 'UNIQUE constraint failed: t.name' } }),
    })
    const db = new Database(':memory:')
    expect(() => db.prepare('SELECT 1; SELECT 2')).toThrow(RangeError)
    let error
    try {
      db.prepare('INSERT INTO t VALUES (1)').run()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SqliteError)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: t.name' })
    expect(Database.SqliteError).toBe(SqliteError)
  })

  it('runs transactions with BEGIN / COMMIT / ROLLBACK and savepoints when nested', () => {
    let inTransaction = false
    const executed = []
    fakeSqlite({
      exec: (request) => {
        executed.push(request.sql)
        if (/^BEGIN/.test(request.sql)) inTransaction = true
        if (request.sql === 'COMMIT' || request.sql === 'ROLLBACK') inTransaction = false
        return { value: null }
      },
      status: () => ({ value: { inTransaction } }),
    })
    const db = new Database(':memory:')
    const add = db.transaction((value) => {
      if (value === 'fail') throw new Error('boom')
      return value * 2
    })
    expect(add(21)).toBe(42)
    expect(() => add('fail')).toThrow('boom')
    expect(add.immediate(1)).toBe(2)
    expect(add.database).toBe(db)
    const outer = db.transaction(() => add(5))
    expect(outer()).toBe(10)
    expect(executed).toEqual([
      'BEGIN', 'COMMIT',
      'BEGIN', 'ROLLBACK',
      'BEGIN IMMEDIATE', 'COMMIT',
      'BEGIN', 'SAVEPOINT `\t_bs3.\t`', 'RELEASE `\t_bs3.\t`', 'COMMIT',
    ])
    expect(() => db.transaction(async () => {})()).toThrow('Transaction function cannot return a promise')
  })

  it('answers the user functions SQLite asks for, then runs the statement again', () => {
    let round = 0
    fakeSqlite({
      prepare: () => ({ value: { reader: true, readonly: true, columns: [{ name: 'v' }], params: [] } }),
      query: (request) => {
        round++
        if (!request.retry) return { value: { needs: [{ name: 'twice', args: [{ $i: '21' }], key: 'k21' }] } }
        expect(request.memo).toEqual([{ key: 'k21', value: 42 }])
        return { value: { columns: ['v'], rows: [[42]] } }
      },
    })
    const db = new Database(':memory:')
    expect(db.function('twice', { deterministic: true }, (n) => n * 2)).toBe(db)
    expect(state.sync.at(-1).request).toEqual({ id: 7, name: 'twice', args: 1, deterministic: true, directOnly: false, varargs: false })
    expect(db.prepare('SELECT twice(21) AS v').pluck().get()).toBe(42)
    expect(round).toBe(2)
    expect(() => db.aggregate('sum2', {})).toThrow(/aggregate/)
  })

  it('pragma, serialize, backup and close', async () => {
    fakeSqlite({
      prepare: () => ({ value: { reader: false, readonly: true, columns: [], params: [] } }),
      query: () => ({ value: { columns: ['journal_mode'], rows: [['wal']] } }),
      serialize: () => ({ bytes: new Uint8Array([83, 81, 76]) }),
    })
    const db = new Database('app.db')
    // Pragmas return data even when SQLite says they do not.
    expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal')
    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }])
    expect(state.sync.at(-1).request.sql).toBe('PRAGMA journal_mode')
    expect(db.serialize().toString()).toBe('SQL')
    state.onCommand = (command, { request }) => {
      expect(command).toBe('sqlite')
      expect(request).toEqual({ op: 'backup', id: 7, destination: '/work/backup.db', attached: 'main' })
      return bytesOf({ totalPages: 3, remainingPages: 0 })
    }
    const progress = vi.fn()
    expect(await db.backup('backup.db', { progress })).toEqual({ totalPages: 3, remainingPages: 0 })
    expect(progress).toHaveBeenCalledWith({ totalPages: 3, remainingPages: 0 })
    expect(db.close()).toBe(db)
    expect(db.open).toBe(false)
    expect(db.inTransaction).toBe(false)
    expect(() => db.prepare('SELECT 1')).toThrow('The database connection is not open')
    expect(state.sync.filter((s) => s.path === 'node/sqlite/close')).toHaveLength(1)
  })

  it('explains a disabled feature and a sandboxed renderer', () => {
    state.onSync = () => ({ status: 501, value: { code: 'ERR_FEATURE_DISABLED', feature: 'sqlite' } })
    expect(() => new Database(':memory:')).toThrow(/"sqlite"/)
    state.onSync = () => ({ status: 403, value: { code: 'ERR_ACCESS_DENIED', message: 'only in the main process' } })
    let error
    try {
      new Database(':memory:')
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ name: 'NotImplementedError', reason: 'permission' })
  })
})

// --- sqlite3 ---------------------------------------------------------------------------------------------------

describe('sqlite3', () => {
  /** The `sqlite` command, answered per operation. */
  function fakeCommands(handlers = {}) {
    state.onCommand = (command, { request }) => {
      expect(command).toBe('sqlite')
      const handler = handlers[request.op]
      if (handler) return bytesOf(handler(request))
      if (request.op === 'open') return bytesOf({ id: 3 })
      return bytesOf(null)
    }
  }

  const ops = () => state.commands.map((c) => c.args.request)

  it('opens asynchronously with a callback and the open event', async () => {
    fakeCommands()
    const opened = vi.fn()
    const db = new sqlite3.Database('notes.db', opened)
    db.on('open', () => opened('event'))
    expect(db.open).toBe(false)
    await settle()
    expect(ops()[0]).toEqual({ op: 'open', flavor: 'sqlite3', filename: '/work/notes.db', mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX })
    expect(opened.mock.calls).toEqual([[null], ['event']])
    expect(db.open).toBe(true)
    expect(sqlite3.verbose()).toBe(sqlite3)
    expect(sqlite3.OPEN_READONLY).toBe(1)
    expect(sqlite3.CONSTRAINT).toBe(19)
  })

  it('runs statements in order with lastID / changes, rows as objects', async () => {
    fakeCommands({
      run: () => ({ changes: 1, lastInsertRowid: 5 }),
      query: (request) => ({ columns: ['id', 'name'], rows: request.first ? [[1, 'a']] : [[1, 'a'], [2, 'b']] }),
    })
    const db = new sqlite3.Database(':memory:')
    const events = []
    db.serialize(() => {
      db.run('INSERT INTO t (name) VALUES (?)', 'a', function (error) {
        events.push(['run', error, this.lastID, this.changes, this.sql])
      })
      db.run('INSERT INTO t VALUES ($id, $name)', { $id: 2, $name: true }, () => {})
      db.get('SELECT * FROM t WHERE id = ?', [1], (error, row) => events.push(['get', error, row]))
      db.all('SELECT * FROM t', (error, rows) => events.push(['all', error, rows.length]))
      db.each('SELECT * FROM t', (error, row) => events.push(['row', row.name]), (error, count) => events.push(['done', count]))
      db.map('SELECT * FROM t', (error, map) => events.push(['map', map]))
    })
    await settle()
    expect(events).toEqual([
      ['run', null, 5, 1, 'INSERT INTO t (name) VALUES (?)'],
      ['get', null, { id: 1, name: 'a' }],
      ['all', null, 2],
      ['row', 'a'],
      ['row', 'b'],
      ['done', 2],
      ['map', { 1: 'a', 2: 'b' }],
    ])
    expect(ops()[1].params).toEqual({ positional: ['a'] })
    // node-sqlite3 binds integers as INTEGERs and booleans as 1 / 0; object keys are full names.
    expect(ops()[2].params).toEqual({ named: { $id: { $i: '2' }, $name: { $i: '1' } } })
    expect(ops()[3]).toMatchObject({ op: 'query', first: true, params: { positional: [{ $i: '1' }] } })
  })

  it('reports errors like node-sqlite3, to the callback or the error event', async () => {
    fakeCommands({
      run: () => {
        throw { kind: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE', primary: 'SQLITE_CONSTRAINT', errno: 19, message: 'UNIQUE constraint failed: t.name' }
      },
    })
    state.onCommand = ((inner) => (command, args) => {
      if (args.request.op === 'run') throw { kind: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE', primary: 'SQLITE_CONSTRAINT', errno: 19, message: 'UNIQUE constraint failed: t.name' }
      return inner(command, args)
    })(state.onCommand)
    const db = new sqlite3.Database(':memory:')
    const error = await new Promise((resolve) => db.run('INSERT INTO t VALUES (1)', resolve))
    expect(error.message).toBe('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.name')
    expect(error).toMatchObject({ errno: 19, code: 'SQLITE_CONSTRAINT' })
    const emitted = new Promise((resolve) => db.on('error', resolve))
    db.run('INSERT INTO t VALUES (1)')
    expect((await emitted).code).toBe('SQLITE_CONSTRAINT')
  })

  it('prepared statements bind once and run many times; close ends the database', async () => {
    fakeCommands({ run: () => ({ changes: 1, lastInsertRowid: 1 }), prepare: () => ({ reader: false }) })
    const db = new sqlite3.Database(':memory:')
    const stmt = db.prepare('INSERT INTO t VALUES (?)')
    stmt.run(1)
    stmt.run(2)
    const finalized = new Promise((resolve) => stmt.finalize(resolve))
    await finalized
    const closed = vi.fn()
    db.on('close', closed)
    const result = await new Promise((resolve) => db.close(resolve))
    expect(result).toBeNull()
    expect(closed).toHaveBeenCalled()
    expect(ops().map((o) => o.op)).toEqual(['open', 'prepare', 'run', 'run', 'close'])
    expect(ops().filter((o) => o.op === 'run').map((o) => o.params.positional)).toEqual([[{ $i: '1' }], [{ $i: '2' }]])
    const after = await new Promise((resolve) => db.all('SELECT 1', resolve))
    expect(after).toMatchObject({ code: 'SQLITE_MISUSE', message: 'SQLITE_MISUSE: Database is closed' })
  })

  it('reports prepare errors to the prepare callback once', async () => {
    state.onCommand = (command, { request }) => {
      if (request.op === 'open') return bytesOf({ id: 3 })
      throw { kind: 'SqliteError', code: 'SQLITE_ERROR', primary: 'SQLITE_ERROR', errno: 1, message: 'no such table: nope' }
    }
    const db = new sqlite3.Database(':memory:')
    const errors = []
    const stmt = db.prepare('SELECT * FROM nope', (error) => errors.push(error?.message))
    stmt.all(() => errors.push('all callback'))
    await settle()
    expect(errors).toEqual(['SQLITE_ERROR: no such table: nope'])
  })
})

// --- node-pty ------------------------------------------------------------------------------------------------------

describe('node-pty', () => {
  function fakePty() {
    state.onSync = (path, request) => {
      if (path === 'node/pty/spawn') return { value: { id: 4, pid: 1234 } }
      if (path === 'node/pty/process') return { value: 'vim' }
      return { status: 404 }
    }
    state.onCommand = () => true
  }

  it('spawns synchronously with node-pty defaults and the app environment', () => {
    fakePty()
    processShim.env = { PATH: '/bin', TMUX: '/tmp/tmux', COLUMNS: '80', HOME: '/home/me' }
    const term = pty.spawn('/bin/bash', ['-l'], {})
    expect(term.pid).toBe(1234)
    expect(term).toMatchObject({ cols: 80, rows: 24 })
    expect(state.sync[0]).toEqual({
      path: 'node/pty/spawn',
      request: { file: '/bin/bash', args: ['-l'], cwd: '/work', env: { PATH: '/bin', HOME: '/home/me', TERM: 'xterm' }, cols: 80, rows: 24 },
    })
    const custom = pty.spawn('sh', [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/tmp', env: { A: 'b', TMUX: 'kept', N: 1 } })
    expect(state.sync.at(-1).request).toMatchObject({ cwd: '/tmp', cols: 120, rows: 40, env: { A: 'b', TMUX: 'kept', N: '1', TERM: 'xterm-256color' } })
    expect(custom.process).toBe('vim')
    expect(state.commands[0]).toMatchObject({ command: 'pty_attach', args: { id: 4 } })
    expect(() => pty.spawn('sh', [], { uid: 0 })).toThrow(/uid, gid/)
    expect(pty.default.spawn).toBe(pty.spawn)
  })

  it('streams output as text (split characters included) and exits after the last output', async () => {
    fakePty()
    const term = pty.spawn('sh')
    const channel = state.commands[0].args.onEvent
    const seen = []
    const subscription = term.onData((data) => seen.push(data))
    term.on('data', (data) => seen.push(`on:${data}`))
    term.onExit((exit) => seen.push(exit))
    term.on('exit', (code, signal) => seen.push(['exit', code, signal]))
    const euro = Buffer.from('€')
    channel.onmessage({ type: 'data', data: Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)]).toString('base64') })
    channel.onmessage({ type: 'data', data: euro.subarray(1).toString('base64') })
    subscription.dispose()
    channel.onmessage({ type: 'data', data: Buffer.from('z').toString('base64') })
    channel.onmessage({ type: 'exit', exitCode: 0, signal: 15 })
    expect(seen).toEqual(['a', 'on:a', '€', 'on:€', 'on:z', { exitCode: 0, signal: 15 }, ['exit', 0, 15]])
    expect(term.process).toBe('sh')
  })

  it('gives Buffers with encoding: null', () => {
    fakePty()
    const term = pty.spawn('sh', [], { encoding: null })
    const chunks = []
    term.onData((data) => chunks.push(data))
    state.commands[0].args.onEvent.onmessage({ type: 'data', data: 'AAE=' })
    expect(Buffer.isBuffer(chunks[0]) && [...chunks[0]]).toEqual([0, 1])
  })

  it('writes in order, one request at a time; resizes, signals and pauses', async () => {
    fakePty()
    let release
    state.onCommand = (command, args) => {
      if (command === 'pty_control' && args.op === 'write' && !release) return new Promise((resolve) => (release = resolve))
      return true
    }
    const term = pty.spawn('sh', [], { handleFlowControl: true })
    term.write('ls')
    term.write(' -l')
    term.write(Buffer.from('\r'))
    const writes = () => state.commands.filter((c) => c.args.op === 'write').map((c) => Buffer.from(c.args.args.data, 'base64').toString())
    expect(writes()).toEqual(['ls'])
    release(true)
    await settle()
    expect(writes()).toEqual(['ls', ' -l\r'])
    term.write('\x13')
    term.write('\x11')
    term.resize(100, 30)
    expect(term).toMatchObject({ cols: 100, rows: 30 })
    expect(() => term.resize(0, 10)).toThrow('resizing must be done using positive cols and rows')
    term.kill()
    term.kill('SIGTERM')
    await settle()
    const controls = state.commands.filter((c) => c.command === 'pty_control' && c.args.op !== 'write').map((c) => [c.args.op, c.args.args])
    expect(controls).toEqual([
      ['pause', undefined],
      ['resume', undefined],
      ['resize', { cols: 100, rows: 30 }],
      ['kill', { signal: 1 }],
      ['kill', { signal: 15 }],
    ])
  })

  it('throws what spawn failed with', () => {
    state.onSync = () => ({ status: 400, value: { message: "Failed to spawn '/nope': No such file or directory" } })
    expect(() => pty.spawn('/nope')).toThrow(/Failed to spawn/)
  })
})

// --- aliases ----------------------------------------------------------------------------------------------------------

describe('module aliases', () => {
  const NAMES = ['keytar', 'better-sqlite3', 'sqlite3', 'node-pty']

  it('the Vite plugin aliases each package to its shim', () => {
    const config = tauriElectron().config({ root: nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'c5-')) })
    for (const name of NAMES) {
      const alias = config.resolve.alias.find((a) => a.find.test?.(name))
      expect(alias?.replacement).toBe(`tauri-electron/${name}`)
    }
    expect(config.resolve.alias.find((a) => a.find.test?.('sqlite3-extra'))).toBeUndefined()
    expect(shared.NATIVE_MODULE_SHIMS).toMatchObject({ keytar: 'tauri-electron/keytar' })
  })

  it('the webpack plugin redirects them; require() gives the module itself', () => {
    const at = (request) => redirect(request, { userResolved: new Set() })
    expect(at('keytar')).toMatch(/native[\\/]keytar\.js$/)
    expect(at('node-pty')).toMatch(/native[\\/]node-pty\.js$/)
    expect(at('better-sqlite3')).toMatch(/bundler[\\/]better-sqlite3\.cjs$/)
    expect(at('sqlite3')).toMatch(/bundler[\\/]sqlite3\.cjs$/)
    const require = createRequire(import.meta.url)
    const BetterSqlite3 = require(at('better-sqlite3'))
    expect(typeof BetterSqlite3).toBe('function')
    expect(BetterSqlite3.SqliteError.name).toBe('SqliteError')
    expect(typeof require(at('sqlite3')).Database).toBe('function')
  })

  it('a webpack build resolves them without the packages installed', async () => {
    const require = createRequire(import.meta.url)
    const { TauriElectronPlugin } = require('../webpack.cjs')
    const webpack = require('webpack')
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'c5-webpack-'))
    nodeFs.mkdirSync(nodePath.join(dir, 'src'))
    nodeFs.writeFileSync(
      nodePath.join(dir, 'src/main.js'),
      "const Database = require('better-sqlite3')\nconst sqlite3 = require('sqlite3')\nconst pty = require('node-pty')\nconst keytar = require('keytar')\nglobalThis.loaded = [Database.SqliteError, sqlite3.verbose, pty.spawn, keytar.getPassword]\n",
    )
    const outDir = nodePath.join(dir, 'dist')
    const stats = await new Promise((resolve, reject) =>
      webpack(
        { mode: 'development', devtool: false, context: dir, target: 'electron-main', output: { path: outDir }, plugins: [new TauriElectronPlugin({ main: './src/main.js' })], infrastructureLogging: { level: 'error' } },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    )
    expect(stats.hasErrors() ? stats.toString({ all: false, errors: true }) : '').toBe('')
    const bundle = nodeFs.readFileSync(nodePath.join(outDir, 'electron-main.js'), 'utf8')
    for (const file of ['bundler/better-sqlite3.cjs', 'bundler/sqlite3.cjs', 'src/native/node-pty.js', 'src/native/keytar.js']) expect(bundle).toContain(file)
  }, 60000)

  it('CommonJS require() in a Vite build takes the default export', () => {
    expect(shared.rewriteBuiltinRequires("const Database = require('better-sqlite3')")).toContain('m.default')
    expect(shared.rewriteBuiltinRequires("require('node-pty')")).toContain('m.default')
    expect(shared.rewriteBuiltinRequires("require('left-pad3')")).toBe("require('left-pad3')")
  })

  it('the global require() serves them', () => {
    expect(requireShim('better-sqlite3')).toBe(Database)
    expect(requireShim('keytar').getPassword).toBe(keytar.getPassword)
    expect(requireShim('sqlite3')).toBe(sqlite3)
    expect(requireShim('node-pty').spawn).toBe(pty.spawn)
  })

  it('the package exports them', () => {
    const pkg = JSON.parse(nodeFs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    for (const name of NAMES) expect(nodeFs.existsSync(new URL(`../${pkg.exports[`./${name}`]}`, import.meta.url))).toBe(true)
  })
})

describe('scaffolder', () => {
  const script = fileURLToPath(new URL('../../../scripts/create-app.mjs', import.meta.url))

  it('enables the Cargo features of the native modules an app depends on', async () => {
    const { nativeModuleFeatures } = await import(script)
    expect(nativeModuleFeatures({ 'better-sqlite3': '^11', sqlite3: '^5', 'node-pty': '^1', react: '^19' })).toEqual(['sqlite', 'pty'])
    expect(nativeModuleFeatures({})).toEqual([])

    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'c5-into-'))
    nodeFs.writeFileSync(nodePath.join(dir, 'package.json'), JSON.stringify({ name: 'term', main: 'main.js', dependencies: { 'node-pty': '^1.0.0', keytar: '^7.9.0' } }))
    nodeFs.writeFileSync(nodePath.join(dir, 'main.js'), "require('electron')")
    const out = execFileSync('node', [script, '--into', dir], { encoding: 'utf8' })
    const cargo = nodeFs.readFileSync(nodePath.join(dir, 'src-tauri/Cargo.toml'), 'utf8')
    expect(cargo).toMatch(/^ {2}"keytar", /m)
    expect(cargo).toMatch(/^ {2}"pty", /m)
    expect(cargo).toMatch(/^ {2}# "sqlite", /m)
    expect(out).toContain('enabled "keytar", "pty" in src-tauri/Cargo.toml')
  })

  it('lists them, commented out, in the template', () => {
    const cargo = nodeFs.readFileSync(new URL('../../../templates/tauri-electron-app/src-tauri/Cargo.toml', import.meta.url), 'utf8')
    for (const feature of ['keytar', 'sqlite', 'pty']) expect(cargo).toMatch(new RegExp(`^ {2}# "${feature}",`, 'm'))
  })
})
