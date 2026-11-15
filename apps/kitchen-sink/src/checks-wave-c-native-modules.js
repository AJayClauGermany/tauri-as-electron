// Checks for roadmap wave C item C5 (docs/ROADMAP.md): npm packages with
// native code, aliased by the bundler plugin to tauri-plugin-electron's
// keytar / sqlite / pty features (enabled in src-tauri/Cargo.toml). Same
// shape as checks.js and, like it, runs unchanged on Electron and on Tauri.
// The packages themselves are not installed in the kitchen sink, so on
// Electron these checks say so instead of loading them.
import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isElectron = Boolean(process.versions.electron)
const dirname = import.meta.dirname
const NOT_INSTALLED = (name) => `${name} is not installed in the kitchen sink`

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve once `predicate()` holds, or fail after `ms`. */
async function waitFor(predicate, what, ms = 5000) {
  const until = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await delay(25)
  }
}

/** `promise`, or a failure after `ms`. */
function within(promise, ms, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** A fresh temporary folder, removed after `fn`. */
async function inTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-wave-c-'))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Opens child.html in a hidden window with `webPreferences`, runs `fn`, always closes it. */
async function withWindow(webPreferences, fn) {
  const win = new BrowserWindow({ show: false, width: 360, height: 240, webPreferences })
  try {
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out loading the window')), 10000)
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    win.loadFile(path.join(dirname, '../child.html'))
    await loaded
    return await fn(win)
  } finally {
    win.destroy()
  }
}

/** A script for executeJavaScript that reports what threw instead of rejecting. */
const attempt = (code) => `(() => { try { return ${code} } catch (error) { return 'threw: ' + error.message } })()`

export const waveCNativeModuleChecks = [
  // --- better-sqlite3 -----------------------------------------------------------------------------------
  { id: 'better-sqlite3: statements, transactions, SqliteError (aliased)', run: async () => {
    if (isElectron) return NOT_INSTALLED('better-sqlite3')
    const { default: Database } = await import('better-sqlite3')
    return inTempDir((dir) => {
      const file = path.join(dir, 'notes.db')
      const db = new Database(file)
      try {
        assert(db.open && !db.memory && db.name === file, 'open, on disk')
        db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT UNIQUE NOT NULL, body BLOB, big INTEGER)')
        const insert = db.prepare('INSERT INTO notes (title, body, big) VALUES (@title, ?, ?)')
        const first = insert.run({ title: 'one' }, Buffer.from([1, 2, 3]), 9007199254740993n)
        assert(first.changes === 1 && first.lastInsertRowid === 1, `run: ${JSON.stringify(first)}`)
        const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(1)
        assert(row.title === 'one' && Buffer.isBuffer(row.body) && row.body.equals(Buffer.from([1, 2, 3])), 'get: TEXT and BLOB')
        assert(db.prepare('SELECT big FROM notes').safeIntegers().pluck().get() === 9007199254740993n, 'safeIntegers')
        const insertMany = db.transaction((titles) => {
          for (const title of titles) insert.run({ title }, null, 0)
          return titles.length
        })
        assert(insertMany(['two', 'three']) === 2, 'transaction result')
        let error
        try {
          insertMany(['four', 'one'])
        } catch (e) {
          error = e
        }
        assert(error instanceof Database.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE', `SqliteError: ${error}`)
        const titles = db.prepare('SELECT title FROM notes ORDER BY id').pluck().all()
        assert(titles.join() === 'one,two,three', `rolled back: ${titles}`)
        assert(!db.inTransaction, 'not in a transaction')
        const expanded = db.prepare('SELECT title, 1 AS one FROM notes LIMIT 1').expand().get()
        assert(expanded.notes.title === 'one' && expanded.$.one === 1, `expand: ${JSON.stringify(expanded)}`)
        assert([...db.prepare('SELECT id FROM notes ORDER BY id').raw().iterate()].flat().join() === '1,2,3', 'raw + iterate')
        db.close()
        assert(!db.open, 'closed')
        const again = new Database(file, { readonly: true, fileMustExist: true })
        try {
          assert(again.prepare('SELECT count(*) FROM notes').pluck().get() === 3, 'persisted')
          let readonlyError
          try {
            again.exec("INSERT INTO notes (title) VALUES ('x')")
          } catch (e) {
            readonlyError = e
          }
          assert(readonlyError?.code === 'SQLITE_READONLY', `readonly: ${readonlyError?.code}`)
        } finally {
          again.close()
        }
        return `3 rows on disk, ${error.code} rolled back`
      } finally {
        if (db.open) db.close()
      }
    })
  } },
  { id: 'better-sqlite3: user functions, pragma, serialize, backup', run: async () => {
    if (isElectron) return NOT_INSTALLED('better-sqlite3')
    const { default: Database } = await import('better-sqlite3')
    return inTempDir(async (dir) => {
      const db = new Database(':memory:')
      try {
        db.function('slugify', { deterministic: true }, (text) => String(text).toLowerCase().replace(/\s+/g, '-'))
        db.exec("CREATE TABLE t (title TEXT, slug TEXT); INSERT INTO t (title) VALUES ('Hello World'), ('Tauri Apps')")
        db.prepare('UPDATE t SET slug = slugify(title)').run()
        const slugs = db.prepare('SELECT slug FROM t ORDER BY title').pluck().all()
        assert(slugs.join() === 'hello-world,tauri-apps', `user function: ${slugs}`)
        assert(db.pragma('foreign_keys', { simple: true }) === 1, 'foreign keys on, as in better-sqlite3')
        db.pragma('user_version = 3')
        assert(db.pragma('user_version', { simple: true }) === 3, 'pragma user_version')
        const image = db.serialize()
        assert(Buffer.isBuffer(image) && image.length > 0, 'serialize')
        const copy = new Database(image)
        assert(copy.prepare('SELECT count(*) FROM t').pluck().get() === 2, 'opened from a Buffer')
        copy.close()
        const target = path.join(dir, 'backup.db')
        const progress = await db.backup(target)
        assert(progress.totalPages > 0 && progress.remainingPages === 0, `backup: ${JSON.stringify(progress)}`)
        const restored = new Database(target, { readonly: true })
        assert(restored.prepare('SELECT slug FROM t ORDER BY title').pluck().all().join() === slugs.join(), 'backup contents')
        restored.close()
        return `slugs ${slugs.join(' ')}, ${progress.totalPages} pages backed up`
      } finally {
        db.close()
      }
    })
  } },

  // --- sqlite3 -----------------------------------------------------------------------------------------------
  { id: 'sqlite3: callbacks, serialize, prepared statements, errors (aliased)', run: async () => {
    if (isElectron) return NOT_INSTALLED('sqlite3')
    const sqlite3 = (await import('sqlite3')).default.verbose()
    const db = await new Promise((resolve, reject) => {
      const opened = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(opened)))
    })
    const events = []
    await new Promise((resolve) => {
      db.serialize(() => {
        db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)')
        const stmt = db.prepare('INSERT INTO t (name) VALUES (?)')
        for (const name of ['a', 'b', 'c']) stmt.run(name)
        stmt.finalize()
        db.run('INSERT INTO t (name) VALUES ($name)', { $name: 'd' }, function () {
          events.push(`lastID ${this.lastID}`)
        })
        db.run('INSERT INTO t (name) VALUES (?)', 'a', (error) => events.push(error?.code))
        db.get('SELECT count(*) AS n FROM t', (error, row) => events.push(`count ${row?.n}`))
        db.each('SELECT name FROM t ORDER BY id', (error, row) => events.push(row.name), (error, n) => {
          events.push(`each ${n}`)
          resolve()
        })
      })
    })
    await new Promise((resolve) => db.close(resolve))
    assert(events.join() === 'lastID 4,SQLITE_CONSTRAINT,count 4,a,b,c,d,each 4', events.join())
    assert(/^3\.\d+\.\d+$/.test(sqlite3.VERSION), `VERSION ${sqlite3.VERSION}`)
    return `SQLite ${sqlite3.VERSION}: ${events.join(' ')}`
  } },

  // --- node-pty ----------------------------------------------------------------------------------------------
  { id: 'node-pty: a shell in a pseudo-terminal (aliased)', run: async () => {
    if (isElectron) return NOT_INSTALLED('node-pty')
    if (process.platform === 'win32') return 'ConPTY is not exercised by the kitchen sink'
    const pty = await import('node-pty')
    const term = pty.spawn('/bin/sh', [], { name: 'xterm-256color', cols: 90, rows: 20, cwd: os.tmpdir(), env: { ...process.env, KITCHEN: 'pty' } })
    assert(Number.isInteger(term.pid) && term.pid > 0, `pid ${term.pid}`)
    let output = ''
    term.onData((data) => (output += data))
    const exited = new Promise((resolve) => term.onExit(resolve))
    term.write('echo "$TERM-$KITCHEN"; stty size\r')
    await waitFor(() => output.includes('xterm-256color-pty') && /20 90/.test(output), `the shell's answer (got ${JSON.stringify(output)})`)
    const program = term.process
    assert(/sh$/.test(program), `process ${program}`)
    term.resize(100, 30)
    term.write('stty size; exit 7\r')
    const exit = await within(exited, 5000, 'the exit')
    assert(/30 100/.test(output), `resized: ${JSON.stringify(output)}`)
    assert(exit.exitCode === 7, `exit ${JSON.stringify(exit)}`)
    return `pid ${term.pid}, ${program}, exit ${exit.exitCode}`
  } },

  // --- keytar --------------------------------------------------------------------------------------------------
  { id: 'keytar: OS keychain, or the error keytar gives without one (aliased)', run: async () => {
    if (isElectron) return NOT_INSTALLED('keytar')
    const keytar = (await import('keytar')).default
    const service = `tauri-electron-kitchen-sink-${process.pid}`
    try {
      await within(keytar.setPassword(service, 'alice', 'pässwörd 1'), 30000, 'the keychain')
    } catch (error) {
      // No keychain (Linux without a Secret Service, as in CI): keytar fails, and so does this.
      assert(error.name !== 'NotImplementedError', `an error from the keychain, got ${error.name}: ${error.message}`)
      const read = await keytar.getPassword(service, 'alice').then(() => 'read', () => 'rejected')
      assert(read === 'rejected', 'nothing was stored in plain text')
      return `no keychain: ${error.message}`
    }
    try {
      await keytar.setPassword(service, 'bob', 'two')
      assert((await keytar.getPassword(service, 'alice')) === 'pässwörd 1', 'getPassword')
      const found = (await keytar.findCredentials(service)).map((c) => `${c.account}=${c.password}`).sort()
      assert(found.join() === 'alice=pässwörd 1,bob=two', `findCredentials: ${found}`)
      assert((await keytar.deletePassword(service, 'bob')) === true, 'deleted')
      assert((await keytar.deletePassword(service, 'bob')) === false, 'deleted once')
      assert((await keytar.getPassword(service, 'bob')) === null, 'gone')
      return 'stored, found and deleted'
    } finally {
      await keytar.deletePassword(service, 'alice').catch(() => {})
      await keytar.deletePassword(service, 'bob').catch(() => {})
    }
  } },

  // --- who may use them ----------------------------------------------------------------------------------------
  { id: 'native modules: nodeIntegration windows yes, sandboxed renderers no', run: async () => {
    if (isElectron) return NOT_INSTALLED('better-sqlite3')
    const open = attempt(`(() => { const db = new (require('better-sqlite3'))(':memory:'); const two = db.prepare('SELECT 1 + 1').pluck().get(); db.close(); return two })()`)
    const sandboxed = await withWindow({}, (win) => win.webContents.executeJavaScript(open))
    assert(String(sandboxed).startsWith('threw') && /main process/.test(sandboxed), `sandboxed: ${sandboxed}`)
    const granted = await withWindow({ nodeIntegration: true, contextIsolation: false }, (win) => win.webContents.executeJavaScript(open))
    assert(granted === 2, `nodeIntegration: ${granted}`)
    return 'refused in a sandboxed window, works with nodeIntegration'
  } },
]
