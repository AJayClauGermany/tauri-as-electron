# Tauri + Electron API template

A Tauri v2 app written like an Electron app. Copy this folder to start a
new project or to port an existing Electron one
(see [MIGRATING.md](../../docs/MIGRATING.md)).

```
electron-main.html        hidden window that runs the main-process code
index.html                renderer page (any root-level *.html is a page)
src/main.js               Electron main process: app, BrowserWindow, ipcMain, ...
src/preload.js            preload: contextBridge.exposeInMainWorld(...)
src/renderer.js           page code; talks to main through window.api
vite.config.js            tauri-electron/vite plugin (aliases `electron`)
src-tauri/                Tauri shell: config, and tauri-plugin-electron's features in Cargo.toml
```

```bash
npm run dev     # tauri dev (main-process logs appear here as [electron-main])
```

```bash
npm run build   # tauri build
```

## Things to customise

- `src-tauri/tauri.conf.json`: `productName`, `version`, `identifier`.
- Icons: `npx tauri icon path/to/icon.png`.
- `src-tauri/Cargo.toml`: the features of `tauri-plugin-electron` pick the
  Electron modules (and the official Tauri plugins behind them). Most are on
  by default; add `"single-instance"` if your app calls
  `app.requestSingleInstanceLock()`, `"updater"` for `autoUpdater` (plus
  `plugins.updater` in `tauri.conf.json`). See the
  [feature list](../../crates/tauri-plugin-electron/README.md#features).
- `src-tauri/src/lib.rs`: declare every scheme your main process passes to
  `protocol.handle()` with `.protocol("app")`. Nothing else to change.
- `src-tauri/capabilities/`: empty on purpose; tauri-plugin-electron grants
  Electron's defaults (the main process may use everything enabled,
  renderers only IPC). Add capability files if your pages call Tauri APIs
  directly.
- Until tauri-electron is published,
  `tauri-plugin-electron` points at this repository with a relative `path`.
  In a copy outside the repository, use
  `git = "https://github.com/AJayClauGermany/tauri-as-electron"`.
