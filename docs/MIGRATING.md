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
keep the package (`file:`, a git URL, or a registry once published), and the
`tauri-plugin-electron` crate in `src-tauri/Cargo.toml` at the git
repository instead of the relative `path`.

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
| `ipcRenderer.sendSync` / `event.returnValue` | Works (through `tauri-plugin-electron`), but blocks the page; prefer `invoke` + `handle`. |
| `dialog.show*Sync` | Works (through `tauri-plugin-electron`); the async versions are preferred. |
| `clipboard.readText()` used synchronously | `await clipboard.readText()` (also the current Electron API). |
| `screen.getCursorScreenPoint()` | `await screen.getCursorScreenPoint()`. |
| IPC payloads with class instances or cycles | Structured-clone types (`Uint8Array`, `Date`, `Map`, `Error`, …) work; class instances arrive as plain objects (as in Electron) and cyclic objects throw. |
| `protocol.handle('app', …)` | Also declare the scheme in `src-tauri/src/lib.rs`: `tauri_plugin_electron::Builder::new().protocol("app")`. |
| `autoUpdater` | Register `tauri-plugin-updater` in `lib.rs`, configure `plugins.updater` (endpoints, public key) in `tauri.conf.json` and add `updater:default` to `capabilities/main.json`. |
| App allows several instances (Electron's default) | Remove `tauri-plugin-single-instance` from `Cargo.toml` and `lib.rs`. |
| Custom title bars (`frame: false` + `-webkit-app-region: drag`) | Works. Interactive elements inside a drag area need `-webkit-app-region: no-drag`, as in Electron. |
| `webContents.on('before-input-event')` with `preventDefault()` | Reported after the fact; use a `keydown` listener in the page to block keys. |
| `fs`, `child_process`, other Node built-ins in main | Not available (the main process is a webview). Use Tauri plugins such as `@tauri-apps/plugin-fs` / `plugin-shell`, or a Rust command. |
| Renderers calling privileged APIs directly | Renderers only get IPC permissions. Route through the main process, or add permissions to `src-tauri/capabilities/renderer.json`. |
| `webContents.openDevTools()` | Works in debug builds. For release builds, enable the `devtools` feature of `tauri-plugin-electron` (uses private APIs on macOS). |
| `utilityProcess.fork()` | Not available. Run Node code as a sidecar (`@tauri-apps/plugin-shell`) or move it to Rust. |
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
