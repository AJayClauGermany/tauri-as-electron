/**
 * The IPC handler through which a page announces a desktop getUserMedia()
 * (see ./display-media.js), in the main process. Imported last by
 * src/index.js: ipc-main.js and display-media.js import each other
 * indirectly, so ipcMain only exists once the rest has been evaluated.
 */
import { isMainProcess } from '../internal/runtime.js'
import { ipcMain } from './ipc-main.js'
import { DESKTOP_CAPTURE_CHANNEL, noteDesktopCapture } from './display-media.js'

if (isMainProcess) {
  ipcMain._handlers.set(DESKTOP_CAPTURE_CHANNEL, (event, request) => noteDesktopCapture(event.sender?._label ?? event.sender?.id, request))
}
