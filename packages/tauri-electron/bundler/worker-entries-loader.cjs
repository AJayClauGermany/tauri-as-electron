// webpack / rspack loader for bundler/worker-entries.js: the app's worker
// scripts as lazy chunks of the worker bundle (see bundler/worker-entry.js).
'use strict'

const { workerEntriesSource } = require('./shared.cjs')

module.exports = function workerEntriesLoader() {
  const { entries = [] } = this.getOptions?.() ?? this.query ?? {}
  return workerEntriesSource(entries)
}
