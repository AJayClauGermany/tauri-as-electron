import { parentPort } from 'node:worker_threads'
import fs from 'fs'

parentPort.postMessage(['WORKER_SCRIPT_MARKER', typeof fs.readFileSync])
