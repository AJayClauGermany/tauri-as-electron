#!/usr/bin/env node
// Builds the kitchen sink (debug, no bundle), launches it, waits for the
// renderer to run every automatic check and prints the results.
//
//   npm run smoke                 # build + run
//   npm run smoke -- --no-build   # reuse the last smoke build
//   npm run smoke -- --json out.json
//   npm run smoke -- --electron   # run the same app on real Electron instead
//                                 # (uses $ELECTRON_PATH or `npx electron`)
//
// Exit code is 1 if any check *failed*; "unsupported" checks are expected.
// On Linux without a display it uses `xvfb-run` when available.
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const port = Number(process.env.KITCHEN_SMOKE_PORT ?? 17321)
const smokeUrl = `http://127.0.0.1:${port}/report`
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const electron = args.includes('--electron')

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', ...options })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))))
    child.on('error', reject)
  })
}

function binaryPath() {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: path.join(root, 'src-tauri') }))
  const exe = process.platform === 'win32' ? 'kitchen-sink.exe' : 'kitchen-sink'
  return path.join(metadata.target_directory, 'debug', exe)
}

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!electron && !args.includes('--no-build')) {
  await run('npx', ['tauri', 'build', '--debug', '--no-bundle'], {
    env: { ...process.env, VITE_KITCHEN_SMOKE_URL: smokeUrl },
  })
}

const report = new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end()
      server.close()
      resolve(JSON.parse(body))
    })
  })
  server.listen(port, '127.0.0.1')
})

let launch
if (electron) {
  const electronArgs = ['.']
  // Chromium refuses to run as root without this.
  if (process.platform === 'linux' && process.getuid?.() === 0) electronArgs.push('--no-sandbox')
  launch = process.env.ELECTRON_PATH ? [process.env.ELECTRON_PATH, electronArgs] : ['npx', ['--yes', 'electron', ...electronArgs]]
} else {
  launch = [binaryPath(), []]
}
const useXvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && hasCommand('xvfb-run')
const [command, commandArgs] = useXvfb ? ['xvfb-run', ['-a', ...launch.flat()]] : launch
console.log(`\n> ${command} ${commandArgs.join(' ')}`)
const app = spawn(command, commandArgs, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, KITCHEN_SMOKE_URL: smokeUrl },
})

const timeout = setTimeout(() => {
  console.error('Timed out waiting for the kitchen sink report')
  app.kill()
  process.exit(2)
}, 180_000)

const data = await report
clearTimeout(timeout)
setTimeout(() => app.kill(), 2000).unref()

if (data.error) {
  console.error(`Kitchen sink reported an error: ${data.error}`)
  process.exit(2)
}

const results = data.results
console.log(`\nRuntime: ${data.runtime}`)
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2))
const width = Math.max(...results.map((r) => r.id.length))
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.id.padEnd(width)}  ${String(r.detail ?? '').slice(0, 100)}`)
}
const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})
console.log('\n' + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '))
process.exit(counts.fail ? 1 : 0)
