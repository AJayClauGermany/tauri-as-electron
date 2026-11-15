import { describe, expect, it } from 'vitest'
import path from '../src/path.js'

describe('path shim', () => {
  it('joins and normalizes like node posix', () => {
    expect(path.join('/src', 'index.html')).toBe('/src/index.html')
    expect(path.join('/src/main', '../renderer/index.html')).toBe('/src/renderer/index.html')
    expect(path.join('a', '', 'b/')).toBe('a/b/')
    expect(path.join()).toBe('.')
    expect(path.normalize('a/../../b')).toBe('../b')
  })

  it('resolves against /', () => {
    expect(path.resolve('a', 'b')).toBe('/a/b')
    expect(path.resolve('/x', '../y')).toBe('/y')
  })

  it('splits paths', () => {
    expect(path.dirname('/a/b/c.txt')).toBe('/a/b')
    expect(path.dirname('c.txt')).toBe('.')
    expect(path.basename('/a/b/c.txt')).toBe('c.txt')
    expect(path.basename('/a/b/c.txt', '.txt')).toBe('c')
    expect(path.extname('/a/b/c.tar.gz')).toBe('.gz')
    expect(path.extname('.bashrc')).toBe('')
    expect(path.relative('/a/b', '/a/c/d')).toBe('../c/d')
    expect(path.parse('/home/u/file.txt')).toEqual({ root: '/', dir: '/home/u', base: 'file.txt', ext: '.txt', name: 'file' })
    expect(path.format({ dir: '/home/u', base: 'file.txt' })).toBe('/home/u/file.txt')
  })
})

describe('path.win32', async () => {
  const nodePath = await import('node:path')
  const W = nodePath.win32
  const ours = path.win32
  const samples = [
    '', '.', '..', 'a', 'a\\b', 'a/b/', 'C:', 'C:\\', 'C:/', 'C:a', 'C:\\a\\b.txt', 'c:/a/../b/', 'C:\\a\\..\\..\\x', '\\a', '/a/b',
    '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\x\\y.js', '//server/share/x', 'C:\\a\\b\\', 'a.b.c', '.bashrc',
    'C:\\foo\\..', 'x\\..\\..\\y', 'C:\\Users\\Me\\AppData\\Roaming\\app\\config.json', 'D:relative\\p',
  ]

  it('is a real Windows implementation, while path stays POSIX', () => {
    expect(ours.sep).toBe('\\')
    expect(ours.delimiter).toBe(';')
    expect(ours.posix).toBe(path)
    expect(path.sep).toBe('/')
    expect(ours.join('C:\\Users\\me', 'AppData', '../x.json')).toBe('C:\\Users\\me\\x.json')
  })

  it('matches Node for drive, UNC and relative paths', () => {
    const cwd = process.cwd
    process.cwd = () => 'C:\\work\\dir' // what Node's win32.resolve uses too
    try {
      for (const s of samples) {
        for (const fn of ['normalize', 'isAbsolute', 'dirname', 'basename', 'extname', 'parse']) {
          expect(ours[fn](s), `${fn}(${JSON.stringify(s)})`).toEqual(W[fn](s))
        }
      }
      for (const a of samples) {
        for (const b of samples.slice(0, 18)) {
          if (a === '.' && b === 'C:a') continue // Node 22 quirk ('.\\C:a')
          expect(ours.join(a, b), `join(${a}, ${b})`).toBe(W.join(a, b))
          expect(ours.resolve('C:\\base', a, b), `resolve(${a}, ${b})`).toBe(W.resolve('C:\\base', a, b))
          expect(ours.relative(a || 'C:\\x', b || 'C:\\y'), `relative(${a}, ${b})`).toBe(W.relative(a || 'C:\\x', b || 'C:\\y'))
        }
      }
      expect(ours.basename('C:\\a\\b.txt', '.txt')).toBe('b')
      expect(ours.format({ root: 'C:\\', dir: 'C:\\x', base: 'f.txt' })).toBe(W.format({ root: 'C:\\', dir: 'C:\\x', base: 'f.txt' }))
      expect(ours.toNamespacedPath('C:\\a')).toBe(W.toNamespacedPath('C:\\a'))
      expect(ours.toNamespacedPath('\\\\s\\sh\\x')).toBe(W.toNamespacedPath('\\\\s\\sh\\x'))
    } finally {
      process.cwd = cwd
    }
  })
})
