/**
 * ipcMain plus the main side of the IPC bridge.
 *
 * Renderers emit `tauri-electron:to-main` events targeted at the hidden
 * main window; replies and webContents.send() messages travel back as
 * `tauri-electron:to-renderer` events targeted at the sender's window.
 * Payloads are JSON (not structured clone), so send plain data.
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emitTo } from '@tauri-apps/api/event'
import { EventEmitter } from '../internal/emitter.js'
import { TO_MAIN, TO_RENDERER, report, serializeError } from '../internal/runtime.js'
import { webContentsFromLabel } from './browser-window.js'

class IpcMain extends EventEmitter {
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
  return {
    id: -1,
    _label: label,
    send: (channel, ...args) =>
      emitTo(label, TO_RENDERER, { type: 'send', channel, args, to: label }).catch(report('reply')),
    isDestroyed: () => false,
    getURL: () => '',
  }
}

function replyInvoke(label, id, body) {
  return emitTo(label, TO_RENDERER, { type: 'invoke-result', id, to: label, ...body }).catch(report('invoke reply'))
}

async function dispatch(message) {
  const sender = webContentsFromLabel(message.from) ?? anonymousSender(message.from)
  switch (message.type) {
    case 'send': {
      const event = {
        sender,
        senderFrame: null,
        frameId: 0,
        processId: 0,
        ports: [],
        returnValue: undefined,
        reply: (channel, ...args) => sender.send(channel, ...args),
      }
      ipcMain.emit(message.channel, event, ...(message.args ?? []))
      break
    }
    case 'invoke': {
      const handler = ipcMain._handlers.get(message.channel)
      if (!handler) {
        replyInvoke(message.from, message.id, {
          ok: false,
          error: { name: 'Error', message: `No handler registered for '${message.channel}'` },
        })
        return
      }
      try {
        const event = { sender, senderFrame: null, frameId: 0, processId: 0 }
        const result = await handler(event, ...(message.args ?? []))
        replyInvoke(message.from, message.id, { ok: true, result: result ?? null, undef: result === undefined })
      } catch (error) {
        replyInvoke(message.from, message.id, { ok: false, error: serializeError(error) })
      }
      break
    }
    case 'lifecycle':
      sender._onLifecycle?.(message.name, message.data)
      break
    default:
      console.warn('[tauri-electron] unknown IPC message', message)
  }
}

let bridge
/** Start listening for renderer messages. Resolves once the listener is live. */
export function startMainBridge() {
  bridge ??= getCurrentWebviewWindow().listen(TO_MAIN, ({ payload }) => {
    dispatch(payload).catch(report('IPC dispatch'))
  })
  return bridge
}
