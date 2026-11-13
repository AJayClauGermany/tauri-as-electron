// First module of the hidden main-process page under the webpack / rspack
// plugin: a global require() (for dynamic require calls the bundler leaves
// alone) plus `module` / `exports`, like the Vite plugin's main entry.
import { installRequire } from '../src/require.js'

installRequire({ moduleGlobals: true })
