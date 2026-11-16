// webpack / rspack: where worker_threads workers come from (see
// src/node/worker-threads.js), for bundler/main-node.js and
// bundler/renderer-node.js. webpack turns the `new Worker(new URL(...))`
// below into a worker bundle of bundler/worker-entry.js; when the app does
// not use worker threads, __TAURI_ELECTRON_WORKERS__ is `false` (DefinePlugin)
// and the branch, worker bundle included, is left out.
/* eslint-disable no-undef */
export function installWorkerRegistry() {
  if (__TAURI_ELECTRON_WORKERS__) {
    if (globalThis.__TAURI_ELECTRON_WORKERS__) return
    globalThis.__TAURI_ELECTRON_WORKERS__ = {
      ...__TAURI_ELECTRON_WORKERS__,
      type: 'classic',
      url: null,
      create: (options) => new Worker(new URL('./worker-entry.js', import.meta.url), { name: options?.name }),
    }
  }
}
