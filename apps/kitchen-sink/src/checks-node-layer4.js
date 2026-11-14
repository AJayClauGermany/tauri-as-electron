// Checks for the fourth layer of Node built-ins: sockets (net, tls, dgram),
// dns, and HTTP/HTTPS servers. Everything stays on loopback (a local DNS
// server answers the resolver), so the checks need no network. Same shape as
// checks.js and, like it, runs unchanged on Electron and on Tauri (with the
// "node-net" and "node-tls" features of tauri-plugin-electron).
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { setImmediate } from 'node:timers'
import { CA, CERT, KEY } from './fixtures/tls-test-cert.js'

const isWindows = process.platform === 'win32'

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Listen on a free loopback port; resolves with the port. */
async function listen(server, host = '127.0.0.1') {
  server.listen(0, host)
  await once(server, 'listening')
  return server.address().port
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** Everything a socket sends until it ends. */
async function readAll(socket) {
  let text = ''
  for await (const chunk of socket) text += chunk
  return text
}

/** Send raw bytes to a TCP port and collect the answer until the server closes. */
async function exchange(port, request) {
  const socket = net.connect(port, '127.0.0.1')
  socket.end(request)
  return readAll(socket)
}

/** A DNS server that answers every A question with 192.0.2.42 (RFC 1035 wire format). */
function dnsServer() {
  const socket = dgram.createSocket('udp4')
  socket.on('message', (query, rinfo) => {
    // The question ends after the name's zero byte and QTYPE / QCLASS.
    let end = 12
    while (query[end] !== 0) end += query[end] + 1
    end += 5
    const question = query.subarray(12, end)
    const isA = query.readUInt16BE(end - 4) === 1
    const header = Buffer.alloc(12)
    query.copy(header, 0, 0, 2) // the id
    header.writeUInt16BE(0x8180, 2) // response, recursion desired + available, no error
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(isA ? 1 : 0, 6)
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 42])
    socket.send(Buffer.concat([header, question, ...(isA ? [answer] : [])]), rinfo.port, rinfo.address)
  })
  return socket
}

export const layer4Checks = [
  // --- net ------------------------------------------------------------------------------------
  { id: 'net: TCP echo server and client on loopback', run: async () => {
    const server = net.createServer((socket) => socket.pipe(socket))
    const port = await listen(server)
    const socket = net.connect({ port, host: '127.0.0.1' })
    await once(socket, 'connect')
    assert(socket.remotePort === port && socket.remoteAddress === '127.0.0.1', `${socket.remoteAddress}:${socket.remotePort}`)
    socket.setEncoding('utf8')
    socket.end('kitchen ✓ sink')
    const echoed = await readAll(socket)
    assert(echoed === 'kitchen ✓ sink', echoed)
    await close(server)
    return `${echoed} via port ${port}`
  } },
  { id: 'net: connect to a closed port fails with ECONNREFUSED', run: async () => {
    const server = net.createServer()
    const port = await listen(server)
    await close(server)
    const socket = net.connect(port, '127.0.0.1')
    const [error] = await once(socket, 'error').catch((e) => [e])
    assert(error.code === 'ECONNREFUSED' && error.syscall === 'connect' && error.port === port, `${error.code} ${error.syscall} ${error.port}`)
    assert(error.message === `connect ECONNREFUSED 127.0.0.1:${port}`, error.message)
    return error.message
  } },
  { id: 'net: listen on a port in use fails with EADDRINUSE', run: async () => {
    const first = net.createServer()
    const port = await listen(first)
    const second = net.createServer()
    second.listen(port, '127.0.0.1')
    const [error] = await once(second, 'error').catch((e) => [e])
    await close(first)
    assert(error.code === 'EADDRINUSE' && error.syscall === 'listen', `${error.code} ${error.syscall}`)
    return error.message
  } },
  { id: 'net: IPC server (Unix socket / named pipe)', run: async () => {
    const where = isWindows ? `\\\\.\\pipe\\tauri-electron-kitchen-${Date.now()}` : path.join(os.tmpdir(), `tauri-electron-kitchen-${Date.now()}.sock`)
    const server = net.createServer((socket) => socket.end('over ipc'))
    server.listen(where)
    await once(server, 'listening')
    assert(server.address() === where, String(server.address()))
    const text = await readAll(net.connect(where).setEncoding('utf8'))
    await close(server)
    assert(text === 'over ipc', text)
    return `${text} at ${where}`
  } },
  { id: 'net: pause / resume and back-pressure (1 MiB)', run: async () => {
    const size = 1024 * 1024
    const server = net.createServer((socket) => socket.end(Buffer.alloc(size, 7)))
    const port = await listen(server)
    const started = performance.now()
    const socket = net.connect(port, '127.0.0.1')
    let received = 0
    let chunks = 0
    socket.on('data', (chunk) => {
      received += chunk.length
      chunks++
      // A slow reader: Rust stops reading while JavaScript is paused.
      socket.pause()
      setImmediate(() => socket.resume())
    })
    await once(socket, 'end')
    await close(server)
    assert(received === size, `${received} bytes`)
    return `${received} bytes in ${chunks} chunks, ${Math.round(performance.now() - started)} ms`
  } },

  // --- dgram ----------------------------------------------------------------------------------
  { id: 'dgram: UDP send / receive on loopback', run: async () => {
    const receiver = dgram.createSocket('udp4')
    receiver.bind(0, '127.0.0.1')
    await once(receiver, 'listening')
    const sender = dgram.createSocket('udp4')
    const message = once(receiver, 'message')
    sender.send('datagram', receiver.address().port, '127.0.0.1')
    const [data, rinfo] = await message
    receiver.close()
    sender.close()
    assert(data.toString() === 'datagram' && rinfo.address === '127.0.0.1' && rinfo.size === 8, `${data} from ${rinfo.address}`)
    return `${data} from ${rinfo.address}:${rinfo.port}`
  } },

  // --- dns ------------------------------------------------------------------------------------
  { id: "dns.lookup('localhost')", run: async () => {
    const { address, family } = await dnsPromises.lookup('localhost')
    assert(['127.0.0.1', '::1'].includes(address) && [4, 6].includes(family), `${address} ${family}`)
    const all = await new Promise((resolve, reject) => dns.lookup('localhost', { all: true }, (e, list) => (e ? reject(e) : resolve(list))))
    assert(Array.isArray(all) && all.length >= 1, JSON.stringify(all))
    return `${address} (IPv${family}), ${all.length} address(es)`
  } },
  { id: 'dns.lookup of a name that does not exist', run: async () => {
    const error = await dnsPromises.lookup('no-such-host.invalid').then(() => null, (e) => e)
    assert(error, 'resolved?')
    // ENOTFOUND, or EAI_AGAIN on a machine without a DNS server.
    assert(['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) && error.syscall === 'getaddrinfo' && error.hostname === 'no-such-host.invalid', `${error.code} ${error.syscall}`)
    return error.message
  } },
  { id: 'dns.Resolver against a local DNS server (resolve4)', run: async () => {
    const server = dnsServer()
    server.bind(0, '127.0.0.1')
    await once(server, 'listening')
    const resolver = new dnsPromises.Resolver({ timeout: 2000, tries: 1 })
    resolver.setServers([`127.0.0.1:${server.address().port}`])
    try {
      const addresses = await resolver.resolve4('kitchen.test')
      assert(addresses.length === 1 && addresses[0] === '192.0.2.42', JSON.stringify(addresses))
      const withTtl = await resolver.resolve4('kitchen.test', { ttl: true })
      assert(withTtl[0].address === '192.0.2.42' && withTtl[0].ttl === 60, JSON.stringify(withTtl))
      const callbackStyle = new dns.Resolver()
      callbackStyle.setServers(resolver.getServers())
      const viaCallback = await new Promise((resolve, reject) => callbackStyle.resolve('kitchen.test', 'A', (e, list) => (e ? reject(e) : resolve(list))))
      assert(viaCallback[0] === '192.0.2.42', JSON.stringify(viaCallback))
      return `kitchen.test → ${addresses[0]} (ttl ${withTtl[0].ttl})`
    } finally {
      server.close()
    }
  } },

  // --- tls ------------------------------------------------------------------------------------
  { id: 'tls: server and client with a private CA', run: async () => {
    const server = tls.createServer({ key: KEY, cert: CERT, ALPNProtocols: ['kitchen/1'] }, (socket) => socket.end(`hello ${socket.alpnProtocol}`))
    const port = await listen(server)
    const socket = tls.connect({ port, host: 'localhost', ca: CA, ALPNProtocols: ['kitchen/1'] })
    await once(socket, 'secureConnect')
    assert(socket.authorized === true, `authorized ${socket.authorized} ${socket.authorizationError}`)
    const protocol = socket.getProtocol()
    assert(['TLSv1.3', 'TLSv1.2'].includes(protocol), protocol)
    assert(socket.alpnProtocol === 'kitchen/1', String(socket.alpnProtocol))
    const fingerprint = socket.getPeerCertificate().fingerprint256
    socket.setEncoding('utf8')
    const text = await readAll(socket)
    await close(server)
    assert(text === 'hello kitchen/1', text)
    assert(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint), fingerprint)
    return `${text} over ${protocol}`
  } },
  { id: 'tls: untrusted and mismatched certificates', run: async () => {
    const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => socket.end())
    server.on('tlsClientError', () => {})
    const port = await listen(server)
    try {
      // Not signed by a root the client trusts.
      const untrusted = tls.connect({ port, host: 'localhost' })
      const [error] = await once(untrusted, 'error').catch((e) => [e])
      assert(error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', `${error.code}: ${error.message}`)
      // Trusted, but issued for another name.
      const wrongName = tls.connect({ port, host: '127.0.0.1', servername: 'other.test', ca: CA })
      const [mismatch] = await once(wrongName, 'error').catch((e) => [e])
      assert(mismatch.code === 'ERR_TLS_CERT_ALTNAME_INVALID', `${mismatch.code}: ${mismatch.message}`)
      // rejectUnauthorized: false connects and records why it is not authorized.
      const lenient = tls.connect({ port, host: 'localhost', rejectUnauthorized: false })
      await once(lenient, 'secureConnect')
      assert(lenient.authorized === false && lenient.authorizationError === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', `${lenient.authorized} ${lenient.authorizationError}`)
      lenient.destroy()
      return `${error.code}; ${mismatch.code}`
    } finally {
      await close(server)
    }
  } },

  // --- http / https servers -------------------------------------------------------------------
  { id: 'http.createServer + http.get', run: async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ method: req.method, url: req.url, agent: typeof req.headers['user-agent'] }))
    })
    const port = await listen(server)
    try {
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/kitchen?sink=1`, (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }))
        }).on('error', reject)
      })
      assert(body.status === 200 && body.type === 'application/json', `${body.status} ${body.type}`)
      const parsed = JSON.parse(body.text)
      assert(parsed.method === 'GET' && parsed.url === '/kitchen?sink=1', body.text)
      return body.text
    } finally {
      server.closeAllConnections()
      await close(server)
    }
  } },
  { id: 'http server: POST bodies, keep-alive and chunked responses', run: async () => {
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      if (req.url === '/chunked') {
        res.write('part1,')
        res.end('part2')
      } else {
        res.end(`${req.method} ${body}`)
      }
    })
    const port = await listen(server)
    const raw = await exchange(
      port,
      'POST /echo HTTP/1.1\r\nHost: kitchen\r\nContent-Length: 4\r\n\r\nsink' +
        'GET /chunked HTTP/1.1\r\nHost: kitchen\r\nConnection: close\r\n\r\n',
    )
    await close(server)
    const responses = raw.split(/(?=HTTP\/1\.1 )/)
    assert(responses.length === 2, raw)
    assert(/Content-Length: 9\r\n/i.test(responses[0]) && responses[0].endsWith('\r\n\r\nPOST sink'), responses[0])
    assert(/Transfer-Encoding: chunked\r\n/i.test(responses[1]) && responses[1].endsWith('\r\n\r\n6\r\npart1,\r\n5\r\npart2\r\n0\r\n\r\n'), responses[1])
    return 'two requests on one connection'
  } },
  { id: "http server: 'upgrade' hands over the socket", run: async () => {
    const server = http.createServer((req, res) => res.end('not upgraded'))
    server.on('upgrade', (req, socket, head) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: kitchen\r\nConnection: Upgrade\r\n\r\n')
      socket.end(`raw:${head}`)
    })
    const port = await listen(server)
    const raw = await exchange(port, 'GET / HTTP/1.1\r\nHost: kitchen\r\nConnection: Upgrade\r\nUpgrade: kitchen\r\n\r\nhello')
    await close(server)
    assert(raw.startsWith('HTTP/1.1 101 Switching Protocols\r\n') && raw.endsWith('\r\n\r\nraw:hello'), raw)
    return 'raw:hello'
  } },
  { id: 'https.createServer (read over tls.connect)', run: async () => {
    const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => res.end(`secure ${req.socket.encrypted === true}`))
    const port = await listen(server)
    const socket = tls.connect({ port, host: 'localhost', ca: CA })
    socket.end('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    const raw = await readAll(socket.setEncoding('utf8'))
    await close(server)
    assert(raw.startsWith('HTTP/1.1 200 OK\r\n') && raw.endsWith('\r\n\r\nsecure true'), raw)
    return 'secure true'
  } },
]
