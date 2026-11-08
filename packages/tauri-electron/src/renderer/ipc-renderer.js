/**
 * ipcRenderer and the renderer side of the IPC bridge.
 * See src/main/ipc-main.js for the protocol.
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emitTo } from '@tauri-apps/api/event'
import { EventEmitter } from '../internal/emitter.js'
import {
  MAIN_LABEL,
  TO_MAIN,
  TO_RENDERER,
  currentLabel,
  deferred,
  deserializeError,
  isRenderer,
  report,
} from '../internal/runtime.js'
import { encode, decode, decodeArgs } from '../internal/serialize.js'
import { syncRequest } from '../internal/native.js'

const label = currentLabel()
const pending = new Map()
let nextInvokeId = 1
let nextPortId = 1

/** Renderer-side ends of ports shared with the main process, by port id. */
const relays = new Map()

export function postToMain(message) {
  return emitTo(MAIN_LABEL, TO_MAIN, { ...message, from: label })
}

function relay(id, port) {
  relays.set(id, port)
  port.onmessage = (event) => {
    let data
    try {
      data = encode(event.data)
    } catch (error) {
      return report('MessagePort message')(error)
    }
    postToMain({ type: 'port-message', port: id, data }).catch(report('MessagePort relay'))
  }
}

/** Ports received from main: a real MessageChannel whose far end is relayed. */
function receivePorts(ids) {
  return (ids ?? []).map((id) => {
    const channel = new MessageChannel()
    relay(id, channel.port2)
    return channel.port1
  })
}

class IpcRenderer extends EventEmitter {
  send(channel, ...args) {
    postToMain({ type: 'send', channel: String(channel), args: encode(args) }).catch(report('ipcRenderer.send'))
  }

  invoke(channel, ...args) {
    const id = nextInvokeId++
    const { promise, resolve, reject } = deferred()
    pending.set(id, { resolve, reject, channel })
    let encoded
    try {
      encoded = encode(args)
    } catch (error) {
      pending.delete(id)
      return Promise.reject(error)
    }
    postToMain({ type: 'invoke', id, channel: String(channel), args: encoded }).catch((error) => {
      pending.delete(id)
      reject(error)
    })
    return promise
  }

  /**
   * Blocks until a main-process listener sets `event.returnValue`, like
   * Electron. Uses tauri-plugin-electron's synchronous bridge; without the
   * plugin it falls back to an async send() and returns undefined.
   */
  sendSync(channel, ...args) {
    const body = JSON.stringify({ channel: String(channel), args: encode(args) })
    let response
    try {
      response = syncRequest('sync-ipc', body)
    } catch (error) {
      console.warn(`[tauri-electron] ipcRenderer.sendSync('${channel}') needs tauri-plugin-electron; sent asynchronously instead.`, error)
      this.send(channel, ...args)
      return undefined
    }
    if (response.status !== 200) throw new Error(`ipcRenderer.sendSync('${channel}') failed: ${response.status} ${response.text}`)
    return decode(JSON.parse(response.text))
  }

  /** Transfer DOM MessagePorts to the main process (event.ports there). */
  postMessage(channel, message, transfer = []) {
    const ids = transfer.map((port) => {
      if (!(port instanceof MessagePort)) throw new TypeError('Only MessagePort objects can be transferred')
      const id = `${label}:${nextPortId++}`
      relay(id, port)
      return id
    })
    postToMain({ type: 'send', channel: String(channel), args: encode([message]), ports: ids }).catch(report('ipcRenderer.postMessage'))
  }

  sendToHost(channel, ...args) {
    this.send(channel, ...args)
  }
}

export const ipcRenderer = new IpcRenderer()

/** Handlers for commands sent by the main process (navigation, executeJavaScript, ...). */
export const commandHandlers = {
  navigate: ({ url }) => {
    location.href = url
  },
  reload: () => location.reload(),
  execute: async ({ id, code }) => {
    let data
    try {
      // Indirect eval runs in global scope, like Electron's executeJavaScript.
      const result = await (0, eval)(code)
      data = { id, ok: true, result: encode(result) }
    } catch (error) {
      data = { id, ok: false, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack } }
    }
    postToMain({ type: 'lifecycle', name: 'exec-result', data })
  },
}

function onMessage(message) {
  if (!message || (message.to && message.to !== label)) return
  switch (message.type) {
    case 'send':
      ipcRenderer.emit(message.channel, { sender: ipcRenderer, senderId: 0, ports: receivePorts(message.ports) }, ...decodeArgs(message.args))
      break
    case 'invoke-result': {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok) entry.resolve(decode(message.result))
      else {
        const error = deserializeError(message.error)
        // Electron stringifies the remote error: "...: Error: boom".
        error.message = `Error invoking remote method '${entry.channel}': ${error.name}: ${error.message}`
        entry.reject(error)
      }
      break
    }
    case 'port-message':
      relays.get(message.port)?.postMessage(decode(message.data))
      break
    case 'port-close':
      relays.get(message.port)?.close()
      relays.delete(message.port)
      break
    case 'command':
      commandHandlers[message.name]?.(message)
      break
  }
}

/** Resolves once this renderer is listening for messages from main. */
export const rendererReady = isRenderer
  ? getCurrentWebviewWindow().listen(TO_RENDERER, ({ payload }) => onMessage(payload))
  : Promise.resolve()
