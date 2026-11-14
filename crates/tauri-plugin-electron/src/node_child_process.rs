//! Node's `child_process` (Cargo feature `node-child-process`).
//!
//! - `spawnSync` / `execSync` / `execFileSync`: [`spawn_sync`] over the
//!   synchronous bridge (`node/child_process/spawnSync`), on a thread of its
//!   own. The request body is the child's stdin; the answer is a frame with
//!   the exit status and both outputs.
//! - `spawn` / `exec` / `execFile`: [`Children::spawn`] behind the
//!   `child_spawn` command. Output and the exit are streamed to JavaScript
//!   through a Tauri `Channel`; `child_write`, `child_end` and `child_kill`
//!   act on the running process by id.
//!
//! Shells are chosen by JavaScript (`/bin/sh -c`, `cmd.exe /d /s /c`), as
//! Node does: Rust runs exactly the file and arguments it is given.

// NodeError is the payload sent to JavaScript, not an error passed around.
#![allow(clippy::result_large_err)]

use std::{
    collections::HashMap,
    io::{self, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::node_common::NodeError;

const SIGTERM: i32 = 15;

/// What JavaScript passes for every kind of spawn.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SpawnOptions {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// The complete environment; `None` inherits the app's.
    pub env: Option<HashMap<String, String>>,
    /// `pipe`, `inherit` or `ignore` for stdin, stdout and stderr.
    pub stdio: Vec<String>,
    /// Milliseconds; 0 means none (sync only).
    pub timeout: u64,
    /// Bytes per output stream (sync only).
    pub max_buffer: Option<usize>,
    pub kill_signal: Option<i32>,
    pub detached: bool,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub windows_hide: bool,
    pub windows_verbatim_arguments: bool,
}

impl SpawnOptions {
    fn stdio(&self, fd: usize) -> &str {
        self.stdio.get(fd).map(String::as_str).unwrap_or("pipe")
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.file);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            if self.windows_verbatim_arguments {
                for arg in &self.args {
                    command.raw_arg(arg);
                }
            } else {
                command.args(&self.args);
            }
            let mut flags = 0;
            if self.windows_hide {
                flags |= 0x0800_0000; // CREATE_NO_WINDOW
            }
            if self.detached {
                flags |= 0x0000_0008; // DETACHED_PROCESS
            }
            command.creation_flags(flags);
        }
        #[cfg(not(windows))]
        command.args(&self.args);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            if self.detached {
                command.process_group(0);
            }
            if let Some(uid) = self.uid {
                command.uid(uid);
            }
            if let Some(gid) = self.gid {
                command.gid(gid);
            }
        }
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = &self.env {
            command.env_clear().envs(env);
        }
        let stdio = |kind: &str| match kind {
            "inherit" => Stdio::inherit(),
            "ignore" => Stdio::null(),
            _ => Stdio::piped(),
        };
        command
            .stdin(stdio(self.stdio(0)))
            .stdout(stdio(self.stdio(1)))
            .stderr(stdio(self.stdio(2)));
        command
    }

    fn spawn_error(&self, error: &io::Error, sync: bool) -> NodeError {
        let syscall = format!("{} {}", if sync { "spawnSync" } else { "spawn" }, self.file);
        let mut node = NodeError::io(error, &syscall, Some(&self.file), None);
        // ENOENT from a missing cwd reads like Node's (the path is the file).
        if node.code == "ENOENT"
            && self
                .cwd
                .as_ref()
                .is_some_and(|cwd| !std::path::Path::new(cwd).is_dir())
        {
            node.message = format!("cwd does not exist: {}", self.cwd.as_deref().unwrap_or(""));
        }
        node
    }
}

fn signal_process(pid: u32, signal: i32) -> io::Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: kill(2) has no memory preconditions.
        if unsafe { libc::kill(pid as libc::pid_t, signal) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // No signals on Windows: Node terminates the process for every signal.
        let _ = signal;
        let status = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::from(io::ErrorKind::NotFound))
        }
    }
}

/// Exit code and terminating signal number.
fn exit_of(status: std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (status.code(), status.signal())
    }
    #[cfg(not(unix))]
    (status.code(), None)
}

/// Read a child's output into `out` (shared, so that a killed child's output
/// can be taken while a grandchild still holds the pipe open).
fn read_capped(
    mut source: impl Read,
    cap: Option<usize>,
    overflow: Arc<AtomicBool>,
    out: Arc<Mutex<Vec<u8>>>,
) {
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match source.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut out = out.lock().unwrap();
                out.extend_from_slice(&chunk[..n]);
                if cap.is_some_and(|cap| out.len() > cap) {
                    out.truncate(cap.unwrap_or(0));
                    overflow.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
    }
}

type Reader = (thread::JoinHandle<()>, Arc<Mutex<Vec<u8>>>);

/// `spawnSync`. The answer frame: little-endian `u32` header length, JSON
/// `{ pid, status, signal, stdout, stderr, error }` (`stdout` / `stderr`:
/// byte lengths, or null when not piped), then stdout and stderr.
pub fn spawn_sync(options: &SpawnOptions, input: &[u8]) -> Vec<u8> {
    let mut header = json!({ "pid": 0, "status": Value::Null, "signal": Value::Null, "stdout": Value::Null, "stderr": Value::Null });
    let (stdout, stderr) = match run_sync(options, input, &mut header) {
        Ok(outputs) => outputs,
        Err(error) => {
            header["error"] = json!(error);
            (None, None)
        }
    };
    header["stdout"] = json!(stdout.as_ref().map(Vec::len));
    header["stderr"] = json!(stderr.as_ref().map(Vec::len));
    let header = header.to_string().into_bytes();
    let mut frame = (header.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(&header);
    frame.extend_from_slice(stdout.as_deref().unwrap_or_default());
    frame.extend_from_slice(stderr.as_deref().unwrap_or_default());
    frame
}

type Outputs = (Option<Vec<u8>>, Option<Vec<u8>>);

fn run_sync(
    options: &SpawnOptions,
    input: &[u8],
    header: &mut Value,
) -> Result<Outputs, NodeError> {
    let mut child = options
        .command()
        .spawn()
        .map_err(|e| options.spawn_error(&e, true))?;
    let pid = child.id();
    header["pid"] = json!(pid);
    if let Some(mut stdin) = child.stdin.take() {
        let input = input.to_vec();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let overflow = Arc::new(AtomicBool::new(false));
    let reader = |stream: Option<Box<dyn Read + Send>>| -> Option<Reader> {
        let (cap, overflow) = (options.max_buffer, overflow.clone());
        stream.map(|s| {
            let out = Arc::new(Mutex::new(Vec::new()));
            let target = out.clone();
            (
                thread::spawn(move || read_capped(s, cap, overflow, target)),
                out,
            )
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );

    let started = Instant::now();
    let kill_signal = options.kill_signal.unwrap_or(SIGTERM);
    let mut failure = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                let timed_out = options.timeout > 0
                    && started.elapsed() >= Duration::from_millis(options.timeout);
                if failure.is_none() && (timed_out || overflow.load(Ordering::Relaxed)) {
                    let _ = signal_process(pid, kill_signal);
                    failure = Some(sync_failure(options, timed_out));
                }
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(NodeError::io(&error, "waitpid", None, None)),
        }
    };
    // The child may have died of the closed pipe before the loop saw the overflow.
    if failure.is_none() && overflow.load(Ordering::Relaxed) {
        failure = Some(sync_failure(options, false));
    }
    let (code, signal) = exit_of(status);
    header["status"] = json!(code);
    header["signal"] = json!(signal);
    if let Some(error) = failure {
        header["error"] = json!(error);
    }
    // Like Node: after a timeout or maxBuffer kill, return what was read
    // instead of waiting for pipes a grandchild may still hold open.
    let killed = header.get("error").is_some();
    let collect = |reader: Option<Reader>| {
        reader.map(|(handle, out)| {
            if killed {
                let deadline = Instant::now() + Duration::from_millis(50);
                while !handle.is_finished() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(2));
                }
            } else {
                let _ = handle.join();
            }
            std::mem::take(&mut *out.lock().unwrap())
        })
    };
    Ok((collect(stdout), collect(stderr)))
}

/// ETIMEDOUT (timeout) or ENOBUFS (maxBuffer), as Node's spawnSync reports them.
fn sync_failure(options: &SpawnOptions, timed_out: bool) -> NodeError {
    NodeError {
        code: if timed_out { "ETIMEDOUT" } else { "ENOBUFS" }.into(),
        errno: if timed_out {
            timeout_errno()
        } else {
            nobufs_errno()
        },
        syscall: format!("spawnSync {}", options.file),
        path: Some(options.file.clone()),
        dest: None,
        message: String::new(),
    }
}

fn timeout_errno() -> i64 {
    #[cfg(unix)]
    return -i64::from(libc::ETIMEDOUT);
    #[cfg(not(unix))]
    return -4039;
}

fn nobufs_errno() -> i64 {
    #[cfg(unix)]
    return -i64::from(libc::ENOBUFS);
    #[cfg(not(unix))]
    return -4060;
}

// --- asynchronous children ------------------------------------------------------------------

struct Running {
    pid: u32,
    child: Mutex<Child>,
    stdin: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

/// The running children of `spawn`, by id. Managed as plugin state.
#[derive(Default)]
pub struct Children {
    table: Mutex<HashMap<u32, Arc<Running>>>,
    next_id: AtomicU32,
}

impl Children {
    /// Start a child and stream its output and exit to `events`:
    /// `{ type: 'data', fd, data }` (base64), `{ type: 'end', fd }`,
    /// `{ type: 'exit', code, signal }`. Returns `{ id, pid }`.
    pub fn spawn(
        self: &Arc<Self>,
        options: &SpawnOptions,
        events: Channel<Value>,
    ) -> Result<Value, NodeError> {
        let mut child = options
            .command()
            .spawn()
            .map_err(|e| options.spawn_error(&e, false))?;
        let pid = child.id();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        // stdin: writes are queued, so the command that delivers them never blocks.
        let stdin = child.stdin.take().map(|mut pipe| {
            let (sender, receiver) = mpsc::channel::<Vec<u8>>();
            thread::spawn(move || {
                for chunk in receiver {
                    if pipe.write_all(&chunk).is_err() {
                        break;
                    }
                }
                // Dropping the pipe closes the child's stdin.
            });
            sender
        });

        for (fd, stream) in [
            (
                1,
                child
                    .stdout
                    .take()
                    .map(|s| Box::new(s) as Box<dyn Read + Send>),
            ),
            (
                2,
                child
                    .stderr
                    .take()
                    .map(|s| Box::new(s) as Box<dyn Read + Send>),
            ),
        ] {
            let Some(mut stream) = stream else { continue };
            let events = events.clone();
            thread::spawn(move || {
                let mut chunk = vec![0u8; 64 * 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let _ = events.send(json!({ "type": "data", "fd": fd, "data": BASE64.encode(&chunk[..n]) }));
                        }
                    }
                }
                let _ = events.send(json!({ "type": "end", "fd": fd }));
            });
        }

        let running = Arc::new(Running {
            pid,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
        });
        self.table.lock().unwrap().insert(id, running.clone());
        let children = self.clone();
        thread::spawn(move || loop {
            let status = running.child.lock().unwrap().try_wait();
            match status {
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Ok(Some(status)) => {
                    let (code, signal) = exit_of(status);
                    children.table.lock().unwrap().remove(&id);
                    let _ = events.send(json!({ "type": "exit", "code": code, "signal": signal }));
                    break;
                }
                Err(_) => {
                    children.table.lock().unwrap().remove(&id);
                    let _ = events.send(
                        json!({ "type": "exit", "code": Value::Null, "signal": Value::Null }),
                    );
                    break;
                }
            }
        });
        Ok(json!({ "id": id, "pid": pid }))
    }

    fn get(&self, id: u32) -> Option<Arc<Running>> {
        self.table.lock().unwrap().get(&id).cloned()
    }

    /// Queue bytes for the child's stdin. False once stdin is closed or the child has exited.
    pub fn write(&self, id: u32, data: Vec<u8>) -> bool {
        self.get(id)
            .and_then(|running| {
                running
                    .stdin
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|sender| sender.send(data).is_ok())
            })
            .unwrap_or(false)
    }

    /// Close the child's stdin (after the queued writes).
    pub fn end(&self, id: u32) {
        if let Some(running) = self.get(id) {
            running.stdin.lock().unwrap().take();
        }
    }

    /// `subprocess.kill(signal)`: false when the process is gone.
    pub fn kill(&self, id: u32, signal: i32) -> Result<bool, NodeError> {
        let Some(running) = self.get(id) else {
            return Ok(false);
        };
        match signal_process(running.pid, signal) {
            Ok(()) => Ok(true),
            Err(error) if error.raw_os_error() == Some(3) && cfg!(unix) => Ok(false), // ESRCH
            Err(error) => Err(NodeError::io(&error, "kill", None, None)),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn parse(frame: &[u8]) -> (Value, Vec<u8>, Vec<u8>) {
        let len = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(&frame[4..4 + len]).unwrap();
        let out = header["stdout"].as_u64().unwrap_or(0) as usize;
        let err = header["stderr"].as_u64().unwrap_or(0) as usize;
        let body = &frame[4 + len..];
        (
            header.clone(),
            body[..out].to_vec(),
            body[out..out + err].to_vec(),
        )
    }

    fn sh(script: &str) -> SpawnOptions {
        SpawnOptions {
            file: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            ..Default::default()
        }
    }

    #[test]
    fn runs_synchronously_with_input_and_status() {
        let (header, out, err) = parse(&spawn_sync(&sh("cat; echo oops >&2; exit 3"), b"hello"));
        assert_eq!(
            (header["status"].as_i64(), out.as_slice(), err.as_slice()),
            (Some(3), &b"hello"[..], &b"oops\n"[..])
        );
        let missing = SpawnOptions {
            file: "/definitely/not/here".into(),
            ..Default::default()
        };
        let (header, ..) = parse(&spawn_sync(&missing, b""));
        assert_eq!(header["error"]["code"], "ENOENT");
        assert_eq!(header["error"]["syscall"], "spawnSync /definitely/not/here");
    }

    #[test]
    fn enforces_timeout_and_max_buffer() {
        let mut slow = sh("sleep 5");
        slow.timeout = 100;
        let started = Instant::now();
        let (header, ..) = parse(&spawn_sync(&slow, b""));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            (header["error"]["code"].as_str(), header["signal"].as_i64()),
            (Some("ETIMEDOUT"), Some(15))
        );
        let mut chatty = sh("yes");
        chatty.max_buffer = Some(1000);
        let (header, out, _) = parse(&spawn_sync(&chatty, b""));
        assert_eq!(
            (header["error"]["code"].as_str(), out.len()),
            (Some("ENOBUFS"), 1000)
        );
    }
}
