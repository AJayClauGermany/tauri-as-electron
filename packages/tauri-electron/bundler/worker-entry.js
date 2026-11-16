// The script of every worker_threads worker, bundled as a Web Worker by the
// Vite and webpack / rspack plugins. Only the dependency-free bootstrap runs
// at once; the Node layer and the worker script load after the window's
// 'init' message (see src/worker/bootstrap.js), as lazy chunks.
import { start } from '../src/worker/bootstrap.js'
import loadEntry from './worker-entries.js'

start(() => import('../src/worker/runtime.js').then((runtime) => runtime.run(loadEntry)))
