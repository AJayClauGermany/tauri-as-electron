//! What the Rust-backed Node built-ins share: Node-shaped errors.
//!
//! An `io::Error` becomes Node's `code` (`ENOENT`, …) and negative `errno`
//! (libuv's numbering on Windows); the JavaScript side builds Node's message
//! from `code`, `syscall`, `path` and `dest`.

// NodeError is the payload sent to JavaScript, not an error passed around.
#![allow(clippy::result_large_err)]
// Each node-* feature uses part of this module.
#![allow(dead_code)]

use std::io;

use serde::Serialize;

/// A Node-shaped error.
#[derive(Serialize, Debug)]
pub struct NodeError {
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

impl NodeError {
    pub fn io(error: &io::Error, syscall: &str, path: Option<&str>, dest: Option<&str>) -> Self {
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

    pub fn invalid(message: impl Into<String>) -> Self {
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
        io::ErrorKind::ConnectionRefused => uv("ECONNREFUSED"),
        io::ErrorKind::ConnectionReset => uv("ECONNRESET"),
        io::ErrorKind::ConnectionAborted => uv("ECONNABORTED"),
        io::ErrorKind::AddrInUse => uv("EADDRINUSE"),
        io::ErrorKind::AddrNotAvailable => uv("EADDRNOTAVAIL"),
        io::ErrorKind::BrokenPipe => uv("EPIPE"),
        io::ErrorKind::TimedOut => uv("ETIMEDOUT"),
        io::ErrorKind::NotConnected => uv("ENOTCONN"),
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
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::ECONNRESET => "ECONNRESET",
        libc::ECONNABORTED => "ECONNABORTED",
        libc::EADDRINUSE => "EADDRINUSE",
        libc::EADDRNOTAVAIL => "EADDRNOTAVAIL",
        libc::EPIPE => "EPIPE",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::EHOSTUNREACH => "EHOSTUNREACH",
        libc::ENETUNREACH => "ENETUNREACH",
        libc::ENOTCONN => "ENOTCONN",
        libc::EAFNOSUPPORT => "EAFNOSUPPORT",
        libc::ENOBUFS => "ENOBUFS",
        libc::EAGAIN => "EAGAIN",
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
        109 => "EOF",                  // BROKEN_PIPE
        232 => "EPIPE",                // NO_DATA
        231 => "EBUSY",                // PIPE_BUSY
        10061 => "ECONNREFUSED",       // WSAECONNREFUSED
        10054 => "ECONNRESET",         // WSAECONNRESET
        10053 => "ECONNABORTED",       // WSAECONNABORTED
        10048 => "EADDRINUSE",         // WSAEADDRINUSE
        10049 => "EADDRNOTAVAIL",      // WSAEADDRNOTAVAIL
        10060 => "ETIMEDOUT",          // WSAETIMEDOUT
        10065 => "EHOSTUNREACH",       // WSAEHOSTUNREACH
        10051 => "ENETUNREACH",        // WSAENETUNREACH
        10057 => "ENOTCONN",           // WSAENOTCONN
        10047 => "EAFNOSUPPORT",       // WSAEAFNOSUPPORT
        10055 => "ENOBUFS",            // WSAENOBUFS
        10035 => "EAGAIN",             // WSAEWOULDBLOCK
        _ => return None,
    };
    Some(uv(code))
}

#[cfg(not(any(unix, windows)))]
fn from_raw(_raw: i32) -> Option<(&'static str, i64)> {
    None
}

/// A code with this platform's errno for it (libuv's numbering on Windows).
pub fn uv(code: &'static str) -> (&'static str, i64) {
    #[cfg(unix)]
    let errno = match code {
        "ENOENT" => libc::ENOENT,
        "EACCES" => libc::EACCES,
        "EEXIST" => libc::EEXIST,
        "EINVAL" => libc::EINVAL,
        "EISDIR" => libc::EISDIR,
        "ENOTDIR" => libc::ENOTDIR,
        "EROFS" => libc::EROFS,
        "ECONNREFUSED" => libc::ECONNREFUSED,
        "ECONNRESET" => libc::ECONNRESET,
        "ECONNABORTED" => libc::ECONNABORTED,
        "EADDRINUSE" => libc::EADDRINUSE,
        "EADDRNOTAVAIL" => libc::EADDRNOTAVAIL,
        "EPIPE" => libc::EPIPE,
        "ETIMEDOUT" => libc::ETIMEDOUT,
        "ENOTCONN" => libc::ENOTCONN,
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
        "ECONNREFUSED" => 4078,
        "ECONNRESET" => 4077,
        "ECONNABORTED" => 4079,
        "EADDRINUSE" => 4091,
        "EADDRNOTAVAIL" => 4090,
        "EPIPE" => 4047,
        "ETIMEDOUT" => 4039,
        "EHOSTUNREACH" => 4073,
        "ENETUNREACH" => 4062,
        "ENOTCONN" => 4053,
        "EAFNOSUPPORT" => 4089,
        "ENOBUFS" => 4060,
        "EAGAIN" => 4088,
        _ => 0,
    };
    (code, -i64::from(errno))
}
