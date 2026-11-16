//! node-pty (feature `pty`) on portable-pty: a pseudo-terminal (a Unix pty,
//! ConPTY on Windows) with a program running in it.
//!
//! `spawn` answers synchronously over the bridge with the terminal's id and
//! the child's pid, as node-pty's does; output is kept until JavaScript
//! attaches its Channel (`pty_attach`), then streamed as
//! `{ "type": "data", "data": <base64> }` and finally
//! `{ "type": "exit", "exitCode", "signal" }`. The exit is sent once the
//! output has been read to its end (or shortly after the child exited, when
//! a background process keeps the terminal open), so no output follows it.
//! Writes go through a thread of their own, so a child that does not read
//! never blocks the caller; `pause` stops reading, which makes a child that
//! writes a lot wait, as node-pty's flow control does.

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc, Condvar, LazyLock, Mutex,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

/// How long the exit waits for the rest of the output.
const DRAIN: Duration = Duration::from_millis(250);
/// Events kept for a terminal nobody attached to.
const MAX_BUFFERED: usize = 10_000;

/// Where a terminal's events go: kept until the Channel attaches.
enum Sink {
    Buffer(Vec<Value>),
    Channel(Channel<Value>),
}

struct Terminal {
    owner: String,
    stamp: u64,
    file: String,
    /// For signals (Windows terminates through the killer).
    #[cfg_attr(windows, allow(dead_code))]
    pid: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    sink: Mutex<Sink>,
    /// Reading is paused (node-pty's `pause()`).
    paused: (Mutex<bool>, Condvar),
    /// The output reached its end.
    drained: (Mutex<bool>, Condvar),
}

static TERMINALS: LazyLock<Mutex<HashMap<u32, Arc<Terminal>>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn failure(message: impl std::fmt::Display) -> Value {
    json!({ "message": message.to_string() })
}

impl Terminal {
    /// Send (or keep) an event; an exit delivered to JavaScript retires the terminal.
    fn send(&self, id: u32, event: Value) {
        let exit = event["type"] == "exit";
        let mut sink = self.sink.lock().unwrap();
        match &mut *sink {
            Sink::Buffer(events) => {
                if events.len() < MAX_BUFFERED || exit {
                    events.push(event);
                }
            }
            Sink::Channel(channel) => {
                let _ = channel.send(event);
                if exit {
                    drop(sink);
                    TERMINALS.lock().unwrap().remove(&id);
                }
            }
        }
    }
}

fn terminal(owner: &str, id: u32) -> Option<Arc<Terminal>> {
    TERMINALS
        .lock()
        .unwrap()
        .get(&id)
        .filter(|t| t.owner == owner)
        .cloned()
}

/// `spawn` (`{ file, args, cwd, env, cols, rows }` → `{ id, pid }`) and
/// `process` (`{ id }` → the foreground process's name).
pub fn run(owner: &str, op: &str, request: &Value, stamp: fn() -> u64) -> Result<Value, Value> {
    match op {
        "spawn" => spawn(owner, request, stamp()),
        "process" => {
            let id = request["id"].as_u64().unwrap_or(0) as u32;
            Ok(json!(terminal(owner, id).map(|t| foreground(&t))))
        }
        other => Err(failure(format!("unknown pty operation '{other}'"))),
    }
}

fn size(request: &Value) -> PtySize {
    let dimension = |key: &str, default: u16| {
        request[key]
            .as_u64()
            .map(|n| n.clamp(1, u16::MAX as u64) as u16)
            .unwrap_or(default)
    };
    PtySize {
        cols: dimension("cols", 80),
        rows: dimension("rows", 24),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn(owner: &str, request: &Value, stamp: u64) -> Result<Value, Value> {
    let file = request["file"]
        .as_str()
        .filter(|f| !f.is_empty())
        .ok_or_else(|| failure("file is required"))?
        .to_string();
    let pair = portable_pty::native_pty_system()
        .openpty(size(request))
        .map_err(failure)?;
    let mut command = CommandBuilder::new(&file);
    for arg in request["args"].as_array().into_iter().flatten() {
        command.arg(arg.as_str().unwrap_or_default());
    }
    if let Some(cwd) = request["cwd"].as_str() {
        if !std::path::Path::new(cwd).is_dir() {
            return Err(failure(format!("The cwd does not exist: {cwd}")));
        }
        command.cwd(cwd);
    }
    if let Some(env) = request["env"].as_object() {
        command.env_clear();
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| failure(format!("Failed to spawn '{file}': {e}")))?;
    // Our copy of the slave would keep the output open after the child exits.
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(failure)?;
    let mut writer = pair.master.take_writer().map_err(failure)?;
    let (to_writer, writes) = mpsc::channel::<Vec<u8>>();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let pid = child.process_id();
    let terminal = Arc::new(Terminal {
        owner: owner.to_string(),
        stamp,
        file,
        pid,
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(to_writer)),
        killer: Mutex::new(child.clone_killer()),
        sink: Mutex::new(Sink::Buffer(Vec::new())),
        paused: (Mutex::new(false), Condvar::new()),
        drained: (Mutex::new(false), Condvar::new()),
    });
    TERMINALS.lock().unwrap().insert(id, terminal.clone());

    thread::spawn(move || {
        for bytes in writes {
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });

    let output = terminal.clone();
    thread::spawn(move || read_output(id, &output, reader));

    thread::spawn(move || {
        let (exit_code, signal) = wait(&mut child);
        // ConPTY keeps the output open until the pseudo console is closed.
        if cfg!(windows) {
            terminal.master.lock().unwrap().take();
        }
        let (lock, done) = &terminal.drained;
        drop(done.wait_timeout_while(lock.lock().unwrap(), DRAIN, |drained| !*drained));
        terminal.send(
            id,
            json!({ "type": "exit", "exitCode": exit_code, "signal": signal }),
        );
    });

    Ok(json!({ "id": id, "pid": pid }))
}

fn read_output(id: u32, terminal: &Terminal, mut reader: Box<dyn Read + Send>) {
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        {
            let (lock, resumed) = &terminal.paused;
            drop(resumed.wait_while(lock.lock().unwrap(), |paused| *paused));
        }
        match reader.read(&mut chunk) {
            // EIO on Linux once every process holding the terminal is gone.
            Ok(0) | Err(_) => break,
            Ok(n) => terminal.send(
                id,
                json!({ "type": "data", "data": BASE64.encode(&chunk[..n]) }),
            ),
        }
    }
    let (lock, done) = &terminal.drained;
    *lock.lock().unwrap() = true;
    done.notify_all();
}

/// node-pty's `exitCode` and `signal` (the terminating signal's number, 0 if none).
fn wait(child: &mut Box<dyn portable_pty::Child + Send + Sync>) -> (i64, i64) {
    // Unix children are std's, whose status has the signal's number
    // (portable-pty's carries its description).
    #[cfg(unix)]
    if let Some(std_child) = {
        let child: &mut dyn portable_pty::Child = &mut **child;
        child.downcast_mut::<std::process::Child>()
    } {
        use std::os::unix::process::ExitStatusExt;
        return match std_child.wait() {
            Ok(status) => (
                status.code().unwrap_or(0) as i64,
                status.signal().unwrap_or(0) as i64,
            ),
            Err(_) => (1, 0),
        };
    }
    match child.wait() {
        Ok(status) => (status.exit_code() as i64, 0),
        Err(_) => (1, 0),
    }
}

/// The name of the program in the foreground of the terminal, as node-pty's
/// `process` reports it; the spawned file where that cannot be known.
fn foreground(terminal: &Terminal) -> String {
    #[cfg(unix)]
    {
        let leader = terminal
            .master
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|m| m.process_group_leader());
        if let Some(name) = leader.and_then(process_name) {
            return name;
        }
    }
    terminal.file.clone()
}

#[cfg(target_os = "linux")]
fn process_name(pid: i32) -> Option<String> {
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let first = cmdline.split(|&b| b == 0).next()?;
    (!first.is_empty()).then(|| String::from_utf8_lossy(first).into_owned())
}

#[cfg(target_os = "macos")]
fn process_name(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: proc_name writes at most `buffer.len()` bytes into `buffer`.
    let len = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    (len > 0).then(|| String::from_utf8_lossy(&buffer[..len as usize]).into_owned())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_name(_pid: i32) -> Option<String> {
    None
}

/// Send the terminal's events to `channel`, the ones kept so far first.
pub fn attach(owner: &str, id: u32, channel: Channel<Value>) -> bool {
    let Some(terminal) = terminal(owner, id) else {
        return false;
    };
    let mut sink = terminal.sink.lock().unwrap();
    let kept = match &mut *sink {
        Sink::Buffer(events) => std::mem::take(events),
        Sink::Channel(_) => Vec::new(),
    };
    let exited = kept.iter().any(|event| event["type"] == "exit");
    for event in kept {
        let _ = channel.send(event);
    }
    *sink = Sink::Channel(channel);
    drop(sink);
    if exited {
        TERMINALS.lock().unwrap().remove(&id);
    }
    true
}

/// `write`, `resize`, `kill`, `pause`, `resume`, `clear`. False when the
/// terminal is gone.
pub fn control(owner: &str, id: u32, op: &str, args: &Value) -> Result<Value, Value> {
    let Some(terminal) = terminal(owner, id) else {
        return Ok(json!(false));
    };
    match op {
        "write" => {
            let bytes = BASE64
                .decode(args["data"].as_str().unwrap_or_default())
                .map_err(failure)?;
            let sent = terminal
                .writer
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|writer| writer.send(bytes).is_ok());
            Ok(json!(sent))
        }
        "resize" => {
            let master = terminal.master.lock().unwrap();
            if let Some(master) = master.as_ref() {
                master.resize(size(args)).map_err(failure)?;
            }
            Ok(json!(true))
        }
        "kill" => {
            let signal = args["signal"].as_i64().unwrap_or(1);
            kill(&terminal, signal).map_err(failure)?;
            Ok(json!(true))
        }
        "pause" | "resume" => {
            let (lock, resumed) = &terminal.paused;
            *lock.lock().unwrap() = op == "pause";
            resumed.notify_all();
            Ok(json!(true))
        }
        // Windows' clear() resets ConPTY's buffer; there is nothing to clear elsewhere.
        "clear" => Ok(json!(true)),
        other => Err(failure(format!("unknown pty operation '{other}'"))),
    }
}

fn kill(terminal: &Terminal, signal: i64) -> std::io::Result<()> {
    #[cfg(unix)]
    if let Some(pid) = terminal.pid {
        // SAFETY: kill(2) has no memory preconditions.
        if unsafe { libc::kill(pid as libc::pid_t, signal as libc::c_int) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        return Ok(());
    }
    let _ = signal;
    terminal.killer.lock().unwrap().kill()
}

/// End the terminals `owner` opened before `stamp`: hang up (closing the
/// terminal signals its processes) and kill the child.
pub fn close_owned_before(owner: &str, stamp: u64) {
    let closed: Vec<Arc<Terminal>> = {
        let mut table = TERMINALS.lock().unwrap();
        let ids: Vec<u32> = table
            .iter()
            .filter(|(_, t)| t.owner == owner && t.stamp < stamp)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter().filter_map(|id| table.remove(&id)).collect()
    };
    for terminal in closed {
        terminal.writer.lock().unwrap().take();
        let _ = terminal.killer.lock().unwrap().kill();
        terminal.master.lock().unwrap().take();
        let (lock, resumed) = &terminal.paused;
        *lock.lock().unwrap() = false;
        resumed.notify_all();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn events(id: u32) -> Vec<Value> {
        let terminal = TERMINALS.lock().unwrap().get(&id).cloned();
        match terminal
            .map(|t| std::mem::replace(&mut *t.sink.lock().unwrap(), Sink::Buffer(Vec::new())))
        {
            Some(Sink::Buffer(events)) => events,
            _ => Vec::new(),
        }
    }

    fn output(events: &[Value]) -> String {
        events
            .iter()
            .filter(|e| e["type"] == "data")
            .map(|e| {
                String::from_utf8_lossy(&BASE64.decode(e["data"].as_str().unwrap()).unwrap())
                    .into_owned()
            })
            .collect()
    }

    /// Collect a terminal's events until its exit.
    fn until_exit(id: u32) -> Vec<Value> {
        let mut all = Vec::new();
        for _ in 0..200 {
            all.extend(events(id));
            if all.iter().any(|e| e["type"] == "exit") {
                return all;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("no exit: {all:?}");
    }

    #[test]
    fn runs_a_program_in_a_terminal() {
        let spawned = run(
            "pty-test",
            "spawn",
            &json!({ "file": "/bin/sh", "args": ["-c", "test -t 1 && echo tty; printf \"$COLUMNS_SET\"; stty size; exit 3"], "env": { "COLUMNS_SET": "ok ", "PATH": "/usr/bin:/bin" }, "cols": 100, "rows": 30 }),
            || 1,
        )
        .unwrap();
        let id = spawned["id"].as_u64().unwrap() as u32;
        assert!(spawned["pid"].as_u64().unwrap() > 0);
        let all = until_exit(id);
        let text = output(&all);
        assert!(text.contains("tty"), "{text:?}");
        assert!(text.contains("ok 30 100"), "{text:?}");
        assert_eq!(
            all.last().unwrap(),
            &json!({ "type": "exit", "exitCode": 3, "signal": 0 })
        );
    }

    #[test]
    fn writes_resizes_and_signals() {
        let spawned = run("pty-test", "spawn", &json!({ "file": "/bin/cat" }), || 1).unwrap();
        let id = spawned["id"].as_u64().unwrap() as u32;
        let data = BASE64.encode("hello\n");
        assert_eq!(
            control("pty-test", id, "write", &json!({ "data": data })).unwrap(),
            true
        );
        assert_eq!(
            control("pty-test", id, "resize", &json!({ "cols": 50, "rows": 10 })).unwrap(),
            true
        );
        assert_eq!(control("other", id, "resize", &json!({})).unwrap(), false);
        let mut seen = String::new();
        for _ in 0..100 {
            seen += &output(&events(id));
            if seen.matches("hello").count() >= 2 {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        // The echo of the input, then cat's copy.
        assert!(seen.matches("hello").count() >= 2, "{seen:?}");
        assert_eq!(
            run("pty-test", "process", &json!({ "id": id }), || 1).unwrap(),
            "/bin/cat"
        );
        control("pty-test", id, "kill", &json!({ "signal": 15 })).unwrap();
        let all = until_exit(id);
        assert_eq!(all.last().unwrap()["signal"], 15);
    }

    #[test]
    fn missing_programs_and_folders_fail_at_spawn() {
        assert!(run(
            "pty-test",
            "spawn",
            &json!({ "file": "/no/such/program" }),
            || 1
        )
        .is_err());
        assert!(run(
            "pty-test",
            "spawn",
            &json!({ "file": "/bin/sh", "cwd": "/no/such/dir" }),
            || 1
        )
        .is_err());
    }
}
