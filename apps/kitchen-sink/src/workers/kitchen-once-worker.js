// A worker_threads worker that answers once and ends by itself (nothing
// keeps it alive), for the 'exit' check in checks-wave-c-workers-vm.js.
import { parentPort, workerData } from 'node:worker_threads'

setTimeout(() => parentPort.postMessage({ doubled: workerData * 2 }), 10)
