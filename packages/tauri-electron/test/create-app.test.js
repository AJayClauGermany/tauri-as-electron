import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const script = path.join(repo, 'scripts/create-app.mjs')
const { toPackageName, toIdentifier, dependencySpecs, findPreload } = await import(script)

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
const json = (dir, file) => JSON.parse(read(dir, file))

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-app-'))
  return dir
}

describe('create-tauri-electron-app helpers', () => {
  it('derives safe names', () => {
    expect(toPackageName('My App!')).toBe('my-app')
    expect(toPackageName('')).toBe('tauri-electron-app')
    expect(toIdentifier('my.app')).toBe('com.example.my-app')
  })

  it('points both dependencies at GitHub, pinned the same way', () => {
    expect(dependencySpecs({}, '/x')).toEqual({
      npm: 'github:AJayClauGermany/tauri-as-electron',
      cargo: '{ git = "https://github.com/AJayClauGermany/tauri-as-electron" }',
    })
    expect(dependencySpecs({ ref: 'v0.2.0' }, '/x').cargo).toContain('tag = "v0.2.0"')
    expect(dependencySpecs({ ref: 'v0.2.0' }, '/x').npm).toBe('github:AJayClauGermany/tauri-as-electron#v0.2.0')
    expect(dependencySpecs({ ref: 'next' }, '/x').cargo).toContain('branch = "next"')
    expect(dependencySpecs({ ref: 'a'.repeat(40) }, '/x').cargo).toContain(`rev = "${'a'.repeat(40)}"`)
  })

  it('uses relative paths for a local checkout next door', () => {
    const specs = dependencySpecs({ local: repo }, path.join(path.dirname(repo), 'my-app'))
    expect(specs.npm).toBe('file:../tauri-as-electron')
    expect(specs.cargo).toBe('{ path = "../../tauri-as-electron/crates/tauri-plugin-electron" }')
  })

  it('finds the preload from webPreferences.preload or by name', () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'app'))
    fs.writeFileSync(path.join(dir, 'app/main.js'), "new BrowserWindow({ webPreferences: { preload: path.join(__dirname, 'pre.js') } })")
    fs.writeFileSync(path.join(dir, 'app/pre.js'), '')
    expect(findPreload(dir, 'app/main.js')).toBe('app/pre.js')
    fs.writeFileSync(path.join(dir, 'preload.cjs'), '')
    expect(findPreload(dir, 'missing.js')).toBe('preload.cjs')
    expect(findPreload(tmp(), 'main.js')).toBeNull()
  })
})

describe('create-tauri-electron-app', () => {
  it('creates a renamed copy of the template that depends on GitHub', () => {
    const dir = path.join(tmp(), 'Hello World')
    execFileSync('node', [script, dir, '--identifier', 'org.test.hello'], { stdio: 'pipe' })
    const pkg = json(dir, 'package.json')
    expect(pkg.name).toBe('hello-world')
    expect(pkg.dependencies['tauri-electron']).toBe('github:AJayClauGermany/tauri-as-electron')
    expect(json(dir, 'src-tauri/tauri.conf.json')).toMatchObject({ productName: 'hello-world', identifier: 'org.test.hello' })
    const cargo = read(dir, 'src-tauri/Cargo.toml')
    expect(cargo).toContain('name = "hello-world"')
    expect(cargo).toContain('name = "hello_world_lib"')
    expect(cargo).toMatch(/^tauri-plugin-electron = \{ git = "https:\/\/github.com\/AJayClauGermany\/tauri-as-electron" \}$/m)
    expect(cargo).not.toContain('path = "../../../crates')
    expect(read(dir, 'src-tauri/src/main.rs')).toContain('hello_world_lib::run()')
    expect(read(dir, 'README.md')).not.toContain('](../../')
    expect(read(dir, '.gitignore')).toContain('src-tauri/target/')
    expect(fs.existsSync(path.join(dir, 'src-tauri/capabilities/README.md'))).toBe(true)
    expect(() => execFileSync('node', [script, dir], { stdio: 'pipe' })).toThrow(/not empty/)
  })

  it('adds Tauri to an existing Electron project without touching its code', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'legacy', version: '2.0.0', main: 'src/index.js', scripts: { start: 'electron .' }, build: { appId: 'com.legacy.app', productName: 'Legacy' } }))
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src/index.js'), "const { app } = require('electron')\nnew BrowserWindow({ webPreferences: { preload: path.join(__dirname, 'preload.js') } })")
    fs.writeFileSync(path.join(dir, 'src/preload.js'), '// preload')
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n')
    execFileSync('node', [script, '--into', dir, '--ref', 'v1.0.0'], { stdio: 'pipe' })

    const pkg = json(dir, 'package.json')
    expect(pkg.scripts).toMatchObject({ start: 'electron .', 'tauri:dev': 'tauri dev', 'dev:web': 'vite' })
    expect(pkg.dependencies['tauri-electron']).toBe('github:AJayClauGermany/tauri-as-electron#v1.0.0')
    expect(pkg.devDependencies['@tauri-apps/cli']).toMatch(/^\^2/)
    expect(read(dir, 'src/index.js')).toContain("require('electron')")
    expect(read(dir, 'electron-main.html')).toContain('src="/src/index.js"')
    expect(read(dir, 'vite.config.mjs')).toContain("preload: 'src/preload.js'")
    expect(read(dir, 'src-tauri/Cargo.toml')).toContain('tag = "v1.0.0"')
    expect(json(dir, 'src-tauri/tauri.conf.json')).toMatchObject({ productName: 'Legacy', identifier: 'com.legacy.app', version: '2.0.0' })
    expect(read(dir, '.gitignore').split('\n')).toEqual(expect.arrayContaining(['node_modules', 'dist/', 'src-tauri/target/']))

    // Running it again keeps what is there.
    fs.writeFileSync(path.join(dir, 'vite.config.mjs'), '// mine')
    const out = execFileSync('node', [script, '--into', dir], { encoding: 'utf8' })
    expect(read(dir, 'vite.config.mjs')).toBe('// mine')
    expect(out).toMatch(/Kept/)
  })
})
