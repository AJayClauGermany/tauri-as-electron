/**
 * The main page's Node layer: every built-in tauri-electron implements,
 * registered for `require()`, plus Node's globals (see ./install.js). The
 * bundler plugins import this module first on the main page.
 */
import { installNodeLayer } from './install.js'

installNodeLayer()
