import { beforeEach, describe, expect, it, vi } from 'vitest'

// net, dgram, dns, tls and the HTTP server talk to Rust's socket table
// (crates/tauri-plugin-electron/src/node_net.rs). Here an in-memory network
// plays that part: same commands, same events, loopback only.
const state = vi.hoisted(() => {
  const s = { features: ['node-net', 'node-tls'], calls: [], nextId: 1, servers: new Map(), sockets: new Map(), udp: new Map() }
  s.reset = () => {
    s.features = ['node-net', 'node-tls']
    s.calls = []
    s.servers.clear()
    s.sockets.clear()
    s.udp.clear()
    s.dnsLookup = null
    s.pauseInFlight = 0
    s.maxPauseInFlight = 0
    s.dnsResolve = null
  }
  return s
})

vi.mock('../src/internal/runtime.js', async (importOriginal) => ({ ...(await importOriginal()), inTauri: true }))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal()),
  Channel: class {
    constructor() {
      this.onmessage = null
    }
  },
}))
vi.mock('../src/internal/native.js', async (importOriginal) => {
  const actual = await importOriginal()
  const later = (fn) => setTimeout(fn, 0)
  /** Send an event to a socket: client sockets have a channel, accepted ones go through their server's. */
  const deliver = (id, event) => {
    const socket = state.sockets.get(id)
    if (!socket) return
    // A paused socket keeps what arrives until it is resumed, as Rust stops reading.
    if (socket.paused) return socket.queue.push(event)
    later(() => {
      if (socket.channel) socket.channel.onmessage(event)
      // Accepted sockets keep their server's channel after server.close(), as in Rust.
      else socket.serverChannel.onmessage({ ...event, socket: id })
    })
  }
  return {
    ...actual,
    hasFeature: (name) => state.features.includes(name),
    async native(command, args) {
      state.calls.push({ command, args })
      switch (command) {
        case 'net_listen': {
          const port = args.options.port || 40000 + state.nextId
          if ([...state.servers.values()].some((s) => s.port === port)) {
            throw { code: 'EADDRINUSE', errno: -98, syscall: 'listen', address: '127.0.0.1', port }
          }
          const id = state.nextId++
          state.servers.set(id, { id, port, channel: args.onEvent, tls: args.options.tls })
          return { id, address: '127.0.0.1', family: 'IPv4', port }
        }
        case 'net_connect': {
          const { host, port } = args.options
          const server = [...state.servers.values()].find((s) => s.port === port)
          if (!server) throw { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '127.0.0.1', port }
          const client = state.nextId++
          const accepted = state.nextId++
          state.sockets.set(client, { channel: args.onEvent, peer: accepted, queue: [] })
          state.sockets.set(accepted, { serverChannel: server.channel, peer: client, queue: [] })
          const clientPort = 50000 + client
          later(() =>
            server.channel.onmessage({
              type: 'connection', socket: accepted, localAddress: '127.0.0.1', localPort: port, localFamily: 'IPv4',
              remoteAddress: '127.0.0.1', remotePort: clientPort, remoteFamily: 'IPv4',
              ...(args.options.tls ? { authorized: false, protocol: 'TLSv1.3', servername: args.options.tls.servername } : {}),
            }),
          )
          const tls = args.options.tls ? { authorized: true, authorizationError: null, protocol: 'TLSv1.3', alpnProtocol: args.options.tls.ALPNProtocols[0] ?? null, servername: args.options.tls.servername ?? host, peerCertificate: Buffer.from('fake DER').toString('base64') } : {}
          return { id: client, remoteAddress: '127.0.0.1', remotePort: port, remoteFamily: 'IPv4', localAddress: '127.0.0.1', localPort: clientPort, localFamily: 'IPv4', ...tls }
        }
        case 'net_write':
          deliver(state.sockets.get(args.id)?.peer, { type: 'data', data: args.data })
          return null
        case 'net_end':
          deliver(state.sockets.get(args.id)?.peer, { type: 'end' })
          return null
        case 'net_destroy': {
          if (state.servers.delete(args.id) || state.udp.delete(args.id)) return null
          const socket = state.sockets.get(args.id)
          if (socket) {
            if (!socket.ended) deliver(socket.peer, { type: 'end' })
            state.sockets.delete(args.id)
          }
          return null
        }
        case 'udp_bind': {
          const id = state.nextId++
          const port = args.options.port || 41000 + id
          state.udp.set(id, { port, channel: args.onEvent })
          return { id, address: args.options.address ?? '0.0.0.0', family: 'IPv4', port }
        }
        case 'udp_send': {
          const from = state.udp.get(args.id)
          const to = [...state.udp.values()].find((u) => u.port === args.port)
          const size = Buffer.from(args.data, 'base64').length
          if (to) later(() => to.channel.onmessage({ type: 'message', data: args.data, address: '127.0.0.1', port: from.port, family: 'IPv4', size }))
          return size
        }
        case 'net_pause': {
          // Pausing takes longer than resuming here, so a resume sent right after a
          // pause overtakes it, as separate IPC calls can in Tauri.
          state.pauseInFlight = (state.pauseInFlight ?? 0) + 1
          state.maxPauseInFlight = Math.max(state.maxPauseInFlight ?? 0, state.pauseInFlight)
          await new Promise((resolve) => setTimeout(resolve, args.paused ? 8 : 1))
          state.pauseInFlight--
          const socket = state.sockets.get(args.id)
          if (socket) {
            socket.paused = args.paused
            if (!args.paused) for (const event of socket.queue.splice(0)) deliver(args.id, event)
          }
          return null
        }
        case 'dns_lookup':
          return state.dnsLookup(args)
        case 'dns_resolve':
          return state.dnsResolve(args)
        default:
          return true
      }
    },
  }
})

const net = await import('../src/node/net.js')
const tls = await import('../src/node/tls.js')
const dgram = (await import('../src/node/dgram.js')).default
const dns = (await import('../src/node/dns.js')).default
const http = (await import('../src/node/http.js')).default
const https = (await import('../src/node/https.js')).default
const { Buffer } = await import('../src/node/buffer.js')

const once = (emitter, event) => new Promise((resolve, reject) => {
  emitter.once(event, (...args) => resolve(args))
  if (event !== 'error') emitter.once('error', reject)
})

/** Raw HTTP over a net socket: send `text`, collect everything until the server closes or `until` matches. */
function exchange(port, text, until) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port)
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (until?.test(received)) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('end', () => resolve(received))
    socket.on('error', reject)
    socket.write(text)
  })
}

async function listening(server) {
  server.listen(0)
  await once(server, 'listening')
  return server.address().port
}

beforeEach(() => state.reset())

describe('net', () => {
  it('connects, echoes and closes like Node', async () => {
    const server = net.createServer((socket) => socket.pipe(socket))
    const port = await listening(server)
    expect(server.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port })

    const socket = net.connect({ port, host: '127.0.0.1' })
    await once(socket, 'connect')
    expect(socket.remotePort).toBe(port)
    expect(socket.readyState).toBe('open')
    socket.setEncoding('utf8')
    socket.end('hello')
    let text = ''
    for await (const chunk of socket) text += chunk
    expect(text).toBe('hello')
    expect(socket.bytesWritten).toBe(5)

    const closed = once(server, 'close')
    server.close()
    await closed
    expect(server.listening).toBe(false)
  })

  it('closes a server whose sockets nobody reads', async () => {
    const server = net.createServer((socket) => socket.end('bye'))
    const port = await listening(server)
    let text = ''
    for await (const chunk of net.connect(port)) text += chunk
    expect(text).toBe('bye')
    await new Promise((resolve) => server.close(resolve))
  })

  it('pauses reading in Rust one call at a time, in the latest state', async () => {
    const server = net.createServer(async (socket) => {
      // Spread out, so chunks arrive while pause / resume calls are in flight.
      for (let i = 0; i < 20; i++) {
        socket.write(Buffer.alloc(4096, i))
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      socket.end()
    })
    const port = await listening(server)
    const socket = net.connect({ port, readableHighWaterMark: 1024 })
    let received = 0
    socket.on('data', (chunk) => {
      received += chunk.length
      socket.pause()
      setTimeout(() => socket.resume(), 6) // slower than the writer
    })
    await once(socket, 'end')
    expect(received).toBe(20 * 4096)
    const pauses = state.calls.filter((c) => c.command === 'net_pause' && c.args.id === socket._id)
    expect(pauses.length).toBeGreaterThan(0)
    expect(state.maxPauseInFlight).toBe(1)
    // Rust ends in the state JavaScript wanted last, and no call repeats the one before.
    expect(pauses.at(-1).args.paused).toBe(socket._pausedInRust)
    expect(pauses.every((c, i) => i === 0 || c.args.paused !== pauses[i - 1].args.paused)).toBe(true)
    server.close()
  })

  it('reports connect and listen errors as Node does', async () => {
    const socket = net.connect(9, '127.0.0.1')
    const [error] = await once(socket, 'error')
    expect(error.message).toBe('connect ECONNREFUSED 127.0.0.1:9')
    expect(error).toMatchObject({ code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '127.0.0.1', port: 9 })

    const first = net.createServer()
    const port = await listening(first)
    const second = net.createServer().listen(port)
    const [inUse] = await once(second, 'error')
    expect(inUse.message).toBe(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`)
    expect(() => net.connect({ port: 70000 })).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }))
    first.close()
  })

  it('closes a server whose listen() has not finished yet', async () => {
    const server = net.createServer()
    server.listen(0)
    const closed = new Promise((resolve) => server.close(resolve))
    await closed
    expect(server.listening).toBe(false)
    // The listener Rust opened was destroyed again.
    const id = state.calls.find((c) => c.command === 'net_listen') && [...state.calls].reverse().find((c) => c.command === 'net_destroy')?.args.id
    expect(id).toBeTypeOf('number')
    expect(state.servers.has(id)).toBe(false)
    expect(() => net.createServer().listen(0).listen(0)).toThrow(expect.objectContaining({ code: 'ERR_SERVER_ALREADY_LISTEN' }))
  })

  it('explains itself when the feature is off', () => {
    state.features = []
    expect(() => net.connect(80)).toThrow(/node-net/)
    expect(net.isIP('::1')).toBe(6)
    expect(net.isIPv4('10.0.0.1')).toBe(true)
  })
})

describe('tls', () => {
  it('connects with SNI and ALPN and reports the session', async () => {
    const server = tls.createServer({ key: 'KEY', cert: 'CERT', ALPNProtocols: ['h2', 'http/1.1'] }, (socket) => socket.end('secure'))
    const port = await listening(server)
    expect(state.calls.find((c) => c.command === 'net_listen').args.options.tls).toMatchObject({ key: 'KEY', cert: 'CERT', ALPNProtocols: ['h2', 'http/1.1'] })

    const socket = tls.connect({ port, host: 'example.test', ca: 'CA', ALPNProtocols: ['http/1.1'] })
    await once(socket, 'secureConnect')
    const sent = state.calls.find((c) => c.command === 'net_connect').args.options.tls
    expect(sent).toMatchObject({ servername: 'example.test', rejectUnauthorized: true, ca: ['CA'], ALPNProtocols: ['http/1.1'] })
    expect(socket.encrypted).toBe(true)
    expect(socket.authorized).toBe(true)
    expect(socket.alpnProtocol).toBe('http/1.1')
    expect(socket.getProtocol()).toBe('TLSv1.3')
    let text = ''
    for await (const chunk of socket) text += chunk
    expect(text).toBe('secure')
    server.close()
  })

  it('calls checkServerIdentity and never passes a certificate it cannot check', async () => {
    const server = tls.createServer({ key: 'K', cert: 'C' }, (socket) => socket.end())
    const connections = []
    server.on('connection', (socket) => connections.push(socket))
    const port = await listening(server)
    const pinned = tls.connect({ port, host: 'localhost', checkServerIdentity: (host, cert) => new Error(`pin mismatch for ${host} ${typeof cert.fingerprint256}`) })
    const [error] = await once(pinned, 'error')
    expect(error.message).toBe('pin mismatch for localhost string')
    let seen
    const accepted = tls.connect({ port, host: 'localhost', checkServerIdentity: (host) => void (seen = host) })
    await once(accepted, 'secureConnect')
    expect(seen).toBe('localhost')
    // The exported check passes only what rustls verified for that name.
    const cert = accepted.getPeerCertificate()
    expect(tls.checkServerIdentity('localhost', cert)).toBeUndefined()
    expect(tls.checkServerIdentity('other.test', cert)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    expect(tls.checkServerIdentity('localhost', { raw: Buffer.alloc(1) })).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    accepted.destroy()
    // tls.Server emits 'connection' as well as 'secureConnection'.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connections.length).toBe(2)
    server.close()
  })

  it('names certificate failures as Node does', async () => {
    const server = tls.createServer({ key: 'K', cert: 'C' })
    const port = await listening(server)
    // Rust answers with OpenSSL's code for the failure.
    const spy = vi.spyOn(await import('../src/internal/native.js'), 'native')
    spy.mockImplementationOnce(async () => {
      throw { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'certificate not valid for name', host: 'wrong.test' }
    })
    const socket = tls.connect(port, 'wrong.test')
    const [error] = await once(socket, 'error')
    expect(error.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    expect(error.message).toBe("Hostname/IP does not match certificate's altnames: Host: wrong.test. is not in the cert's altnames")
    spy.mockImplementationOnce(async () => {
      throw { code: 'CERT_HAS_EXPIRED', message: 'expired' }
    })
    const [expired] = await once(tls.connect(port, 'old.test'), 'error')
    expect(expired).toMatchObject({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' })
    spy.mockRestore()
    server.close()
  })
})

describe('dgram', () => {
  it('sends and receives datagrams', async () => {
    const a = dgram.createSocket('udp4')
    const b = dgram.createSocket({ type: 'udp4' })
    a.bind(0)
    await once(a, 'listening')
    const message = once(a, 'message')
    b.send('ping', a.address().port, '127.0.0.1', (error, bytes) => {
      expect(error).toBeNull()
      expect(bytes).toBe(4)
    })
    const [data, rinfo] = await message
    expect(data.toString()).toBe('ping')
    expect(rinfo).toMatchObject({ address: '127.0.0.1', family: 'IPv4', size: 4 })
    expect(rinfo.port).toBe(b.address().port)
    a.close()
    b.close()
    expect(() => dgram.createSocket('udp5')).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_TYPE' }))
  })
})

describe('dns', () => {
  it('looks up names with Node results and errors', async () => {
    state.dnsLookup = ({ hostname }) => {
      if (hostname === 'nowhere.invalid') throw { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname }
      return [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]
    }
    const [address, family] = await new Promise((resolve, reject) => dns.lookup('localhost', (e, a, f) => (e ? reject(e) : resolve([a, f]))))
    expect([address, family]).toEqual(['::1', 6])
    expect(await dns.promises.lookup('localhost', { all: true, order: 'ipv4first' })).toEqual([{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])
    expect(await dns.promises.lookup('10.1.2.3')).toEqual({ address: '10.1.2.3', family: 4 })
    const error = await dns.promises.lookup('nowhere.invalid').catch((e) => e)
    expect(error.message).toBe('getaddrinfo ENOTFOUND nowhere.invalid')
    expect(error).toMatchObject({ code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'nowhere.invalid' })
  })

  it('resolves records through the servers set', async () => {
    state.dnsResolve = ({ hostname, rrtype, servers }) => {
      if (rrtype === 'MX') throw { code: 'ENODATA', syscall: 'queryMx', hostname }
      return { A: ['192.0.2.1'], TXT: [['v=spf1', ' -all']] }[rrtype]
    }
    const resolver = new dns.promises.Resolver({ timeout: 500 })
    resolver.setServers(['127.0.0.1:5353'])
    expect(resolver.getServers()).toEqual(['127.0.0.1:5353'])
    expect(await resolver.resolve4('app.test')).toEqual(['192.0.2.1'])
    expect(state.calls.at(-1).args).toMatchObject({ hostname: 'app.test', rrtype: 'A', servers: ['127.0.0.1:5353'], timeout: 500 })
    expect(await resolver.resolveTxt('app.test')).toEqual([['v=spf1', ' -all']])
    const error = await resolver.resolveMx('app.test').catch((e) => e)
    expect(error).toMatchObject({ message: 'queryMx ENODATA app.test', code: 'ENODATA', syscall: 'queryMx', hostname: 'app.test' })
    expect(() => resolver.setServers(['not an ip'])).toThrow(expect.objectContaining({ code: 'ERR_INVALID_IP_ADDRESS' }))
  })
})

describe('http server', () => {
  it('answers requests with Content-Length and chunked bodies', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/stream') {
        res.writeHead(201, { 'Content-Type': 'text/plain' })
        res.write('a')
        res.end('b')
        return
      }
      res.setHeader('X-Method', req.method)
      res.end(`hello ${req.headers.host}`)
    })
    const port = await listening(server)

    const plain = await exchange(port, 'GET / HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n')
    expect(plain).toMatch(/^HTTP\/1\.1 200 OK\r\n/)
    expect(plain).toMatch(/\r\nContent-Length: 14\r\n/)
    expect(plain).toMatch(/\r\nX-Method: GET\r\n/)
    expect(plain).toMatch(/\r\nConnection: close\r\n/)
    expect(plain.endsWith('\r\n\r\nhello app.test')).toBe(true)

    const chunked = await exchange(port, 'GET /stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    expect(chunked).toMatch(/^HTTP\/1\.1 201 Created\r\n/)
    expect(chunked).toMatch(/\r\nTransfer-Encoding: chunked\r\n/)
    expect(chunked.endsWith('\r\n\r\n1\r\na\r\n1\r\nb\r\n0\r\n\r\n')).toBe(true)
    server.close()
  })

  it('reads request bodies and keeps connections alive', async () => {
    const seen = []
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      seen.push({ method: req.method, url: req.url, body, complete: req.complete })
      res.end(String(body.length))
    })
    const port = await listening(server)
    const both = await exchange(
      port,
      'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello' +
        'PUT /b HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n',
      /\r\n\r\n5[\s\S]*\r\n\r\n5$/,
    )
    expect(both.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2)
    expect(both).toMatch(/Connection: keep-alive/)
    expect(seen).toEqual([
      { method: 'POST', url: '/a', body: 'hello', complete: true },
      { method: 'PUT', url: '/b', body: 'abcde', complete: true },
    ])
    server.closeAllConnections()
    server.close()
  })

  it('answers every pipelined request when the client half-closes after sending', async () => {
    const server = http.createServer(async (req, res) => {
      for await (const chunk of req) void chunk
      await new Promise((resolve) => setTimeout(resolve, 10)) // the client's FIN arrives first
      res.end(req.url)
    })
    const port = await listening(server)
    const socket = net.connect(port)
    socket.end('POST /first HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nsink' + 'GET /second HTTP/1.1\r\nHost: x\r\n\r\n')
    let text = ''
    for await (const chunk of socket) text += chunk
    expect(text.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2)
    expect(text.endsWith('\r\n\r\n/second')).toBe(true)
    server.close()
  })

  it('handles HEAD, 204, 100-continue and malformed requests', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/empty') {
        res.statusCode = 204
        return res.end()
      }
      res.end('body')
    })
    const port = await listening(server)
    const head = await exchange(port, 'HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    expect(head).toMatch(/Content-Length: 4\r\n/)
    expect(head.endsWith('\r\n\r\n')).toBe(true)
    const empty = await exchange(port, 'GET /empty HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    expect(empty).toMatch(/^HTTP\/1\.1 204 No Content/)
    expect(empty).not.toMatch(/Content-Length|Transfer-Encoding/)
    const continued = await exchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    expect(continued).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 OK/)
    const bad = await exchange(port, 'NOT HTTP\r\n\r\n')
    expect(bad).toMatch(/^HTTP\/1\.1 400 Bad Request\r\nConnection: close/)
    server.close()
  })

  it("hands the socket to 'upgrade' listeners", async () => {
    const server = http.createServer(() => {
      throw new Error('not a request')
    })
    server.on('upgrade', (req, socket, head) => {
      expect(req.headers.upgrade).toBe('websocket')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.write(`echo:${head.toString()}`)
      socket.on('data', (chunk) => socket.end(`echo:${chunk}`))
    })
    const port = await listening(server)
    const socket = net.connect(port)
    socket.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nfirst')
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk
      if (received.endsWith('echo:first')) socket.write('second')
    })
    await once(socket, 'end')
    expect(received).toMatch(/^HTTP\/1\.1 101 Switching Protocols\r\n/)
    expect(received.endsWith('echo:firstecho:second')).toBe(true)
    socket.destroy()
    server.close()
  })

  it('serves https over tls sockets', async () => {
    const server = https.createServer({ key: 'K', cert: 'C' }, (req, res) => res.end(`secure ${req.socket.encrypted}`))
    const port = await listening(server)
    expect(state.calls.find((c) => c.command === 'net_listen').args.options.tls).toMatchObject({ key: 'K', cert: 'C' })
    const socket = tls.connect({ port, host: 'localhost' })
    socket.end('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    let text = ''
    for await (const chunk of socket) text += chunk
    expect(text.endsWith('\r\n\r\nsecure true')).toBe(true)
    server.close()
  })

  it('keeps connections alive after close() and listen() again', async () => {
    const server = http.createServer((req, res) => res.end('ok'))
    await listening(server)
    await new Promise((resolve) => server.close(resolve))
    const port = await listening(server)
    const reply = await exchange(port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n', /\r\n\r\nok$/)
    expect(reply).toMatch(/Connection: keep-alive/)
    server.closeAllConnections()
    server.close()
  })

  it('stops reading pipelined requests while a response is running', async () => {
    let release
    const server = http.createServer((req, res) => {
      if (req.url === '/slow') release = () => res.end('slow')
      else res.end('fast')
    })
    const port = await listening(server)
    const socket = net.connect(port)
    const filler = `GET /fast HTTP/1.1\r\nHost: x\r\nX-Pad: ${'p'.repeat(1000)}\r\n\r\n`
    socket.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n' + filler.repeat(30))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const accepted = [...state.sockets.entries()].find(([, v]) => v.peer === socket._id)[0]
    const serverSocket = [...server._connections][0]
    expect(serverSocket.isPaused()).toBe(true)
    expect(accepted).toBeTypeOf('number')
    let text = ''
    socket.on('data', (chunk) => (text += chunk))
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(text.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(31)
    expect(serverSocket.isPaused()).toBe(false)
    socket.destroy()
    server.closeAllConnections()
    server.close()
  })

  it('validates what handlers set', () => {
    const res = new http.ServerResponse({ method: 'GET', httpVersion: '1.1', headers: {} })
    res.setHeader('X-A', ['1', '2'])
    expect(res.getHeader('x-a')).toEqual(['1', '2'])
    expect(res.getHeaderNames()).toEqual(['x-a'])
    expect(() => res.setHeader('bad header', 'x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_HTTP_TOKEN' }))
    expect(() => res.writeHead(42)).toThrow(expect.objectContaining({ code: 'ERR_HTTP_INVALID_STATUS_CODE' }))
  })
})
