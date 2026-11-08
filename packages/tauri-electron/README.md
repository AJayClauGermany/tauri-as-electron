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

Install it from this repository (not on npm yet):

```bash
npm install tauri-electron@github:AJayClauGermany/tauri-as-electron
```

The plugin:

- aliases `electron` (+ `electron/main|renderer|common`) to this package and
  `path`, `process`, `events`, `url` (with or without `node:`) to
  `tauri-electron/path|process|events|url`;
- provides `require()` for those modules in CommonJS main and preload scripts
  (`tauri-electron/require`), and turns imports of other Node built-ins
  (`fs`, `child_process`, …) into a runtime `NotImplementedError` naming the
  replacement instead of a build error;
- rewrites `__dirname`, `__filename`, `import.meta.dirname`,
  `import.meta.filename` and `fileURLToPath(import.meta.url)` to
  project-relative paths;
- loads the renderer bootstrap and your preload at the top of every page
  except `electron-main.html`, as an external module script (pages with a
  `script-src 'self'` CSP keep working);
- gives classic `<script src>` tags `type="module"` so Vite bundles them;
- makes `process.env` read the real environment instead of Vite's `{}`;
- adds every root-level `*.html` to the build inputs;
- in dev, prints the hidden main window's console in the terminal.

Options: `preload` (string or array), `mainHtml` (default
`electron-main.html`), `aliasPath` (default `true`), `require` (default
`true`), `moduleScripts` (default `true`), `forwardMainConsole` (default
`true`).

The Tauri side needs [`tauri-plugin-electron`](../../crates/tauri-plugin-electron)
(which registers the official plugins and grants the capabilities) and the
`electron-main` hidden window in `tauri.conf.json` — see
[the template](../../templates/tauri-electron-app/src-tauri).

## Layout

```
src/index.js            all exports (main + renderer, like Electron)
src/main/               app, BrowserWindow/webContents, ipcMain, MessageChannelMain, dialog, Menu,
                        Tray, net, session, protocol, autoUpdater, powerMonitor, ...
src/renderer/           ipcRenderer, contextBridge, webFrame, webUtils, bootstrap (page-side behaviour)
src/internal/           event emitter, runtime detection, accelerators, IPC serialization,
                        tauri-plugin-electron bindings (native.js)
src/path.js             node:path (POSIX) for the browser
src/process.js          process.platform & friends
src/require.js          require() for CommonJS Electron code; stubs for Node built-ins
src/events.js           node:events (EventEmitter, once)
src/url.js              node:url (fileURLToPath, pathToFileURL, parse, format)
vite.js                 the Vite plugin
```

See [API-COVERAGE.md](../../docs/API-COVERAGE.md) for what is implemented.

## Errors

Anything unavailable throws a `NotImplementedError` whose `reason` says why:
`unimplemented` (Tauri could do it, nobody wrote it), `unsupported` (no Tauri
or WebKit equivalent, not planned), `feature` (a Cargo feature of
tauri-plugin-electron is off), `plugin` (tauri-plugin-electron is not
registered) or `permission` (Tauri's capability model refused the command,
usually a main-process API called from a renderer). No-ops warn once with a
`[tauri-electron]` prefix. [MIGRATING.md](../../docs/MIGRATING.md#6-reading-errors)
has the table.
