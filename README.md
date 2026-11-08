# tauri-as-electron

Run Electron-style apps on [Tauri v2](https://v2.tauri.app) by treating
[Electron's API](https://www.electronjs.org/docs/latest/api/app) as the
interface and implementing it on top of Tauri and its official plugins.
The goal: moving an Electron project means aliasing `electron` and changing
very little code.

```js
// src/main.js — unchanged Electron code, running on Tauri
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 640 })
  win.loadFile(path.join(import.meta.dirname, '../index.html'))
})
ipcMain.handle('ping', () => 'pong')
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

## What's in the repo

| Path | What it is |
| --- | --- |
| [`packages/tauri-electron`](packages/tauri-electron) | The library. `import … from 'electron'` resolves here. Includes a Vite plugin (`tauri-electron/vite`) that sets everything up. |
| [`templates/tauri-electron-app`](templates/tauri-electron-app) | Starter template: an Electron-shaped project (main / preload / renderer) that builds as a Tauri app. Copy it to start or to port an app. |
| [`apps/kitchen-sink`](apps/kitchen-sink) | Exercises ~100 Electron APIs. Runs unchanged on **both** Tauri and real Electron, so you can compare behaviour side by side. |
| [`docs/MIGRATING.md`](docs/MIGRATING.md) | Step-by-step guide for porting an Electron app. |
| [`docs/API-COVERAGE.md`](docs/API-COVERAGE.md) | What is implemented, partial, or missing, and the behavioural differences. |

No UI framework is assumed: the template and kitchen sink are plain HTML,
CSS and JavaScript. Vite is used only as the bundler (it is what lets
`electron` be aliased).

## How it works

Electron has a Node *main process* plus one *renderer* per window. Tauri
runs JavaScript only inside webviews, so:

- Your **main-process code runs in a hidden window** (label `electron-main`,
  page `electron-main.html`). `new BrowserWindow()` there creates Tauri
  `WebviewWindow`s.
- **IPC** (`ipcMain` / `ipcRenderer` / `webContents.send`) is carried over
  Tauri events addressed to specific windows. Payloads are JSON.
- **Preload scripts** are injected by the Vite plugin at the top of every
  page, before your renderer code. `contextBridge.exposeInMainWorld` assigns
  to `window`.
- **Capabilities mirror Electron's security model**: the hidden main window
  may use all APIs; renderer windows may only exchange IPC messages (see
  `src-tauri/capabilities/`).
- Electron APIs that are **synchronous** but async in Tauri (`app.getPath`,
  `app.getVersion`, `screen.getAllDisplays`, `BrowserWindow#getSize`, …) are
  pre-fetched before `ready` or cached from window events, so they stay
  synchronous. The few that cannot (`clipboard.readText`,
  `screen.getCursorScreenPoint`) return Promises — `await` works in both
  runtimes (current Electron's clipboard is async too).
- **Rust is boilerplate**: `lib.rs` only registers the official plugins.

## Quick start

Requires Node 20+, Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
```

```bash
npm run template:dev        # the starter template
```

```bash
npm run kitchen-sink:dev    # the API kitchen sink
```

```bash
npm test                    # unit tests for the library
```

```bash
npm run kitchen-sink:smoke  # build the kitchen sink, run every automatic check, print results
```

To compare against real Electron, run the same kitchen sink on it:

```bash
npm run smoke --workspace kitchen-sink -- --electron
```

## Status

First pass, focused on the low-hanging fruit that Tauri's core and official
plugins cover. On Linux the kitchen sink currently reports **65 automatic
checks passing on Tauri** (76 on Electron 45, from the same source) and 11
modules explicitly reported as *unsupported*, plus 23 interactive checks
(dialogs, notifications, tray, window state) to click through. See
[docs/API-COVERAGE.md](docs/API-COVERAGE.md).

## License

[0BSD](LICENSE)
