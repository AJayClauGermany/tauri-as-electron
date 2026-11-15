/**
 * The main page's Node layer: every built-in tauri-electron implements,
 * registered for `require()`, plus Node's globals (see ./install.js). The
 * bundler plugins import this module first on the main page.
 */
import { registerNodeModule } from '../require.js'
import electronUpdater from '../main/electron-updater.js'
import { installNodeLayer } from './install.js'

installNodeLayer()

// Not a built-in: electron-builder's updater, for require('electron-updater') in CommonJS main code.
registerNodeModule('electron-updater', electronUpdater)
