/**
 * Node built-ins in renderer windows, as Electron gives them to pages of a
 * window created with `nodeIntegration: true` and to unsandboxed preloads
 * (`sandbox: false`, the default before Electron 20 and with
 * nodeIntegration): `require('fs')`, `os`, `child_process`, `net`, …,
 * `Buffer`, `global`, `setImmediate`.
 *
 * The bundler plugins load this module in renderer pages before the
 * preload (their `rendererNode` option). It installs the Node layer only
 * when the main process created the window with Node access; the
 * operating-system calls are checked again in Rust (tauri-plugin-electron
 * accepts only windows the main process granted). Other windows keep the
 * sandboxed renderer's `require`, which explains how to reach Node over IPC.
 */
import { installNodeLayer } from '../node/install.js'
import { windowConfig } from './window-config.js'

/** Whether this page got the Node layer. */
export const hasNode = Boolean(windowConfig()?.node)

if (hasNode) installNodeLayer({ timers: false })
