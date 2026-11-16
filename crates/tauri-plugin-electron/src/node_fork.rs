//! `child_process.fork`, `utilityProcess.fork` and `spawn` with an `'ipc'`
//! stdio entry (Cargo feature `node-child-process`): the IPC channel to the
//! child and the Node.js runtime `fork` starts.
//!
//! - **Channel.** On Unix, one end of a `socketpair` becomes descriptor `fd`
//!   (the index of `'ipc'` in `stdio`, 3 by default) in the child. For
//!   [`IpcKind::Node`] the child gets `NODE_CHANNEL_FD` and
//!   `NODE_CHANNEL_SERIALIZATION_MODE=json`, so `process.send()` and
//!   `process.on('message')` are Node's own; for [`IpcKind::Utility`]
//!   tauri-electron's bootstrap (`--require`) reads `TAURI_ELECTRON_IPC` and
//!   builds `process.parentPort` on it. Windows passes no descriptors to a
//!   child this way (Node's channel there is a named pipe handed over in
//!   `lpReserved2`, which `std::process::Command` cannot do), so the child
//!   connects back over loopback TCP instead and proves itself with a random
//!   token from its environment; the bootstrap then provides
//!   `process.send` / `process.parentPort` on that socket. Unverified on
//!   Windows; tested on Linux with `tcp: true`.
//! - **Messages** are newline-delimited JSON both ways (Node's `json`
//!   serialization). Rust forwards whole lines and never parses them.
//! - **Runtime.** [`node_runtime`]: the `execPath` option, then
//!   `$TAURI_ELECTRON_NODE`, then a sidecar next to the app's executable
//!   (`bundle.externalBin`: `<crate>-node`, or `node`), then in debug builds
//!   `node` on `PATH`.

// NodeError is the payload sent to JavaScript, not an error passed around.
#![allow(clippy::result_large_err)]

use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, Shutdown, TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::{fd::OwnedFd, unix::net::UnixStream};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::node_common::NodeError;

/// The variable tauri-electron's child bootstrap reads: `<kind>:fd:<n>` or
/// `<kind>:tcp:<port>:<token>`.
pub const IPC_ENV: &str = "TAURI_ELECTRON_IPC";

/// How long a TCP child has to connect back.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// Who reads the channel in the child.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IpcKind {
    /// Node's own `process.send` (`child_process.fork`).
    Node,
    /// tauri-electron's `process.parentPort` (`utilityProcess.fork`).
    Utility,
}

impl IpcKind {
    fn name(self) -> &'static str {
        match self {
            IpcKind::Node => "node",
            IpcKind::Utility => "utility",
        }
    }
}

/// The `ipc` part of a spawn request.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IpcOptions {
    pub kind: IpcKind,
    /// The descriptor in the child (Unix).
    #[serde(default = "default_fd")]
    pub fd: i32,
    /// Use the loopback transport on Unix too (always used on Windows).
    #[serde(default)]
    pub tcp: bool,
}

fn default_fd() -> i32 {
    3
}

/// Receives `{ type: 'ipc', lines }` and `{ type: 'ipc-end' }`.
pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// Either end of a channel.
enum Stream {
    #[cfg(unix)]
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Stream {
    fn try_clone(&self) -> io::Result<Stream> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.try_clone().map(Stream::Unix),
            Stream::Tcp(s) => s.try_clone().map(Stream::Tcp),
        }
    }

    fn shutdown(&self) {
        let _ = match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.shutdown(Shutdown::Both),
            Stream::Tcp(s) => s.shutdown(Shutdown::Both),
        };
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.read(buf),
            Stream::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.write(buf),
            Stream::Tcp(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.flush(),
            Stream::Tcp(s) => s.flush(),
        }
    }
}

/// A channel set up on a `Command` that has not been spawned yet.
pub enum Pending {
    #[cfg(unix)]
    Socket {
        parent: UnixStream,
        /// The child's end: closed in the parent once the child runs, so
        /// that the parent sees end-of-file when the child goes away.
        child: OwnedFd,
    },
    Tcp {
        listener: TcpListener,
        token: String,
    },
}

/// Give `command` an IPC channel.
pub fn prepare(command: &mut Command, ipc: &IpcOptions) -> io::Result<Pending> {
    #[cfg(unix)]
    if !ipc.tcp {
        return prepare_socket(command, ipc);
    }
    // Windows always connects back over loopback; there is no descriptor to place.
    #[cfg(not(unix))]
    let _ = (ipc.fd, ipc.tcp);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    command.env(IPC_ENV, format!("{}:tcp:{port}:{token}", ipc.kind.name()));
    Ok(Pending::Tcp { listener, token })
}

#[cfg(unix)]
fn prepare_socket(command: &mut Command, ipc: &IpcOptions) -> io::Result<Pending> {
    use std::os::{fd::AsRawFd, unix::process::CommandExt};

    if ipc.fd < 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the IPC descriptor must be 3 or higher",
        ));
    }
    // Both ends are close-on-exec; the child's end is made inheritable as
    // `target` between fork and exec only.
    let (parent, child) = UnixStream::pair()?;
    let child: OwnedFd = child.into();
    let raw = child.as_raw_fd();
    let target = ipc.fd;
    // SAFETY: the closure runs between fork and exec and only calls the
    // async-signal-safe dup2(2) and fcntl(2).
    unsafe {
        command.pre_exec(move || {
            if raw == target {
                let flags = libc::fcntl(target, libc::F_GETFD);
                if flags < 0 || libc::fcntl(target, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(io::Error::last_os_error());
                }
            } else if libc::dup2(raw, target) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    match ipc.kind {
        IpcKind::Node => {
            command
                .env("NODE_CHANNEL_FD", target.to_string())
                .env("NODE_CHANNEL_SERIALIZATION_MODE", "json");
        }
        IpcKind::Utility => {
            command.env(IPC_ENV, format!("utility:fd:{target}"));
        }
    }
    Ok(Pending::Socket { parent, child })
}

/// 128 random bits as hex, from the standard library's randomly seeded hasher keys.
fn random_token() -> String {
    let mut token = String::new();
    for round in 0..2u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(round);
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        hasher.write_u32(std::process::id());
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

/// A running channel.
pub struct Ipc {
    /// Lines for the child; dropped by `disconnect`, after which the writer
    /// flushes what is queued and shuts the socket down.
    queue: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    /// The connected socket (for TCP, once the child has connected).
    stream: Mutex<Option<Stream>>,
    closed: Mutex<bool>,
    closed_changed: Condvar,
    /// TCP: whether to keep waiting for the child to connect. A disconnect()
    /// stops the wait unless messages were queued before the child connected
    /// (they reach it first, as on Unix); the child's exit always stops it.
    disconnecting: AtomicBool,
    queued_unconnected: AtomicBool,
    child_gone: AtomicBool,
}

impl Ipc {
    fn new(sender: mpsc::Sender<Vec<u8>>) -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(Some(sender)),
            stream: Mutex::new(None),
            closed: Mutex::new(false),
            closed_changed: Condvar::new(),
            disconnecting: AtomicBool::new(false),
            queued_unconnected: AtomicBool::new(false),
            child_gone: AtomicBool::new(false),
        })
    }

    /// Queue bytes (a JSON line) for the child. False once disconnected.
    pub fn send(&self, data: Vec<u8>) -> bool {
        if self.stream.lock().unwrap().is_none() {
            self.queued_unconnected.store(true, Ordering::SeqCst);
        }
        self.queue
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|sender| sender.send(data).is_ok())
    }

    /// Close the channel after the queued messages (`subprocess.disconnect()`).
    pub fn disconnect(&self) {
        self.disconnecting.store(true, Ordering::SeqCst);
        self.queue.lock().unwrap().take();
    }

    /// The child exited: it will not connect any more (TCP), then disconnect.
    pub fn child_exited(&self) {
        self.child_gone.store(true, Ordering::SeqCst);
        self.disconnect();
    }

    /// TCP: whether waiting for the child to connect is pointless now.
    fn stop_waiting(&self) -> bool {
        *self.closed.lock().unwrap()
            || self.child_gone.load(Ordering::SeqCst)
            || (self.disconnecting.load(Ordering::SeqCst)
                && !self.queued_unconnected.load(Ordering::SeqCst))
    }

    /// Wait until the channel has closed (the child exited or disconnected).
    pub fn wait_closed(&self, timeout: Duration) -> bool {
        let closed = self.closed.lock().unwrap();
        let (closed, _) = self
            .closed_changed
            .wait_timeout_while(closed, timeout, |closed| !*closed)
            .unwrap();
        *closed
    }

    fn mark_closed(&self) {
        *self.closed.lock().unwrap() = true;
        self.closed_changed.notify_all();
        self.queue.lock().unwrap().take();
    }

    /// Shut the socket down (both directions), ending both threads.
    fn shutdown(&self) {
        if let Some(stream) = self.stream.lock().unwrap().as_ref() {
            stream.shutdown();
        }
    }
}

impl Drop for Ipc {
    fn drop(&mut self) {
        if let Some(stream) = self.stream.get_mut().unwrap().as_ref() {
            stream.shutdown();
        }
    }
}

impl Pending {
    /// The child is running: close its end here and start moving lines.
    pub fn start(self, sink: Sink) -> Arc<Ipc> {
        let (sender, receiver) = mpsc::channel::<Vec<u8>>();
        let ipc = Ipc::new(sender);
        match self {
            #[cfg(unix)]
            Pending::Socket { parent, child } => {
                drop(child);
                connected(&ipc, Stream::Unix(parent), receiver, sink);
            }
            Pending::Tcp { listener, token } => {
                let ipc = ipc.clone();
                thread::spawn(move || match accept(&listener, &token, &ipc) {
                    Some(stream) => connected(&ipc, Stream::Tcp(stream), receiver, sink),
                    None => {
                        ipc.mark_closed();
                        sink(json!({ "type": "ipc-end" }));
                    }
                });
            }
        }
        ipc
    }
}

/// The first loopback connection that presents `token` (TCP transport).
fn accept(listener: &TcpListener, token: &str, ipc: &Ipc) -> Option<TcpStream> {
    listener.set_nonblocking(true).ok()?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    // A disconnect() after send() still waits for the child: the queued
    // messages must reach it first, as on Unix (see `Ipc::stop_waiting`).
    while Instant::now() < deadline && !ipc.stop_waiting() {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                // Byte by byte, so that what follows the token stays in the
                // socket for the reader.
                let mut first = Vec::new();
                let mut byte = [0u8];
                while first.len() <= token.len() && stream.read_exact(&mut byte).is_ok() {
                    if byte[0] == b'\n' {
                        break;
                    }
                    first.push(byte[0]);
                }
                if byte[0] == b'\n' && first == token.as_bytes() {
                    let _ = stream.set_read_timeout(None);
                    let _ = stream.set_nodelay(true);
                    return Some(stream);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => return None,
        }
    }
    None
}

/// Start the writer (queue → socket) and the reader (socket → `sink`).
fn connected(ipc: &Arc<Ipc>, stream: Stream, receiver: mpsc::Receiver<Vec<u8>>, sink: Sink) {
    let (Ok(mut writer), Ok(control)) = (stream.try_clone(), stream.try_clone()) else {
        ipc.mark_closed();
        sink(json!({ "type": "ipc-end" }));
        return;
    };
    *ipc.stream.lock().unwrap() = Some(control);
    // A disconnect() that came before the child connected (TCP) has dropped
    // the sender: the writer below sends what is queued, then shuts down.
    let writer_ipc = Arc::downgrade(ipc);
    thread::spawn(move || {
        for chunk in receiver {
            if writer.write_all(&chunk).is_err() {
                break;
            }
        }
        // Every sender is gone: disconnect() or the child is gone.
        if let Some(ipc) = writer_ipc.upgrade() {
            ipc.shutdown();
        } else {
            writer.shutdown();
        }
    });
    let reader_ipc = ipc.clone();
    thread::spawn(move || {
        read_lines(stream, &sink);
        reader_ipc.mark_closed();
        sink(json!({ "type": "ipc-end" }));
    });
}

/// Forward complete lines, batching those that arrived together.
fn read_lines(stream: Stream, sink: &Sink) {
    let mut reader = BufReader::with_capacity(64 * 1024, stream);
    let mut line = Vec::new();
    loop {
        let mut lines = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => {
                    flush(sink, lines);
                    return;
                }
                Ok(_) => {
                    if line.last() == Some(&b'\n') {
                        line.pop();
                    } else {
                        // The child closed mid-line: what Node would also drop.
                        flush(sink, lines);
                        return;
                    }
                    if !line.is_empty() {
                        lines.push(String::from_utf8_lossy(&line).into_owned());
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    flush(sink, lines);
                    return;
                }
            }
            // Stop batching when no further complete line is buffered.
            if !reader.buffer().contains(&b'\n') || lines.len() >= 256 {
                break;
            }
        }
        flush(sink, lines);
    }
}

fn flush(sink: &Sink, lines: Vec<String>) {
    if !lines.is_empty() {
        sink(json!({ "type": "ipc", "lines": lines }));
    }
}

// --- the Node.js runtime ----------------------------------------------------------------------

fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Executable files called `name` in the directories of `$PATH`.
fn search_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// The Node.js that `fork` runs (see the module documentation). `crate_name`
/// is the app's Cargo package, whose `<crate>-node` sidecar is looked for first.
pub fn node_runtime(explicit: &str, crate_name: &str) -> Result<PathBuf, NodeError> {
    if !explicit.is_empty() {
        return Ok(PathBuf::from(explicit));
    }
    if let Some(path) = std::env::var_os("TAURI_ELECTRON_NODE").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let names = [exe_name(&format!("{crate_name}-node")), exe_name("node")];
    let dir = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    if let Some(dir) = &dir {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    if cfg!(debug_assertions) {
        if let Some(found) = search_path(&exe_name("node")) {
            return Ok(found);
        }
    }
    let looked = dir
        .map(|dir| format!(" (looked for {} in {})", names.join(" and "), dir.display()))
        .unwrap_or_default();
    Err(NodeError {
        code: "ENOENT".into(),
        errno: -2,
        syscall: "spawn node".into(),
        path: Some("node".into()),
        dest: None,
        message: format!(
            "no Node.js runtime to fork with{looked}: bundle one as a sidecar (bundle.externalBin \"binaries/{crate_name}-node\"; `npx tauri-electron-node-sidecar` sets it up) or pass execPath{}",
            if cfg!(debug_assertions) { ", or put node on PATH" } else { "" }
        ),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn collect() -> (Sink, mpsc::Receiver<Value>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (
            Arc::new(move |v| {
                let _ = tx.lock().unwrap().send(v);
            }),
            rx,
        )
    }

    fn next_lines(rx: &mpsc::Receiver<Value>) -> Vec<String> {
        let mut all = Vec::new();
        while all.is_empty() {
            let event = rx.recv_timeout(Duration::from_secs(10)).expect("an event");
            if event["type"] == "ipc" {
                all.extend(
                    event["lines"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|l| l.as_str().unwrap().to_string()),
                );
            } else {
                panic!("unexpected {event}");
            }
        }
        all
    }

    fn wait_end(rx: &mpsc::Receiver<Value>) {
        loop {
            let event = rx.recv_timeout(Duration::from_secs(10)).expect("ipc-end");
            if event["type"] == "ipc-end" {
                return;
            }
        }
    }

    /// A shell child that echoes each line it reads on the descriptor back.
    #[test]
    fn socket_channel_round_trip_and_end() {
        let ipc = IpcOptions {
            kind: IpcKind::Utility,
            fd: 3,
            tcp: false,
        };
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "echo \"$TAURI_ELECTRON_IPC\" >&3; while read -r line <&3; do echo \"got $line\" >&3; done",
            ])
            .stdin(Stdio::null());
        let pending = prepare(&mut command, &ipc).unwrap();
        let mut child = command.spawn().unwrap();
        let (sink, rx) = collect();
        let channel = pending.start(sink);
        assert_eq!(next_lines(&rx), vec!["utility:fd:3".to_string()]);
        assert!(channel.send(b"{\"a\":1}\n".to_vec()));
        assert_eq!(next_lines(&rx), vec!["got {\"a\":1}".to_string()]);
        // disconnect(): the child reads end-of-file and exits; the channel ends.
        channel.disconnect();
        assert!(!channel.send(b"late\n".to_vec()));
        wait_end(&rx);
        assert!(channel.wait_closed(Duration::from_secs(1)));
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn node_kind_sets_nodes_variables() {
        let ipc = IpcOptions {
            kind: IpcKind::Node,
            fd: 4,
            tcp: false,
        };
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "echo \"$NODE_CHANNEL_FD $NODE_CHANNEL_SERIALIZATION_MODE\" >&4",
        ]);
        let pending = prepare(&mut command, &ipc).unwrap();
        let mut child = command.spawn().unwrap();
        let (sink, rx) = collect();
        let _channel = pending.start(sink);
        assert_eq!(next_lines(&rx), vec!["4 json".to_string()]);
        wait_end(&rx);
        child.wait().unwrap();
        let low = IpcOptions {
            kind: IpcKind::Node,
            fd: 1,
            tcp: false,
        };
        assert!(prepare(&mut Command::new("/bin/true"), &low).is_err());
    }

    #[test]
    fn tcp_channel_needs_the_token() {
        let ipc = IpcOptions {
            kind: IpcKind::Utility,
            fd: 3,
            tcp: true,
        };
        let mut command = Command::new("/bin/true");
        let pending = prepare(&mut command, &ipc).unwrap();
        let env: Vec<_> = command
            .get_envs()
            .filter(|(k, _)| *k == IPC_ENV)
            .map(|(_, v)| v.unwrap().to_string_lossy().into_owned())
            .collect();
        let parts: Vec<&str> = env[0].split(':').collect();
        assert_eq!(&parts[..2], ["utility", "tcp"]);
        let port: u16 = parts[2].parse().unwrap();
        let token = parts[3].to_string();
        assert_eq!(token.len(), 32);
        let (sink, rx) = collect();
        let channel = pending.start(sink);
        // A wrong token is turned away; the right one connects.
        let mut intruder = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        intruder.write_all(b"guess\n").unwrap();
        let mut child = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        child.write_all(format!("{token}\n").as_bytes()).unwrap();
        assert!(channel.send(b"\"hello\"\n".to_vec()));
        let mut reader = BufReader::new(child.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "\"hello\"\n");
        child.write_all(b"1\n2\n").unwrap();
        let mut lines = next_lines(&rx);
        if lines.len() < 2 {
            lines.extend(next_lines(&rx));
        }
        assert_eq!(lines, vec!["1".to_string(), "2".to_string()]);
        drop(reader);
        drop(child);
        wait_end(&rx);
    }

    /// send() then disconnect() before the child connects back (TCP): the
    /// child still gets the message, then end-of-file.
    #[test]
    fn tcp_disconnect_before_connect_flushes_the_queue() {
        let ipc = IpcOptions {
            kind: IpcKind::Utility,
            fd: 3,
            tcp: true,
        };
        let mut command = Command::new("/bin/true");
        let pending = prepare(&mut command, &ipc).unwrap();
        let env: String = command
            .get_envs()
            .find(|(k, _)| *k == IPC_ENV)
            .map(|(_, v)| v.unwrap().to_string_lossy().into_owned())
            .unwrap();
        let parts: Vec<&str> = env.split(':').collect();
        let port: u16 = parts[2].parse().unwrap();
        let token = parts[3].to_string();
        let (sink, rx) = collect();
        let channel = pending.start(sink);
        assert!(channel.send(b"\"job\"\n".to_vec()));
        channel.disconnect();
        let mut child = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        child.write_all(format!("{token}\n").as_bytes()).unwrap();
        let mut received = String::new();
        child.read_to_string(&mut received).unwrap();
        assert_eq!(received, "\"job\"\n");
        drop(child);
        wait_end(&rx);
    }

    /// Waiting for a TCP child stops at once when nothing is queued for it,
    /// and when the child has exited.
    #[test]
    fn tcp_stops_waiting_for_a_child_that_will_not_connect() {
        for exited in [false, true] {
            let ipc = IpcOptions {
                kind: IpcKind::Utility,
                fd: 3,
                tcp: true,
            };
            let mut command = Command::new("/bin/true");
            let pending = prepare(&mut command, &ipc).unwrap();
            let (sink, rx) = collect();
            let channel = pending.start(sink);
            if exited {
                assert!(channel.send(b"\"never read\"\n".to_vec()));
                channel.child_exited();
            } else {
                channel.disconnect();
            }
            let started = Instant::now();
            wait_end(&rx);
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }

    #[test]
    fn finds_an_explicit_runtime() {
        assert_eq!(
            node_runtime("/opt/node/bin/node", "app").unwrap(),
            PathBuf::from("/opt/node/bin/node")
        );
    }
}
