import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ requests: [], respond: null }))
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: async (url, init) => {
    state.requests.push({ url, init })
    return state.respond(url, init)
  },
}))

const http = (await import('../src/node/http.js')).default
const https = (await import('../src/node/https.js')).default

beforeEach(() => {
  state.requests = []
  state.respond = () => new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=1' } })
})

const body = (res) => new Promise((resolve) => {
  let text = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => (text += chunk))
  res.on('end', () => resolve(text))
})

describe('http client', () => {
  it('gets a URL and streams the response', async () => {
    const res = await new Promise((resolve) => http.get('http://example.test:8080/a?b=1', resolve))
    expect(res.statusCode).toBe(200)
    expect(res.statusMessage).toBe('OK')
    expect(res.headers['content-type']).toBe('text/plain')
    expect(await body(res)).toBe('hello world')
    expect(state.requests[0]).toMatchObject({ url: 'http://example.test:8080/a?b=1', init: { method: 'GET', maxRedirections: 0 } })
  })

  it('sends options, headers, auth and a written body', async () => {
    state.respond = () => new Response(null, { status: 201 })
    const req = https.request({ hostname: 'api.test', path: '/items', method: 'post', headers: { 'X-Id': '7' }, auth: 'u:p' })
    req.setHeader('Content-Type', 'application/json')
    req.write('{"a":')
    req.end('1}')
    const res = await new Promise((resolve) => req.on('response', resolve))
    expect(res.statusCode).toBe(201)
    const { url, init } = state.requests[0]
    expect(url).toBe('https://api.test/items')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(expect.arrayContaining([['X-Id', '7'], ['Content-Type', 'application/json'], ['Authorization', `Basic ${btoa('u:p')}`]]))
    expect(new TextDecoder().decode(init.body)).toBe('{"a":1}')
    expect(() => req.setHeader('x', 'y')).toThrow(expect.objectContaining({ code: 'ERR_HTTP_HEADERS_SENT' }))
  })

  it('maps network failures to Node error codes and checks the protocol', async () => {
    state.respond = () => Promise.reject(new Error('error sending request: tcp connect error: Connection refused (os error 111)'))
    const error = await new Promise((resolve) => http.get('http://127.0.0.1:9/').on('error', resolve))
    expect(error).toMatchObject({ code: 'ECONNREFUSED', syscall: 'connect' })
    expect(() => http.get('https://x.test/')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_PROTOCOL' }))
    expect(http.STATUS_CODES[404]).toBe('Not Found')
    expect(http.METHODS).toContain('PATCH')
    expect(() => http.createServer()).toThrow(/not implemented yet/)
  })
})
