#!/usr/bin/env node
/**
 * Ship a Node.js runtime with a Tauri app, for `utilityProcess.fork()` and
 * `child_process.fork()` (tauri-plugin-electron's `node-child-process`
 * feature runs them on it).
 *
 *   npx tauri-electron-node-sidecar [--from <node binary>] [--target <triple>] [--name <name>] [--project <dir>]
 *
 * Copies a Node.js binary (default: the one running this script) to
 * `src-tauri/binaries/<name>-<target triple>[.exe]` and adds
 * `binaries/<name>` to `bundle.externalBin` in `src-tauri/tauri.conf.json`.
 * Tauri then puts it next to the app's executable as `<name>`, in
 * development builds too. `<name>` defaults to `<Cargo package>-node`, which
 * tauri-plugin-electron looks for first: a plain `node` would collide with
 * the system's in Linux packages (`/usr/bin/node`).
 *
 * The target triple defaults to the host's (`rustc -vV`); for another
 * platform pass `--target` and `--from` with that platform's Node.js (from
 * https://nodejs.org/dist/). Run it again for each target you build.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: tauri-electron-node-sidecar [--from <node binary>] [--target <triple>] [--name <name>] [--project <dir>]')
  process.exit(0)
}

const project = path.resolve(option('project') ?? '.')
const tauriDir = path.join(project, 'src-tauri')
const confFile = path.join(tauriDir, 'tauri.conf.json')
if (!fs.existsSync(confFile)) {
  console.error(`No src-tauri/tauri.conf.json in ${project}: run this in the app's folder (or pass --project).`)
  process.exit(1)
}

function cargoPackageName() {
  try {
    const manifest = fs.readFileSync(path.join(tauriDir, 'Cargo.toml'), 'utf8')
    const pkg = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(manifest)
    return pkg?.[1] ?? null
  } catch {
    return null
  }
}

function hostTriple() {
  try {
    return /^host:\s*(\S+)/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1] ?? null
  } catch {
    return null
  }
}

const target = option('target') ?? hostTriple()
if (!target) {
  console.error('Could not tell the target triple (is rustc on PATH?): pass --target, e.g. --target x86_64-unknown-linux-gnu')
  process.exit(1)
}
const crate = cargoPackageName()
const name = option('name') ?? (crate ? `${crate}-node` : 'node')
const from = path.resolve(option('from') ?? process.execPath)
if (!fs.existsSync(from)) {
  console.error(`No Node.js binary at ${from}`)
  process.exit(1)
}

const exe = target.includes('windows') ? '.exe' : ''
const binaries = path.join(tauriDir, 'binaries')
const destination = path.join(binaries, `${name}-${target}${exe}`)
fs.mkdirSync(binaries, { recursive: true })
fs.copyFileSync(from, destination)
fs.chmodSync(destination, 0o755)

const conf = JSON.parse(fs.readFileSync(confFile, 'utf8'))
conf.bundle ??= {}
const externalBin = new Set(conf.bundle.externalBin ?? [])
const entry = `binaries/${name}`
if (!externalBin.has(entry)) {
  conf.bundle.externalBin = [...externalBin, entry]
  fs.writeFileSync(confFile, JSON.stringify(conf, null, 2) + '\n')
}

const size = (fs.statSync(destination).size / 1024 / 1024).toFixed(0)
console.log(`Node.js ${from} (${size} MB) → ${path.relative(project, destination)}`)
console.log(`bundle.externalBin in src-tauri/tauri.conf.json lists "${entry}".`)
console.log('Consider adding src-tauri/binaries/ to .gitignore.')
