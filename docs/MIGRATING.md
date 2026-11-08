# From an Electron project to a Tauri project

This guide takes an existing Electron app and makes it build and run as a
Tauri app with [tauri-electron](../packages/tauri-electron), keeping the
Electron code as it is. Nothing is published to npm or crates.io yet: both
halves install straight from this GitHub repository.

| You have | You get |
| --- | --- |
| `main.js` with `require('electron')` or `import … from 'electron'` | The same file, run by Tauri in a hidden window |
| a preload script, renderer pages with `<script src>` | The same files, bundled by Vite and loaded into Tauri windows |
| `electron-builder` / Forge config | `src-tauri/tauri.conf.json` + `cargo`, via `tauri build` |
| Node.js in the main process (`fs`, `child_process`, native modules) | **Not available.** See [Node.js code](#4-nodejs-code) |

Requirements: Node 20+, Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

## 1. Add Tauri to the project

One command, run in the project folder (nothing is installed globally):

```bash
npx github:AJayClauGermany/tauri-as-electron --into .
```

It adds files next to your code and leaves your code alone:

```
electron-main.html      hidden page that loads your main script (package.json "main")
vite.config.mjs         the tauri-electron Vite plugin; preload path detected from webPreferences.preload
src-tauri/              Tauri config, icons and a 10-line Rust crate
package.json            + "tauri-electron" (GitHub), @tauri-apps/cli, vite; + tauri:dev / tauri:build scripts
.gitignore              + dist/, src-tauri/target/
```

Then:

```bash
npm install
```

```bash
npm run tauri:dev
```

`tauri dev` compiles the Rust crate the first time (a few minutes), starts
Vite, and opens your app. Main-process `console.log` output appears in the
terminal prefixed `[electron-main]`.

Starting from scratch instead? `npx github:AJayClauGermany/tauri-as-electron my-app`
copies the [template](../templates/tauri-electron-app) (main / preload /
renderer, ES modules) with the dependencies already pointing at GitHub.

Options for either form: `--name`, `--product-name`, `--identifier`
(reverse-DNS app id), `--ref <tag|branch|sha>` to pin both dependencies to
the same git ref, `--local <checkout>` to use a local clone of this
repository, `--force` to overwrite. Run it with `--help` for the list.

### Doing it by hand

The scaffolder only writes files; if you prefer to see each one:

1. `npm install github:AJayClauGermany/tauri-as-electron` as `tauri-electron`:
   in `package.json`, `"tauri-electron": "github:AJayClauGermany/tauri-as-electron"`
   (append `#v0.1.0` or `#<branch>` to pin). Add `vite` and `@tauri-apps/cli`
   as dev dependencies.
2. `vite.config.mjs`:
   ```js
   import { defineConfig } from 'vite'
   import tauriElectron from 'tauri-electron/vite'
   export default defineConfig({
     plugins: [tauriElectron({ preload: 'preload.js' })],
     server: { port: 1420, strictPort: true },
   })
   ```
3. `electron-main.html` with `<script type="module" src="/main.js"></script>`
   (your main script). Copy it from the template.
4. `src-tauri/` from the template: `tauri.conf.json` (set `productName`,
   `identifier`, `version`), `Cargo.toml` with
   `tauri-plugin-electron = { git = "https://github.com/AJayClauGermany/tauri-as-electron" }`,
   `build.rs`, `src/lib.rs`, `src/main.rs`, `icons/`
   (regenerate with `npx tauri icon your-icon.png`).
5. Scripts: `"tauri:dev": "tauri dev"`, `"tauri:build": "tauri build"`,
   `"dev:web": "vite"`, `"build:web": "vite build"` (the last two are what
   `tauri.conf.json` runs before dev and build).

## 2. What keeps working unchanged

- `import { app, BrowserWindow } from 'electron'` **and**
  `const { app } = require('electron')`. The Vite plugin aliases `electron`
  (also `electron/main`, `electron/renderer`, `electron/common`) and provides
  a `require()` in the main page and in every renderer page (preload scripts
  are usually CommonJS).
- `path`, `process`, `events` (`EventEmitter`) and `url` (`fileURLToPath`,
  `pathToFileURL`, `parse`, `format`), with `node:` prefixes or without,
  through `import` or `require()`.
- `__dirname`, `__filename`, `import.meta.dirname` / `filename` and
  `fileURLToPath(import.meta.url)` are rewritten to project-relative paths at
  build time, so `win.loadFile(path.join(__dirname, 'index.html'))` and
  `webPreferences.preload: path.join(__dirname, 'preload.js')` keep working.
- `loadFile('index.html')`, `loadURL('https://…')`, `loadURL('app://…')` for
  schemes you handle with `protocol.handle`.
- Renderer pages: `<script src="renderer.js">` without `type="module"` is
  bundled anyway (the plugin adds the attribute). A
  `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`
  stays valid: tauri-electron injects no inline scripts.
- `contextBridge.exposeInMainWorld`, `ipcRenderer.invoke/send/on`,
  `ipcMain.handle/on`, `webContents.send`, `event.reply`, `event.sender`,
  `MessagePort`s, `sendSync` + `event.returnValue`.
- `process.platform`, `process.argv`, `process.env`, `process.versions`
  (no `electron` key: use it to detect which runtime you are on).
- Menus, dialogs, tray, notifications, clipboard, shell, globalShortcut,
  screen, nativeTheme, net, protocol, autoUpdater (opt-in), single instance
  (opt-in). [API-COVERAGE.md](API-COVERAGE.md) has the full list with the
  behavioural differences.

## 3. Things that differ

| In Electron | On tauri-electron |
| --- | --- |
| `ipcRenderer.sendSync` / `event.returnValue` | Works (through `tauri-plugin-electron`), but blocks the page like Electron; prefer `invoke` + `handle`. |
| `dialog.show*Sync` | Works (through `tauri-plugin-electron`); the async versions are preferred. |
| `clipboard.readText()` used synchronously | `await clipboard.readText()` (also the current Electron API). |
| `screen.getCursorScreenPoint()` | `await screen.getCursorScreenPoint()`. |
| IPC payloads with class instances or cycles | Structured-clone types (`Uint8Array`, `Date`, `Map`, `Error`, …) work; class instances arrive as plain objects (as in Electron); cyclic objects throw. |
| `protocol.handle('app', …)` | Also declare the scheme in `src-tauri/src/lib.rs`: `tauri_plugin_electron::Builder::new().protocol("app")`. Tauri needs schemes at build time. |
| `autoUpdater` | Add `"updater"` to the features of `tauri-plugin-electron` in `src-tauri/Cargo.toml` and configure `plugins.updater` (endpoints, public key) in `tauri.conf.json`. |
| `app.requestSingleInstanceLock()` | Opt in: `features = ["single-instance"]` on `tauri-plugin-electron`. The lock is taken at startup, so a second launch exits before its main process runs. |
| `webContents.openDevTools()` | Debug builds only. For release builds, add the `devtools` feature (uses private APIs on macOS). |
| `webContents.on('before-input-event')` + `preventDefault()` | Reported after the page saw the key; block keys with a `keydown` listener in the page. |
| Renderer calls to privileged Tauri APIs | Renderers only get IPC permissions (like context-isolated, sandboxed Electron renderers). Route through the main process, or add a capability file in `src-tauri/capabilities/`. |
| `webPreferences.nodeIntegration: true` | No Node.js in any webview. `process.env` is filled in for such renderers, nothing else. |
| `utilityProcess.fork()`, `child_process` | Not available. Run Node code as a sidecar (`@tauri-apps/plugin-shell`) or move it to Rust. |
| `app.getPath('userData')` | `<appData>/<identifier>` rather than `<appData>/<productName>`. |
| Linux tray `click` events | Not delivered (Tauri / libappindicator limitation). |

## 4. Node.js code

Electron's main process is a Node.js process. Here it is a webview: there is
no `fs`, `child_process`, `os`, `crypto` (Node flavour), `http`, native
modules, or `asar`. This is the part of a port that is real work.

- `require('fs')` / `import fs from 'fs'` do not fail the build and do not
  throw by themselves; every member throws a `NotImplementedError` (reason
  `unsupported`) naming the replacement when it is called
  (`fs.readFileSync is not supported on Tauri … Use @tauri-apps/plugin-fs`).
  Use the error messages as a to-do list.
- Replacements: `@tauri-apps/plugin-fs` (files), `@tauri-apps/plugin-shell`
  (processes, sidecars), `@tauri-apps/plugin-http` or `net.fetch` (HTTP),
  `@tauri-apps/plugin-store` (settings), Web Crypto, `URL`, or a Rust
  command in `src-tauri/src/lib.rs` invoked with `@tauri-apps/api/core`.
- Install a Tauri plugin like in any Tauri app (`cargo add`, `.plugin(...)`
  in `lib.rs`, and a permission in `src-tauri/capabilities/` for the
  `electron-main` window). The main window is the only one that needs it.

## 5. Build and ship

```bash
npm run tauri:build
```

produces installers under `src-tauri/target/release/bundle/` (configure them in
`tauri.conf.json` → `bundle`). Code signing, updater keys and app icons follow
the [Tauri distribution guide](https://v2.tauri.app/distribute/).

## 6. Reading errors

Every failure tauri-electron produces says what kind it is, so you can tell
whether to change your code, enable a feature, or stop looking:

| You see | It means | Do |
| --- | --- | --- |
| `X is not implemented by tauri-electron yet` (`NotImplementedError`, `reason: 'unimplemented'`) | Tauri could support it; nobody wrote it yet. | Work around it, or contribute it. [API-COVERAGE.md](API-COVERAGE.md) lists these as ❌. |
| `X is not supported on Tauri (no equivalent …)` (`reason: 'unsupported'`) | No Tauri / WebKit / WebView2 counterpart (Node built-ins, Chromium-only features, Electron's view hierarchy). Not planned. | Use the hint in the message (a Tauri plugin, a Rust command). Listed as 🚫. |
| `X is disabled: a Cargo feature of tauri-plugin-electron is off` (`reason: 'feature'`) | The official Tauri plugin behind the API is not compiled in. | Add the feature to `tauri-plugin-electron` in `src-tauri/Cargo.toml` ([list](../crates/tauri-plugin-electron/README.md#features)). |
| `X is unavailable: tauri-plugin-electron is not registered` (`reason: 'plugin'`) | `lib.rs` does not call `tauri_plugin_electron::Builder::new().install(...)`. | Copy `lib.rs` from the template. |
| `X is denied by Tauri's capability model` (`reason: 'permission'`) | Tauri refused the underlying command. Almost always a main-process API called from a renderer page. | Move the call to the main process, or add a capability file in `src-tauri/capabilities/` for that window. |
| `[tauri-electron] X is a no-op …` (console warning, once) | Accepted so startup code keeps running; no native effect (⚪ in API-COVERAGE). | Nothing, unless you relied on the effect. |
| `[tauri-electron] … failed: …` (console error) | A Tauri call behind a fire-and-forget Electron API rejected. The message is translated when it is a permission or feature problem. | Read the translated message. |
| `plugin X not found` in a stack trace | Same as `reason: 'feature'`, seen raw. | Enable the feature. |
| `Failed to resolve module specifier "fs"` in the browser console | A Node built-in imported from a page the Vite plugin did not process (e.g. a `<script>` tag loaded from outside the project). | Let Vite bundle the file, or drop the import. |

Everything Electron accepts but behaves differently here is marked 🟡 in
[API-COVERAGE.md](API-COVERAGE.md), with the difference spelled out. The
[kitchen sink](../apps/kitchen-sink) runs the same checks on Tauri and on
real Electron if you want to compare a behaviour yourself.

## 7. Keeping up to date

Both dependencies track `main` unless pinned:

```bash
npm update tauri-electron
```

```bash
cargo update -p tauri-plugin-electron --manifest-path src-tauri/Cargo.toml
```

To pin, use the same ref on both sides: `"tauri-electron": "github:AJayClauGermany/tauri-as-electron#v0.1.0"`
and `tauri-plugin-electron = { git = "…", tag = "v0.1.0" }` (the scaffolder's
`--ref` does this). The JavaScript and Rust halves talk over a small internal
protocol, so keep them at the same commit.
