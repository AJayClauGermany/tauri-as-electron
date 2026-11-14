//! Node's `net` and `dgram` (Cargo feature `node-net`), and the transport of
//! `tls` (feature `node-tls`), on tokio.
//!
//! Every socket, server and UDP socket is a handle in [`Net`], by id.
//! Events (data, end, errors, accepted connections, datagrams) go to
//! JavaScript through the Tauri Channel given when the handle was created.
//! A server's channel also carries the events of its connections, tagged
//! with their id, so a connection's data never overtakes its 'connection'.
//!
//! Writes resolve once the bytes are flushed to the kernel, which gives the
//! JavaScript Writable real back-pressure; `pause` / `resume` stop reading,
//! for back-pressure the other way.

// The error payloads are JSON for JavaScript, not errors passed around.
#![allow(clippy::result_large_err)]

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use socket2::{Domain, Protocol, SockRef, Socket as RawSocket, TcpKeepalive, Type};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{watch, Mutex as AsyncMutex},
    task::JoinHandle,
};

use crate::node_common::error_code;

type BoxRead = Box<dyn AsyncRead + Send + Unpin>;
type BoxWrite = Box<dyn AsyncWrite + Send + Unpin>;
type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// A Node-shaped error for a socket call: `{ code, errno, syscall, address, port, message }`.
fn io_error(
    error: &std::io::Error,
    syscall: &str,
    address: Option<&str>,
    port: Option<u16>,
) -> Value {
    let (code, errno) = error_code(error);
    json!({ "code": code, "errno": errno, "syscall": syscall, "address": address, "port": port, "message": error.to_string() })
}

fn invalid(message: impl Into<String>) -> Value {
    json!({ "code": "ERR_INVALID_ARG_VALUE", "message": message.into() })
}

fn family(addr: &SocketAddr) -> &'static str {
    if addr.is_ipv4() {
        "IPv4"
    } else {
        "IPv6"
    }
}

/// The address an IPv4-mapped IPv6 peer is reported with, as Node does on dual-stack servers.
fn shown(addr: &SocketAddr) -> String {
    addr.ip().to_string()
}

fn addresses(local: Option<SocketAddr>, remote: Option<SocketAddr>) -> Value {
    json!({
        "localAddress": local.map(|a| shown(&a)),
        "localPort": local.map(|a| a.port()),
        "localFamily": local.map(|a| family(&a)),
        "remoteAddress": remote.map(|a| shown(&a)),
        "remotePort": remote.map(|a| a.port()),
        "remoteFamily": remote.map(|a| family(&a)),
    })
}

// --- handles ------------------------------------------------------------------------------

struct Socket {
    writer: AsyncMutex<Option<BoxWrite>>,
    pause: watch::Sender<bool>,
    reader: Mutex<Option<JoinHandle<()>>>,
    /// A second handle on the TCP socket, for options set after connecting.
    tcp: Option<std::net::TcpStream>,
}

struct Server {
    accept: Mutex<Option<JoinHandle<()>>>,
    #[cfg(unix)]
    path: Option<String>,
}

struct Udp {
    socket: Arc<UdpSocket>,
    receiver: Mutex<Option<JoinHandle<()>>>,
}

enum Handle {
    Socket(Arc<Socket>),
    Server(Arc<Server>),
    Udp(Arc<Udp>),
}

/// Every open handle, managed as plugin state.
#[derive(Default)]
pub struct Net {
    handles: Mutex<HashMap<u32, Handle>>,
    next_id: AtomicU32,
}

fn emitter(channel: Channel<Value>, socket: Option<u32>) -> Emit {
    Arc::new(move |mut event: Value| {
        if let Some(id) = socket {
            event["socket"] = json!(id);
        }
        let _ = channel.send(event);
    })
}

/// Read until EOF, error or destroy, honouring pause.
async fn pump(mut reader: BoxRead, mut paused: watch::Receiver<bool>, emit: Emit) {
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        while *paused.borrow() {
            if paused.changed().await.is_err() {
                return;
            }
        }
        tokio::select! {
            read = reader.read(&mut buffer) => match read {
                Ok(0) => {
                    emit(json!({ "type": "end" }));
                    return;
                }
                // A TLS peer that closes without close_notify: an end for Node too.
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    emit(json!({ "type": "end" }));
                    return;
                }
                Ok(n) => emit(json!({ "type": "data", "data": BASE64.encode(&buffer[..n]) })),
                Err(e) => {
                    emit(json!({ "type": "error", "error": io_error(&e, "read", None, None) }));
                    return;
                }
            },
            changed = paused.changed() => if changed.is_err() { return },
        }
    }
}

impl Net {
    fn id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn insert(&self, id: u32, handle: Handle) {
        self.handles.lock().unwrap().insert(id, handle);
    }

    fn socket(&self, id: u32) -> Result<Arc<Socket>, Value> {
        match self.handles.lock().unwrap().get(&id) {
            Some(Handle::Socket(socket)) => Ok(socket.clone()),
            _ => Err(json!({ "code": "ERR_SOCKET_CLOSED", "message": "Socket is closed" })),
        }
    }

    fn udp(&self, id: u32) -> Result<Arc<Udp>, Value> {
        match self.handles.lock().unwrap().get(&id) {
            Some(Handle::Udp(udp)) => Ok(udp.clone()),
            _ => Err(json!({ "code": "ERR_SOCKET_DGRAM_NOT_RUNNING", "message": "Not running" })),
        }
    }

    /// Register a connected stream and start reading it.
    fn adopt(
        &self,
        id: u32,
        reader: BoxRead,
        writer: BoxWrite,
        tcp: Option<std::net::TcpStream>,
        emit: Emit,
    ) {
        let (pause, paused) = watch::channel(false);
        let socket = Arc::new(Socket {
            writer: AsyncMutex::new(Some(writer)),
            pause,
            reader: Mutex::new(None),
            tcp,
        });
        self.insert(id, Handle::Socket(socket.clone()));
        *socket.reader.lock().unwrap() = Some(tokio_task(tauri::async_runtime::spawn(pump(
            reader, paused, emit,
        ))));
    }

    // --- net.Socket -------------------------------------------------------------------------

    /// `net.connect()` / `tls.connect()`: returns `{ id, ...addresses }` once connected.
    pub async fn connect(
        &self,
        options: ConnectOptions,
        channel: Channel<Value>,
    ) -> Result<Value, Value> {
        let id = self.id();
        let emit = emitter(channel, None);
        if let Some(path) = &options.path {
            let (reader, writer) = connect_path(path).await?;
            self.adopt(id, reader, writer, None, emit);
            return Ok(json!({ "id": id, "path": path }));
        }
        let host = options.host.clone().unwrap_or_else(|| "localhost".into());
        let port = options
            .port
            .ok_or_else(|| invalid("The \"port\" option is required"))?;
        let mut targets: Vec<SocketAddr> = match host.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => tokio::net::lookup_host((host.as_str(), port))
                .await
                .map_err(
                    |_| json!({ "code": "ENOTFOUND", "syscall": "getaddrinfo", "hostname": host }),
                )?
                .collect(),
        };
        match options.family {
            Some(4) => targets.retain(|a| a.is_ipv4()),
            Some(6) => targets.retain(|a| a.is_ipv6()),
            _ => {}
        }
        if targets.is_empty() {
            return Err(json!({ "code": "ENOTFOUND", "syscall": "getaddrinfo", "hostname": host }));
        }
        let mut last = None;
        let mut stream = None;
        for target in &targets {
            match connect_tcp(*target, &options).await {
                Ok(s) => {
                    stream = Some(s);
                    break;
                }
                Err(e) => {
                    last = Some(io_error(
                        &e,
                        "connect",
                        Some(&target.ip().to_string()),
                        Some(target.port()),
                    ))
                }
            }
        }
        let stream = stream.ok_or_else(|| last.unwrap_or_else(|| invalid("no address")))?;
        let (local, remote) = (stream.local_addr().ok(), stream.peer_addr().ok());
        let std_stream = stream
            .into_std()
            .map_err(|e| io_error(&e, "connect", None, None))?;
        let control = std_stream.try_clone().ok();
        let stream =
            TcpStream::from_std(std_stream).map_err(|e| io_error(&e, "connect", None, None))?;
        let mut info = addresses(local, remote);
        if let Some(tls) = &options.tls {
            #[cfg(feature = "node-tls")]
            {
                let tls_options: crate::node_tls::ClientOptions =
                    serde_json::from_value(tls.clone()).map_err(|e| invalid(e.to_string()))?;
                let (stream, session) =
                    crate::node_tls::connect(stream, &host, &tls_options).await?;
                merge(&mut info, session);
                let (reader, writer) = tokio::io::split(stream);
                self.adopt(id, Box::new(reader), Box::new(writer), control, emit);
                info["id"] = json!(id);
                return Ok(info);
            }
            #[cfg(not(feature = "node-tls"))]
            {
                let _ = tls;
                return Err(json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-tls" }));
            }
        }
        let (reader, writer) = stream.into_split();
        self.adopt(id, Box::new(reader), Box::new(writer), control, emit);
        info["id"] = json!(id);
        Ok(info)
    }

    /// Write and flush; resolves when the kernel has the bytes.
    pub async fn write(&self, id: u32, data: Vec<u8>) -> Result<(), Value> {
        let socket = self.socket(id)?;
        let mut writer = socket.writer.lock().await;
        let writer = writer.as_mut().ok_or_else(|| json!({ "code": "EPIPE", "syscall": "write", "message": "This socket has been ended by the other party" }))?;
        writer
            .write_all(&data)
            .await
            .map_err(|e| io_error(&e, "write", None, None))?;
        writer
            .flush()
            .await
            .map_err(|e| io_error(&e, "write", None, None))
    }

    /// Half-close: no more writes (FIN, or TLS close_notify then FIN).
    pub async fn end(&self, id: u32) -> Result<(), Value> {
        let socket = self.socket(id)?;
        let mut writer = socket.writer.lock().await;
        if let Some(mut w) = writer.take() {
            let _ = w.shutdown().await;
        }
        Ok(())
    }

    /// Close everything about a handle (socket, server or UDP socket).
    pub fn destroy(&self, id: u32) {
        let handle = self.handles.lock().unwrap().remove(&id);
        match handle {
            Some(Handle::Socket(socket)) => {
                if let Some(task) = socket.reader.lock().unwrap().take() {
                    task.abort();
                }
                if let Some(tcp) = &socket.tcp {
                    let _ = tcp.shutdown(std::net::Shutdown::Both);
                }
                if let Ok(mut writer) = socket.writer.try_lock() {
                    writer.take();
                }
            }
            Some(Handle::Server(server)) => {
                if let Some(task) = server.accept.lock().unwrap().take() {
                    task.abort();
                }
                #[cfg(unix)]
                if let Some(path) = &server.path {
                    let _ = std::fs::remove_file(path);
                }
            }
            Some(Handle::Udp(udp)) => {
                if let Some(task) = udp.receiver.lock().unwrap().take() {
                    task.abort();
                }
            }
            None => {}
        }
    }

    pub fn set_paused(&self, id: u32, paused: bool) -> Result<(), Value> {
        let socket = self.socket(id)?;
        let _ = socket.pause.send(paused);
        Ok(())
    }

    /// `setNoDelay` / `setKeepAlive` (TCP only; ignored for pipes).
    pub fn set_option(&self, id: u32, name: &str, value: &Value) -> Result<(), Value> {
        let socket = self.socket(id)?;
        let Some(tcp) = &socket.tcp else {
            return Ok(());
        };
        let result = match name {
            "noDelay" => tcp.set_nodelay(value.as_bool().unwrap_or(true)),
            "keepAlive" => {
                let enable = value
                    .get("enable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let delay = value
                    .get("initialDelay")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let sock = SockRef::from(tcp);
                if enable {
                    let mut keepalive = TcpKeepalive::new();
                    if delay > 0 {
                        keepalive = keepalive.with_time(Duration::from_millis(delay));
                    }
                    sock.set_tcp_keepalive(&keepalive)
                } else {
                    sock.set_keepalive(false)
                }
            }
            other => return Err(invalid(format!("unknown socket option {other}"))),
        };
        result.map_err(|e| io_error(&e, "setsockopt", None, None))
    }

    // --- net.Server ---------------------------------------------------------------------------

    /// `server.listen()`: returns `{ id, address, port, family }` or `{ id, path }`.
    pub async fn listen(
        self: &Arc<Self>,
        options: ListenOptions,
        channel: Channel<Value>,
    ) -> Result<Value, Value> {
        let id = self.id();
        #[cfg(feature = "node-tls")]
        let acceptor = match &options.tls {
            Some(tls) => {
                let tls_options: crate::node_tls::ServerOptions =
                    serde_json::from_value(tls.clone()).map_err(|e| invalid(e.to_string()))?;
                Some(crate::node_tls::acceptor(&tls_options)?)
            }
            None => None,
        };
        #[cfg(not(feature = "node-tls"))]
        if options.tls.is_some() {
            return Err(json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-tls" }));
        }

        if let Some(path) = options.path.clone() {
            return self.listen_path(id, path, channel).await;
        }
        let listener = bind_listener(&options)?;
        let local = listener.local_addr().ok();
        let net = self.clone();
        let accept = tauri::async_runtime::spawn(async move {
            loop {
                let (stream, peer) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(e) => {
                        let _ = channel.send(
                            json!({ "type": "error", "error": io_error(&e, "accept", None, None) }),
                        );
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let socket_id = net.id();
                let local = stream.local_addr().ok();
                let Ok(std_stream) = stream.into_std() else {
                    continue;
                };
                let control = std_stream.try_clone().ok();
                let Ok(stream) = TcpStream::from_std(std_stream) else {
                    continue;
                };
                let mut info = addresses(local, Some(peer));
                info["type"] = json!("connection");
                info["socket"] = json!(socket_id);
                #[cfg(feature = "node-tls")]
                if let Some(acceptor) = acceptor.clone() {
                    let (net, channel) = (net.clone(), channel.clone());
                    tauri::async_runtime::spawn(async move {
                        match acceptor.accept(stream).await {
                            Ok(tls) => {
                                merge(&mut info, crate::node_tls::server_info(&tls));
                                let _ = channel.send(info);
                                let (reader, writer) = tokio::io::split(tls);
                                net.adopt(
                                    socket_id,
                                    Box::new(reader),
                                    Box::new(writer),
                                    control,
                                    emitter(channel, Some(socket_id)),
                                );
                            }
                            Err(e) => {
                                let _ = channel.send(json!({ "type": "tlsClientError", "error": { "code": "ECONNRESET", "message": e.to_string() }, "remoteAddress": peer.ip().to_string(), "remotePort": peer.port() }));
                            }
                        }
                    });
                    continue;
                }
                let _ = channel.send(info);
                let (reader, writer) = stream.into_split();
                net.adopt(
                    socket_id,
                    Box::new(reader),
                    Box::new(writer),
                    control,
                    emitter(channel.clone(), Some(socket_id)),
                );
            }
        });
        let accept = Some(tokio_task(accept));
        self.insert(
            id,
            Handle::Server(Arc::new(Server {
                accept: Mutex::new(accept),
                #[cfg(unix)]
                path: None,
            })),
        );
        let local = local.ok_or_else(|| invalid("no local address"))?;
        Ok(
            json!({ "id": id, "address": shown(&local), "port": local.port(), "family": family(&local) }),
        )
    }

    #[cfg(unix)]
    async fn listen_path(
        self: &Arc<Self>,
        id: u32,
        path: String,
        channel: Channel<Value>,
    ) -> Result<Value, Value> {
        let listener = tokio::net::UnixListener::bind(&path)
            .map_err(|e| io_error(&e, "listen", Some(&path), None))?;
        let net = self.clone();
        let accept = tauri::async_runtime::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let socket_id = net.id();
                        let _ = channel.send(json!({ "type": "connection", "socket": socket_id }));
                        let (reader, writer) = stream.into_split();
                        net.adopt(
                            socket_id,
                            Box::new(reader),
                            Box::new(writer),
                            None,
                            emitter(channel.clone(), Some(socket_id)),
                        );
                    }
                    Err(e) => {
                        let _ = channel.send(
                            json!({ "type": "error", "error": io_error(&e, "accept", None, None) }),
                        );
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        });
        let accept = Some(tokio_task(accept));
        self.insert(
            id,
            Handle::Server(Arc::new(Server {
                accept: Mutex::new(accept),
                path: Some(path.clone()),
            })),
        );
        Ok(json!({ "id": id, "path": path }))
    }

    /// Windows named pipes (`\\.\pipe\name`): a new pipe instance per client.
    #[cfg(windows)]
    async fn listen_path(
        self: &Arc<Self>,
        id: u32,
        path: String,
        channel: Channel<Value>,
    ) -> Result<Value, Value> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)
            .map_err(|e| io_error(&e, "listen", Some(&path), None))?;
        let net = self.clone();
        let pipe = path.clone();
        let accept = tauri::async_runtime::spawn(async move {
            loop {
                if let Err(e) = server.connect().await {
                    let _ = channel.send(
                        json!({ "type": "error", "error": io_error(&e, "accept", None, None) }),
                    );
                    return;
                }
                let connected = server;
                server = match ServerOptions::new().create(&pipe) {
                    Ok(next) => next,
                    Err(e) => {
                        let _ = channel.send(
                            json!({ "type": "error", "error": io_error(&e, "listen", None, None) }),
                        );
                        return;
                    }
                };
                let socket_id = net.id();
                let _ = channel.send(json!({ "type": "connection", "socket": socket_id }));
                let (reader, writer) = tokio::io::split(connected);
                net.adopt(
                    socket_id,
                    Box::new(reader),
                    Box::new(writer),
                    None,
                    emitter(channel.clone(), Some(socket_id)),
                );
            }
        });
        let accept = Some(tokio_task(accept));
        self.insert(
            id,
            Handle::Server(Arc::new(Server {
                accept: Mutex::new(accept),
            })),
        );
        Ok(json!({ "id": id, "path": path }))
    }

    #[cfg(not(any(unix, windows)))]
    async fn listen_path(
        self: &Arc<Self>,
        _id: u32,
        path: String,
        _channel: Channel<Value>,
    ) -> Result<Value, Value> {
        Err(io_error(
            &std::io::Error::from(std::io::ErrorKind::Unsupported),
            "listen",
            Some(&path),
            None,
        ))
    }

    // --- dgram ------------------------------------------------------------------------------------

    /// `socket.bind()`: returns `{ id, address, port, family }`.
    pub async fn udp_bind(
        &self,
        options: UdpOptions,
        channel: Channel<Value>,
    ) -> Result<Value, Value> {
        let v6 = options.r#type == "udp6";
        let address: IpAddr = match &options.address {
            Some(host) if !host.is_empty() => match host.parse() {
                Ok(ip) => ip,
                Err(_) => tokio::net::lookup_host((host.as_str(), 0))
                    .await
                    .ok()
                    .and_then(|mut found| found.find(|a| a.is_ipv6() == v6))
                    .map(|a| a.ip())
                    .ok_or_else(|| json!({ "code": "ENOTFOUND", "syscall": "getaddrinfo", "hostname": host }))?,
            },
            _ => {
                if v6 {
                    IpAddr::V6(Ipv6Addr::UNSPECIFIED)
                } else {
                    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
                }
            }
        };
        let target = SocketAddr::new(address, options.port.unwrap_or(0));
        let raw = RawSocket::new(
            if v6 { Domain::IPV6 } else { Domain::IPV4 },
            Type::DGRAM,
            Some(Protocol::UDP),
        )
        .map_err(|e| io_error(&e, "bind", None, None))?;
        if options.reuse_addr {
            let _ = raw.set_reuse_address(true);
        }
        if v6 {
            let _ = raw.set_only_v6(options.ipv6_only);
        }
        if let Some(size) = options.recv_buffer_size {
            let _ = raw.set_recv_buffer_size(size);
        }
        if let Some(size) = options.send_buffer_size {
            let _ = raw.set_send_buffer_size(size);
        }
        raw.bind(&target.into()).map_err(|e| {
            io_error(
                &e,
                "bind",
                Some(&target.ip().to_string()),
                Some(target.port()),
            )
        })?;
        raw.set_nonblocking(true)
            .map_err(|e| io_error(&e, "bind", None, None))?;
        let socket = Arc::new(
            UdpSocket::from_std(raw.into()).map_err(|e| io_error(&e, "bind", None, None))?,
        );
        let local = socket
            .local_addr()
            .map_err(|e| io_error(&e, "bind", None, None))?;
        let id = self.id();
        let receiving = socket.clone();
        let receiver = tauri::async_runtime::spawn(async move {
            let mut buffer = vec![0u8; 65536];
            loop {
                match receiving.recv_from(&mut buffer).await {
                    Ok((n, from)) => {
                        let _ = channel.send(json!({
                            "type": "message", "data": BASE64.encode(&buffer[..n]),
                            "address": shown(&from), "port": from.port(), "family": family(&from), "size": n,
                        }));
                    }
                    Err(e) => {
                        let _ = channel.send(json!({ "type": "error", "error": io_error(&e, "recvmsg", None, None) }));
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        });
        let receiver = Some(tokio_task(receiver));
        self.insert(
            id,
            Handle::Udp(Arc::new(Udp {
                socket,
                receiver: Mutex::new(receiver),
            })),
        );
        Ok(
            json!({ "id": id, "address": shown(&local), "port": local.port(), "family": family(&local) }),
        )
    }

    /// `socket.send()`: resolves with the bytes sent.
    pub async fn udp_send(
        &self,
        id: u32,
        data: Vec<u8>,
        port: u16,
        address: String,
    ) -> Result<usize, Value> {
        let udp = self.udp(id)?;
        let v6 = udp
            .socket
            .local_addr()
            .map(|a| a.is_ipv6())
            .unwrap_or(false);
        let target = match address.parse::<IpAddr>() {
            Ok(ip) => SocketAddr::new(ip, port),
            Err(_) => tokio::net::lookup_host((address.as_str(), port))
                .await
                .ok()
                .and_then(|mut found| found.find(|a| a.is_ipv6() == v6))
                .ok_or_else(|| json!({ "code": "ENOTFOUND", "syscall": "getaddrinfo", "hostname": address }))?,
        };
        udp.socket
            .send_to(&data, target)
            .await
            .map_err(|e| io_error(&e, "send", Some(&target.ip().to_string()), Some(port)))
    }

    /// `setBroadcast`, `setTTL`, `setMulticastTTL`, `setMulticastLoopback`,
    /// `setMulticastInterface`, `setRecvBufferSize`, `setSendBufferSize`; the
    /// buffer sizes are returned by `getRecvBufferSize` / `getSendBufferSize`.
    pub fn udp_option(&self, id: u32, name: &str, value: &Value) -> Result<Value, Value> {
        let udp = self.udp(id)?;
        let sock = SockRef::from(&*udp.socket);
        let v6 = udp
            .socket
            .local_addr()
            .map(|a| a.is_ipv6())
            .unwrap_or(false);
        let number = value.as_u64().unwrap_or(0) as u32;
        let flag = value.as_bool().unwrap_or(false);
        let result: std::io::Result<Value> = match name {
            "broadcast" => sock.set_broadcast(flag).map(|_| Value::Null),
            "ttl" => if v6 {
                sock.set_unicast_hops_v6(number)
            } else {
                sock.set_ttl_v4(number)
            }
            .map(|_| Value::Null),
            "multicastTTL" => if v6 {
                sock.set_multicast_hops_v6(number)
            } else {
                sock.set_multicast_ttl_v4(number)
            }
            .map(|_| Value::Null),
            "multicastLoopback" => if v6 {
                sock.set_multicast_loop_v6(flag)
            } else {
                sock.set_multicast_loop_v4(flag)
            }
            .map(|_| Value::Null),
            "multicastInterface" => match value.as_str().and_then(|s| s.parse::<Ipv4Addr>().ok()) {
                Some(interface) if !v6 => sock.set_multicast_if_v4(&interface).map(|_| Value::Null),
                _ => Ok(Value::Null),
            },
            "recvBufferSize" => sock
                .set_recv_buffer_size(number as usize)
                .map(|_| Value::Null),
            "sendBufferSize" => sock
                .set_send_buffer_size(number as usize)
                .map(|_| Value::Null),
            "getRecvBufferSize" => sock.recv_buffer_size().map(|n| json!(n)),
            "getSendBufferSize" => sock.send_buffer_size().map(|n| json!(n)),
            other => return Err(invalid(format!("unknown dgram option {other}"))),
        };
        result.map_err(|e| io_error(&e, "setsockopt", None, None))
    }

    /// `addMembership` / `dropMembership`.
    pub fn udp_membership(
        &self,
        id: u32,
        add: bool,
        group: &str,
        interface: Option<&str>,
    ) -> Result<(), Value> {
        let udp = self.udp(id)?;
        let group: IpAddr = group
            .parse()
            .map_err(|_| invalid(format!("Invalid multicast address {group}")))?;
        let result = match group {
            IpAddr::V4(group) => {
                let interface = interface
                    .and_then(|i| i.parse().ok())
                    .unwrap_or(Ipv4Addr::UNSPECIFIED);
                if add {
                    udp.socket.join_multicast_v4(group, interface)
                } else {
                    udp.socket.leave_multicast_v4(group, interface)
                }
            }
            IpAddr::V6(group) => {
                if add {
                    udp.socket.join_multicast_v6(&group, 0)
                } else {
                    udp.socket.leave_multicast_v6(&group, 0)
                }
            }
        };
        result.map_err(|e| {
            io_error(
                &e,
                if add {
                    "addMembership"
                } else {
                    "dropMembership"
                },
                None,
                None,
            )
        })
    }
}

/// The tokio task behind a tauri task handle (abortable).
fn tokio_task(handle: tauri::async_runtime::JoinHandle<()>) -> JoinHandle<()> {
    let tauri::async_runtime::JoinHandle::Tokio(task) = handle;
    task
}

#[cfg(feature = "node-tls")]
fn merge(target: &mut Value, extra: Value) {
    if let (Some(target), Value::Object(extra)) = (target.as_object_mut(), extra) {
        target.extend(extra);
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectOptions {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub path: Option<String>,
    pub family: Option<u8>,
    pub local_address: Option<String>,
    pub local_port: Option<u16>,
    pub no_delay: bool,
    pub keep_alive: bool,
    pub keep_alive_initial_delay: Option<u64>,
    /// `tls.connect` options (feature node-tls).
    pub tls: Option<Value>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListenOptions {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub path: Option<String>,
    pub backlog: Option<i32>,
    pub ipv6_only: bool,
    /// `tls.createServer` options (feature node-tls).
    pub tls: Option<Value>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UdpOptions {
    pub r#type: String,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub reuse_addr: bool,
    pub ipv6_only: bool,
    pub recv_buffer_size: Option<usize>,
    pub send_buffer_size: Option<usize>,
}

async fn connect_tcp(target: SocketAddr, options: &ConnectOptions) -> std::io::Result<TcpStream> {
    let socket = if target.is_ipv4() {
        tokio::net::TcpSocket::new_v4()?
    } else {
        tokio::net::TcpSocket::new_v6()?
    };
    if options.local_address.is_some() || options.local_port.is_some() {
        let ip = options
            .local_address
            .as_deref()
            .and_then(|a| a.parse().ok())
            .unwrap_or(if target.is_ipv4() {
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            } else {
                IpAddr::V6(Ipv6Addr::UNSPECIFIED)
            });
        socket.bind(SocketAddr::new(ip, options.local_port.unwrap_or(0)))?;
    }
    let stream = socket.connect(target).await?;
    if options.no_delay {
        stream.set_nodelay(true)?;
    }
    if options.keep_alive {
        let mut keepalive = TcpKeepalive::new();
        if let Some(delay) = options.keep_alive_initial_delay.filter(|d| *d > 0) {
            keepalive = keepalive.with_time(Duration::from_millis(delay));
        }
        SockRef::from(&stream).set_tcp_keepalive(&keepalive)?;
    }
    Ok(stream)
}

#[cfg(unix)]
async fn connect_path(path: &str) -> Result<(BoxRead, BoxWrite), Value> {
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .map_err(|e| io_error(&e, "connect", Some(path), None))?;
    let (reader, writer) = stream.into_split();
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(windows)]
async fn connect_path(path: &str) -> Result<(BoxRead, BoxWrite), Value> {
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(path)
        .map_err(|e| io_error(&e, "connect", Some(path), None))?;
    let (reader, writer) = tokio::io::split(client);
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(not(any(unix, windows)))]
async fn connect_path(path: &str) -> Result<(BoxRead, BoxWrite), Value> {
    Err(io_error(
        &std::io::Error::from(std::io::ErrorKind::Unsupported),
        "connect",
        Some(path),
        None,
    ))
}

/// A listening TCP socket like Node's: SO_REUSEADDR on Unix, dual-stack `::`
/// when no host is given (falling back to `0.0.0.0`), the given backlog.
fn bind_listener(options: &ListenOptions) -> Result<TcpListener, Value> {
    let port = options.port.unwrap_or(0);
    let candidates: Vec<SocketAddr> = match options.host.as_deref() {
        None | Some("") => vec![
            SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
        ],
        Some(host) => match host.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => {
                use std::net::ToSocketAddrs;
                (host, port)
                    .to_socket_addrs()
                    .map_err(|_| json!({ "code": "ENOTFOUND", "syscall": "getaddrinfo", "hostname": host }))?
                    .collect()
            }
        },
    };
    let mut last = None;
    for address in candidates {
        let attempt = (|| -> std::io::Result<TcpListener> {
            let socket = RawSocket::new(
                Domain::for_address(address),
                Type::STREAM,
                Some(Protocol::TCP),
            )?;
            #[cfg(unix)]
            socket.set_reuse_address(true)?;
            if address.is_ipv6() {
                socket.set_only_v6(options.ipv6_only)?;
            }
            socket.bind(&address.into())?;
            socket.listen(options.backlog.unwrap_or(511))?;
            socket.set_nonblocking(true)?;
            TcpListener::from_std(socket.into())
        })();
        match attempt {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                last = Some(io_error(
                    &e,
                    "listen",
                    Some(&address.ip().to_string()),
                    Some(port),
                ))
            }
        }
    }
    Err(last.unwrap_or_else(|| invalid("no address to listen on")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn listens_on_loopback_and_reports_errors() {
        let listener = bind_listener(&ListenOptions {
            host: Some("127.0.0.1".into()),
            ..Default::default()
        })
        .unwrap();
        let port = listener.local_addr().unwrap().port();
        let taken = bind_listener(&ListenOptions {
            host: Some("127.0.0.1".into()),
            port: Some(port),
            ..Default::default()
        });
        let error = taken.err().unwrap();
        assert_eq!(
            (error["code"].as_str(), error["syscall"].as_str()),
            (Some("EADDRINUSE"), Some("listen"))
        );
        let stream = connect_tcp(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            &ConnectOptions::default(),
        )
        .await
        .unwrap();
        let (mut accepted, _) = listener.accept().await.unwrap();
        let (_, mut writer) = stream.into_split();
        writer.write_all(b"ping").await.unwrap();
        let mut buffer = [0u8; 4];
        accepted.read_exact(&mut buffer).await.unwrap();
        assert_eq!(&buffer, b"ping");
        drop(listener);
        let refused = connect_tcp(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            &ConnectOptions::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error_code(&refused).0, "ECONNREFUSED");
    }
}
