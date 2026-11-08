# Porting an Electron app

This guide assumes your Electron code already uses ES module syntax in its
source (true for electron-vite, Electron Forge's Vite template and most
bundled projects). If it uses `require()`, convert those to `import`s first.

## 1. Start from the template

Copy [`templates/tauri-electron-app`](../templates/tauri-electron-app) and
drop your code into it:

| Electron project | Template |
| --- | --- |
| main process entry (`main.js`) | `src/main.js` (loaded by `electron-main.html`) |
| preload script | `src/preload.js` (path set in `vite.config.js`) |
| renderer pages (`index.html`, …) | project root; every root-level `*.html` is built |
| renderer scripts / styles | anywhere; reference them from the HTML |
| `package.json` `name`/`productName`/`version` | `src-tauri/tauri.conf.json` (`productName`, `version`, `identifier`) |
| app icons | `npx tauri icon path/to/icon.png` |

Outside this monorepo, point the `tauri-electron` dependency at wherever you
keep the package (`file:`, a git URL, or a registry once published).

## 2. Keep importing `electron`

The Vite plugin aliases `electron`, `electron/main`, `electron/renderer`,
`electron/common`, `path` and `node:path`. Nothing to change in
`import { app, BrowserWindow } from 'electron'`.

`__dirname`, `__filename`, `import.meta.dirname` and `import.meta.filename`
are rewritten to project-relative paths at build time, so
`win.loadFile(path.join(__dirname, 'index.html'))` keeps working.
`loadURL('https://…')` works too.

## 3. Adjust the few things that differ

| In Electron | Do this |
| --- | --- |
| Renderer `<script>` without `type="module"` | Add `type="module"` (Vite only bundles module scripts). |
| `ipcRenderer.sendSync` / `event.returnValue` | Use `ipcRenderer.invoke` + `ipcMain.handle`. |
| `dialog.show*Sync` | Use the async versions (`await dialog.showOpenDialog()`). |
| `clipboard.readText()` used synchronously | `await clipboard.readText()` (also the current Electron API). |
| `screen.getCursorScreenPoint()` | `await screen.getCursorScreenPoint()`. |
| IPC payloads with `Date`, `Map`, `Uint8Array`, class instances | Electron uses structured clone; here payloads are JSON. Send plain data. |
| `fs`, `child_process`, other Node built-ins in main | Not available (the main process is a webview). Use Tauri plugins such as `@tauri-apps/plugin-fs` / `plugin-shell`, or a Rust command. |
| Renderers calling privileged APIs directly | Renderers only get IPC permissions. Route through the main process, or add permissions to `src-tauri/capabilities/renderer.json`. |
| `webContents.openDevTools()` | Right-click → Inspect in debug builds. |
| Main-process `console.log` | Printed in the `tauri dev` terminal, prefixed `[electron-main]`. |

## 4. Run it

```bash
npm run dev     # tauri dev
```

```bash
npm run build   # tauri build
```

If something misbehaves, look for `[tauri-electron]` warnings: unsupported
calls either warn once (no-ops) or throw a `NotImplementedError` naming the
API. [API-COVERAGE.md](API-COVERAGE.md) lists the gaps, and the kitchen sink
shows how each API behaves on both runtimes.
