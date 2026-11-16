const { parentPort } = require('worker_threads')

parentPort.postMessage('URL_WORKER_MARKER')
