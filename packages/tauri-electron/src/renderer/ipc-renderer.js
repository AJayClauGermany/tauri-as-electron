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
  serializeError,
  NotImplementedError,
} from '../internal/runtime.js'

const label = currentLabel()
const pending = new Map()
let nextInvokeId = 1

export function postToMain(message) {
  return emitTo(MAIN_LABEL, TO_MAIN, { ...message, from: label })
}

class IpcRenderer extends EventEmitter {
  send(channel, ...args) {
    postToMain({ type: 'send', channel: String(channel), args }).catch(report('ipcRenderer.send'))
  }

  invoke(channel, ...args) {
    const id = nextInvokeId++
    const { promise, resolve, reject } = deferred()
    pending.set(id, { resolve, reject, channel })
    postToMain({ type: 'invoke', id, channel: String(channel), args }).catch((error) => {
      pending.delete(id)
      reject(error)
    })
    return promise
  }

  /** Synchronous IPC cannot be expressed over Tauri's async events. */
  sendSync(channel) {
    throw new NotImplementedError(`ipcRenderer.sendSync('${channel}')`, 'use `await ipcRenderer.invoke()` with ipcMain.handle()')
  }

  postMessage(channel, message) {
    this.send(channel, message)
  }

  sendToHost(channel, ...args) {
    this.send(channel, ...args)
  }
}

export const ipcRenderer = new IpcRenderer()

const commandHandlers = {
  navigate: ({ url }) => {
    location.href = url
  },
  reload: () => location.reload(),
  execute: async ({ id, code }) => {
    try {
      // Indirect eval runs in global scope, like Electron's executeJavaScript.
      const result = await (0, eval)(code)
      postToMain({ type: 'lifecycle', name: 'exec-result', data: { id, ok: true, result: result ?? null } })
    } catch (error) {
      postToMain({ type: 'lifecycle', name: 'exec-result', data: { id, ok: false, error: serializeError(error) } })
    }
  },
}

function onMessage(message) {
  if (!message || (message.to && message.to !== label)) return
  switch (message.type) {
    case 'send':
      ipcRenderer.emit(message.channel, { sender: ipcRenderer, senderId: 0, ports: [] }, ...(message.args ?? []))
      break
    case 'invoke-result': {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok) entry.resolve(message.undef ? undefined : message.result)
      else {
        const error = deserializeError(message.error)
        error.message = `Error invoking remote method '${entry.channel}': ${error.message}`
        entry.reject(error)
      }
      break
    }
    case 'command':
      commandHandlers[message.name]?.(message)
      break
  }
}

/** Resolves once this renderer is listening for messages from main. */
export const rendererReady = isRenderer
  ? getCurrentWebviewWindow().listen(TO_RENDERER, ({ payload }) => onMessage(payload))
  : Promise.resolve()
