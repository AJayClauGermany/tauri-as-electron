# Electron kitchen sink

Exercises the Electron API surface, one check per API. The same source runs
on Tauri (through tauri-electron) and on real Electron, so differences show
up side by side.

- `src/checks.js` – main-process checks, plain Electron code.
- `src/renderer.js` – renderer-side checks (IPC) and the UI.
- *auto* checks run on load; *manual* ones (dialogs, notifications, tray,
  window state) run when you click **Run**. Right-click for a context menu.

```bash
npm run dev                      # interactive, on Tauri
```

```bash
npm run smoke                    # build, run every auto check, print a report (exit 1 on failures)
```

```bash
npm run smoke -- --electron      # same report from real Electron (ELECTRON_PATH or npx electron)
```

```bash
npm run start:electron           # interactive, on Electron
```

Statuses: **pass**, **fail** (threw / wrong value), **unsupported**
(`NotImplementedError` from tauri-electron), **manual** (not run yet).
On Linux without a display the smoke script uses `xvfb-run`.
