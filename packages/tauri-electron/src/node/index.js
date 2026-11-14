/**
 * The Node built-ins tauri-electron implements beyond path / process /
 * events / url, registered for `require()` on the main page (the bundler
 * plugins import this module first there), plus the `Buffer` global Node
 * code expects. Not loaded in renderer pages, like Node's own modules are
 * not available to a sandboxed Electron renderer.
 */
import fs from './fs.js'
import fsPromises from './fs-promises.js'
import buffer, { Buffer } from './buffer.js'
import { registerNodeModule } from '../require.js'

registerNodeModule('fs', fs)
registerNodeModule('original-fs', fs)
registerNodeModule('fs/promises', fsPromises)
registerNodeModule('buffer', buffer)

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer
