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
| [`crates/tauri-plugin-electron`](crates/tauri-plugin-electron) | Small Rust plugin for what Tauri's JS API and official plugins cannot do: `sendSync`, `process.argv`/`env`, devtools, `shell.trashItem`, `protocol.handle`, navigation and macOS app events. |
| [`templates/tauri-electron-app`](templates/tauri-electron-app) | Starter template: an Electron-shaped project (main / preload / renderer) that builds as a Tauri app. |
| [`scripts/create-app.mjs`](scripts/create-app.mjs) | `npx github:AJayClauGermany/tauri-as-electron my-app` (new app from the template) or `--into <dir>` (add Tauri to an existing Electron project). |
| [`apps/kitchen-sink`](apps/kitchen-sink) | Exercises ~100 Electron APIs. Runs unchanged on **both** Tauri and real Electron, so you can compare behaviour side by side. |
| [`docs/MIGRATING.md`](docs/MIGRATING.md) | Step-by-step guide for porting an Electron app, and how to read the errors you may hit. |
| [`docs/API-COVERAGE.md`](docs/API-COVERAGE.md) | What is implemented, partial, or missing, and the behavioural differences. |
| [`docs/TARGET-APPS.md`](docs/TARGET-APPS.md) | The Electron APIs VS Code and GitHub Desktop rely on, and where each one stands. |

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
  Tauri events addressed to specific windows. Payloads use a
  structured-clone-like encoding (`Uint8Array`, `Date`, `Map`, `Error`, … survive).
  `MessagePort`s can be transferred, and `ipcRenderer.sendSync` blocks on a
  synchronous request to `tauri-plugin-electron`'s URI scheme.
- **Preload scripts** are loaded by the Vite plugin at the top of every
  page, before your renderer code. `contextBridge.exposeInMainWorld` assigns
  to `window`. CommonJS code works: `require('electron')`, `require('path')`
  are provided; other Node built-ins throw a `NotImplementedError` that names
  the Tauri replacement.
- **Capabilities mirror Electron's security model and defaults**: the hidden
  main window may use all APIs; renderer windows may only exchange IPC
  messages (plus zoom, `window.close()` and `-webkit-app-region` dragging),
  like context-isolated, sandboxed Electron renderers. `tauri-plugin-electron`
  grants them at startup; see the security table in API-COVERAGE.md.
- Electron APIs that are **synchronous** but async in Tauri (`app.getPath`,
  `app.getVersion`, `screen.getAllDisplays`, `BrowserWindow#getSize`, …) are
  pre-fetched before `ready` or cached from window events, so they stay
  synchronous. The few that cannot (`clipboard.readText`,
  `screen.getCursorScreenPoint`) return Promises — `await` works in both
  runtimes (current Electron's clipboard is async too).
- **Rust is boilerplate**: `lib.rs` is one call to
  `tauri_plugin_electron::Builder::new().install(...)`. Which Electron
  modules exist is set by that plugin's Cargo features, each backed by an
  official Tauri plugin (dialog, clipboard, notification, shell, net,
  global-shortcut, tray, protocol-client, login-item on by default;
  single-instance, updater, devtools opt-in, like in Electron).

## Use it in your project

Nothing is published to npm or crates.io yet; both halves install from this
repository. Requires Node 20+, Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Add Tauri to an existing Electron project (your code is not touched):

```bash
npx github:AJayClauGermany/tauri-as-electron --into .
```

```bash
npm install
```

```bash
npm run tauri:dev
```

Or start a new app from the template:

```bash
npx github:AJayClauGermany/tauri-as-electron my-app
```

The generated `package.json` depends on
`"tauri-electron": "github:AJayClauGermany/tauri-as-electron"` and
`src-tauri/Cargo.toml` on
`tauri-plugin-electron = { git = "https://github.com/AJayClauGermany/tauri-as-electron" }`;
`--ref v0.1.0` pins both. [docs/MIGRATING.md](docs/MIGRATING.md) walks
through the port, what differs, and how to read the errors.

## Working on this repository

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

The API surface is driven by two large Electron apps, VS Code and GitHub
Desktop: [TARGET-APPS.md](docs/TARGET-APPS.md) lists every Electron API on
their main code path and where it stands. On Linux the kitchen sink
currently reports **112 automatic checks passing on Tauri** and 4 reported
as *unsupported* (`desktopCapturer`, `utilityProcess`, `contentTracing`,
and a check that asserts those errors say why), plus 30 interactive checks
(dialogs, notifications, tray, devtools, frameless window dragging and file
drops) to click through. The same source runs on real Electron for
comparison. See [docs/API-COVERAGE.md](docs/API-COVERAGE.md).

## License

[0BSD](LICENSE)
