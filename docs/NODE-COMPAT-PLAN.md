# Node.js built-ins on Tauri: implementation plan

Hand-off document for the agent that implements Node built-in support in
tauri-electron. It records what was decided, what was measured, where each
built-in should be implemented, the order of work, and the traps.

Status: **layer 1 (the `fs` proof of concept) is implemented**; layers 2 and
later are not started. See "Implementation status" below.

## Implementation status

Layer 1 (section 6) landed as planned, with these specifics:

| Piece | Where | Notes |
| --- | --- | --- |
| `fs`, `fs/promises`, `original-fs` | `src/node/fs.js`, `src/node/fs-promises.js`; Rust in `crates/tauri-plugin-electron/src/node_fs.rs` | Feature `node-fs`, permission set `electron:node-fs`. Sync over `node/fs/<op>` on the bridge (always answered from a spawned thread), async over the `node_fs` command with a framed raw body (`u32` LE header length, JSON `{ op, args }`, data), so no custom headers are needed. All operations from step 2, plus `exists` and `readdir` `recursive`. Errors map raw OS codes per platform (libc on Unix, libuv's table on Windows), `ErrorKind` as fallback. |
| Caller check | `node_refusal` in `lib.rs` | `electron-main` only, and its webview must show the app's own page (`tauri:` / `tauri.localhost`, or the dev URL in debug builds). |
| `buffer`, global `Buffer` | `src/node/buffer.js` | The `buffer` npm package, imported as `buffer/index.js` so the `buffer` alias does not apply to it. The global is installed on the main page only. |
| `path.win32` | `src/node/path-win32.js` | Compared against Node's `path.win32` in `test/path.test.js`; differs only for `\\?\` verbatim paths. `path` itself stays POSIX. |
| Registry for `require()` | `registerNodeModule` in `src/require.js`, `src/node/index.js` | The main page's first module (`virtual:tauri-electron/main`, `bundler/main-node.js`) imports `tauri-electron/node`, which registers `fs`, `fs/promises`, `original-fs`, `buffer`. Renderer pages keep the stub, whose hint now says fs is main-process only. |
| App-relative paths (8.1) | `src/internal/app-files.js`, `appFilesConfig` / `stageAppFiles` in `bundler/shared.cjs` | The plugins publish `{ root, entries }` (top-level project entries minus dot-files, `src-tauri` and names such as `tmp`, `home`, `Users`) as `globalThis.__TAURI_ELECTRON_APP__`. An absolute path whose first segment is an entry, and that is not under a known real root, maps to the project (dev) or `<resource_dir>/app` (build; asked from Rust via `node/fs/resourceDir` if `process.resourcesPath` is not known yet). Writes there fail with `EROFS` in a build. `app.getAppPath()` returns the same root and `loadFile` maps paths under it back to project paths. Staging runs in production builds only, and only when `src-tauri/electron-resources/` exists; the `resources` plugin option overrides the default selection. |
| Template, scaffolder, kitchen sink | | `node-fs` line, `bundle.resources: { "electron-resources/": "" }`, the staging folder with its `.gitignore`. Kitchen sink: 12 `fs` / `Buffer` checks in `src/checks-node.js`. |

Measured after the change (Linux, WebKitGTK 2.52.6): 102 unit tests pass;
kitchen-sink smoke 124 pass, 0 fail, 4 unsupported, 30 manual on Tauri, both
for a debug build and under `tauri dev`; 128 pass, 0 fail on real Electron
with the same 12 checks.

Open points from layer 1:

- Not verified on macOS (WKWebView) or Windows (WebView2): section 8.3 still applies.
- The staging folder's `.gitignore` is copied to the resource directory
  root as well (Tauri copies dot-files). Harmless; avoid it with a narrower
  resource mapping if it matters.
- electron-builder `files` / `extraResources` and Forge `extraResource` are
  not read yet (section 8.1, step 2); only the default selection and the
  `resources` option exist.
- Staging is unit-tested for both plugins' shared code and end-to-end for
  Vite; the webpack / rspack path (`beforeRun`) is not exercised by an
  end-to-end build.
- `nodeIntegration: true` renderers still cannot use `fs` (section 8.5).
- `path` is not switched to `win32` on Windows (section 8.2).
- Strict `connect-src` CSPs are untested with the bridge (section 8.3).

## 1. Goal and hard constraints

Electron apps call Node built-ins (`fs`, `os`, `child_process`, `util`, …)
from the main process. Today tauri-electron resolves those imports to stubs
that throw `NotImplementedError` when called. The goal is to make them work so
that a migrating app changes as little of its own code as possible, ideally
nothing, and can go back to Electron.

Constraints set by the project owner:

- **No Node.js is bundled or shipped.** No sidecar Node, no embedded runtime.
- Every built-in is implemented with one of:
  1. what the webview already provides (Web APIs, pure JavaScript), or
  2. Rust, inside `tauri-plugin-electron` or through an official Tauri plugin.
- The user's Electron source stays untouched. All wiring lives in the bundler
  plugins and in `src-tauri/`.
- **Compatibility first.** A migrating app should get as much working as
  possible before its author has to decide anything. Native-backed built-ins
  are enabled for migrated apps, but each one is a visibly named switch that
  is easy to turn off (section 5.3).
- Third-party polyfill packages are acceptable as dependencies of
  tauri-electron, as many as are useful. The user never chooses or installs
  them.
- Everything that works today must keep working (section 9).

## 2. What exists today

| Piece | File | Role |
| --- | --- | --- |
| Built-in lists | `packages/tauri-electron/bundler/shared.cjs` | `NODE_SHIMS` (aliased to real implementations: `path`, `process`, `events`, `url`; since layer 1 also `fs`, `fs/promises`, `original-fs`, `buffer`, `path/win32`) and `NODE_BUILTINS` (stubbed) |
| Vite plugin | `packages/tauri-electron/vite.js` | `resolve.alias` for `NODE_SHIMS`; `resolveId` + `load` produce the stub module for `NODE_BUILTINS` |
| webpack / rspack plugin | `packages/tauri-electron/webpack.cjs`, `bundler/node-builtin.cjs` | Same, through `NormalModuleReplacementPlugin`-style redirects |
| Runtime `require()` | `packages/tauri-electron/src/require.js` | `requireShim(id)` for CommonJS code in dev; `nodeBuiltin(name)` builds the throwing proxy |
| Synchronous bridge, JS | `packages/tauri-electron/src/internal/native.js` | `syncRequest(path, body)`: blocking `XMLHttpRequest` to the `tauri-electron://` scheme |
| Synchronous bridge, Rust | `crates/tauri-plugin-electron/src/lib.rs` | `handle_bridge`: routes `window-config`, `sync-ipc`, `dialog/*` |
| Features and permissions | `crates/tauri-plugin-electron/Cargo.toml`, `src/features.rs`, `build.rs`, `permissions/default.toml` | Cargo feature → plugin registration → capability for the `electron-main` window |
| End-to-end checks | `apps/kitchen-sink/src/checks*.js`, `apps/kitchen-sink/scripts/smoke.mjs` | Same checks run on Tauri and on real Electron |

The synchronous bridge is the piece that makes `fs.readFileSync` possible in a
webview. It is already used for `ipcRenderer.sendSync` and `dialog.show*Sync`.

## 3. What was verified

A throwaway prototype added a `node/<op>` route to `handle_bridge` (running
`std::fs` and `std::process::Command`) and ten checks to the kitchen sink.
It ran in the real Tauri app under Xvfb on Linux (WebKitGTK 2.52.6, Tauri 2,
debug build). The prototype was reverted afterwards.

Baseline before any change: 76 unit tests pass; kitchen-sink smoke reports
112 pass, 0 fail, 4 unsupported, 30 manual. With the prototype: 122 pass, 0 fail.

| Question | Result |
| --- | --- |
| Can the main window do a blocking request that runs Rust code and returns the result? | Yes. |
| Cost per call | 0.2 ms when Rust answers inside the handler, 0.3 ms when it answers from a spawned thread (1000 × `stat`). |
| Large files | 32 MB: write 263 ms; read 448 ms as raw bytes, 691 ms as base64. |
| Request body as `Uint8Array` / `ArrayBuffer` | Arrives intact. |
| Request body as `Blob` | **Arrives empty (0 bytes).** Never send a `Blob`. |
| Custom request header, query string, UTF-8 in both | Arrive intact (`a b/ü?&` round-trips through `?arg=`). |
| Binary response through `overrideMimeType('text/plain; charset=x-user-defined')` | Byte-exact (70 000-byte and 32 MB round trips). |
| Binary response through base64 text | Byte-exact, about 1.5 × slower than the above. |
| `xhr.responseType = 'arraybuffer'` on a synchronous request | Works on WebKitGTK. Do not rely on it: the XHR spec forbids it for documents and Chromium enforces that, so expect it to throw on Windows (WebView2). |
| UTF-8 text response | Correct with a plain `responseText` read. |
| Rust `io::Error` | `kind()` and `raw_os_error()` are available to build Node's `code` / `errno` (`NotFound`, errno 2 for a missing file). |
| `sh -c` through `std::process::Command` | Works; stdout, stderr and exit status returned. |
| Does blocking the main window freeze renderer windows? | No. While the main window was blocked for 2.4 s, a renderer window's 20 ms timer never slipped by more than 42 ms. |
| Which thread runs `handle_bridge`? | The process main thread (the GTK thread). Blocking work there freezes native UI, so slow operations must run on another thread. |

Two Vite dev-server gaps were also reproduced (Vite 8.3.6):

| Case | Result today |
| --- | --- |
| `import { readFileSync } from 'fs'` in dev | Page fails to load: `does not provide an export named 'readFileSync'`. The dev stub has only a default export. |
| A dependency in `node_modules` that does `require('util')` / `require('fs')` in dev | The plugin's `resolveId` stub is bypassed. Vite's dependency optimizer substitutes its own "externalized for browser compatibility" proxy, so `util.inspect is not a function`. `require('path')` in the same dependency works, because `path` is a `resolve.alias` entry and the optimizer honours aliases. |

A second throwaway run (also reverted) checked the later-layer ideas in the
same environment:

| Question | Result |
| --- | --- |
| Can a hidden `<iframe>` serve as a `vm` context? | Yes. `iframe.contentWindow.eval(...)` ran synchronously in about 1 ms, mutated an object shared from the main page by reference, called a function passed in from it, and kept its own globals (a global set inside was not visible outside). Arrays created inside fail `instanceof Array` outside but pass `Array.isArray`, as with Node contexts. |
| Can a Web Worker reach the synchronous bridge? | Yes: a blocking request from a worker returned status 200. Native-backed modules are therefore reachable from a `worker_threads` adapter. |
| `performance.memory` | Not available on WebKitGTK, so `v8.getHeapStatistics()` has to return zeros there. |
| `SharedArrayBuffer` | Undefined (`crossOriginIsolated` is `false`). |
| `bundle.resources` as `{ "electron-resources/": "" }` | Copies the folder's contents to the resource root: `electron-resources/app/src/data.json` appeared as `<target>/debug/app/src/data.json` and `electron-resources/extra/note.txt` as `<target>/debug/extra/note.txt`, in a debug build. |

**Not verified:** macOS (WKWebView) and Windows (WebView2). CI is Linux-only,
so the existing `sendSync` bridge is untested there too. Section 8 lists what
to check on each.

## 4. Where each built-in goes

"JS" means pure JavaScript or Web APIs with no Rust. "Rust" means new code in
`tauri-plugin-electron` reached over the synchronous bridge (sync variants)
and Tauri commands (async variants). "Plugin" means an official Tauri plugin.

| Built-in | Where | Notes |
| --- | --- | --- |
| `path`, `path/posix` | JS (exists) | POSIX only today. See `path/win32` below. |
| `path/win32` | JS | Needed once real Windows paths flow through `fs`. `path.win32` currently points at the POSIX implementation. |
| `process` | JS + Rust (exists) | Add `hrtime`, `memoryUsage`, `umask`, `uptime` as cheap extras when asked for. |
| `events`, `url` | JS (exists) | |
| `buffer` + global `Buffer` | JS | Must subclass `Uint8Array` (the `buffer` npm package does). Everything else binary depends on it. |
| `util`, `util/types` | JS | `inspect`, `format`, `promisify`, `inherits`, `types`, `TextEncoder`/`TextDecoder` re-exports. |
| `assert` | JS | |
| `string_decoder` | JS | Thin wrapper over `TextDecoder` with `stream: true`. |
| `querystring` | JS | |
| `punycode` | JS | |
| `timers`, `timers/promises` | JS | Wrap `setTimeout` & co.; `setImmediate` via `MessageChannel`. |
| `perf_hooks` | JS | `performance` global. |
| `stream`, `stream/promises` | JS | `readable-stream` or an equivalent Node-streams implementation. `fs.createReadStream` depends on it. |
| `stream/web` | JS | Re-export the webview's `ReadableStream` etc. |
| `zlib` | JS | `fflate` (sync and async, gzip / deflate / inflate). `CompressionStream` is async-only, so it cannot back the `*Sync` functions. Brotli has no browser equivalent: leave it unsupported or do it in Rust later. |
| `crypto` | JS first, Rust if needed | `randomBytes`, `randomUUID`, `getRandomValues`, `webcrypto`, `subtle` from Web Crypto. `createHash` / `createHmac` are synchronous and Web Crypto is async, so use a pure-JS hash library (`@noble/hashes`). Ciphers, `pbkdf2Sync`, `scryptSync`, key pairs: Rust later, on demand. |
| `os` | Rust (+ `plugin-os`, already a dependency) | Fetch once at startup next to `process_info` and serve synchronously from the cache: `platform`, `arch`, `type`, `release`, `version`, `hostname`, `homedir`, `tmpdir`, `EOL`, `endianness`, `userInfo`. `cpus`, `totalmem`, `freemem`, `networkInterfaces`, `loadavg`, `uptime` need a Rust command (`sysinfo` crate) or stay unsupported at first. |
| `fs`, `fs/promises` | Rust | The proof of concept. Section 6. Do not build it on `@tauri-apps/plugin-fs`: that plugin is async-only and scope-restricted, and one Rust implementation behind both the sync and async variants keeps their behaviour and errors identical. |
| `child_process` | Rust | `execSync`, `spawnSync`, `execFileSync` over the bridge on a worker thread. `spawn` / `exec` / `execFile` over a command plus a Tauri `Channel` for stdout / stderr / exit. Do not build it on `plugin-shell`: its scope model requires every command to be declared ahead of time. `fork()` stays unsupported (it needs Node). |
| `http`, `https` (client) | JS over `plugin-http` | `net.request` in `src/main/net.js` already implements `ClientRequest` / `IncomingMessage`; `http.request` / `http.get` can wrap it. |
| `http`, `https` (server), `net`, `tls`, `dgram`, `dns` | Rust, later | No official plugin. Each needs its own Rust implementation with handle tables and event channels. Defer until an app needs it. |
| `readline` | JS, partial | Only `createInterface({ input: stream })` line splitting. No terminal. |
| `worker_threads` | JS, partial, late | A partial adapter over Web Workers (section 4.2). Different semantics: no shared `require`, no worker script loaded from a real file path. Until then keep the stub with its hint. |
| `module` | JS, partial | `createRequire` returning `requireShim`, `builtinModules`. |
| `constants` | JS | Static tables (`fs.constants`, `os.constants`). |
| `vm` | JS, partial, late | A hidden iframe as the separate context (section 4.2). |
| `v8` | JS, partial, late | Small stubs for commonly called functions (`getHeapStatistics`, `serialize` / `deserialize` via structured clone). |
| `wasi` | JS, late | The webview runs WebAssembly; a JS WASI layer on top of `fs`. Low priority. |
| `cluster`, `repl`, `inspector`, `trace_events` | Unsupported | Need Node or the engine itself (section 4.2). Keep the stubs. |
| `tty`, `domain`, `async_hooks`, `diagnostics_channel`, `http2`, `sys` | See layers 3 and 4 | Minimal or partial JS versions (`async_hooks.AsyncLocalStorage`, `diagnostics_channel`) when a common dependency needs them. |
| Native `.node` addons, `asar` | Unsupported | Cannot load in a webview. The escape hatch in section 7.4 lets a user map such a package to their own module. |

### 4.1 Layers and how much of Node they cover

Node 22 exposes 54 public built-in module specifiers
(`require('module').builtinModules`, without the `_`-prefixed internals).
Work proceeds in layers; each layer is shippable on its own.

| Layer | Modules | Count | Cumulative |
| --- | --- | --- | --- |
| 0. Exists today | `path`, `path/posix`, `process`, `events`, `url` | 5 | 5 / 54 (9 %) |
| 1. Proof of concept | `fs`, `fs/promises`, `buffer`, `path/win32` | 4 | 9 / 54 (17 %) |
| 2. Major | `os`, `child_process`, `util`, `util/types`, `stream`, `stream/promises`, `crypto`, `http`, `https` (client side) | 9 | 18 / 54 (33 %) |
| 3. Smaller, mostly pure JS | `assert`, `assert/strict`, `string_decoder`, `querystring`, `punycode`, `timers`, `timers/promises`, `perf_hooks`, `stream/web`, `stream/consumers`, `zlib`, `constants`, `console`, `sys`, `module` (partial), `readline`, `readline/promises` (partial), `async_hooks` (partial), `diagnostics_channel`, `tty` (minimal), `domain` (minimal) | 21 | 39 / 54 (72 %) |
| 4. Networking in Rust, on demand | `net`, `tls`, `dns`, `dns/promises`, `dgram`, `http2`, and the server side of `http` / `https` | 6 | 45 / 54 (83 %) |
| 5. Approximations, late | `vm`, `v8`, `wasi`, `worker_threads` (section 4.2) | 4 | 49 / 54 (91 %) |
| Not planned (need Node or the engine itself) | `cluster`, `inspector`, `inspector/promises`, `repl`, `trace_events` | 5 | |

Read the percentages with care:

- They count modules, not usage. Layers 0 to 2 are the modules application
  code calls most. [TARGET-APPS.md](TARGET-APPS.md) names `fs`,
  `child_process`, `os`, `crypto` and `net` as what VS Code and GitHub
  Desktop use in the main process; the first four are in layers 1 and 2.
  No usage survey of Electron apps was done, so the ordering inside a layer
  is judgment.
- A module being "covered" does not mean every export. `fs` has 106 exports
  in Node 22; phase 1 (section 6) implements roughly 40, the ones typical
  config and data-file code uses. `crypto` (67 exports) starts with hashing
  and random values only.
- `buffer` is in layer 1 because `fs` returns `Buffer`s. `util` and `stream`
  are in layer 2 although they are pure JS, because `child_process`, `http`
  and half of npm depend on them.
- Native addons (`node-pty`, `sqlite3`, `keytar`) are outside all layers.
  The `modules` escape hatch (section 7) is the answer there.

### 4.2 The engine-level modules, and why not embed V8

Embedding V8 in Rust (the `v8` crate, "Rusty V8") was considered for the
modules that look V8-bound. It is **not** the plan, for these reasons:

- The app's JavaScript runs in the webview's engine (JavaScriptCore on macOS
  and Linux, the V8 inside WebView2 on Windows). An embedded V8 is a second
  engine with its own heap. Code run through `vm` there could not share
  objects or functions with the app, only serialized copies, and that
  sharing is what `vm` contexts are normally used for. `v8` and `inspector`
  would describe the wrong engine.
- `worker_threads`, `cluster` and `repl` do not need V8 so much as a second
  *Node*: bare V8 has no `fs`, `require` or event loop. Providing those means
  embedding a Node-compatible runtime (in Rust, effectively Deno's), which is
  bundling Node in all but name and adds tens of megabytes.
- `wasi` does not need V8 at all.

What to do instead, all in the webview:

| Module | Approach | Known limits |
| --- | --- | --- |
| `vm` | A hidden same-origin `<iframe>` per context; evaluate with the iframe's own `eval` / `Function`. Same engine, synchronous, objects shared by reference. | No `timeout`, no `breakOnSigint`, not a security boundary (neither is Node's). Needs `'unsafe-eval'` if the app sets a CSP. Objects from another context have different prototypes, as in Node. |
| `v8` | Stubs: `getHeapStatistics()` from `performance.memory` where available (zeros elsewhere; it is absent on WebKitGTK), `serialize` / `deserialize` with a structured-clone-compatible encoding, `setFlagsFromString` as a no-op. | Not the real wire format. |
| `worker_threads` | Adapter over Web Workers: `Worker`, `parentPort`, `workerData`, `isMainThread`, `MessageChannel`. The worker script must be a bundler entry. | The bridge is reachable from a worker (section 3), so native-backed modules can work there; check which window label Rust sees for a worker's request before applying the main-only guard. No `SharedArrayBuffer` (undefined in the webview without cross-origin isolation). |
| `wasi` | A JS WASI implementation over the `fs` shim. | Low priority. |

An embedded runtime stays a possible **opt-in feature for later**, to be
decided by the owner, only if `child_process.fork()`, real worker threads or
native addons turn out to be must-haves. It would stretch the "no Node"
constraint in section 1.

### 4.3 Where Node support touches the Electron API

This plan adds Node built-ins; it does not extend tauri-electron's Electron
API. These are the points where the two meet, to be handled when the
relevant layer lands:

| Point | What to do |
| --- | --- |
| Electron APIs marked unavailable only because there is no `fs` (`protocol.registerFileProtocol`, `registerStreamProtocol`, `webContents.downloadURL`, `session` downloads; see [API-COVERAGE.md](API-COVERAGE.md)) | Become implementable after layer 1. Separate, Electron-side work; update API-COVERAGE when done. |
| `original-fs` (Electron's `fs` without asar patching) | Alias it to the `fs` shim in `NODE_SHIMS` and `requireShim`. Do this with layer 1. |
| Transparent reads inside `app.asar` | Covered by the resource mapping in section 8.1. |
| `child_process.fork()`, `utilityProcess.fork()` | Both start another Node process from Electron's binary. Stay unsupported without an embedded runtime (section 4.2). |
| Renderers created with `nodeIntegration: true` | Native-backed modules need an explicit per-window grant recorded in Rust (section 8.5). The wiring is not designed yet. |
| `process` extras Electron adds (`resourcesPath`, `type`, `versions`) | Already provided by the `process` shim. |

## 5. Design

### 5.1 JavaScript layout

- One ES module per built-in under `packages/tauri-electron/src/node/`
  (`fs.js`, `fs-promises.js`, `os.js`, `buffer.js`, …). Each has **explicit
  named exports and a default export** that is the same object, so
  `import fs from 'fs'`, `import { readFileSync } from 'fs'`,
  `import * as fs from 'fs'` and `require('fs')` all work, in dev and in a build.
- Add each implemented name to `NODE_SHIMS` in `bundler/shared.cjs` and remove
  it from `NODE_BUILTINS`. Both plugins read those lists, and the Vite alias
  form is the one Vite's dependency optimizer honours (section 3).
- Add an `exports` entry per module to **both** `package.json` files (the
  repository root, which is what GitHub installs resolve, and
  `packages/tauri-electron/package.json`). `test/root-package.test.js` guards this.
- `requireShim` in `src/require.js` must return the same module objects. It is
  synchronous, so the modules it serves have to be imported statically
  somewhere. Do not import the heavy ones (`stream`, `zlib`, `crypto`) from
  `require.js` itself, because it is loaded into every renderer page. Use a
  registry (`registerNodeModule(name, exports)`) that `require.js` consults,
  and have the main-page virtual entry (`VIRTUAL.main` in `vite.js`,
  `MODULES.mainEntry` in `webpack.cjs`) import a `node/register-all.js` module.
- Renderers get the pure-JS modules only when imported. Native-backed modules
  must refuse to work outside the main window unless that window was created
  with `nodeIntegration: true` (section 8, security).

### 5.2 Bridge protocol for native-backed modules

Extend `handle_bridge` with one route family, for example `node/<module>/<op>`:

- Arguments: JSON, percent-encoded in the query string (`?a=`). The URL comes
  from `bridgeUrl()`; append the query after it, because `convertFileSrc`
  percent-encodes the path part including `?`.
- Binary input (`writeFileSync` data): the request body, sent as a
  `Uint8Array`. Never a `Blob`.
- Binary output (`readFileSync`): raw bytes, read in JS with
  `overrideMimeType('text/plain; charset=x-user-defined')` and
  `charCodeAt(i) & 0xff`. Use base64 only as a fallback if a platform fails
  the raw path.
- Errors: a non-200 status with a JSON body `{ code, errno, syscall, path, message }`.
  JS rebuilds a Node-shaped `Error` from it.
- Cheap operations (`stat`, `exists`, small reads) may answer inside the
  handler. Anything that can block (`execSync`, large files, network mounts)
  must answer from a worker thread, as `dialog/*` already does.
- Async variants (`fs.promises.*`, callback APIs) use Tauri commands with raw
  request / response bodies (`tauri::ipc::Request` raw payload,
  `tauri::ipc::Response`), not the bridge, so they never block the page.
  Share the Rust functions between both paths.

### 5.3 Rust layout and features

- New modules in `crates/tauri-plugin-electron/src/` (`node_fs.rs`, later
  `node_os.rs`, `node_child_process.rs`), each behind a Cargo feature:
  `node-fs`, `node-os`, `node-child-process`.
- **Decided: enabled for every migrated app, as explicit switches.** The node
  features are *not* part of the crate's `default` feature set. Instead the
  scaffolder (`scripts/create-app.mjs`) and the template write them out in
  the app's `src-tauri/Cargo.toml`:

  ```toml
  tauri-plugin-electron = { git = "…", features = [
    "node-fs",             # fs, fs/promises
    "node-os",             # os
    "node-child-process",  # child_process: runs arbitrary commands; delete to disable
  ] }
  ```

  A migrating user gets full compatibility without choosing anything, sees
  exactly which native capabilities the app has, and disables one by deleting
  a line. Apps that already depend on the crate do not silently gain file or
  process access on update. The by-hand steps in `docs/MIGRATING.md` must show
  the same block.
- Give each feature its own named permission set (`node-fs`, `node-os`,
  `node-child-process`) granted to `electron-main` by `features::capabilities()`,
  rather than folding the commands into `default`, so the grant is visible in
  the generated permission reference.
- For each feature, follow the existing pattern exactly: `Cargo.toml` feature,
  `features::enabled()` list (so JS can tell "feature off" from "unsupported"),
  command names in `build.rs` `COMMANDS`, `generate_handler!` in `lib.rs`,
  permissions in a per-feature set under `permissions/` (next point). When a feature is off, the JS
  module must throw `NotImplementedError` with `reason: 'feature'`, like the
  other feature-gated modules.
- The pure-JS modules need no feature.

## 6. Phase 1: `fs` proof of concept

Deliver in this order. Each step should leave the test suites green.

1. **Bridge route and guard.** `node/fs/<op>` in `handle_bridge`, main window
   only, behind `node-fs`. Add the feature plumbing from section 5.3.
2. **Rust operations.** `read`, `write` (with flags `w`, `a`, `wx`), `stat`,
   `lstat`, `exists`, `access`, `mkdir` (recursive), `readdir` (with
   `withFileTypes`), `rm` / `unlink` / `rmdir` (recursive, force), `rename`,
   `copy_file`, `realpath`, `mkdtemp`, `truncate`, `chmod`, `utimes`,
   `readlink`, `symlink`.
3. **Error mapping.** `io::ErrorKind` → Node `code` (`NotFound` → `ENOENT`,
   `PermissionDenied` → `EACCES`, `AlreadyExists` → `EEXIST`,
   `DirectoryNotEmpty` → `ENOTEMPTY`, `NotADirectory` → `ENOTDIR`,
   `IsADirectory` → `EISDIR`, …). Map by `ErrorKind` first; raw OS error
   numbers differ on Windows. Message format:
   `ENOENT: no such file or directory, open '/x'`, with `code`, `errno`
   (negative, as in Node), `syscall`, `path`.
4. **`src/node/fs.js`.** Sync API over the bridge: `readFileSync` (encoding
   option, returns `Buffer` or string), `writeFileSync`, `appendFileSync`,
   `existsSync`, `statSync` / `lstatSync` (a `Stats` class with `isFile()`,
   `isDirectory()`, `isSymbolicLink()`, `size`, `mtime`, `mtimeMs`, `mode`, …,
   and `throwIfNoEntry`), `mkdirSync`, `readdirSync` (`Dirent`), `rmSync`,
   `unlinkSync`, `rmdirSync`, `renameSync`, `copyFileSync`, `accessSync`,
   `realpathSync`, `mkdtempSync`, `constants`.
5. **Async API.** `fs.promises.*` over commands, and the callback forms as
   wrappers around the promises (errors as first argument, callbacks invoked
   asynchronously). `src/node/fs-promises.js` re-exports `fs.promises`.
6. **`buffer` and `path/win32` land in this phase** (layer 1), before step 4:
   `fs` returns `Buffer`s, and real Windows paths need a real `path.win32`
   (section 8.2).
7. **App-relative paths** (section 8.1) must be handled in this phase, or the
   most common call, `fs.readFileSync(path.join(__dirname, 'x.json'))`, fails.
8. **Tests.**
   - Unit (`packages/tauri-electron/test/`): error reconstruction, encoding
     handling, `Stats`, argument validation, feature-off behaviour, with
     `syncRequest` mocked.
   - Kitchen sink: `fs` checks that write, read back, stat, list and delete
     under `app.getPath('temp')`. They must pass unchanged on real Electron
     too (`npm run smoke -- --electron`), which is what proves parity.
   - Rust: `cargo check` with `--all-features` and `--no-default-features`.
9. **Docs.** Update `docs/MIGRATING.md` section 4, `docs/API-COVERAGE.md`
   ("CommonJS and Node.js built-ins"), the crate README feature list, and the
   comment block at the top of `vite.js`.

Phase 1 leaves out: file descriptors (`openSync` / `readSync` / `writeSync` /
`closeSync`, which need a Rust handle table), streams (need `stream`),
`fs.watch` / `watchFile` (need the `notify` crate and an event channel),
`fs.cp`, `opendir`. Stub them with `reason: 'unimplemented'`.

## 7. Later phases

These follow the layers in section 4.1.

**Layer 2: major modules.**

1. `util`, `util/types` and `stream`, `stream/promises` first: pure JS, and
   the rest of this layer depends on them.
2. `os` (`node-os`).
3. `child_process` (`node-child-process`).
4. `crypto` subset (hashing, HMAC, random values, `webcrypto`).
5. `http` / `https` client on top of the existing `net.request`.

**Layer 3: smaller modules.** `assert`, `string_decoder`, `querystring`,
`punycode`, `timers`, `perf_hooks`, `stream/web`, `stream/consumers`, `zlib`,
`constants`, `console`, `sys`, and the partial ones (`module`, `readline`,
`async_hooks`, `diagnostics_channel`, `tty`, `domain`).

**Alongside, in any order.**

- **`fs` follow-ups.** Descriptors, streams (after `stream`), `watch`.
- **Escape hatch.** A `modules` option on both bundler plugins
  (`tauriElectron({ modules: { keytar: './tauri/keytar.js' } })`) plus the
  runtime registry from 5.1, so users can map third-party or native packages
  to their own implementations without touching app code.
- **Dev-mode named exports for the remaining stubs.** The Vite plugin runs
  in Node, so it can read the real export names
  (`Object.keys(require('node:' + name))`) and emit `export const X = stub.X`
  lines, fixing the named-import failure in section 3 for modules that stay
  unsupported.

**Layer 4** (`net`, `tls`, `dns`, `dgram`, `http2`, HTTP servers) waits until
an app needs it.

Notes for the pure-JS modules:

- Third-party packages are approved (section 1): add them as regular
  `dependencies` so the user installs nothing extra. Candidates checked on
  npm, all MIT: `buffer`, `readable-stream`, `util`, `assert`, `fflate`,
  `@noble/hashes`.
- Keep the root package's `dependencies` and `files` consistent with the
  workspace package (`test/root-package.test.js`, `npm pack --dry-run`).
- Globals to install on the main page only: `Buffer`, `setImmediate`,
  `clearImmediate`, `global`.

### 7.1 Working out which native features an app needs

Not designed in detail yet. The default stays "everything on" (section 5.3);
this is the tooling that lets a user turn features off with confidence.

Three sources of truth, from cheapest to most exact:

1. **Static scan at scaffold time.** `create-app.mjs --into` already reads the
   project. Have it scan the app's own source for `require('x')` /
   `import … from 'x'` of Node built-ins (with and without `node:`) and print
   a table: module, where it is used, status on Tauri (works / needs feature
   `node-fs` / not supported). It can then write only the needed feature
   lines, with the unused ones present but commented out so they stay visible.
   Blind spot: dependencies in `node_modules` and computed `require(name)`.
2. **Exact list from the bundler.** In a production build every built-in
   import, including those inside dependencies, passes through the plugins'
   resolver (`resolveId` in `vite.js`, the redirect in `webpack.cjs`). Record
   them with their importers and write a report file
   (for example `dist/tauri-electron-node-report.json`), and print a summary:
   which features the bundle needs, which enabled features nothing imports,
   which imports are unsupported. Vite dev is not a reliable source, because
   its dependency optimizer bypasses the resolver (section 3).
3. **Run time.** A module whose feature is off already has a defined
   behaviour: `NotImplementedError` with `reason: 'feature'` naming the
   feature to enable. That catches whatever static analysis missed, such as
   an import that exists but is only called on one code path.

A small command ties these together, for example
`npx tauri-electron doctor`: it compares the bundler report with the features
in `src-tauri/Cargo.toml` and prints what to add or remove. Editing
`Cargo.toml` stays opt-in behind a flag (`--fix`); never rewrite it silently
during a build.

Limits to state in the docs: importing a module is not the same as calling it
(the report over-approximates), and a computed `require()` is invisible to
it (the run-time error covers that case). Only the three native features
need this at all; the pure-JS modules are always available and unused ones
are dropped by the bundler.

## 8. Pitfalls

### 8.1 `__dirname` is not a real directory

The bundler plugins rewrite `__dirname`, `__filename`,
`import.meta.dirname` and `fileURLToPath(import.meta.url)` to
**project-relative** paths such as `/src/main`. `loadFile`, `preload` and
`nativeImage.createFromPath` depend on that and must not change.

With a real `fs`, `fs.readFileSync(path.join(__dirname, 'config.json'))` would
ask the operating system for `/src/main/config.json`. In a production Tauri
build the frontend is embedded in the binary, so app files are not on disk at
all. `app.getAppPath()` has the same question.

#### How Electron lays files out

Electron itself has no packaging config; the packager decides. At run time
an Electron app sees two roots:

| | Development | Packaged |
| --- | --- | --- |
| `app.getAppPath()`, and `__dirname` relative to it | the project folder (where `package.json` is) | `<resources>/app.asar` (a virtual folder), or `<resources>/app` when asar is off |
| `process.resourcesPath` | Electron's own `resources` folder | the app's `resources` folder (`Contents/Resources` on macOS) |

What lands where is configured in one of two places:

| Tool | App files (inside `app.asar`) | Extra files next to it |
| --- | --- | --- |
| electron-builder (`build` in `package.json`, or `electron-builder.{yml,json,json5,toml,js,ts}`) | `files` (globs with `!` negation; default: the whole project minus dev dependencies and build output). `asarUnpack` moves matches to `app.asar.unpacked`. | `extraResources` (into `resources/`), `extraFiles` (next to the executable). Entries are a path or `{ from, to, filter }`. |
| Electron Forge / `@electron/packager` (`packagerConfig`) | the whole project minus `ignore` patterns; `asar.unpack` | `extraResource` (each path copied into `resources/` under its base name) |

#### Mapping to Tauri (decided: automatic)

Tauri's counterpart is `bundle.resources` in `tauri.conf.json`, read at run
time from `resource_dir()`. Checked in the `tauri-utils` 2.10 and
`tauri-build` sources: it accepts a `{ "source": "target" }` map, a source
may be a directory (copied recursively), and `tauri-build` also copies
resources into `target/<profile>/`, so they exist under `tauri dev` too.
`process.resourcesPath` already returns `resource_dir()` (`process_info` in
`lib.rs`).

Reuse Electron's layout under that directory:

| Electron | On Tauri | User code that keeps working |
| --- | --- | --- |
| `resources/app/…` (app files) | `<resource_dir>/app/<project-relative path>` | `fs.readFileSync(path.join(__dirname, 'x.json'))`, `path.join(app.getAppPath(), 'assets', …)` |
| `extraResources` `{ from, to }` | `<resource_dir>/<to>` | `path.join(process.resourcesPath, to)` |
| Forge `extraResource` | `<resource_dir>/<basename>` | same |
| `asarUnpack` / `app.asar.unpacked` | nothing to do: every file is already a real file | `p.replace('app.asar', 'app.asar.unpacked')` is a harmless no-op |
| `extraFiles` | no general equivalent (the resource and executable folders coincide only on Windows) | report as unsupported in the scaffolder summary |

Implementation:

1. **Staging at build time, not a file list in the config.** Tauri's resource
   globs have no negation, and a list written once by the scaffolder goes
   stale. Have the bundler plugins copy the selected files into a staging
   folder (for example `src-tauri/electron-resources/app/…` and
   `src-tauri/electron-resources/<to>/…`) on every build and dev start, and
   have the scaffolder add one static entry to `tauri.conf.json` that maps
   that folder to the resource root: `"resources": { "electron-resources/": "" }`
   (verified, section 3). The folder must exist before `tauri-build` runs
   (commit a placeholder; add the contents to `.gitignore`).
2. **Which files.** Read the Electron packaging config the project already
   has: electron-builder `files` / `extraResources`, Forge `ignore` /
   `extraResource`. Without one, stage every project file except
   `node_modules`, `src-tauri`, build output, dot-files, and the source
   types the bundler compiles (`.js`, `.ts`, `.jsx`, `.tsx`, `.css`, `.html`
   and their variants). Offer a `resources` plugin option to override.
   The scaffolder already detects Forge configs (`FORGE_CONFIGS`); it does
   not read electron-builder config yet.
3. **Path resolution in the `fs` shim.** `__dirname` stays project-relative
   (`/src/main`). When `fs` receives a path, resolve it in this order:
   - a real path (under a known real root such as `app.getPath(...)`,
     `os.homedir()`, `os.tmpdir()`, `process.cwd()`, `process.resourcesPath`,
     or anything with a Windows drive prefix) is used as is;
   - otherwise it is app-relative: map it to `<project root>/<path>` in dev
     (the plugin passes the project root through a `define`) and to
     `<resource_dir>/app/<path>` in a build.
   Write this rule down in the user docs and unit-test both branches. The
   remaining ambiguity is an absolute POSIX path outside every known root
   (`/etc/hosts`): treat it as real when the app-relative mapping does not
   exist on disk.
4. **`app.getAppPath()`** should return the same app root (`<project root>`
   in dev, `<resource_dir>/app` in a build) so that paths built from it and
   paths built from `__dirname` agree. Check what it returns today and that
   `loadFile` is unaffected.
5. Writes to app-relative paths fail in a packaged Electron app too (asar is
   read-only), so return `EROFS` / `EACCES` there rather than writing into
   the install folder.

### 8.2 Windows paths

The `path` shim is POSIX-only and `path.win32` is the same object. Real paths
on Windows (`C:\Users\…` from `app.getPath`) make `path.isAbsolute` return
`false` and `path.resolve` produce wrong results. A real `win32`
implementation is needed, selected by `process.platform`, while the
app-relative paths from 8.1 stay POSIX. `loadFile` and friends currently
assume POSIX joins; re-test them after any change to `path`.

### 8.3 Bridge transport

- Never send a `Blob` body (arrives empty on WebKitGTK).
- Do not set `responseType` on synchronous requests (section 3).
- A plain `responseText` read decodes as UTF-8 and corrupts binary; always
  use `overrideMimeType` for bytes.
- `convertFileSrc` encodes the whole path, so query strings must be appended
  after `bridgeUrl()`.
- The URL form differs per platform (`tauri-electron://localhost/…` on
  Linux / macOS, `http://tauri-electron.localhost/…` on Windows / Android).
  Always go through `bridgeUrl()`.
- An app with a strict `connect-src` Content-Security-Policy may block the
  bridge. The kitchen sink runs with `csp: null`, so this is untested; check
  it and document the directive users need.
- To verify on macOS: that WKWebView delivers POST bodies and custom headers
  to the scheme handler for synchronous requests, and the raw-bytes read. To
  verify on Windows: the same, plus that a synchronous request to
  `http://tauri-electron.localhost` is not treated as mixed content or
  blocked by CORS preflight for the custom header (the handler already
  answers `OPTIONS`). If a header or body fails on a platform, move that
  payload into the query string.

### 8.4 Threads and deadlocks

- `handle_bridge` runs on the process main thread. Slow work there freezes
  native UI on every window. Spawn a thread for anything that can block.
- While the main page waits on a synchronous call it cannot run JavaScript.
  Any Rust code that, during that call, needs an answer from the main page
  (`forward()`, used by `sync-ipc` and `protocol.handle`) will wait until the
  timeout. Native operations must never call back into the main page.
- `execSync` of a long-running command blocks the main page for its whole
  duration, as in Node. Renderers keep running (section 3) but their
  `invoke` calls to `ipcMain` queue up.

### 8.5 Security

- The bridge identifies the caller only by window label. Native routes must
  be refused unless the label is `electron-main`, and should also check that
  the main webview is showing the app's own page, so that a main window that
  somehow navigated to remote content cannot reach `fs` or `child_process`.
- Renderers must not get native-backed modules by default. Honour
  `nodeIntegration: true` only as an explicit per-window grant recorded in
  the existing `window_config` state in Rust, never on the renderer's say-so.
- Async commands need permission entries; keep them in the `default`
  permission set, which is documented as main-window only.

### 8.6 Bundler and module-shape traps

- Every shim needs named exports **and** a default export. The current dev
  stub has only a default, which is why named imports fail in dev.
- Vite's dependency optimizer ignores the plugin's `resolveId`. Anything that
  dependencies may import has to be a `resolve.alias` entry (that is, in
  `NODE_SHIMS`).
- `node:`-prefixed and bare specifiers, and subpaths (`fs/promises`,
  `util/types`, `stream/promises`, `path/posix`), all need entries. The
  alias regexes are anchored (`^(node:)?fs$`), so `fs` does not cover
  `fs/promises`.
- `require.js` is loaded in every renderer page. Importing heavy modules from
  it bloats every page and exposes them where they should not be.
- Do not install a global `module` or `exports` in renderer pages (UMD
  bundles such as jQuery would stop defining `window.X`; `installRequire`
  already documents this). Apply the same care to `global` and `Buffer`.
- webpack / rspack: redirects go through CommonJS wrapper files in
  `bundler/` (`process.cjs`, `events.cjs`). New shims need the same treatment
  where `require('x')` must return the object itself rather than a namespace.
- Keep `aliasPath: false` working (it turns `path` back into a stub).
- Production builds target `safari13` on macOS / Linux and `chrome105` on
  Windows. Polyfill packages that ship newer syntax will be transpiled, but
  ones relying on newer runtime APIs will fail at run time.

### 8.7 Behavioural fidelity

- Node error shape (`code`, `errno`, `syscall`, `path`) matters: real apps
  branch on `err.code === 'ENOENT'`.
- `Buffer` must be a `Uint8Array` subclass, and IPC serialization
  (`src/internal/serialize.js`) must keep treating it as bytes.
- Callback APIs must call back asynchronously even on immediate failure.
- `existsSync` never throws; `statSync` honours `throwIfNoEntry: false`.
- Text encodings: at least `utf8`, `utf-8`, `latin1` / `binary`, `base64`,
  `hex`, `ascii`, `utf16le`.
- The existing unsupported-module error messages are asserted in tests
  (`test/node-shims.test.js`, `test/errors.test.js`, `test/require.test.js`).
  When a module moves from stub to real, update those tests deliberately
  rather than loosening them.

## 9. Regression checklist

Run before and after every phase; all must match the baseline in section 3.

```bash
npm test
```

```bash
cargo check -p tauri-plugin-electron --all-features
```

```bash
cargo check -p tauri-plugin-electron --no-default-features
```

```bash
npm run kitchen-sink:smoke
```

```bash
npm run build --workspace tauri-electron-app -- --debug --no-bundle
```

```bash
npm pack --dry-run
```

Notes:

- The smoke run needs the Tauri Linux system packages and uses `xvfb-run`
  when there is no display. The first build takes several minutes.
- To save the smoke results as JSON, call the script directly
  (`node scripts/smoke.mjs --no-build --json out.json` in
  `apps/kitchen-sink`); through `npm run … --workspace` the `--json` flag is
  swallowed by npm. The table printed to the terminal truncates details at
  100 characters.
- CI (`.github/workflows/ci.yml`) also scaffolds an app from the packed root
  and builds its frontend. New dependencies and `exports` entries must
  survive that step.
- New kitchen-sink checks must also pass on real Electron
  (`npm run smoke -- --electron` in `apps/kitchen-sink`), since the point is
  identical behaviour.

## 10. Decisions taken

| Question | Decision |
| --- | --- |
| Is `child_process` enabled by default? | Yes for migrated apps, compatibility first, but as an explicit, named feature line in the app's `Cargo.toml` that can be deleted (section 5.3). |
| App files read through `fs` in production | Staged and bundled automatically, mirroring Electron's `resources/app` and `extraResources` layout and reading the project's existing electron-builder / Forge config (section 8.1). |
| Third-party polyfill packages | Allowed, as many as useful; shipped as dependencies of tauri-electron so the user makes no choice (section 7). |
| Order of work | Layers in section 4.1: `fs` proof of concept, then the major modules, then the smaller ones. Full Node compatibility is not a goal yet. |
