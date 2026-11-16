// Electron main process starting worker_threads workers the two usual ways.
import { Worker } from 'node:worker_threads'
import path from 'node:path'

globalThis.startWorkers = {
  byPath: () => new Worker(path.join(__dirname, 'worker.js'), { workerData: 1 }),
  byUrl: () => new Worker(new URL('./url-worker.js', import.meta.url)),
}
