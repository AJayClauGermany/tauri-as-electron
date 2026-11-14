import { describe, expect, it, vi } from 'vitest'

// The electron module pulls in every Tauri plugin; a stand-in is enough here.
vi.mock('../src/index.js', () => ({ app: { name: 'stub' }, BrowserWindow: class {} }))

const { requireShim, nodeBuiltin, installRequire, registerNodeModule } = await import('../src/require.js')

describe('require()', () => {
  it('serves electron, path and process', () => {
    expect(requireShim('electron').app).toEqual({ name: 'stub' })
    expect(requireShim('electron/main')).toBe(requireShim('electron/renderer'))
    expect(requireShim('path').join('a', 'b')).toBe('a/b')
    expect(requireShim('node:path')).toBe(requireShim('path'))
    expect(requireShim('node:process').platform).toBeTypeOf('string')
    expect(new (requireShim('events').EventEmitter)().listenerCount('x')).toBe(0)
    expect(requireShim('node:url').fileURLToPath('file:///tmp/a%20b')).toBe('/tmp/a b')
  })

  it('hands out a stub for Node built-ins that explains itself when used', () => {
    const os = requireShim('node:os')
    const error = (() => {
      try {
        os.hostname()
      } catch (e) {
        return e
      }
    })()
    expect(error.name).toBe('NotImplementedError')
    expect(error.reason).toBe('unsupported')
    expect(error.message).toMatch(/os\.hostname is not supported on Tauri/)
    expect(error.message).toMatch(/@tauri-apps\/plugin-os/)
    expect(() => requireShim('left-pad')).toThrow(/Use import/)
  })

  it('serves fs only where it was registered (the main page), a stub that says so elsewhere', () => {
    // Renderer pages: fs is the main process's.
    expect(() => requireShim('fs').readFileSync('/x')).toThrow(/fs\.readFileSync is not supported on Tauri.*main process only.*node-fs/)
    const fs = { readFileSync: () => 'real' }
    registerNodeModule('fs', fs)
    expect(requireShim('node:fs')).toBe(fs)
    expect(requireShim('path/win32').sep).toBe('\\')
  })

  it('installs a global require once, and module/exports only on request', () => {
    const saved = { require: globalThis.require, module: globalThis.module, exports: globalThis.exports }
    try {
      delete globalThis.require
      delete globalThis.module
      delete globalThis.exports
      expect(installRequire()).toBe(requireShim)
      expect(globalThis.module).toBeUndefined() // UMD bundles in pages must not see a CommonJS `module`
      installRequire({ moduleGlobals: true })
      expect(globalThis.module.exports).toBe(globalThis.exports)
      const marker = () => {}
      globalThis.require = marker
      expect(installRequire()).toBe(marker)
    } finally {
      Object.assign(globalThis, saved)
    }
  })
})

describe('nodeBuiltin()', () => {
  it('throws on use, not on import or property access', () => {
    const fs = nodeBuiltin('fs')
    expect(fs).toBeTypeOf('function')
    expect(fs.then).toBeUndefined()
    expect(fs.__esModule).toBeUndefined()
    expect(fs.default).toBe(fs)
    const { readFileSync } = fs // a named import after CommonJS interop
    expect(readFileSync).toBeTypeOf('function')
    expect(() => readFileSync('x')).toThrow(/fs\.readFileSync is not supported on Tauri.*ipcMain\.handle/)
    expect(() => fs()).toThrow(/fs\(\) is not supported/)
    expect(() => new (nodeBuiltin('child_process'))()).toThrow(/new child_process\(\) .*plugin-shell/)
  })
})
