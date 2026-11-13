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

## Webpack and rspack

Projects that build with webpack 5 or rspack use `tauri-electron/webpack`
(also exported as `tauri-electron/rspack`) instead. Tauri runs main,
preload and renderer in webviews, so one web build makes the whole app:

```js
// webpack.tauri.config.cjs (or rspack.tauri.config.cjs)
const path = require('node:path')
const { TauriElectronPlugin } = require('tauri-electron/webpack')

module.exports = {
  module: { rules: [/* your loaders */] },
  output: { path: path.resolve(__dirname, 'dist'), publicPath: '/' },
  plugins: [
    new TauriElectronPlugin({
      main: './src/main.js',
      pages: [{ name: 'main_window', html: './src/index.html', js: './src/renderer.js', preload: './src/preload.js' }],
    }),
  ],
  devServer: { port: 1420 },
}
```

For an Electron Forge project, `fromForge()` builds the whole config from
`@electron-forge/plugin-webpack`'s options:

```js
// webpack.tauri.config.cjs
const { fromForge } = require('tauri-electron/webpack')
module.exports = (env, argv) => fromForge('./forge.config.js', { mode: argv.mode })
```

The plugin:

- adds an `electron-main` entry for `main` and emits `electron-main.html`
  (the hidden page Tauri opens first, `tauri.conf.json` → `app.windows`);
- prepends `require()`, the renderer bootstrap and the preload(s) to every
  other entry;
- with `pages`, creates the renderer entries and their HTML pages
  (html-webpack-plugin from your project, else rspack's `HtmlRspackPlugin`)
  and defines Electron Forge's `<NAME>_WEBPACK_ENTRY` /
  `<NAME>_PRELOAD_WEBPACK_ENTRY` to match;
- switches `electron-*` / `node` targets (and externals presets) to `web`;
- redirects `electron`, `path`, `process`, `events`, `url` and stubs other
  Node built-ins, with or without `node:` (names you already map in
  `resolve.alias` / `resolve.fallback` are left alone);
- rewrites `__dirname` & co. in your source (an `enforce: 'pre'` loader);
- in watch mode with `mode: 'development'`, prints the main window's console
  in the terminal (through a small listener of its own on 127.0.0.1, since
  CLIs copy `devServer` options before plugins run).

Options: `main` (required; string or array), `preload` (string, array, or
`{ [entryName]: path }`), `pages` (`[{ name, js?, html?, filename?, preload?, title?, additionalChunks? }]`;
`filename` defaults to `<name>/index.html`), `mainEntry` (default
`electron-main`), `mainHtml` (default `electron-main.html`), `aliasPath`,
`require`, `forwardMainConsole` (default `true` each), `forgeGlobals`
(default `true`). `fromForge(forgeConfig?, { context, mode, outDir = 'dist', port = 1420, ...pluginOptions })`
returns a Promise of the config.

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
webpack.cjs             the webpack / rspack plugin (+ fromForge)
bundler/                shared by both plugins: path rewriting, Node built-in stubs, page entries
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
