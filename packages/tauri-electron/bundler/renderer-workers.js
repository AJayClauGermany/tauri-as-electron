// Loaded in renderer pages after bundler/renderer-node.js under the webpack /
// rspack plugin: where worker_threads workers come from, in windows with Node.
// Separate from renderer-node.js, which the trusted-origins renderer script
// (bundler/trusted.cjs) also imports: those pages are not on the app's
// origin, which serves the worker bundle, so that script builds no worker.
import { hasNode } from '../src/renderer/node.js'
import { installWorkerRegistry } from './worker-registry.js'

if (hasNode) installWorkerRegistry()
