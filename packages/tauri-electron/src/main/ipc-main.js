/**
 * ipcMain plus the main side of the IPC bridge.
 *
 * Renderers emit `tauri-electron:to-main` events targeted at the hidden
 * main window; replies and webContents.send() messages travel back as
 * `tauri-electron:to-renderer` events targeted at the sender's window.
 * Payloads go through a structured-clone-like encoding
 * (src/internal/serialize.js), so Uint8Array, Date, Map, Error, ... survive.
 *
 * Like Electron, a message is emitted on the sender's `webContents.ipc`
 * first and then on `ipcMain`; `invoke` prefers a handler registered on
 * `webContents.ipc`. `ipcRenderer.sendSync` arrives through
 * tauri-plugin-electron's synchronous bridge.
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emitTo } from '@tauri-apps/api/event'
import { EventEmitter } from '../internal/emitter.js'
import { TO_MAIN, TO_RENDERER, report, serializeError } from '../internal/runtime.js'
import { encode, decode, decodeArgs } from '../internal/serialize.js'
import { onBridgeRequest, startBridgeListener } from '../internal/native.js'
import { webContentsFromLabel } from './browser-window.js'
import { MessagePortMain, onRendererPortMessage } from './message-ports.js'

export class IpcMain extends EventEmitter {
  constructor() {
    super()
    Object.defineProperty(this, '_handlers', { value: new Map() })
  }

  handle(channel, handler) {
    if (this._handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this._handlers.set(channel, handler)
  }

  handleOnce(channel, handler) {
    this.handle(channel, (event, ...args) => {
      this.removeHandler(channel)
      return handler(event, ...args)
    })
  }

  removeHandler(channel) {
    this._handlers.delete(channel)
  }
}

export const ipcMain = new IpcMain()

/** Fallback sender for windows that were not created through BrowserWindow. */
function anonymousSender(label) {
  const sender = {
    id: -1,
    _label: label,
    ipc: null,
    send: (channel, ...args) =>
      emitTo(label, TO_RENDERER, { type: 'send', channel, args: encode(args), to: label }).catch(report('reply')),
    isDestroyed: () => false,
    getURL: () => '',
    getProcessId: () => 0,
  }
  sender.mainFrame = { url: '', origin: '', routingId: -1, processId: 0, frameTreeNodeId: -1, name: '', top: null, parent: null, frames: [], send: sender.send }
  return sender
}

function replyInvoke(label, id, body) {
  return emitTo(label, TO_RENDERER, { type: 'invoke-result', id, to: label, ...body }).catch(report('invoke reply'))
}

function baseEvent(sender) {
  const event = {
    type: 'frame',
    sender,
    senderFrame: sender.mainFrame ?? null,
    frameId: sender.mainFrame?.routingId ?? 0,
    processId: sender.getProcessId?.() ?? 0,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    },
  }
  return event
}

/** Emit on webContents.ipc first, then on ipcMain (Electron's order). */
function emitIpc(sender, channel, event, args) {
  sender.ipc?.emit(channel, event, ...args)
  ipcMain.emit(channel, event, ...args)
}

function listened(sender, channel) {
  return (sender.ipc?.listenerCount(channel) ?? 0) + ipcMain.listenerCount(channel) > 0
}

async function dispatch(message) {
  const sender = webContentsFromLabel(message.from) ?? anonymousSender(message.from)
  switch (message.type) {
    case 'send': {
      const event = baseEvent(sender)
      event.ports = (message.ports ?? []).map((id) => MessagePortMain._fromRenderer(message.from, id))
      event.returnValue = undefined
      event.reply = (channel, ...args) => sender.send(channel, ...args)
      emitIpc(sender, message.channel, event, decodeArgs(message.args))
      break
    }
    case 'invoke': {
      const handler = sender.ipc?._handlers?.get(message.channel) ?? ipcMain._handlers.get(message.channel)
      if (!handler) {
        replyInvoke(message.from, message.id, {
          ok: false,
          error: { name: 'Error', message: `No handler registered for '${message.channel}'` },
        })
        return
      }
      try {
        const result = await handler(baseEvent(sender), ...decodeArgs(message.args))
        replyInvoke(message.from, message.id, { ok: true, result: encode(result) })
      } catch (error) {
        replyInvoke(message.from, message.id, { ok: false, error: serializeError(error) })
      }
      break
    }
    case 'port-message':
    case 'port-close':
      onRendererPortMessage(message)
      break
    case 'lifecycle':
      sender._onLifecycle?.(message.name, message.data)
      break
    default:
      console.warn('[tauri-electron] unknown IPC message', message)
  }
}

const SYNC_WAIT_MS = 25_000

/** ipcRenderer.sendSync(): resolves once a listener sets event.returnValue. */
function dispatchSync({ from, body }) {
  const { channel, args } = JSON.parse(body)
  const sender = webContentsFromLabel(from) ?? anonymousSender(from)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let payload
      try {
        payload = JSON.stringify(encode(value))
      } catch (error) {
        payload = JSON.stringify(encode(undefined))
        report(`sendSync('${channel}') returnValue`)(error)
      }
      resolve({ status: 200, headers: [['content-type', 'application/json']], body: payload })
    }
    const timer = setTimeout(() => {
      console.warn(`[tauri-electron] ipcRenderer.sendSync('${channel}'): no event.returnValue after ${SYNC_WAIT_MS / 1000}s`)
      finish(undefined)
    }, SYNC_WAIT_MS)
    let returnValue
    let assigned = false
    const event = baseEvent(sender)
    event.ports = []
    Object.defineProperty(event, 'returnValue', {
      enumerable: true,
      get: () => returnValue,
      set: (value) => {
        returnValue = value
        assigned = true
        finish(value)
      },
    })
    event.reply = (replyChannel, ...replyArgs) => sender.send(replyChannel, ...replyArgs)
    if (!listened(sender, channel)) {
      console.warn(`[tauri-electron] ipcRenderer.sendSync('${channel}') has no ipcMain listener`)
      return finish(undefined)
    }
    try {
      emitIpc(sender, channel, event, decodeArgs(args))
    } catch (error) {
      report(`ipcMain '${channel}' listener`)(error)
      if (!assigned) finish(undefined)
    }
  })
}

let bridge
/** Start listening for renderer messages. Resolves once the listener is live. */
export function startMainBridge() {
  onBridgeRequest('sync-ipc', dispatchSync)
  bridge ??= Promise.all([
    getCurrentWebviewWindow().listen(TO_MAIN, ({ payload }) => {
      dispatch(payload).catch(report('IPC dispatch'))
    }),
    startBridgeListener(),
  ])
  return bridge
}
