// Hosts tauri-electron's worker side (src/worker/bootstrap.js + runtime.js)
// in a Node worker thread made to look like a dedicated Web Worker:
// `self`, WorkerGlobalScope, addEventListener('message') with MessageEvents
// (data + ports), postMessage, close, and a synchronous XMLHttpRequest that
// answers tauri-plugin-electron's bridge from a small table. Used by
// test/roadmap-wave-c-workers-vm.test.js through a fake Web Worker.
import { parentPort, workerData } from 'node:worker_threads'

const nodeProcess = process
const target = new EventTarget()
const isPort = (value) => value instanceof MessagePort

globalThis.self = globalThis
globalThis.WorkerGlobalScope = class WorkerGlobalScope {
  static [Symbol.hasInstance](value) {
    return value === globalThis
  }
}
globalThis.addEventListener = target.addEventListener.bind(target)
globalThis.removeEventListener = target.removeEventListener.bind(target)
globalThis.dispatchEvent = target.dispatchEvent.bind(target)
globalThis.postMessage = (data, transfer = []) => parentPort.postMessage({ data, ports: transfer.filter(isPort) }, transfer)
globalThis.close = () => {
  parentPort.postMessage({ closed: true })
  setTimeout(() => nodeProcess.exit(0), 20)
}
globalThis.location = { href: 'http://harness.localhost/worker-entry.js', origin: 'http://harness.localhost' }
// A webview has no Node `process`: tauri-electron's shim takes the place of
// this stand-in (readable-stream only takes nextTick from it, as from the
// `process` npm polyfill a bundler gives it).
globalThis.process = { nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)), env: {} }

// The synchronous bridge: `node/<module>/<op>` requests answered from a table.
const bridge = { 'node/os/info': JSON.stringify({ hostname: 'harness-host' }) }
globalThis.__bridgeRequests = []
globalThis.XMLHttpRequest = class XMLHttpRequest {
  open(method, url, async) {
    this.method = method
    this.url = url
    this.async = async
  }
  overrideMimeType() {}
  send() {
    globalThis.__bridgeRequests.push(this.url)
    const path = decodeURIComponent(new URL(this.url).pathname.slice(1))
    this.status = path in bridge ? 200 : 404
    this.responseText = bridge[path] ?? ''
  }
}

parentPort.on('message', ({ data, ports }) => target.dispatchEvent(new MessageEvent('message', { data, ports })))

const fixtures = new URL('./workers/', import.meta.url)
const { start } = await import('../../src/worker/bootstrap.js')
start(() =>
  import('../../src/worker/runtime.js').then((runtime) =>
    runtime.run((path) => (workerData?.entries?.includes(path) ? import(new URL(`.${path}`, fixtures).href) : undefined)),
  ),
)
