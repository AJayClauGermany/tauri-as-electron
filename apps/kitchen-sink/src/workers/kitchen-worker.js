// A worker_threads worker for the wave C checks (checks-wave-c-workers-vm.js).
// Runs unchanged on Electron (a Node worker thread) and on Tauri (a Web
// Worker with tauri-electron's Node layer). Answers `{ id, op, args }`
// requests with `{ id, ok, value | error }`.
import { parentPort, workerData, isMainThread, threadId, getEnvironmentData } from 'node:worker_threads'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { exec } from 'node:child_process'
import { Buffer } from 'node:buffer'

const handlers = {
  hello: () => ({
    isMainThread,
    threadId,
    workerData,
    env: process.env.KITCHEN_WORKER ?? null,
    argv: process.argv.slice(2),
    environment: getEnvironmentData('kitchen') ?? null,
  }),
  readSync: ({ file }) => fs.readFileSync(file, 'utf8'),
  readAsync: ({ file }) => fs.promises.readFile(file, 'utf8'),
  writeSync: ({ file, text }) => {
    fs.writeFileSync(file, text)
    return 'written'
  },
  hostname: () => os.hostname(),
  hash: ({ text }) => crypto.createHash('sha256').update(text).digest('hex'),
  base64: ({ text }) => Buffer.from(text).toString('base64'),
  exec: () => new Promise((resolve) => exec('echo kitchen', (error, stdout) => resolve(error ? `error: ${error.message}` : stdout.trim()))),
  port: ({ port }) => {
    port.on('message', (value) => port.postMessage({ echoed: value }))
    return 'listening'
  },
  log: ({ text }) => {
    console.log(text)
    return 'logged'
  },
  exit: ({ code }) => process.exit(code),
  throwLater: ({ message }) => {
    setTimeout(() => {
      throw new Error(message)
    }, 0)
    return 'scheduled'
  },
}

parentPort.on('message', async ({ id, op, args }) => {
  try {
    parentPort.postMessage({ id, ok: true, value: await handlers[op](args ?? {}) })
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) })
  }
})

parentPort.postMessage({ ready: true })
