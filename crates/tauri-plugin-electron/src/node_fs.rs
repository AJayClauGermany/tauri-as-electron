//! Node's `fs` / `fs/promises` (Cargo feature `node-fs`).
//!
//! One implementation behind both transports, so the synchronous and the
//! asynchronous JavaScript APIs behave and fail identically:
//!
//! - `fs.*Sync` reach [`run`] through the synchronous bridge
//!   (`tauri-electron://…/node/fs/<op>?a=<json>`, see `handle_node` in lib.rs),
//! - `fs.promises.*` and the callback API through the `node_fs` command.
//!
//! Arguments are a JSON object; data to write is the raw request body. A
//! failure is a [`FsError`] carrying what Node puts on its errors (`code`,
//! `errno`, `syscall`, `path`, `dest`); the JavaScript side builds Node's
//! message from it (`ENOENT: no such file or directory, open '/x'`).

// FsError is the payload sent to JavaScript, not an error passed around.
#![allow(clippy::result_large_err)]

use std::{
    collections::hash_map::RandomState,
    fs::{self, File, OpenOptions},
    hash::{BuildHasher, Hasher},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// What an operation returns: raw bytes (`read`) or JSON (everything else).
pub enum Output {
    Bytes(Vec<u8>),
    Json(Value),
}

/// A Node-shaped error.
#[derive(Serialize, Debug)]
pub struct FsError {
    pub code: String,
    pub errno: i64,
    pub syscall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest: Option<String>,
    /// The operating system's own description, for codes Node has no text for.
    pub message: String,
}

impl FsError {
    fn io(error: &io::Error, syscall: &str, path: Option<&str>, dest: Option<&str>) -> Self {
        let (code, errno) = error_code(error);
        Self {
            code: code.into(),
            errno,
            syscall: syscall.into(),
            path: path.map(Into::into),
            dest: dest.map(Into::into),
            message: error.to_string(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "ERR_INVALID_ARG_VALUE".into(),
            errno: 0,
            syscall: String::new(),
            path: None,
            dest: None,
            message: message.into(),
        }
    }
}

type FsResult = Result<Output, FsError>;

// --- error codes ----------------------------------------------------------------------------

/// `io::Error` → Node's `code` and (negative, libuv) `errno`. Raw OS error
/// numbers are mapped per platform (they differ between Linux, macOS and
/// Windows); `ErrorKind` is the fallback.
pub fn error_code(error: &io::Error) -> (&'static str, i64) {
    if let Some(raw) = error.raw_os_error() {
        if let Some(found) = from_raw(raw) {
            return found;
        }
    }
    match error.kind() {
        io::ErrorKind::NotFound => uv("ENOENT"),
        io::ErrorKind::PermissionDenied => uv("EACCES"),
        io::ErrorKind::AlreadyExists => uv("EEXIST"),
        io::ErrorKind::InvalidInput => uv("EINVAL"),
        io::ErrorKind::UnexpectedEof => uv("EOF"),
        _ => ("UNKNOWN", -4094),
    }
}

#[cfg(unix)]
fn from_raw(raw: i32) -> Option<(&'static str, i64)> {
    let code = match raw {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::EIO => "EIO",
        libc::EBADF => "EBADF",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::EMFILE => "EMFILE",
        libc::ENFILE => "ENFILE",
        libc::ETXTBSY => "ETXTBSY",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTSUP => "ENOTSUP",
        _ => return None,
    };
    Some((code, -i64::from(raw)))
}

/// Windows error codes as libuv translates them (`uv_translate_sys_error`).
#[cfg(windows)]
fn from_raw(raw: i32) -> Option<(&'static str, i64)> {
    let code = match raw {
        2 | 3 | 123 | 161 => "ENOENT", // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_NAME, BAD_PATHNAME
        5 => "EPERM",                  // ACCESS_DENIED
        1 => "EISDIR",                 // INVALID_FUNCTION
        4 => "EMFILE",                 // TOO_MANY_OPEN_FILES
        17 => "EXDEV",                 // NOT_SAME_DEVICE
        19 => "EROFS",                 // WRITE_PROTECT
        32 | 33 => "EBUSY",            // SHARING_VIOLATION, LOCK_VIOLATION
        39 | 112 => "ENOSPC",          // HANDLE_DISK_FULL, DISK_FULL
        80 | 183 => "EEXIST",          // FILE_EXISTS, ALREADY_EXISTS
        87 | 4390 => "EINVAL",         // INVALID_PARAMETER, NOT_A_REPARSE_POINT
        145 => "ENOTEMPTY",            // DIR_NOT_EMPTY
        206 => "ENAMETOOLONG",         // FILENAME_EXCED_RANGE
        267 => "ENOTDIR",              // DIRECTORY
        1921 => "ELOOP",               // CANT_RESOLVE_FILENAME
        _ => return None,
    };
    Some(uv(code))
}

#[cfg(not(any(unix, windows)))]
fn from_raw(_raw: i32) -> Option<(&'static str, i64)> {
    None
}

/// A code with this platform's errno for it (libuv's numbering on Windows).
fn uv(code: &'static str) -> (&'static str, i64) {
    #[cfg(unix)]
    let errno = match code {
        "ENOENT" => libc::ENOENT,
        "EACCES" => libc::EACCES,
        "EEXIST" => libc::EEXIST,
        "EINVAL" => libc::EINVAL,
        "EISDIR" => libc::EISDIR,
        "ENOTDIR" => libc::ENOTDIR,
        "EROFS" => libc::EROFS,
        "EOF" => return (code, -4095),
        _ => 0,
    };
    #[cfg(not(unix))]
    let errno = match code {
        "EOF" => 4095,
        "EACCES" => 4092,
        "EBUSY" => 4082,
        "EEXIST" => 4075,
        "EINVAL" => 4071,
        "EISDIR" => 4068,
        "ELOOP" => 4067,
        "EMFILE" => 4066,
        "ENAMETOOLONG" => 4064,
        "ENOENT" => 4058,
        "ENOSPC" => 4055,
        "ENOTDIR" => 4052,
        "ENOTEMPTY" => 4051,
        "EPERM" => 4048,
        "EROFS" => 4043,
        "EXDEV" => 4037,
        _ => 0,
    };
    (code, -i64::from(errno))
}

// --- arguments ----------------------------------------------------------------------------------

struct Args<'a>(&'a Map<String, Value>);

impl Args<'_> {
    fn str(&self, key: &str) -> Result<String, FsError> {
        self.0
            .get(key)
            .and_then(Value::as_str)
            .map(Into::into)
            .ok_or_else(|| FsError::invalid(format!("missing string argument `{key}`")))
    }

    fn opt_str(&self, key: &str) -> Option<String> {
        self.0.get(key).and_then(Value::as_str).map(Into::into)
    }

    fn flag(&self, key: &str) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    fn num(&self, key: &str) -> Option<f64> {
        self.0.get(key).and_then(Value::as_f64)
    }
}

// --- operations ---------------------------------------------------------------------------------

/// Run one `fs` operation. `data` is the payload of `write`.
pub fn run(op: &str, args: &Value, data: &[u8]) -> FsResult {
    let empty = Map::new();
    let args = Args(args.as_object().unwrap_or(&empty));
    match op {
        "read" => read(&args.str("path")?),
        "write" => write(
            &args.str("path")?,
            &args.opt_str("flag").unwrap_or_else(|| "w".into()),
            args.num("mode"),
            data,
        ),
        "stat" => stat(&args.str("path")?, false),
        "lstat" => stat(&args.str("path")?, true),
        "exists" => Ok(Output::Json(json!(fs::metadata(args.str("path")?).is_ok()))),
        "access" => access(&args.str("path")?, args.num("mode").unwrap_or(0.0) as i32),
        "mkdir" => mkdir(&args.str("path")?, args.flag("recursive"), args.num("mode")),
        "readdir" => readdir(&args.str("path")?, args.flag("recursive")),
        "rm" => rm(
            &args.str("path")?,
            args.flag("recursive"),
            args.flag("force"),
        ),
        "unlink" => {
            let path = args.str("path")?;
            fs::remove_file(&path).map_err(|e| FsError::io(&e, "unlink", Some(&path), None))?;
            Ok(Output::Json(Value::Null))
        }
        "rmdir" => {
            let path = args.str("path")?;
            let result = if args.flag("recursive") {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_dir(&path)
            };
            result.map_err(|e| FsError::io(&e, "rmdir", Some(&path), None))?;
            Ok(Output::Json(Value::Null))
        }
        "rename" => {
            let (from, to) = (args.str("path")?, args.str("dest")?);
            fs::rename(&from, &to)
                .map_err(|e| FsError::io(&e, "rename", Some(&from), Some(&to)))?;
            Ok(Output::Json(Value::Null))
        }
        "copyFile" => copy_file(
            &args.str("path")?,
            &args.str("dest")?,
            args.num("mode").unwrap_or(0.0) as i64,
        ),
        "realpath" => {
            let path = args.str("path")?;
            let real =
                fs::canonicalize(&path).map_err(|e| FsError::io(&e, "lstat", Some(&path), None))?;
            Ok(Output::Json(json!(display(&real))))
        }
        "mkdtemp" => mkdtemp(&args.str("prefix")?),
        "truncate" => {
            let path = args.str("path")?;
            let file = OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(|e| FsError::io(&e, "open", Some(&path), None))?;
            let len = args.num("len").unwrap_or(0.0).max(0.0) as u64;
            file.set_len(len)
                .map_err(|e| FsError::io(&e, "ftruncate", None, None))?;
            Ok(Output::Json(Value::Null))
        }
        "chmod" => chmod(&args.str("path")?, args.num("mode").unwrap_or(0.0) as u32),
        "utimes" => utimes(
            &args.str("path")?,
            args.num("atime").unwrap_or(0.0),
            args.num("mtime").unwrap_or(0.0),
        ),
        "readlink" => {
            let path = args.str("path")?;
            let target =
                fs::read_link(&path).map_err(|e| FsError::io(&e, "readlink", Some(&path), None))?;
            Ok(Output::Json(json!(display(&target))))
        }
        "symlink" => symlink(
            &args.str("target")?,
            &args.str("path")?,
            args.opt_str("type").as_deref(),
        ),
        other => Err(FsError::invalid(format!("unknown fs operation `{other}`"))),
    }
}

fn read(path: &str) -> FsResult {
    let mut file = File::open(path).map_err(|e| {
        // Windows refuses to open a directory as a file; Node reports EISDIR there too.
        if cfg!(windows) && Path::new(path).is_dir() {
            FsError {
                code: "EISDIR".into(),
                errno: uv("EISDIR").1,
                syscall: "read".into(),
                path: None,
                dest: None,
                message: e.to_string(),
            }
        } else {
            FsError::io(&e, "open", Some(path), None)
        }
    })?;
    let mut bytes = Vec::with_capacity(file.metadata().map(|m| m.len() as usize).unwrap_or(0));
    file.read_to_end(&mut bytes)
        .map_err(|e| FsError::io(&e, "read", None, None))?;
    Ok(Output::Bytes(bytes))
}

fn write(path: &str, flag: &str, mode: Option<f64>, data: &[u8]) -> FsResult {
    let mut options = OpenOptions::new();
    let exclusive = flag.contains('x');
    if flag.starts_with('a') || flag.starts_with("xa") {
        options.append(true);
    } else if flag.starts_with('w') || flag.starts_with("xw") {
        options.write(true).truncate(!exclusive);
    } else {
        return Err(FsError::invalid(format!(
            "unsupported flag '{flag}' for writing"
        )));
    }
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode.map(|m| m as u32).unwrap_or(0o666));
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options
        .open(path)
        .map_err(|e| FsError::io(&e, "open", Some(path), None))?;
    file.write_all(data)
        .map_err(|e| FsError::io(&e, "write", None, None))?;
    Ok(Output::Json(Value::Null))
}

fn millis(time: io::Result<SystemTime>) -> Option<f64> {
    let time = time.ok()?;
    Some(match time.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    })
}

const S_IFMT: u32 = 0o170000;
#[cfg(any(test, not(unix)))]
const S_IFREG: u32 = 0o100000;
#[cfg(not(unix))]
const S_IFDIR: u32 = 0o040000;
#[cfg(not(unix))]
const S_IFLNK: u32 = 0o120000;

/// `fs.Stats` fields, as Node lists them.
pub fn stats_json(meta: &fs::Metadata) -> Value {
    let birthtime = millis(meta.created());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ms = |secs: i64, nsec: i64| secs as f64 * 1000.0 + nsec as f64 / 1e6;
        let ctime = ms(meta.ctime(), meta.ctime_nsec());
        json!({
            "dev": meta.dev(), "ino": meta.ino(), "mode": meta.mode(), "nlink": meta.nlink(),
            "uid": meta.uid(), "gid": meta.gid(), "rdev": meta.rdev(), "size": meta.size(),
            "blksize": meta.blksize(), "blocks": meta.blocks(),
            "atimeMs": ms(meta.atime(), meta.atime_nsec()),
            "mtimeMs": ms(meta.mtime(), meta.mtime_nsec()),
            "ctimeMs": ctime,
            "birthtimeMs": birthtime.unwrap_or(ctime),
        })
    }
    #[cfg(not(unix))]
    {
        // What libuv reports on Windows: type bits plus rw-/r-- from the
        // read-only attribute; no inode numbers.
        let mtime = millis(meta.modified()).unwrap_or(0.0);
        let atime = millis(meta.accessed()).unwrap_or(mtime);
        let kind = meta.file_type();
        let mut mode = if kind.is_symlink() {
            S_IFLNK
        } else if kind.is_dir() {
            S_IFDIR
        } else {
            S_IFREG
        };
        mode |= if meta.permissions().readonly() {
            0o444
        } else {
            0o666
        };
        if kind.is_dir() {
            mode |= 0o111;
        }
        json!({
            "dev": 0, "ino": 0, "mode": mode, "nlink": 1, "uid": 0, "gid": 0, "rdev": 0,
            "size": meta.len(), "blksize": 4096, "blocks": meta.len().div_ceil(4096) * 8,
            "atimeMs": atime, "mtimeMs": mtime, "ctimeMs": mtime,
            "birthtimeMs": birthtime.unwrap_or(mtime),
        })
    }
}

fn stat(path: &str, link: bool) -> FsResult {
    let (meta, syscall) = if link {
        (fs::symlink_metadata(path), "lstat")
    } else {
        (fs::metadata(path), "stat")
    };
    let meta = meta.map_err(|e| FsError::io(&e, syscall, Some(path), None))?;
    Ok(Output::Json(stats_json(&meta)))
}

fn access(path: &str, mode: i32) -> FsResult {
    #[cfg(unix)]
    {
        let c_path = std::ffi::CString::new(path)
            .map_err(|_| FsError::invalid("path contains a NUL byte"))?;
        // SAFETY: a valid NUL-terminated string; access(2) only reads it.
        if unsafe { libc::access(c_path.as_ptr(), mode) } != 0 {
            return Err(FsError::io(
                &io::Error::last_os_error(),
                "access",
                Some(path),
                None,
            ));
        }
    }
    #[cfg(not(unix))]
    {
        // libuv on Windows: the file must exist; W_OK fails on read-only files.
        let meta = fs::metadata(path).map_err(|e| FsError::io(&e, "access", Some(path), None))?;
        if mode & 2 != 0 && !meta.is_dir() && meta.permissions().readonly() {
            let (code, errno) = uv("EPERM");
            return Err(FsError {
                code: code.into(),
                errno,
                syscall: "access".into(),
                path: Some(path.into()),
                dest: None,
                message: "read-only".into(),
            });
        }
    }
    Ok(Output::Json(Value::Null))
}

fn mkdir(path: &str, recursive: bool, mode: Option<f64>) -> FsResult {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(mode.map(|m| m as u32).unwrap_or(0o777));
    }
    #[cfg(not(unix))]
    let _ = mode;
    // Node returns the first directory a recursive mkdir created.
    let first = if recursive {
        Path::new(path)
            .ancestors()
            .take_while(|p| !p.as_os_str().is_empty() && fs::symlink_metadata(p).is_err())
            .last()
            .map(display)
    } else {
        None
    };
    builder
        .create(path)
        .map_err(|e| FsError::io(&e, "mkdir", Some(path), None))?;
    Ok(Output::Json(json!(first)))
}

fn kind_name(kind: fs::FileType) -> &'static str {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if kind.is_block_device() {
            return "block";
        }
        if kind.is_char_device() {
            return "char";
        }
        if kind.is_fifo() {
            return "fifo";
        }
        if kind.is_socket() {
            return "socket";
        }
    }
    if kind.is_symlink() {
        "symlink"
    } else if kind.is_dir() {
        "dir"
    } else if kind.is_file() {
        "file"
    } else {
        "unknown"
    }
}

/// Entries as `{ name, parent, type }`; `parent` is relative to `path`
/// (empty at the top level). Sorted by name per directory and, with
/// `recursive`, breadth first like Node. Symbolic links are not followed.
fn readdir(path: &str, recursive: bool) -> FsResult {
    let mut out = Vec::new();
    let mut queue = vec![PathBuf::new()];
    let mut index = 0;
    while index < queue.len() {
        let relative = queue[index].clone();
        index += 1;
        let dir = Path::new(path).join(&relative);
        let listing = fs::read_dir(&dir).map_err(|e| {
            let shown = if relative.as_os_str().is_empty() {
                path.to_string()
            } else {
                display(&dir)
            };
            FsError::io(&e, "scandir", Some(&shown), None)
        })?;
        let mut entries: Vec<(String, fs::FileType)> = Vec::new();
        for entry in listing {
            let entry = entry.map_err(|e| FsError::io(&e, "scandir", Some(path), None))?;
            let kind = entry
                .file_type()
                .map_err(|e| FsError::io(&e, "lstat", Some(&display(entry.path())), None))?;
            entries.push((entry.file_name().to_string_lossy().into_owned(), kind));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, kind) in entries {
            if recursive && kind.is_dir() {
                queue.push(relative.join(&name));
            }
            out.push(
                json!({ "name": name, "parent": display(&relative), "type": kind_name(kind) }),
            );
        }
        if !recursive {
            break;
        }
    }
    Ok(Output::Json(Value::Array(out)))
}

fn rm(path: &str, recursive: bool, force: bool) -> FsResult {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if force && e.kind() == io::ErrorKind::NotFound => {
            return Ok(Output::Json(Value::Null))
        }
        Err(e) => return Err(FsError::io(&e, "lstat", Some(path), None)),
    };
    let result = if meta.is_dir() {
        if !recursive {
            // Node's own error for this case (positive errno).
            return Err(FsError {
                code: "ERR_FS_EISDIR".into(),
                errno: uv("EISDIR").1.abs(),
                syscall: "rm".into(),
                path: Some(path.into()),
                dest: None,
                message: format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
            });
        }
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|e| FsError::io(&e, "rm", Some(path), None))?;
    Ok(Output::Json(Value::Null))
}

const COPYFILE_EXCL: i64 = 1;

fn copy_file(from: &str, to: &str, mode: i64) -> FsResult {
    let fail = |e: io::Error| FsError::io(&e, "copyfile", Some(from), Some(to));
    if mode & COPYFILE_EXCL != 0 && fs::symlink_metadata(to).is_ok() {
        return Err(fail(io::Error::from(io::ErrorKind::AlreadyExists)));
    }
    fs::copy(from, to).map_err(fail)?;
    Ok(Output::Json(Value::Null))
}

fn random_suffix() -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    let mut value = hasher.finish();
    (0..6)
        .map(|_| {
            let c = CHARS[(value % CHARS.len() as u64) as usize] as char;
            value /= CHARS.len() as u64;
            c
        })
        .collect()
}

fn mkdtemp(prefix: &str) -> FsResult {
    for _ in 0..100 {
        let candidate = format!("{prefix}{}", random_suffix());
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(Output::Json(json!(candidate))),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(FsError::io(
                    &e,
                    "mkdtemp",
                    Some(&format!("{prefix}XXXXXX")),
                    None,
                ))
            }
        }
    }
    Err(FsError::io(
        &io::Error::from(io::ErrorKind::AlreadyExists),
        "mkdtemp",
        Some(&format!("{prefix}XXXXXX")),
        None,
    ))
}

fn chmod(path: &str, mode: u32) -> FsResult {
    let fail = |e: io::Error| FsError::io(&e, "chmod", Some(path), None);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode & !S_IFMT)).map_err(fail)?;
    }
    #[cfg(not(unix))]
    {
        // Windows only has the read-only attribute: set when no write bit is.
        let mut permissions = fs::metadata(path).map_err(fail)?.permissions();
        permissions.set_readonly(mode & 0o222 == 0);
        fs::set_permissions(path, permissions).map_err(fail)?;
    }
    Ok(Output::Json(Value::Null))
}

fn to_system_time(seconds: f64) -> SystemTime {
    if seconds >= 0.0 {
        UNIX_EPOCH + Duration::from_secs_f64(seconds)
    } else {
        UNIX_EPOCH - Duration::from_secs_f64(-seconds)
    }
}

fn utimes(path: &str, atime: f64, mtime: f64) -> FsResult {
    let fail = |e: io::Error| FsError::io(&e, "utime", Some(path), None);
    let mut options = OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_WRITE_ATTRIBUTES; FILE_FLAG_BACKUP_SEMANTICS so directories open too.
        options.access_mode(0x100).custom_flags(0x0200_0000);
    }
    #[cfg(not(windows))]
    options.read(true);
    let file = options.open(path).map_err(fail)?;
    let times = fs::FileTimes::new()
        .set_accessed(to_system_time(atime))
        .set_modified(to_system_time(mtime));
    file.set_times(times).map_err(fail)?;
    Ok(Output::Json(Value::Null))
}

fn symlink(target: &str, path: &str, kind: Option<&str>) -> FsResult {
    let fail = |e: io::Error| FsError::io(&e, "symlink", Some(target), Some(path));
    #[cfg(unix)]
    {
        let _ = kind;
        std::os::unix::fs::symlink(target, path).map_err(fail)?;
    }
    #[cfg(windows)]
    {
        // Like Node: a directory link when asked for, or when the target is a directory.
        let resolved = Path::new(path)
            .parent()
            .unwrap_or(Path::new(""))
            .join(target);
        let dir =
            matches!(kind, Some("dir") | Some("junction")) || (kind.is_none() && resolved.is_dir());
        let result = if dir {
            std::os::windows::fs::symlink_dir(target, path)
        } else {
            std::os::windows::fs::symlink_file(target, path)
        };
        result.map_err(fail)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (kind, path);
        return Err(fail(io::Error::from(io::ErrorKind::Unsupported)));
    }
    Ok(Output::Json(Value::Null))
}

/// A path as JavaScript sees it: `\\?\C:\x` (what `canonicalize` returns on
/// Windows) without the verbatim prefix.
fn display(path: impl AsRef<Path>) -> String {
    let text = path.as_ref().to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").map(Into::into).unwrap_or(text)
}

// --- framing for the `node_fs` command --------------------------------------------------------------

/// Body of a `node_fs` command call: a little-endian `u32` length, that many
/// bytes of JSON `{ op, args }`, then the data to write. One raw body works
/// the same over every IPC transport, headers or not.
pub fn parse_frame(body: &[u8]) -> Result<(String, Value, &[u8]), FsError> {
    let invalid = || FsError::invalid("malformed node_fs request");
    let len = u32::from_le_bytes(
        body.get(..4)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?,
    ) as usize;
    let header: Value =
        serde_json::from_slice(body.get(4..4 + len).ok_or_else(invalid)?).map_err(|_| invalid())?;
    let op = header
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?
        .to_string();
    let args = header.get("args").cloned().unwrap_or(Value::Null);
    Ok((op, args, &body[4 + len..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("node-fs-test-{}", random_suffix()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn call(op: &str, args: Value, data: &[u8]) -> FsResult {
        run(op, &args, data)
    }

    fn json_of(output: FsResult) -> Value {
        match output {
            Ok(Output::Json(value)) => value,
            Ok(Output::Bytes(_)) => panic!("expected JSON"),
            Err(error) => panic!("unexpected error {error:?}"),
        }
    }

    #[test]
    fn write_read_append_and_exclusive() {
        let dir = temp_dir();
        let file = display(dir.join("a.txt"));
        json_of(call("write", json!({ "path": file }), b"hello"));
        json_of(call(
            "write",
            json!({ "path": file, "flag": "a" }),
            b" world",
        ));
        match call("read", json!({ "path": file }), &[]) {
            Ok(Output::Bytes(bytes)) => assert_eq!(bytes, b"hello world"),
            _ => panic!("read failed"),
        }
        let error = call("write", json!({ "path": file, "flag": "wx" }), b"x")
            .err()
            .unwrap();
        assert_eq!(
            (error.code.as_str(), error.syscall.as_str()),
            ("EEXIST", "open")
        );
        let error = call("read", json!({ "path": display(dir.join("missing")) }), &[])
            .err()
            .unwrap();
        assert_eq!(error.code, "ENOENT");
        assert!(error.errno < 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mkdir_readdir_rm() {
        let dir = temp_dir();
        let nested = dir.join("a/b/c");
        let first = json_of(call(
            "mkdir",
            json!({ "path": display(&nested), "recursive": true }),
            &[],
        ));
        assert_eq!(first, json!(display(dir.join("a"))));
        assert_eq!(
            json_of(call(
                "mkdir",
                json!({ "path": display(&nested), "recursive": true }),
                &[]
            )),
            Value::Null
        );
        fs::write(dir.join("a/file"), "x").unwrap();
        let listing = json_of(call(
            "readdir",
            json!({ "path": display(dir.join("a")), "recursive": true }),
            &[],
        ));
        let names: Vec<_> = listing
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    e["parent"].as_str().unwrap().replace('\\', "/"),
                    e["name"].as_str().unwrap().to_string(),
                    e["type"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![
                ("".into(), "b".into(), "dir".into()),
                ("".into(), "file".into(), "file".into()),
                ("b".into(), "c".into(), "dir".into())
            ]
        );
        let error = call("rm", json!({ "path": display(dir.join("a")) }), &[])
            .err()
            .unwrap();
        assert_eq!(error.code, "ERR_FS_EISDIR");
        json_of(call(
            "rm",
            json!({ "path": display(dir.join("a")), "recursive": true }),
            &[],
        ));
        json_of(call(
            "rm",
            json!({ "path": display(dir.join("a")), "force": true }),
            &[],
        ));
        let error = call("rm", json!({ "path": display(dir.join("a")) }), &[])
            .err()
            .unwrap();
        assert_eq!(
            (error.code.as_str(), error.syscall.as_str()),
            ("ENOENT", "lstat")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stat_and_copy() {
        let dir = temp_dir();
        let file = display(dir.join("s"));
        fs::write(&file, "1234").unwrap();
        let stats = json_of(call("stat", json!({ "path": file }), &[]));
        assert_eq!(stats["size"], json!(4));
        assert_eq!(stats["mode"].as_u64().unwrap() as u32 & S_IFMT, S_IFREG);
        let copy = display(dir.join("t"));
        json_of(call("copyFile", json!({ "path": file, "dest": copy }), &[]));
        let error = call(
            "copyFile",
            json!({ "path": file, "dest": copy, "mode": 1 }),
            &[],
        )
        .err()
        .unwrap();
        assert_eq!(
            (error.code.as_str(), error.dest.as_deref()),
            ("EEXIST", Some(copy.as_str()))
        );
        json_of(call(
            "utimes",
            json!({ "path": copy, "atime": 1000, "mtime": 2000.5 }),
            &[],
        ));
        let stats = json_of(call("stat", json!({ "path": copy }), &[]));
        assert_eq!(stats["mtimeMs"].as_f64().unwrap().round(), 2_000_500.0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn frames() {
        let header = br#"{"op":"write","args":{"path":"/x"}}"#;
        let mut body = (header.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(header);
        body.extend_from_slice(b"data");
        let (op, args, data) = parse_frame(&body).unwrap();
        assert_eq!(
            (op.as_str(), args["path"].as_str(), data),
            ("write", Some("/x"), &b"data"[..])
        );
        assert!(parse_frame(b"\xff\x00\x00\x00{}").is_err());
    }
}
