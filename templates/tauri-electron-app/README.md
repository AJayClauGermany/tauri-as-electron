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
src-tauri/                Tauri shell: plugin registration, config, capabilities
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
- `src-tauri/capabilities/renderer.json`: renderers can only do IPC by
  default (like a context-isolated Electron renderer). Widen it if your pages
  call Tauri APIs directly.
- `src-tauri/capabilities/main.json`: what the main process may do. Remove
  plugins you don't use (and their entries in `Cargo.toml` / `lib.rs`).
- `src-tauri/src/lib.rs`: declare every scheme your main process passes to
  `protocol.handle()` with `.protocol("app")`; uncomment the
  `single_instance()` line (and enable the `single-instance` feature in
  `Cargo.toml`) if your app calls `app.requestSingleInstanceLock()`;
  register `tauri-plugin-updater` to use `autoUpdater`.
- `src-tauri/Cargo.toml`: until tauri-electron is published,
  `tauri-plugin-electron` points at this repository with a relative `path`.
  In a copy outside the repository, use
  `git = "https://github.com/AJayClauGermany/tauri-as-electron"`.
