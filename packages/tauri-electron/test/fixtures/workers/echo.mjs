// A worker script for test/fixtures/web-worker-host.mjs. In an app the
// bundler aliases `worker_threads`, `os` and `fs`; here they are imported
// from tauri-electron directly. Answers `{ id, op, args }` with `{ id, ok, value | error }`.
import { parentPort, workerData, isMainThread, threadId, getEnvironmentData } from '../../../src/node/worker-threads.js'
import os from '../../../src/node/os.js'
import fs from '../../../src/node/fs.js'
import { Channel, invoke } from '@tauri-apps/api/core'

const handlers = {
  hello: () => ({
    isMainThread,
    threadId,
    workerData,
    env: process.env.HARNESS ?? null,
    argv: process.argv.slice(2),
    environment: getEnvironmentData('answer') ?? null,
    hasRequire: typeof require === 'function',
    bufferGlobal: typeof Buffer === 'function',
  }),
  hostname: () => os.hostname(),
  bridgeRequests: () => globalThis.__bridgeRequests,
  readAsync: ({ file }) => fs.promises.readFile(file, 'utf8'),
  stream: () =>
    new Promise((resolve, reject) => {
      const seen = []
      const channel = new Channel((message) => {
        seen.push(message)
        if (seen.length === 2) resolve(seen)
      })
      invoke('plugin:test|stream', { onEvent: channel }).catch(reject)
    }),
  port: ({ port }) => {
    port.on('message', (value) => port.postMessage({ echoed: value }))
    return 'listening'
  },
  log: ({ text }) => {
    console.log(text)
    console.error(`err:${text}`)
    return 'logged'
  },
  exit: ({ code }) => process.exit(code),
  throwLater: ({ message }) => {
    setTimeout(() => {
      throw new Error(message)
    }, 0)
    return 'scheduled'
  },
  stop: () => {
    setTimeout(() => parentPort.removeAllListeners('message'), 0)
    return 'stopping'
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
