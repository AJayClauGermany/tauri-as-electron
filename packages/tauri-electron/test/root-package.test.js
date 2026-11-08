import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `npm install github:AJayClauGermany/tauri-as-electron` installs the repository
// root, which re-exports this package. Keep the two package.json files in step.
const here = path.dirname(fileURLToPath(import.meta.url))
const lib = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8'))
const root = JSON.parse(fs.readFileSync(path.join(here, '../../../package.json'), 'utf8'))
const repo = path.join(here, '../../..')

describe('repository root as the GitHub-installable package', () => {
  it('re-exports every entry point of tauri-electron', () => {
    const expected = Object.fromEntries(Object.entries(lib.exports).map(([key, file]) => [key, `./packages/tauri-electron/${file.replace(/^\.\//, '')}`]))
    expect(root.exports).toEqual(expected)
    expect(root.main).toBe(expected['.'])
    for (const file of Object.values(root.exports)) expect(fs.existsSync(path.join(repo, file)), file).toBe(true)
  })

  it('declares the same dependencies and version', () => {
    expect(root.dependencies).toEqual(lib.dependencies)
    expect(root.version).toBe(lib.version)
  })

  it('packs the library, the template and the scaffolder', () => {
    expect(root.files).toEqual(expect.arrayContaining(['packages/tauri-electron/src', 'packages/tauri-electron/vite.js', 'templates/tauri-electron-app', 'scripts/create-app.mjs']))
    expect(root.bin).toEqual({ 'create-tauri-electron-app': './scripts/create-app.mjs' })
    expect(fs.existsSync(path.join(repo, root.bin['create-tauri-electron-app']))).toBe(true)
  })
})
