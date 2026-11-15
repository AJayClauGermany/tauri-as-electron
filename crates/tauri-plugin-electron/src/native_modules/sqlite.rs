//! better-sqlite3 and sqlite3 (feature `sqlite`) on rusqlite, with SQLite
//! compiled in (rusqlite's `bundled`).
//!
//! Databases live in a process-wide table; JavaScript holds their ids.
//! Statements are not kept here: a JavaScript `Statement` holds its SQL text
//! and each call runs it through the connection's prepared-statement cache,
//! so a statement is compiled once and nothing borrows the connection
//! between calls. Rows come back whole (`iterate()` reads them all first).
//!
//! Values cross as JSON: numbers are SQLite REALs, `{"$i": "<int64>"}` an
//! INTEGER (BigInt, or integers when `safeIntegers` is on), `{"$b":
//! "<base64>"}` a BLOB, `{"$f": "NaN" | "Infinity" | "-Infinity"}` a REAL JSON
//! cannot carry.
//!
//! User-defined functions (`db.function`) cannot call into JavaScript, which
//! is blocked in the synchronous request while SQLite runs. They are answered
//! from a memo instead: a call whose arguments have no result yet returns
//! NULL and is recorded; after the statement, the recorded calls go back to
//! JavaScript (`{ "needs": [...] }`), which computes them and runs the
//! statement again with the results, until no call is missing. A statement
//! that writes runs inside a savepoint that is rolled back when calls were
//! missing, so only the final run takes effect.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rusqlite::{
    config::DbConfig,
    functions::FunctionFlags,
    types::{Value as Sql, ValueRef},
    Connection, InterruptHandle, OpenFlags, Statement,
};
use serde_json::{json, Map, Value};

use super::Output;

/// Whose API a database serves: better-sqlite3 (strict binding, foreign keys
/// on) or node-sqlite3.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Flavor {
    Better,
    Node,
}

/// The savepoint a writing statement with user functions runs in.
const UDF_SAVEPOINT: &str = "\"tauri-electron udf\"";

/// User-defined functions of a connection and the memo answering them.
#[derive(Default)]
struct Functions {
    /// Registered names (lowercase).
    names: HashSet<String>,
    /// Results JavaScript computed, by call (`[name, args]` as JSON).
    memo: HashMap<String, Sql>,
    /// Calls without a result in the current run.
    missing: Vec<Value>,
    seen: HashSet<String>,
}

struct Database {
    owner: String,
    stamp: u64,
    flavor: Flavor,
    conn: Mutex<Option<Connection>>,
    interrupt: InterruptHandle,
    functions: Arc<Mutex<Functions>>,
}

static DATABASES: LazyLock<Mutex<HashMap<u32, Arc<Database>>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

// --- errors ------------------------------------------------------------------------------------

fn type_error(message: impl Into<String>) -> Value {
    json!({ "kind": "TypeError", "message": message.into() })
}

fn range_error(message: impl Into<String>) -> Value {
    json!({ "kind": "RangeError", "message": message.into() })
}

fn not_open() -> Value {
    type_error("The database connection is not open")
}

/// An SQLite failure: the extended code's name (better-sqlite3's `code`),
/// the primary code and its name (node-sqlite3's `errno` / `code`).
fn sqlite_failure(extended: i32, message: String) -> Value {
    let primary = extended & 0xff;
    json!({
        "kind": "SqliteError",
        "code": code_name(extended).or_else(|| code_name(primary)).unwrap_or("SQLITE_ERROR"),
        "primary": code_name(primary).unwrap_or("SQLITE_ERROR"),
        "errno": primary,
        "message": message,
    })
}

fn sqlite_error(error: rusqlite::Error) -> Value {
    match error {
        rusqlite::Error::SqliteFailure(failure, message) => {
            let message = message.unwrap_or_else(|| failure.to_string());
            sqlite_failure(failure.extended_code, message)
        }
        rusqlite::Error::SqlInputError { error, msg, .. } => {
            sqlite_failure(error.extended_code, msg)
        }
        rusqlite::Error::MultipleStatement => {
            range_error("The supplied SQL string contains more than one statement")
        }
        rusqlite::Error::Empty => range_error("The supplied SQL string contains no statements"),
        rusqlite::Error::NulError(_) => type_error("The SQL string contains a NUL character"),
        rusqlite::Error::InvalidParameterName(name) => {
            sqlite_failure(25, format!("no such parameter: {name}"))
        }
        other => json!({ "kind": "Error", "message": other.to_string() }),
    }
}

/// SQLite's result code names, extended ones included.
fn code_name(code: i32) -> Option<&'static str> {
    Some(match code {
        1 => "SQLITE_ERROR",
        2 => "SQLITE_INTERNAL",
        3 => "SQLITE_PERM",
        4 => "SQLITE_ABORT",
        5 => "SQLITE_BUSY",
        6 => "SQLITE_LOCKED",
        7 => "SQLITE_NOMEM",
        8 => "SQLITE_READONLY",
        9 => "SQLITE_INTERRUPT",
        10 => "SQLITE_IOERR",
        11 => "SQLITE_CORRUPT",
        12 => "SQLITE_NOTFOUND",
        13 => "SQLITE_FULL",
        14 => "SQLITE_CANTOPEN",
        15 => "SQLITE_PROTOCOL",
        16 => "SQLITE_EMPTY",
        17 => "SQLITE_SCHEMA",
        18 => "SQLITE_TOOBIG",
        19 => "SQLITE_CONSTRAINT",
        20 => "SQLITE_MISMATCH",
        21 => "SQLITE_MISUSE",
        22 => "SQLITE_NOLFS",
        23 => "SQLITE_AUTH",
        24 => "SQLITE_FORMAT",
        25 => "SQLITE_RANGE",
        26 => "SQLITE_NOTADB",
        27 => "SQLITE_NOTICE",
        28 => "SQLITE_WARNING",
        257 => "SQLITE_ERROR_MISSING_COLLSEQ",
        513 => "SQLITE_ERROR_RETRY",
        769 => "SQLITE_ERROR_SNAPSHOT",
        261 => "SQLITE_BUSY_RECOVERY",
        517 => "SQLITE_BUSY_SNAPSHOT",
        773 => "SQLITE_BUSY_TIMEOUT",
        262 => "SQLITE_LOCKED_SHAREDCACHE",
        518 => "SQLITE_LOCKED_VTAB",
        264 => "SQLITE_READONLY_RECOVERY",
        520 => "SQLITE_READONLY_CANTLOCK",
        776 => "SQLITE_READONLY_ROLLBACK",
        1032 => "SQLITE_READONLY_DBMOVED",
        1288 => "SQLITE_READONLY_CANTINIT",
        1544 => "SQLITE_READONLY_DIRECTORY",
        516 => "SQLITE_ABORT_ROLLBACK",
        266 => "SQLITE_IOERR_READ",
        522 => "SQLITE_IOERR_SHORT_READ",
        778 => "SQLITE_IOERR_WRITE",
        1034 => "SQLITE_IOERR_FSYNC",
        1290 => "SQLITE_IOERR_DIR_FSYNC",
        1546 => "SQLITE_IOERR_TRUNCATE",
        1802 => "SQLITE_IOERR_FSTAT",
        2058 => "SQLITE_IOERR_UNLOCK",
        2314 => "SQLITE_IOERR_RDLOCK",
        2570 => "SQLITE_IOERR_DELETE",
        2826 => "SQLITE_IOERR_BLOCKED",
        3082 => "SQLITE_IOERR_NOMEM",
        3338 => "SQLITE_IOERR_ACCESS",
        3594 => "SQLITE_IOERR_CHECKRESERVEDLOCK",
        3850 => "SQLITE_IOERR_LOCK",
        4106 => "SQLITE_IOERR_CLOSE",
        4362 => "SQLITE_IOERR_DIR_CLOSE",
        4618 => "SQLITE_IOERR_SHMOPEN",
        4874 => "SQLITE_IOERR_SHMSIZE",
        5130 => "SQLITE_IOERR_SHMLOCK",
        5386 => "SQLITE_IOERR_SHMMAP",
        5642 => "SQLITE_IOERR_SEEK",
        5898 => "SQLITE_IOERR_DELETE_NOENT",
        6154 => "SQLITE_IOERR_MMAP",
        6410 => "SQLITE_IOERR_GETTEMPPATH",
        6666 => "SQLITE_IOERR_CONVPATH",
        6922 => "SQLITE_IOERR_VNODE",
        7178 => "SQLITE_IOERR_AUTH",
        7434 => "SQLITE_IOERR_BEGIN_ATOMIC",
        7690 => "SQLITE_IOERR_COMMIT_ATOMIC",
        7946 => "SQLITE_IOERR_ROLLBACK_ATOMIC",
        8202 => "SQLITE_IOERR_DATA",
        8458 => "SQLITE_IOERR_CORRUPTFS",
        267 => "SQLITE_CORRUPT_VTAB",
        523 => "SQLITE_CORRUPT_SEQUENCE",
        779 => "SQLITE_CORRUPT_INDEX",
        270 => "SQLITE_CANTOPEN_NOTEMPDIR",
        526 => "SQLITE_CANTOPEN_ISDIR",
        782 => "SQLITE_CANTOPEN_FULLPATH",
        1038 => "SQLITE_CANTOPEN_CONVPATH",
        1294 => "SQLITE_CANTOPEN_DIRTYWAL",
        1550 => "SQLITE_CANTOPEN_SYMLINK",
        275 => "SQLITE_CONSTRAINT_CHECK",
        531 => "SQLITE_CONSTRAINT_COMMITHOOK",
        787 => "SQLITE_CONSTRAINT_FOREIGNKEY",
        1043 => "SQLITE_CONSTRAINT_FUNCTION",
        1299 => "SQLITE_CONSTRAINT_NOTNULL",
        1555 => "SQLITE_CONSTRAINT_PRIMARYKEY",
        1811 => "SQLITE_CONSTRAINT_TRIGGER",
        2067 => "SQLITE_CONSTRAINT_UNIQUE",
        2323 => "SQLITE_CONSTRAINT_VTAB",
        2579 => "SQLITE_CONSTRAINT_ROWID",
        2835 => "SQLITE_CONSTRAINT_PINNED",
        3091 => "SQLITE_CONSTRAINT_DATATYPE",
        283 => "SQLITE_NOTICE_RECOVER_WAL",
        539 => "SQLITE_NOTICE_RECOVER_ROLLBACK",
        284 => "SQLITE_WARNING_AUTOINDEX",
        279 => "SQLITE_AUTH_USER",
        _ => return None,
    })
}

// --- values ------------------------------------------------------------------------------------

fn integer(value: i64, safe: bool) -> Value {
    if safe {
        json!({ "$i": value.to_string() })
    } else {
        json!(value)
    }
}

fn real(value: f64) -> Value {
    if value.is_finite() {
        json!(value)
    } else if value.is_nan() {
        json!({ "$f": "NaN" })
    } else if value > 0.0 {
        json!({ "$f": "Infinity" })
    } else {
        json!({ "$f": "-Infinity" })
    }
}

fn to_json(value: ValueRef<'_>, safe: bool) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => integer(i, safe),
        ValueRef::Real(f) => real(f),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => json!({ "$b": BASE64.encode(bytes) }),
    }
}

const BIND_TYPES: &str = "SQLite3 can only bind numbers, strings, bigints, buffers, and null";

fn to_sql(value: &Value) -> Result<Sql, Value> {
    Ok(match value {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => Sql::Real(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Sql::Text(s.clone()),
        Value::Object(map) => {
            if let Some(int) = map.get("$i").and_then(Value::as_str) {
                Sql::Integer(int.parse().map_err(|_| {
                    range_error("The bound BigInt is too large to be represented as a 64-bit signed integer")
                })?)
            } else if let Some(blob) = map.get("$b").and_then(Value::as_str) {
                Sql::Blob(BASE64.decode(blob).map_err(|e| type_error(e.to_string()))?)
            } else if let Some(float) = map.get("$f").and_then(Value::as_str) {
                Sql::Real(match float {
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ => f64::NAN,
                })
            } else {
                return Err(type_error(BIND_TYPES));
            }
        }
        Value::Array(_) => return Err(type_error(BIND_TYPES)),
    })
}

// --- requests ----------------------------------------------------------------------------------

fn text<'a>(request: &'a Value, key: &str) -> Result<&'a str, Value> {
    request[key]
        .as_str()
        .ok_or_else(|| type_error(format!("Expected a string for '{key}'")))
}

fn flag(request: &Value, key: &str) -> bool {
    request[key].as_bool().unwrap_or(false)
}

fn database(owner: &str, request: &Value) -> Result<Arc<Database>, Value> {
    let id = request["id"].as_u64().unwrap_or(0) as u32;
    DATABASES
        .lock()
        .unwrap()
        .get(&id)
        .filter(|db| db.owner == owner)
        .cloned()
        .ok_or_else(not_open)
}

/// Run `op` for the webview `owner`. `stamp` dates a new database (see
/// `super::page_finished`).
pub fn run(owner: &str, op: &str, request: &Value, stamp: fn() -> u64) -> Result<Output, Value> {
    match op {
        "open" => return open(owner, request, stamp()).map(Output::Json),
        "version" => {
            // SAFETY: a static NUL-terminated string.
            let source_id = unsafe { std::ffi::CStr::from_ptr(rusqlite::ffi::sqlite3_sourceid()) };
            return Ok(Output::Json(json!({
                "version": rusqlite::version(),
                "number": rusqlite::version_number(),
                "sourceId": source_id.to_string_lossy(),
            })));
        }
        _ => {}
    }
    let db = database(owner, request)?;
    match op {
        // Not under the connection's lock: another call may be running.
        "interrupt" => {
            db.interrupt.interrupt();
            return Ok(Output::Json(Value::Null));
        }
        "close" => {
            let id = request["id"].as_u64().unwrap_or(0) as u32;
            DATABASES.lock().unwrap().remove(&id);
            db.conn.lock().unwrap().take();
            return Ok(Output::Json(Value::Null));
        }
        _ => {}
    }
    let mut guard = db.conn.lock().unwrap();
    let conn = guard.as_mut().ok_or_else(not_open)?;
    match op {
        "prepare" => prepare(conn, text(request, "sql")?).map(Output::Json),
        "run" | "query" | "exec" => execute(&db, conn, op, request).map(Output::Json),
        "status" => Ok(Output::Json(
            json!({ "inTransaction": !conn.is_autocommit() }),
        )),
        "function" => define_function(&db, conn, request).map(Output::Json),
        "serialize" => {
            let schema = request["attached"].as_str().unwrap_or("main");
            let data = conn.serialize(schema).map_err(sqlite_error)?;
            Ok(Output::Bytes(data.to_vec()))
        }
        "backup" => backup(conn, request).map(Output::Json),
        "busyTimeout" => {
            let ms = request["ms"].as_u64().unwrap_or(0);
            conn.busy_timeout(Duration::from_millis(ms))
                .map_err(sqlite_error)?;
            Ok(Output::Json(Value::Null))
        }
        other => Err(
            json!({ "kind": "Error", "message": format!("unknown sqlite operation '{other}'") }),
        ),
    }
}

/// `{ filename, flavor: "better-sqlite3" | "sqlite3", readonly, fileMustExist,
/// timeout, mode (sqlite3's OPEN_* flags), data (base64: an image to load) }`.
fn open(owner: &str, request: &Value, stamp: u64) -> Result<Value, Value> {
    let flavor = if request["flavor"] == "sqlite3" {
        Flavor::Node
    } else {
        Flavor::Better
    };
    let filename = request["filename"].as_str().unwrap_or("");
    let readonly = flag(request, "readonly");
    let flags = match flavor {
        // The connection is only used under our own lock.
        Flavor::Better => {
            let mut flags = OpenFlags::SQLITE_OPEN_NO_MUTEX;
            if readonly {
                flags |= OpenFlags::SQLITE_OPEN_READ_ONLY;
            } else {
                flags |= OpenFlags::SQLITE_OPEN_READ_WRITE;
                if !flag(request, "fileMustExist") {
                    flags |= OpenFlags::SQLITE_OPEN_CREATE;
                }
            }
            flags
        }
        Flavor::Node => {
            let mode = request["mode"].as_i64().unwrap_or(0x10006) as i32;
            OpenFlags::from_bits_truncate(mode)
        }
    };
    let image = match request["data"].as_str() {
        Some(data) => Some(BASE64.decode(data).map_err(|e| type_error(e.to_string()))?),
        None => None,
    };
    let mut conn = match &image {
        Some(_) => Connection::open_in_memory(),
        None => Connection::open_with_flags(filename, flags),
    }
    .map_err(sqlite_error)?;
    if let Some(image) = image {
        let len = image.len();
        conn.deserialize_read_exact("main", image.as_slice(), len, readonly)
            .map_err(sqlite_error)?;
    }
    let timeout = request["timeout"].as_u64().unwrap_or(5000);
    conn.busy_timeout(Duration::from_millis(timeout))
        .map_err(sqlite_error)?;
    conn.set_prepared_statement_cache_capacity(256);
    // better-sqlite3 builds SQLite with SQLITE_DQS=0 and foreign keys on (as
    // libsqlite3-sys does); node-sqlite3 keeps SQLite's defaults.
    if flavor == Flavor::Better {
        let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false);
        let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false);
    }
    let foreign_keys = if flavor == Flavor::Better {
        "ON"
    } else {
        "OFF"
    };
    conn.execute_batch(&format!("PRAGMA foreign_keys = {foreign_keys}"))
        .map_err(sqlite_error)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let interrupt = conn.get_interrupt_handle();
    DATABASES.lock().unwrap().insert(
        id,
        Arc::new(Database {
            owner: owner.to_string(),
            stamp,
            flavor,
            conn: Mutex::new(Some(conn)),
            interrupt,
            functions: Arc::default(),
        }),
    );
    Ok(json!({ "id": id }))
}

/// What better-sqlite3's `Statement` knows from the start: whether it returns
/// data, whether it writes, its columns and parameters.
fn prepare(conn: &Connection, sql: &str) -> Result<Value, Value> {
    let stmt = conn.prepare_cached(sql).map_err(sqlite_error)?;
    let columns: Vec<Value> = stmt
        .columns_with_metadata()
        .zip(stmt.columns())
        .map(|(origin, column)| {
            json!({
                "name": origin.name(),
                "column": origin.origin_name(),
                "table": origin.table_name(),
                "database": origin.database_name(),
                "type": column.decl_type(),
            })
        })
        .collect();
    let params: Vec<Value> = (1..=stmt.parameter_count())
        .map(|index| json!(stmt.parameter_name(index)))
        .collect();
    Ok(json!({
        "reader": stmt.column_count() > 0,
        "readonly": stmt.readonly(),
        "columns": columns,
        "params": params,
    }))
}

/// Bind `{ positional: [...], named: {...} }` the way the flavor's library does.
fn bind(stmt: &mut Statement<'_>, params: &Value, flavor: Flavor) -> Result<(), Value> {
    let empty = Vec::new();
    let positional = params["positional"].as_array().unwrap_or(&empty);
    let named = params["named"].as_object();
    let count = stmt.parameter_count();
    match flavor {
        // Anonymous (`?`, `?NNN`) parameters take the positional values in
        // order, named ones (`@x`, `:x`, `$x`) the object's `x`; every one
        // must be given.
        Flavor::Better => {
            let mut next = 0;
            for index in 1..=count {
                let name = stmt.parameter_name(index).map(str::to_string);
                let value = match name.as_deref() {
                    Some(name) if !name.starts_with('?') => {
                        let key = &name[1..];
                        named.and_then(|named| named.get(key)).ok_or_else(|| {
                            range_error(format!("Missing named parameter \"{key}\""))
                        })?
                    }
                    _ => {
                        let value = positional
                            .get(next)
                            .ok_or_else(|| range_error("Too few parameter values were provided"))?;
                        next += 1;
                        value
                    }
                };
                stmt.raw_bind_parameter(index, to_sql(value)?)
                    .map_err(sqlite_error)?;
            }
            if next < positional.len() {
                return Err(range_error("Too many parameter values were provided"));
            }
        }
        // Positional values by index; object keys are full parameter names
        // (`$x`, `:x`, `@x`) or indexes. What is not given stays NULL.
        Flavor::Node => {
            let out_of_range = || sqlite_failure(25, "column index out of range".into());
            for (offset, value) in positional.iter().enumerate() {
                if offset >= count {
                    return Err(out_of_range());
                }
                stmt.raw_bind_parameter(offset + 1, to_sql(value)?)
                    .map_err(sqlite_error)?;
            }
            for (key, value) in named.unwrap_or(&Map::new()) {
                let index = match key.parse::<usize>() {
                    Ok(index) => index,
                    Err(_) => stmt
                        .parameter_index(key)
                        .map_err(sqlite_error)?
                        .ok_or_else(out_of_range)?,
                };
                if index == 0 || index > count {
                    return Err(out_of_range());
                }
                stmt.raw_bind_parameter(index, to_sql(value)?)
                    .map_err(sqlite_error)?;
            }
        }
    }
    Ok(())
}

/// Whether a batch has statements a savepoint would break.
fn controls_transactions(sql: &str) -> bool {
    let upper = sql.to_ascii_uppercase();
    upper
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|word| {
            matches!(
                word,
                "BEGIN" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE"
            )
        })
}

/// `run`, `query` and `exec`, answered from the user-function memo (see the
/// module documentation): `{ needs: [{ name, args, key }] }` when calls were
/// missing, the statement's own answer otherwise.
fn execute(
    db: &Database,
    conn: &mut Connection,
    op: &str,
    request: &Value,
) -> Result<Value, Value> {
    let sql = text(request, "sql")?;
    let with_functions = {
        let mut functions = db.functions.lock().unwrap();
        if !flag(request, "retry") {
            functions.memo.clear();
        }
        for entry in request["memo"].as_array().into_iter().flatten() {
            let key = entry["key"].as_str().unwrap_or_default().to_string();
            functions.memo.insert(key, to_sql(&entry["value"])?);
        }
        functions.missing.clear();
        functions.seen.clear();
        !functions.names.is_empty()
    };
    let savepoint = with_functions
        && match op {
            "exec" => !controls_transactions(sql),
            _ => !conn.prepare_cached(sql).map_err(sqlite_error)?.readonly(),
        };
    if savepoint {
        conn.execute_batch(&format!("SAVEPOINT {UDF_SAVEPOINT}"))
            .map_err(sqlite_error)?;
    }
    let result = match op {
        "exec" => conn
            .execute_batch(sql)
            .map(|_| Value::Null)
            .map_err(sqlite_error),
        "run" => run_statement(conn, sql, request, db.flavor),
        _ => query(conn, sql, request, db.flavor),
    };
    let missing = std::mem::take(&mut db.functions.lock().unwrap().missing);
    if savepoint {
        if !missing.is_empty() || result.is_err() {
            let _ = conn.execute_batch(&format!("ROLLBACK TO {UDF_SAVEPOINT}"));
        }
        let _ = conn.execute_batch(&format!("RELEASE {UDF_SAVEPOINT}"));
    }
    if !missing.is_empty() {
        if with_functions && op == "exec" && !savepoint {
            return Err(
                json!({ "kind": "Error", "message": "exec(): user-defined functions cannot be called from a batch that begins or ends transactions; run its statements with prepare()" }),
            );
        }
        return Ok(json!({ "needs": missing }));
    }
    result
}

/// Every row stepped through (sqlite3's `run` accepts statements that return
/// rows); `changes` counts only this statement's changes, as better-sqlite3 does.
fn run_statement(
    conn: &Connection,
    sql: &str,
    request: &Value,
    flavor: Flavor,
) -> Result<Value, Value> {
    let safe = flag(request, "safe");
    let before = conn.total_changes();
    {
        let mut stmt = conn.prepare_cached(sql).map_err(sqlite_error)?;
        bind(&mut stmt, &request["params"], flavor)?;
        let mut rows = stmt.raw_query();
        while rows.next().map_err(sqlite_error)?.is_some() {}
    }
    let changes = if conn.total_changes() == before {
        0
    } else {
        conn.changes()
    };
    Ok(json!({
        "changes": changes,
        "lastInsertRowid": integer(conn.last_insert_rowid(), safe),
    }))
}

/// `{ columns, rows }`, rows as arrays; `first`: stop after one row.
fn query(conn: &Connection, sql: &str, request: &Value, flavor: Flavor) -> Result<Value, Value> {
    let safe = flag(request, "safe");
    let first = flag(request, "first");
    let mut stmt = conn.prepare_cached(sql).map_err(sqlite_error)?;
    bind(&mut stmt, &request["params"], flavor)?;
    let columns: Vec<String> = stmt.column_names().map(str::to_string).collect();
    let mut rows = stmt.raw_query();
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(sqlite_error)? {
        let mut values = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            values.push(to_json(row.get_ref(index).map_err(sqlite_error)?, safe));
        }
        out.push(Value::Array(values));
        if first {
            break;
        }
    }
    Ok(json!({ "columns": columns, "rows": out }))
}

/// better-sqlite3's `db.function(name, { deterministic, directOnly, varargs }, fn)`:
/// `{ name, args, deterministic, directOnly, varargs }`.
fn define_function(db: &Database, conn: &Connection, request: &Value) -> Result<Value, Value> {
    let name = text(request, "name")?.to_string();
    let args = if flag(request, "varargs") {
        -1
    } else {
        request["args"].as_i64().unwrap_or(-1) as i32
    };
    let mut flags = FunctionFlags::SQLITE_UTF8;
    if flag(request, "deterministic") {
        flags |= FunctionFlags::SQLITE_DETERMINISTIC;
    }
    if flag(request, "directOnly") {
        flags |= FunctionFlags::SQLITE_DIRECTONLY;
    }
    let functions = db.functions.clone();
    let called = name.clone();
    conn.create_scalar_function(name.as_str(), args, flags, move |ctx| {
        let args: Vec<Value> = (0..ctx.len())
            .map(|index| to_json(ctx.get_raw(index), true))
            .collect();
        let key = json!([called, args]).to_string();
        let mut functions = functions.lock().unwrap();
        if let Some(value) = functions.memo.get(&key) {
            return Ok(value.clone());
        }
        if functions.seen.insert(key.clone()) {
            functions
                .missing
                .push(json!({ "name": called, "args": args, "key": key }));
        }
        Ok(Sql::Null)
    })
    .map_err(sqlite_error)?;
    db.functions
        .lock()
        .unwrap()
        .names
        .insert(name.to_ascii_lowercase());
    Ok(Value::Null)
}

/// better-sqlite3's `db.backup(destination, { attached })`: the online backup
/// API, all pages in one go.
fn backup(conn: &Connection, request: &Value) -> Result<Value, Value> {
    let destination = text(request, "destination")?;
    let attached = request["attached"].as_str().unwrap_or("main");
    let mut target = Connection::open(destination).map_err(sqlite_error)?;
    let backup = rusqlite::backup::Backup::new_with_names(conn, attached, &mut target, "main")
        .map_err(sqlite_error)?;
    backup
        .run_to_completion(100, Duration::ZERO, None)
        .map_err(sqlite_error)?;
    let progress = backup.progress();
    Ok(json!({ "totalPages": progress.pagecount, "remainingPages": progress.remaining }))
}

/// Close the databases `owner` opened before `stamp`.
pub fn close_owned_before(owner: &str, stamp: u64) {
    let closed: Vec<Arc<Database>> = {
        let mut table = DATABASES.lock().unwrap();
        let ids: Vec<u32> = table
            .iter()
            .filter(|(_, db)| db.owner == owner && db.stamp < stamp)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter().filter_map(|id| table.remove(&id)).collect()
    };
    for db in closed {
        db.interrupt.interrupt();
        db.conn.lock().unwrap().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(op: &str, request: Value) -> Result<Value, Value> {
        match run("test", op, &request, || 1)? {
            Output::Json(value) => Ok(value),
            Output::Bytes(bytes) => Ok(json!(bytes.len())),
        }
    }

    fn open_memory(flavor: &str) -> u64 {
        call("open", json!({ "filename": ":memory:", "flavor": flavor })).unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    #[test]
    fn better_sqlite3_binding_and_values() {
        let id = open_memory("better-sqlite3");
        call("exec", json!({ "id": id, "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, data BLOB, big INTEGER)" })).unwrap();
        let info = call(
            "prepare",
            json!({ "id": id, "sql": "INSERT INTO t (name, data, big) VALUES (@name, ?, ?)" }),
        )
        .unwrap();
        assert_eq!(info["reader"], false);
        assert_eq!(info["readonly"], false);
        assert_eq!(info["params"], json!(["@name", null, null]));
        let inserted = call("run", json!({
            "id": id,
            "sql": "INSERT INTO t (name, data, big) VALUES (@name, ?, ?)",
            "params": { "positional": [{ "$b": "AAEC" }, { "$i": "9007199254740993" }], "named": { "name": "a" } },
            "safe": true,
        }))
        .unwrap();
        assert_eq!(
            inserted,
            json!({ "changes": 1, "lastInsertRowid": { "$i": "1" } })
        );

        let missing = call("run", json!({ "id": id, "sql": "INSERT INTO t (name) VALUES (@name)", "params": { "positional": [] } })).unwrap_err();
        assert_eq!(
            missing,
            json!({ "kind": "RangeError", "message": "Missing named parameter \"name\"" })
        );
        let too_many = call("run", json!({ "id": id, "sql": "INSERT INTO t (name) VALUES (?)", "params": { "positional": ["x", "y"] } })).unwrap_err();
        assert_eq!(
            too_many["message"],
            "Too many parameter values were provided"
        );
        let duplicate = call("run", json!({ "id": id, "sql": "INSERT INTO t (name) VALUES (?)", "params": { "positional": ["a"] } })).unwrap_err();
        assert_eq!(duplicate["code"], "SQLITE_CONSTRAINT_UNIQUE");
        assert_eq!(duplicate["primary"], "SQLITE_CONSTRAINT");
        assert_eq!(duplicate["errno"], 19);
        assert_eq!(duplicate["message"], "UNIQUE constraint failed: t.name");

        let rows = call("query", json!({ "id": id, "sql": "SELECT name, data, big, 1.5 AS r, NULL AS n FROM t", "safe": true })).unwrap();
        assert_eq!(rows["columns"], json!(["name", "data", "big", "r", "n"]));
        assert_eq!(
            rows["rows"],
            json!([["a", { "$b": "AAEC" }, { "$i": "9007199254740993" }, 1.5, null]])
        );
        let unsafe_rows = call("query", json!({ "id": id, "sql": "SELECT id FROM t" })).unwrap();
        assert_eq!(unsafe_rows["rows"], json!([[1]]));

        let columns = call(
            "prepare",
            json!({ "id": id, "sql": "SELECT name AS n, 1 + 1 AS two FROM t" }),
        )
        .unwrap()["columns"]
            .clone();
        assert_eq!(
            columns[0],
            json!({ "name": "n", "column": "name", "table": "t", "database": "main", "type": "TEXT" })
        );
        assert_eq!(columns[1]["table"], Value::Null);

        let syntax = call("prepare", json!({ "id": id, "sql": "SELEC 1" })).unwrap_err();
        assert_eq!(syntax["code"], "SQLITE_ERROR");
        assert!(syntax["message"].as_str().unwrap().contains("syntax error"));
        let two = call("prepare", json!({ "id": id, "sql": "SELECT 1; SELECT 2" })).unwrap_err();
        assert_eq!(two["kind"], "RangeError");
        let none = call("prepare", json!({ "id": id, "sql": "  -- nothing" })).unwrap_err();
        assert_eq!(
            none["message"],
            "The supplied SQL string contains no statements"
        );
        // better-sqlite3's build: foreign keys on, double-quoted strings off.
        assert_eq!(
            call("query", json!({ "id": id, "sql": "PRAGMA foreign_keys" })).unwrap()["rows"],
            json!([[1]])
        );
        assert!(call(
            "query",
            json!({ "id": id, "sql": "SELECT \"not a column\"" })
        )
        .is_err());

        assert_eq!(
            call("status", json!({ "id": id })).unwrap()["inTransaction"],
            false
        );
        call("exec", json!({ "id": id, "sql": "BEGIN" })).unwrap();
        assert_eq!(
            call("status", json!({ "id": id })).unwrap()["inTransaction"],
            true
        );
        call("exec", json!({ "id": id, "sql": "ROLLBACK" })).unwrap();
        call("close", json!({ "id": id })).unwrap();
        assert_eq!(call("status", json!({ "id": id })).unwrap_err(), not_open());
    }

    #[test]
    fn node_sqlite3_binding() {
        let id = open_memory("sqlite3");
        assert_eq!(
            call("query", json!({ "id": id, "sql": "PRAGMA foreign_keys" })).unwrap()["rows"],
            json!([[0]])
        );
        let rows = call(
            "query",
            json!({
                "id": id,
                "sql": "SELECT $a AS a, ? AS b, :c AS c",
                "params": { "named": { "$a": 1, ":c": true, "2": "two" } },
            }),
        )
        .unwrap();
        assert_eq!(rows["rows"], json!([[1.0, "two", 1]]));
        let range = call(
            "query",
            json!({ "id": id, "sql": "SELECT ?", "params": { "positional": [1, 2] } }),
        )
        .unwrap_err();
        assert_eq!(range["primary"], "SQLITE_RANGE");
        // `run` accepts statements that return rows; changes are this statement's own.
        assert_eq!(
            call("run", json!({ "id": id, "sql": "SELECT 1" })).unwrap()["changes"],
            0
        );
    }

    #[test]
    fn user_functions_are_answered_from_the_memo() {
        let id = open_memory("better-sqlite3");
        call(
            "function",
            json!({ "id": id, "name": "twice", "args": 1, "deterministic": true }),
        )
        .unwrap();
        call("exec", json!({ "id": id, "sql": "CREATE TABLE t (x)" })).unwrap();
        let sql = "INSERT INTO t VALUES (twice(?))";
        let request = json!({ "id": id, "sql": sql, "params": { "positional": [{ "$i": "21" }] } });
        let first = call("run", request.clone()).unwrap();
        let needs = first["needs"].as_array().unwrap();
        assert_eq!(needs.len(), 1);
        assert_eq!(needs[0]["name"], "twice");
        assert_eq!(needs[0]["args"], json!([{ "$i": "21" }]));
        // The first run was rolled back.
        assert_eq!(
            call(
                "query",
                json!({ "id": id, "sql": "SELECT count(*) FROM t" })
            )
            .unwrap()["rows"],
            json!([[0]])
        );
        let mut retry = request.clone();
        retry["retry"] = json!(true);
        retry["memo"] = json!([{ "key": needs[0]["key"], "value": { "$i": "42" } }]);
        assert_eq!(call("run", retry).unwrap()["changes"], 1);
        assert_eq!(
            call("query", json!({ "id": id, "sql": "SELECT x FROM t" })).unwrap()["rows"],
            json!([[42]])
        );
    }

    #[test]
    fn serialize_and_load_an_image() {
        let id = open_memory("better-sqlite3");
        call(
            "exec",
            json!({ "id": id, "sql": "CREATE TABLE t (x); INSERT INTO t VALUES (7)" }),
        )
        .unwrap();
        let Output::Bytes(image) = run("test", "serialize", &json!({ "id": id }), || 1).unwrap()
        else {
            panic!("bytes expected")
        };
        let copy = call(
            "open",
            json!({ "filename": ":memory:", "data": BASE64.encode(&image) }),
        )
        .unwrap()["id"]
            .clone();
        assert_eq!(
            call("query", json!({ "id": copy, "sql": "SELECT x FROM t" })).unwrap()["rows"],
            json!([[7]])
        );
    }

    #[test]
    fn other_owners_cannot_use_a_database_and_pages_close_theirs() {
        let owned = |op: &str, request: Value, stamp: fn() -> u64| match run(
            "lifecycle",
            op,
            &request,
            stamp,
        ) {
            Ok(Output::Json(value)) => Ok(value),
            Ok(Output::Bytes(_)) => Ok(Value::Null),
            Err(error) => Err(error),
        };
        let old = owned("open", json!({ "filename": ":memory:" }), || 1).unwrap()["id"].clone();
        let new = owned("open", json!({ "filename": ":memory:" }), || 5).unwrap()["id"].clone();
        assert_eq!(
            run("someone-else", "status", &json!({ "id": old }), || 1).err(),
            Some(not_open())
        );
        close_owned_before("lifecycle", 2);
        assert_eq!(
            owned("status", json!({ "id": old }), || 1).unwrap_err(),
            not_open()
        );
        assert!(owned("status", json!({ "id": new }), || 1).is_ok());
    }

    #[test]
    fn transaction_keywords() {
        assert!(controls_transactions(
            "begin; insert into t values (1); commit"
        ));
        assert!(!controls_transactions("insert into beginning values (1)"));
    }
}
