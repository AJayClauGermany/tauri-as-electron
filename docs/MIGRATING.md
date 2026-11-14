# From an Electron project to a Tauri project

This guide takes an existing Electron app and makes it build and run as a
Tauri app with [tauri-electron](../packages/tauri-electron), keeping the
Electron code as it is. Nothing is published to npm or crates.io yet: both
halves install straight from this GitHub repository.

| You have | You get |
| --- | --- |
| `main.js` with `require('electron')` or `import … from 'electron'` | The same file, run by Tauri in a hidden window |
| a preload script, renderer pages with `<script src>` | The same files, bundled by Vite (or [webpack / rspack](#webpack-and-rspack), if that is what the project uses) and loaded into Tauri windows |
| `electron-builder` / Forge config | `src-tauri/tauri.conf.json` + `cargo`, via `tauri build` |
| Node.js in the main process | `fs`, `os`, `child_process` (backed by Rust), `Buffer`, `util`, `events`, `stream`, `crypto` (hashes, random values) and the `http` / `https` client work; native modules and the rarer built-ins do not yet. See [Node.js code](#4-nodejs-code) |

Requirements: Node 20+, Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

Vite is the default bundler. Projects that already build with **webpack**
(Electron Forge's webpack template, electron-react-boilerplate, hand-written
configs) or **rspack** can keep it: see [Webpack and rspack](#webpack-and-rspack).
The scaffolder below picks the bundler from your `package.json`.

## 1. Add Tauri to the project

One command, run in the project folder (nothing is installed globally):

```bash
npx github:AJayClauGermany/tauri-as-electron --into .
```

It adds files next to your code and leaves your code alone (for a Vite
build; webpack / rspack projects get a [different config file](#webpack-and-rspack)):

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
repository, `--force` to overwrite, and for `--into`, `--bundler
vite|webpack|rspack` to override the detected bundler. Run it with `--help`
for the list.

### Webpack and rspack

An Electron app built with webpack normally has three builds (main,
preload, renderer, with `electron-*` targets). In Tauri all three run in
webviews, so `tauri-electron/webpack` (the same plugin is exported as
`tauri-electron/rspack`) turns **one web build** into the whole app:

- an `electron-main` entry for your main script, and the hidden
  `electron-main.html` page Tauri opens first (emitted by the plugin),
- the renderer bootstrap and your preload prepended to every renderer entry,
- `electron-*` / `node` targets switched to `web`,
- `electron` and the Node built-ins tauri-electron implements (`fs`, `os`,
  `child_process`, `util`, `stream`, `crypto`, `http`, …) redirected to
  tauri-electron, the others (`zlib`, `net`, …, with or without `node:`) to
  stubs that throw a [`NotImplementedError`](#6-reading-errors) when used,
- `__dirname`, `__filename`, `import.meta.dirname|filename` and
  `fileURLToPath(import.meta.url)` in your source rewritten to
  project-relative paths,
- in dev, the main window's console printed in the terminal (`[electron-main]`).

Your existing webpack / Forge setup keeps working for Electron; the Tauri
build is a separate config file next to it. Supported: webpack 5 and rspack
1 or 2, with their own CLIs and dev servers.

**Electron Forge** (`@electron-forge/plugin-webpack`, JavaScript or
TypeScript, Forge 7 or 8). `--into` detects it and writes
`webpack.tauri.config.cjs`, which reads everything from `forge.config.*`:

```js
// webpack.tauri.config.cjs
const { fromForge } = require('tauri-electron/webpack')
module.exports = (env, argv) => fromForge('./forge.config.mjs', { mode: argv.mode })
```

`fromForge()` takes the renderer config (loaders, plugins, `resolve`), the
main config's entry, and the `entryPoints` (pages and their preloads). Each
page is served at `<name>/index.html`, and `MAIN_WINDOW_WEBPACK_ENTRY` /
`MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY` (one pair per entry point) are defined
to match, so the template's `mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)`
works unchanged. Rules using `node-loader` and
`@vercel/webpack-asset-relocator-loader` are dropped (they only handle
native `.node` addons, which cannot load in a webview). TypeScript Forge
configs are loaded with [jiti](https://github.com/unjs/jiti), like Forge 8
does; the scaffolder adds it. To build a Forge project with rspack instead,
pass `--bundler rspack`. Forge's templates pin `css-loader` 6 and
`style-loader` 3, which declare support only up to rspack 1, so update them
to 7 and 4 for rspack 2.

**Other webpack / rspack projects.** `--into` writes
`webpack.tauri.config.cjs` (or `rspack.tauri.config.cjs`) with the main
script, preload, HTML template and renderer entry it found, plus loader
rules for the loaders you have installed (`ts-loader`, `babel-loader`,
`css-loader`, `sass-loader`; rspack gets `builtin:swc-loader` and native
CSS otherwise). Check the paths (anything not found is marked `TODO`) and
copy over what else your renderer config needs (aliases, `DefinePlugin`
values, more loaders). The shape:

```js
// webpack.tauri.config.cjs
const path = require('node:path')
const { TauriElectronPlugin } = require('tauri-electron/webpack')

module.exports = {
  entry: {},
  module: { rules: [/* your loaders */] },
  output: { path: path.resolve(__dirname, 'dist'), publicPath: '/', clean: true },
  plugins: [
    new TauriElectronPlugin({
      main: './src/main/main.ts',
      pages: [{
        name: 'index',
        html: './src/renderer/index.html',      // template, via html-webpack-plugin (or HtmlRspackPlugin)
        filename: 'src/renderer/index.html',    // where it is served
        js: './src/renderer/index.tsx',
        preload: './src/main/preload.ts',
      }],
    }),
  ],
  devServer: { port: 1420 },                    // tauri.conf.json build.devUrl
}
```

Serving a page at its project-relative source path (`filename`) is what
makes `win.loadFile(path.join(__dirname, '../renderer/index.html'))` and
``win.loadURL(`file://${path.join(__dirname, '../renderer/index.html')}`)``
find it, since `__dirname` is `/src/main` here. A dev-server URL in the main
process (`http://localhost:1212/index.html`) does not; load the file instead.

You can also add the plugin to a config that already has entries and
`HtmlWebpackPlugin` pages: then `preload` (a path, a list, or
`{ entryName: path }`) is prepended to every entry, and `main` becomes the
`electron-main` entry. Options: `main`, `preload`, `pages`
(`{ name, js, html, filename, preload }`), `mainEntry`, `mainHtml`,
`aliasPath`, `require`, `forwardMainConsole`, `forgeGlobals`; see the
[package README](../packages/tauri-electron/README.md#webpack-and-rspack).

Scripts the scaffolder adds (`tauri.conf.json` runs the last two):

| | webpack | rspack |
| --- | --- | --- |
| `dev:web` | `webpack serve --config webpack.tauri.config.cjs --mode development` | `rspack serve --config rspack.tauri.config.cjs --mode development` |
| `build:web` | `webpack --config webpack.tauri.config.cjs --mode production` | `rspack build --config rspack.tauri.config.cjs --mode production` |
| dev dependencies | `webpack`, `webpack-cli`, `webpack-dev-server`, `html-webpack-plugin` | `@rspack/core`, `@rspack/cli`, `@rspack/dev-server` |

By hand: the same steps as [below](#doing-it-by-hand), with the config
file above instead of `vite.config.mjs`, those scripts, and no
`electron-main.html` (the plugin emits it).

### Doing it by hand

The scaffolder only writes files; if you prefer to see each one (Vite):

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
  `const { app } = require('electron')`. The Vite plugin (or the
  webpack / rspack plugin) aliases `electron`
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
  schemes you handle with `protocol.handle`, and `loadURL('file://…')`
  (treated like `loadFile`: the page at that path in the build).
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
| `utilityProcess.fork()`, `child_process.fork()` | Not available: they start another Node.js process, and none is shipped. Run that code in the main process or a Web Worker, or spawn a separate executable with `child_process.spawn`. |
| `fs`, `os`, `child_process` in a renderer (`nodeIntegration`) | Main process only, like a sandboxed Electron renderer: expose what the page needs with `ipcMain.handle`. |
| `app.getPath('userData')` | `<appData>/<identifier>` rather than `<appData>/<productName>`. |
| Linux tray `click` events | Not delivered (Tauri / libappindicator limitation). |

## 4. Node.js code

Electron's main process is a Node.js process. Here it is a webview, and no
Node.js is shipped. tauri-electron implements some Node built-ins itself
(the plan and status: [NODE-COMPAT-PLAN.md](NODE-COMPAT-PLAN.md)):

| Built-in | Status |
| --- | --- |
| `path` (POSIX; `path.win32` is a real Windows implementation), `process`, `events`, `url` | Pure JavaScript, always on. |
| `buffer` and the global `Buffer` (main process) | The `buffer` npm package: a `Uint8Array` subclass. |
| `fs`, `fs/promises`, `original-fs` | Rust, behind the `node-fs` feature of `tauri-plugin-electron` (main process only). |
| `os` | Rust, behind `node-os` (main process only). |
| `child_process` | Rust, behind `node-child-process` (main process only). |
| `util`, `util/types`, `events`, `stream`, `stream/promises`, `string_decoder` | Pure JavaScript (`util` in-house; `stream` is readable-stream, Node's own streams). |
| `crypto` | Hashes, HMAC, PBKDF2, HKDF, scrypt (@noble/hashes), random values and `webcrypto` / `subtle` (Web Crypto). No ciphers, signatures or key pairs yet. |
| `http`, `https` | The client (`request`, `get`) over tauri-plugin-http; no servers yet. |
| `zlib`, `net`, `dns`, `assert`, `readline`, `worker_threads`, … | Not yet: they load, and throw `NotImplementedError` when used. |

The Rust-backed modules are switched on per app in `src-tauri/Cargo.toml`,
one line each, so the native access the app has is visible and easy to turn
off (the template and the scaffolder write this for you):

```toml
tauri-plugin-electron = { git = "https://github.com/AJayClauGermany/tauri-as-electron", features = [
  "node-fs",            # fs, fs/promises: file access from the main process
  "node-os",            # os: host, user, memory, CPUs, network interfaces
  "node-child-process", # child_process: runs arbitrary commands; delete to disable
] }
```

A module whose feature is off throws `NotImplementedError` (reason
`feature`) naming the line to add.

### `fs`

- `*Sync` functions block the main window until Rust answers, like in Node
  (renderer windows keep running). `fs.promises.*` and the callback API do
  not block. Results and errors are the same for all three; errors carry
  Node's `code`, `errno`, `syscall`, `path` and message
  (`ENOENT: no such file or directory, open '/x'`).
- Implemented: `readFile`, `writeFile`, `appendFile`, `exists` / `existsSync`,
  `stat`, `lstat` (`Stats`, `throwIfNoEntry`, `bigint`), `access`, `mkdir`
  (recursive), `readdir` (`withFileTypes`, `recursive`), `rm`, `unlink`,
  `rmdir`, `rename`, `copyFile`, `realpath`, `mkdtemp`, `truncate`, `chmod`,
  `utimes`, `readlink`, `symlink`, `constants`; each as `*Sync`, callback and
  `fs.promises` / `fs/promises`.
- Not yet (they throw `NotImplementedError`, reason `unimplemented`): file
  descriptors (`open`, `read`, `write`, `close`, `fstat`, `FileHandle`),
  streams (`createReadStream`, `createWriteStream`), `watch` / `watchFile`,
  `cp`, `opendir`, `link`, `chown`.
- Main process only. A renderer that calls `fs` gets a `NotImplementedError`
  (reason `permission`): move the file access to `ipcMain.handle`, as with a
  sandboxed Electron renderer.

**The app's own files.** `__dirname` is the project-relative folder of the
source file (`/src/main`), so `fs.readFileSync(path.join(__dirname, 'data.json'))`
reads `/src/main/data.json` *of the project*: a path that is absolute and
starts with a top-level entry of the project (`/src/…`, `/assets/…`,
`/package.json`) is an app file. It is read from the project folder in
development (like `electron .`) and from `<resources>/app/` in a build (like
`resources/app.asar`). Every other path (`app.getPath('userData')`,
`os.tmpdir()`-style real paths, relative paths) is used as is.
`app.getAppPath()` returns that app folder, so `path.join(app.getAppPath(), 'x')`
works with `fs` and with `win.loadFile()` alike. As in a packaged Electron
app, app files are read-only in a build: writing to them fails with `EROFS`.

For builds, the bundler plugin copies the app's files into
`src-tauri/electron-resources/app/` before Tauri bundles them, and
`tauri.conf.json` ships that folder as resources:

```json
"bundle": { "resources": { "electron-resources/": "" } }
```

The template and the scaffolder set both up (the folder holds a
`.gitignore`; its contents are generated). Staging only happens when the
folder exists. By default it takes every project file except
`node_modules`, `src-tauri`, build output, dot-files, lockfiles and the
sources the bundler compiles (`.js`, `.ts`, `.css`, `.html`, …). To choose
yourself, pass `resources` to the plugin: `tauriElectron({ resources: ['assets', 'config/defaults.json'] })`,
or `resources: false` for none. Electron-builder's `extraResources` and
Forge's `extraResource` are not read yet.

### `child_process`

- `execSync`, `execFileSync`, `spawnSync` block the main window until the
  command ends, as they block Node (renderer windows keep running). `input`,
  `timeout`, `maxBuffer`, `killSignal`, `cwd`, `env`, `shell`, `encoding`
  and `stdio` (`'pipe'`, `'inherit'`, `'ignore'`) work; failures throw
  Node's errors (`Command failed: …` with `status`, `stdout`, `stderr`;
  `spawnSync … ENOENT`; `ETIMEDOUT`).
- `spawn`, `exec`, `execFile` return a ChildProcess: `stdout` / `stderr`
  are Readable streams, `stdin` a Writable one, with `'spawn'`, `'exit'`,
  `'close'`, `'error'`, `pid` and `kill(signal)`. `util.promisify(exec)`
  resolves to `{ stdout, stderr }`.
- Shells are Node's: `/bin/sh -c` on Unix, `cmd.exe /d /s /c` on Windows.
  `stdio: 'inherit'` means the app's own stdout / stderr (the terminal of
  `tauri dev`).
- Not available: `fork()` and the `'ipc'` stdio channel (they need a
  Node.js child), and streams or descriptors beyond 0–2 in `stdio`.

### `os`

Everything `os` has: `hostname`, `homedir`, `tmpdir`, `type`, `release`,
`version`, `machine`, `userInfo`, `cpus` (with `times` on Linux; zeros
elsewhere), `totalmem`, `freemem`, `uptime`, `loadavg`, `networkInterfaces`,
`getPriority` / `setPriority`, and `platform`, `arch`, `EOL`, `endianness`,
`availableParallelism`, `constants` (which need no native code).

### `util`, `stream`, `crypto`, `http`

- `util.inspect` / `util.format` print like Node's; `promisify`,
  `callbackify`, `inherits`, `deprecate`, `debuglog`, `isDeepStrictEqual`,
  `types` are there. `events.EventEmitter` can also be called the pre-class
  way (`EventEmitter.call(this)` with `util.inherits`).
- `stream` is Node's own implementation (readable-stream). Its streams
  carry tauri-electron's `Buffer` and `EventEmitter`.
- `crypto`: no `createCipheriv`, `sign` / `verify`, key pairs or
  Diffie-Hellman yet; use `crypto.subtle` meanwhile.
- `http` / `https`: the client side. Like Node, redirects are not followed;
  the request body is sent on `end()`. Connection errors carry a Node `code`,
  but plugin-http does not always say why a connection failed: a refused
  connection can arrive as `ECONNRESET` rather than `ECONNREFUSED`. `createServer` throws: use
  `protocol.handle()` for endpoints inside the app.

### Everything else

- `require('zlib')` / `import net from 'net'` & co. do not fail the
  build and do not throw by themselves; every member throws a
  `NotImplementedError` (reason `unsupported`) naming the replacement when
  it is called (`zlib.gzipSync is not supported on Tauri … Use
  CompressionStream`). Use the error messages as a to-do list.
- Replacements: `@tauri-apps/plugin-http` or `net.fetch` (HTTP),
  `CompressionStream`, `URLSearchParams`, or a Rust command in
  `src-tauri/src/lib.rs` invoked with `@tauri-apps/api/core`.
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
| `Module not found: Can't resolve 'x'` from webpack / rspack | A dependency your Electron build left to Node (`externals`, a native module). | Remove it from `externals` in the Tauri config so it is bundled, or replace the native module. |

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
