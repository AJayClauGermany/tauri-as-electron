import { describe, expect, it } from 'vitest'
import EventEmitter, { once } from '../src/events.js'
import { fileURLToPath, pathToFileURL, parse, format, resolve } from '../src/url.js'

describe('events', () => {
  it('is the EventEmitter tauri-electron objects use, with events.once()', async () => {
    const emitter = new EventEmitter()
    expect(EventEmitter.EventEmitter).toBe(EventEmitter)
    const waited = once(emitter, 'ready')
    emitter.emit('ready', 1, 2)
    expect(await waited).toEqual([1, 2])
  })
})

describe('url', () => {
  it('converts between paths and file URLs', () => {
    expect(fileURLToPath('file:///home/me/a%20b.txt')).toBe('/home/me/a b.txt')
    expect(fileURLToPath(new URL('http://localhost:1420/src/main.js'))).toBe('/src/main.js')
    expect(pathToFileURL('/tmp/x y').href).toBe('file:///tmp/x%20y')
  })

  it('parses and formats like the legacy API', () => {
    const parsed = parse('https://user:pw@example.com:8080/p/a?x=1#h', true)
    expect(parsed).toMatchObject({ protocol: 'https:', host: 'example.com:8080', hostname: 'example.com', port: '8080', pathname: '/p/a', query: { x: '1' }, hash: '#h', auth: 'user:pw' })
    expect(format({ protocol: 'https', hostname: 'example.com', pathname: '/x', query: { a: '1' } })).toBe('https://example.com/x?a=1')
    expect(format(new URL('http://a/b'))).toBe('http://a/b')
    expect(parse('/only/path?q=1').pathname).toBe('/only/path')
    expect(resolve('http://a/b/c', '../d')).toBe('http://a/d')
  })
})
