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
