// Answers once, then has nothing left to do: the worker ends by itself.
import { parentPort, workerData } from '../../../src/node/worker-threads.js'

setTimeout(() => parentPort.postMessage({ doubled: workerData * 2 }), 5)
