// Electron preload script: expose a small, explicit API to the page.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  versions: () => ipcRenderer.invoke('app:versions'),
  ping: (message) => ipcRenderer.invoke('app:ping', message),
  setTitle: (title) => ipcRenderer.send('app:set-title', title),
  onHello: (callback) => ipcRenderer.on('main:hello', (_event, message) => callback(message)),
})
