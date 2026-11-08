# tauri-electron

Electron's JavaScript API implemented on Tauri v2 and its official plugins.
Alias `electron` to this package and keep writing Electron code.

```js
// vite.config.js
import { defineConfig } from 'vite'
import tauriElectron from 'tauri-electron/vite'

export default defineConfig({
  plugins: [tauriElectron({ preload: 'src/preload.js' })],
})
```

The plugin:

- aliases `electron` (+ `electron/main|renderer|common`) to this package and
  `path` / `node:path` to `tauri-electron/path`;
- rewrites `__dirname`, `__filename`, `import.meta.dirname`,
  `import.meta.filename` to project-relative paths;
- injects the renderer bootstrap and your preload at the top of every page
  except `electron-main.html`;
- adds every root-level `*.html` to the build inputs;
- in dev, prints the hidden main window's console in the terminal.

Options: `preload` (string or array), `mainHtml` (default
`electron-main.html`), `aliasPath` (default `true`), `forwardMainConsole`
(default `true`).

The Tauri side needs the plugins registered in `lib.rs`, the
`electron-main` hidden window in `tauri.conf.json`, and the two capability
files — see [the template](../../templates/tauri-electron-app/src-tauri).

## Layout

```
src/index.js            all exports (main + renderer, like Electron)
src/main/               app, BrowserWindow/webContents, ipcMain, dialog, Menu, Tray, ...
src/renderer/           ipcRenderer, contextBridge, webFrame, bootstrap (page lifecycle)
src/internal/           event emitter, runtime detection, accelerator conversion
src/path.js             node:path (POSIX) for the browser
src/process.js          process.platform & friends
vite.js                 the Vite plugin
```

See [API-COVERAGE.md](../../docs/API-COVERAGE.md) for what is implemented.
