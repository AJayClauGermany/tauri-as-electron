// Preload: the only bridge between the pages and the main process.
// (.mjs so that real Electron loads it as an ES module with sandbox: false.)
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('kitchen', {
  // Main-process checks
  listMainChecks: () => ipcRenderer.invoke('kitchen:list'),
  runMainCheck: (id) => ipcRenderer.invoke('kitchen:run', id),
  report: (results) => ipcRenderer.invoke('kitchen:report', results),

  // Raw IPC helpers used by the renderer-side checks
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  once: (channel, callback) => ipcRenderer.once(channel, (_event, ...args) => callback(...args)),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),

  // Child window
  onChildPing: (callback) => ipcRenderer.on('kitchen:child-ping', (_event, value) => callback(value)),
  childPong: (value) => ipcRenderer.send('kitchen:child-pong', value),

  // Context menu
  showContextMenu: (x, y) => ipcRenderer.send('kitchen:context-menu', x, y),
})
