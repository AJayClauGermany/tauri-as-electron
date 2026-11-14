//! Node's `os` (Cargo feature `node-os`), reached over the synchronous bridge
//! (`node/os/<op>`): every `os` function is synchronous in Node.
//!
//! `info` returns what does not change while the app runs (host, kernel,
//! user, folders) and is cached by JavaScript; the other operations are
//! measured on each call.

// NodeError is the payload sent to JavaScript, not an error passed around.
#![allow(clippy::result_large_err)]

use serde_json::{json, Value};
use sysinfo::{CpuRefreshKind, Networks, RefreshKind, System};

use crate::node_common::NodeError;

/// Run one `os` operation.
pub fn run(op: &str, args: &Value) -> Result<Value, NodeError> {
    match op {
        "info" => Ok(info()),
        "memory" => {
            let mut system = System::new().map_err(unavailable)?;
            system.refresh_memory();
            Ok(json!({ "total": system.total_memory(), "free": system.available_memory() }))
        }
        "uptime" => Ok(json!(System::uptime().unwrap_or(0))),
        // Node returns zeros where there is no load average (Windows).
        "loadavg" => Ok(match System::load_average() {
            Ok(load) => json!([load.one, load.five, load.fifteen]),
            Err(_) => json!([0, 0, 0]),
        }),
        "cpus" => Ok(cpus()),
        "networkInterfaces" => Ok(network_interfaces()),
        "getPriority" => priority_get(args.get("pid").and_then(Value::as_i64).unwrap_or(0)),
        "setPriority" => priority_set(
            args.get("pid").and_then(Value::as_i64).unwrap_or(0),
            args.get("priority").and_then(Value::as_i64).unwrap_or(0),
        ),
        other => Err(NodeError::invalid(format!(
            "unknown os operation `{other}`"
        ))),
    }
}

fn unavailable(error: sysinfo::Error) -> NodeError {
    let error = match error {
        sysinfo::Error::Io(error) => error,
        other => std::io::Error::other(other.to_string()),
    };
    NodeError::io(&error, "uv_os_info", None, None)
}

fn strip_trailing_separator(path: String) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    // Keep a root (`/`, `C:\`) as it is.
    if trimmed.is_empty() || trimmed.ends_with(':') {
        path
    } else {
        trimmed.to_string()
    }
}

/// What `os` reports that does not change while the app runs.
fn info() -> Value {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE")
    } else {
        std::env::var("HOME")
    }
    .ok();
    let user = user();
    json!({
        "hostname": System::host_name().unwrap_or_default(),
        "homedir": home.or_else(|| user.get("homedir").and_then(Value::as_str).map(Into::into)).unwrap_or_default(),
        "tmpdir": strip_trailing_separator(std::env::temp_dir().to_string_lossy().into_owned()),
        "type": os_type(),
        "release": release(),
        "version": version(),
        "machine": machine(),
        "endianness": if cfg!(target_endian = "little") { "LE" } else { "BE" },
        "user": user,
    })
}

#[cfg(unix)]
fn uname() -> Option<[String; 4]> {
    // SAFETY: uname fills the struct; the fields are NUL-terminated C strings.
    unsafe {
        let mut name: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut name) != 0 {
            return None;
        }
        let field = |chars: &[libc::c_char]| {
            std::ffi::CStr::from_ptr(chars.as_ptr())
                .to_string_lossy()
                .into_owned()
        };
        Some([
            field(&name.sysname),
            field(&name.release),
            field(&name.version),
            field(&name.machine),
        ])
    }
}

/// `os.type()`: `Linux`, `Darwin`, `Windows_NT`, …
fn os_type() -> String {
    #[cfg(unix)]
    if let Some([sysname, ..]) = uname() {
        return sysname;
    }
    if cfg!(windows) {
        "Windows_NT".into()
    } else {
        std::env::consts::OS.into()
    }
}

/// `os.release()`: the kernel release (`6.8.0-…`, `23.1.0`, `10.0.22631`).
fn release() -> String {
    #[cfg(unix)]
    if let Some([_, release, ..]) = uname() {
        return release;
    }
    let kernel = System::kernel_version().unwrap_or_default();
    if cfg!(windows) && !kernel.contains('.') {
        format!("10.0.{kernel}")
    } else {
        kernel
    }
}

/// `os.version()`: `#1 SMP …` on Unix, `Windows 11 Pro` on Windows.
fn version() -> String {
    #[cfg(unix)]
    if let Some([_, _, version, _]) = uname() {
        return version;
    }
    System::long_os_version().unwrap_or_default()
}

/// `os.machine()`: `x86_64`, `arm64`, …
fn machine() -> String {
    #[cfg(unix)]
    if let Some([.., machine]) = uname() {
        return machine;
    }
    System::cpu_arch()
}

/// `os.userInfo()`.
#[cfg(unix)]
fn user() -> Value {
    // SAFETY: getpwuid_r writes into `entry` and `buffer`, which outlive the reads below.
    unsafe {
        let uid = libc::getuid();
        let gid = libc::getgid();
        let mut entry: libc::passwd = std::mem::zeroed();
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let found = libc::getpwuid_r(
            uid,
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut result,
        ) == 0
            && !result.is_null();
        let text = |ptr: *const libc::c_char| {
            if ptr.is_null() {
                None
            } else {
                Some(std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned())
            }
        };
        let username = if found { text(entry.pw_name) } else { None }
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_default();
        json!({
            "uid": uid,
            "gid": gid,
            "username": username,
            "homedir": if found { text(entry.pw_dir) } else { None }.or_else(|| std::env::var("HOME").ok()).unwrap_or_default(),
            "shell": if found { text(entry.pw_shell) } else { None },
        })
    }
}

#[cfg(not(unix))]
fn user() -> Value {
    json!({
        "uid": -1,
        "gid": -1,
        "username": std::env::var("USERNAME").unwrap_or_default(),
        "homedir": std::env::var("USERPROFILE").unwrap_or_default(),
        "shell": Value::Null,
    })
}

/// CPU time per core in milliseconds, from /proc/stat (Linux only; zeros elsewhere).
fn cpu_times() -> Vec<[u64; 5]> {
    #[cfg(target_os = "linux")]
    if let Ok(stat) = std::fs::read_to_string("/proc/stat") {
        // SAFETY: sysconf has no preconditions.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
        return stat
            .lines()
            .filter(|line| {
                line.starts_with("cpu") && line.as_bytes().get(3).is_some_and(u8::is_ascii_digit)
            })
            .map(|line| {
                let n: Vec<u64> = line
                    .split_whitespace()
                    .skip(1)
                    .map(|v| v.parse().unwrap_or(0))
                    .collect();
                let ms = |i: usize| n.get(i).copied().unwrap_or(0) * 1000 / ticks;
                // user, nice, sys, idle, irq
                [ms(0), ms(1), ms(2), ms(3), ms(5)]
            })
            .collect();
    }
    Vec::new()
}

/// `os.cpus()`: model, speed (MHz) and times per logical core.
fn cpus() -> Value {
    let Ok(system) = System::new_with_specifics(
        RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing().with_frequency()),
    ) else {
        return json!([]);
    };
    let times = cpu_times();
    let list: Vec<Value> = system
        .cpus()
        .iter()
        .enumerate()
        .map(|(index, cpu)| {
            let [user, nice, sys, idle, irq] = times.get(index).copied().unwrap_or([0; 5]);
            json!({
                "model": cpu.brand().trim(),
                "speed": cpu.frequency(),
                "times": { "user": user, "nice": nice, "sys": sys, "idle": idle, "irq": irq },
            })
        })
        .collect();
    Value::Array(list)
}

fn netmask(prefix: u8, v4: bool) -> String {
    if v4 {
        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - u32::from(prefix.min(32)))
        };
        std::net::Ipv4Addr::from(mask).to_string()
    } else {
        let mask = if prefix == 0 {
            0
        } else {
            u128::MAX << (128 - u32::from(prefix.min(128)))
        };
        std::net::Ipv6Addr::from(mask).to_string()
    }
}

/// `os.networkInterfaces()`: `{ name: [{ address, netmask, family, mac, internal, cidr, scopeid? }] }`.
fn network_interfaces() -> Value {
    let Ok(networks) = Networks::new_with_refreshed_list() else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    let mut names: Vec<_> = (&networks).into_iter().collect();
    names.sort_by(|a, b| a.0.cmp(b.0));
    for (name, data) in names {
        let mac = data.mac_address().to_string();
        let entries: Vec<Value> = data
            .ip_networks()
            .iter()
            .map(|network| {
                let v4 = network.addr.is_ipv4();
                let mut entry = json!({
                    "address": network.addr.to_string(),
                    "netmask": netmask(network.prefix, v4),
                    "family": if v4 { "IPv4" } else { "IPv6" },
                    "mac": mac,
                    "internal": network.addr.is_loopback(),
                    "cidr": format!("{}/{}", network.addr, network.prefix),
                });
                if !v4 {
                    entry["scopeid"] = json!(0);
                }
                entry
            })
            .collect();
        if !entries.is_empty() {
            out.insert(name.to_string_lossy().into_owned(), Value::Array(entries));
        }
    }
    Value::Object(out)
}

#[cfg(unix)]
fn priority_get(pid: i64) -> Result<Value, NodeError> {
    // -1 is a valid priority: clear errno first where it can be reached, so
    // that a -1 with errno still 0 is not taken for a failure.
    set_errno_zero();
    // SAFETY: getpriority has no memory preconditions.
    let value = unsafe { libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t) };
    if value == -1 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error().unwrap_or(0) != 0 {
            return Err(NodeError::io(&error, "uv_os_getpriority", None, None));
        }
    }
    Ok(json!(value))
}

#[cfg(unix)]
fn priority_set(pid: i64, priority: i64) -> Result<Value, NodeError> {
    // SAFETY: setpriority has no memory preconditions.
    if unsafe {
        libc::setpriority(
            libc::PRIO_PROCESS,
            pid as libc::id_t,
            priority as libc::c_int,
        )
    } != 0
    {
        return Err(NodeError::io(
            &std::io::Error::last_os_error(),
            "uv_os_setpriority",
            None,
            None,
        ));
    }
    Ok(Value::Null)
}

#[cfg(unix)]
fn set_errno_zero() {
    // SAFETY: the thread's errno location is always valid.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    unsafe {
        #[cfg(target_os = "linux")]
        let location = libc::__errno_location();
        #[cfg(target_os = "android")]
        let location = libc::__errno();
        *location = 0;
    }
    #[cfg(target_vendor = "apple")]
    unsafe {
        *libc::__error() = 0;
    }
}

#[cfg(not(unix))]
fn priority_get(_pid: i64) -> Result<Value, NodeError> {
    Ok(json!(0))
}

#[cfg(not(unix))]
fn priority_set(_pid: i64, _priority: i64) -> Result<Value, NodeError> {
    Err(NodeError::io(
        &std::io::Error::from(std::io::ErrorKind::Unsupported),
        "uv_os_setpriority",
        None,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_host() {
        let info = info();
        assert!(!info["type"].as_str().unwrap().is_empty());
        assert!(!info["tmpdir"].as_str().unwrap().is_empty());
        let memory = run("memory", &Value::Null).unwrap();
        assert!(memory["total"].as_u64().unwrap() >= memory["free"].as_u64().unwrap());
        assert!(!cpus().as_array().unwrap().is_empty());
        assert_eq!(netmask(24, true), "255.255.255.0");
        assert_eq!(netmask(64, false), "ffff:ffff:ffff:ffff::");
        assert!(run("getPriority", &json!({ "pid": 0 })).is_ok());
    }
}
