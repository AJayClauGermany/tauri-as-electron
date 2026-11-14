import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { TauriElectronPlugin, fromForge, webTarget, redirect } = require('../webpack.cjs')
const webpack = require('webpack')
const { rspack } = require('@rspack/core')

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/webpack-app')
const packageDir = path.dirname(require.resolve('../webpack.cjs'))
/** A tauri-electron file's module id in the fixture's bundles (relative to the fixture). */
const moduleId = (file) => path.relative(fixture, path.join(packageDir, file)).split(path.sep).join('/')

describe('webTarget', () => {
  it('turns Electron and Node targets into web', () => {
    expect(webTarget('electron-main')).toBe('web')
    expect(webTarget('electron36-renderer')).toBe('web')
    expect(webTarget('node')).toBe('web')
    expect(webTarget(['web', 'electron-renderer'])).toEqual(['web'])
    expect(webTarget(['electron-preload'])).toBe('web')
  })

  it('leaves web targets and browserslist alone', () => {
    expect(webTarget('web')).toBe('web')
    expect(webTarget('browserslist')).toBe('browserslist')
    expect(webTarget(undefined)).toBe(undefined)
  })
})

describe('redirect', () => {
  const nodeBuiltin = path.join(path.dirname(require.resolve('../webpack.cjs')), 'bundler/node-builtin.cjs')
  const at = (request, options = {}) => redirect(request, { userResolved: new Set(), ...options })

  it('sends electron and the shimmed built-ins to tauri-electron', () => {
    expect(at('electron')).toMatch(/src[\\/]index\.js$/)
    expect(at('electron/renderer')).toMatch(/src[\\/]index\.js$/)
    expect(at('node:path')).toMatch(/src[\\/]path\.js$/)
    expect(at('events')).toMatch(/bundler[\\/]events\.cjs$/)
    expect(at('node:process')).toMatch(/bundler[\\/]process\.cjs$/)
    expect(at('electron-store')).toBeNull()
    expect(at('lodash')).toBeNull()
  })

  it('gives require() the shapes Node does (events is the class itself)', () => {
    const EventEmitter = require(at('events'))
    expect(typeof new EventEmitter().on).toBe('function')
    expect(EventEmitter.EventEmitter).toBe(EventEmitter)
  })

  it('redirects fs, buffer and path/win32 to their implementations', () => {
    expect(at('fs')).toMatch(/src[\\/]node[\\/]fs\.js$/)
    expect(at('original-fs')).toBe(at('node:fs'))
    expect(at('node:fs/promises')).toMatch(/src[\\/]node[\\/]fs-promises\.js$/)
    expect(at('buffer')).toMatch(/src[\\/]node[\\/]buffer\.js$/)
    expect(at('node:path/win32')).toMatch(/src[\\/]node[\\/]path-win32\.js$/)
    expect(at('child_process')).toMatch(/src[\\/]node[\\/]child-process\.js$/)
    // require('stream') is the Stream constructor, as in Node.
    expect(at('stream')).toMatch(/bundler[\\/]stream\.cjs$/)
    expect(typeof require(at('stream'))).toBe('function')
    expect(require(at('stream')).Readable).toBeTypeOf('function')
    // assert, console, constants, module: Node's require() gives the value itself.
    expect(typeof require(at('assert'))).toBe('function')
    expect(require(at('assert/strict')).equal).toBe(require(at('assert')).strictEqual)
    expect(require(at('node:constants')).SIGTERM).toBe(15)
    expect(typeof require(at('module')).createRequire).toBe('function')
  })

  it('stubs other Node built-ins, one module per built-in', () => {
    expect(at('net')).toBe(`${nodeBuiltin}?net`)
    expect(at('node:dns/promises')).toBe(`${nodeBuiltin}?dns/promises`)
    expect(at('path', { aliasPath: false })).toBe(`${nodeBuiltin}?path`)
  })

  it('respects resolve.alias / resolve.fallback the project already has', () => {
    expect(at('buffer', { userResolved: new Set(['buffer']) })).toBeNull()
    expect(at('node:buffer', { userResolved: new Set(['buffer']) })).toBeNull()
  })
})

function compile(bundler, config) {
  return new Promise((resolve, reject) => {
    bundler(config, (error, stats) => {
      if (error) return reject(error)
      if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })))
      resolve(stats)
    })
  })
}

function fixtureConfig(outDir) {
  return {
    mode: 'development',
    devtool: false,
    context: fixture,
    // What an Electron renderer config says; the plugin makes it a web build.
    target: 'electron-renderer',
    output: { path: outDir, publicPath: '/' },
    plugins: [
      new TauriElectronPlugin({
        main: './src/main.js',
        pages: [{ name: 'main_window', html: './src/index.html', js: './src/renderer.js', preload: './src/preload.js' }],
      }),
    ],
    infrastructureLogging: { level: 'error' },
  }
}

describe.each([
  ['webpack', webpack],
  ['rspack', rspack],
])('TauriElectronPlugin with %s', (name, bundler) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `tauri-electron-${name}-`))
  const read = (file) => fs.readFileSync(path.join(outDir, file), 'utf8')
  const built = compile(bundler, fixtureConfig(outDir))

  it('emits the hidden main page and the renderer page', async () => {
    await built
    expect(read('electron-main.html')).toContain('<script defer src="/electron-main.js"></script>')
    const page = read('main_window/index.html')
    expect(page).toContain('main_window.js')
    expect(page).not.toContain('electron-main.js')
  })

  it('builds the main process for a webview', async () => {
    await built
    const main = read('electron-main.js')
    // Forge's globals point at the page; __dirname & co. are project-relative.
    expect(main).toContain('"main_window/index.html"')
    expect(main).toContain('"main_window/preload.js"')
    expect(main).not.toMatch(/\bMAIN_WINDOW_WEBPACK_ENTRY\b/)
    expect(main).toContain(`path.join("/src", 'index.html')`)
    expect(main).toContain('"/src/main.js"')
    // electron → tauri-electron; fs → tauri-electron's fs; net → the stub
    // that explains itself; no Node require().
    expect(main).toContain(moduleId('src/index.js'))
    expect(main).toContain(moduleId('src/node/fs.js'))
    expect(main).not.toContain('node-builtin.cjs?fs"') // as a module id
    expect(main).toContain('node-builtin.cjs?net')
    expect(main).toContain('registerNodeModule(') // bundler/main-node.js: fs & co. for require()
    expect(main).toMatch(/__TAURI_ELECTRON_APP__ = .*"entries":\[/) // where the app's files are (DefinePlugin)
    expect(main).toMatch(/const \{ app, BrowserWindow \} = __webpack_require__\(/)
    expect(main).toMatch(/installRequire\)?\(\{ moduleGlobals: true \}\)/) // bundler/main-entry.js
    expect(main).toContain('meta[name="tauri-electron-log"]') // dev: bundler/console-forwarder.js
    expect(main).not.toContain('trackFileDrops()') // renderer bootstrap
  })

  it('runs require(), the renderer bootstrap and the preload before the renderer', async () => {
    await built
    const renderer = read('main_window.js')
    // Text from each module (rspack inlines entry modules, so ids alone do not tell).
    const order = ['requireShim.resolve =', 'trackFileDrops()', "exposeInMainWorld('api'", 'RENDERER_MARKER'].map((text) =>
      renderer.lastIndexOf(text),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(renderer).not.toMatch(/installRequire\)?\(\{ moduleGlobals: true \}\)/)
  })
})

describe('fromForge', () => {
  const rules = [
    { test: /native_modules[/\\].+\.node$/, use: 'node-loader' },
    { test: /\.node$/, use: { loader: '@vercel/webpack-asset-relocator-loader', options: {} } },
    { test: /\.tsx?$/, use: { loader: 'ts-loader' } },
  ]
  const forgeConfig = {
    plugins: [
      { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
      {
        name: 'webpack',
        config: {
          mainConfig: { entry: './src/main.js', module: { rules }, resolve: { extensions: ['.js', '.ts'] } },
          renderer: {
            config: (env, argv) => ({ mode: argv.mode, module: { rules }, resolve: { extensions: ['.js', '.css'] } }),
            entryPoints: [{ name: 'main_window', html: './src/index.html', js: './src/renderer.js', preload: { js: './src/preload.js' } }],
          },
        },
      },
    ],
  }

  it('builds one web config from the Forge webpack plugin options', async () => {
    const config = await fromForge(forgeConfig, { context: fixture, mode: 'production' })
    expect(config.mode).toBe('production')
    expect(config.target).toBe('web')
    expect(config.output).toMatchObject({ path: path.join(fixture, 'dist'), publicPath: '/' })
    expect(config.devServer.port).toBe(1420)
    expect(config.resolve.extensions).toEqual(['.js', '.ts', '.css'])
    // Native-addon loaders do not apply to a webview.
    expect(config.module.rules).toEqual([rules[2]])
    const plugin = config.plugins.at(-1)
    expect(plugin).toBeInstanceOf(TauriElectronPlugin)
    expect(plugin.options).toMatchObject({
      main: ['./src/main.js'],
      pages: [{ name: 'main_window', html: './src/index.html', js: './src/renderer.js', preload: './src/preload.js' }],
    })
  })

  it('builds the fixture from a Forge config', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-electron-forge-'))
    const config = await fromForge(forgeConfig, { context: fixture, mode: 'development', outDir })
    config.module.rules = [] // no ts-loader in this repository
    config.infrastructureLogging = { level: 'error' }
    config.devtool = false
    await compile(webpack, config)
    expect(fs.readFileSync(path.join(outDir, 'electron-main.js'), 'utf8')).toContain('"main_window/index.html"')
    expect(fs.existsSync(path.join(outDir, 'main_window/index.html'))).toBe(true)
  })

  it('says when the Forge config has no webpack plugin', async () => {
    await expect(fromForge({ plugins: [] }, { context: fixture })).rejects.toThrow(/plugin-webpack/)
  })
})
