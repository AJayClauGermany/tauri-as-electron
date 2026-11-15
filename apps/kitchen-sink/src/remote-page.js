// Loaded by remote.html, a window created with nodeIntegration: true and
// contextIsolation: false, so the page itself has require(), as in Electron.
// `remoteChecks()` is run by checks-wave-b-renderer.js over executeJavaScript.
const remote = require('@electron/remote')

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

window.remoteChecks = async (expected) => {
  const win = remote.getCurrentWindow()
  assert(win.id === expected.windowId, `getCurrentWindow().id ${win.id}`)
  assert(remote.getCurrentWebContents().id === win.webContents.id, 'getCurrentWebContents()')
  assert(remote.app.getName() === expected.appName, `app.getName() ${remote.app.getName()}`)
  assert(remote.getGlobal('kitchenRemote').answer === 42, 'getGlobal')
  assert(remote.require('path').join('a', 'b') === expected.joined, 'require(path)')
  assert(remote.process.platform === expected.platform, 'process.platform')
  assert(remote.screen.getPrimaryDisplay().bounds.width > 0, 'screen')
  // Properties are live: assignments reach the main process.
  win.setTitle('remote title')
  assert(win.getTitle() === 'remote title', `title ${win.getTitle()}`)
  // Renderer callbacks are called back (asynchronously).
  const got = new Promise((resolve) => win.once('kitchen-remote', (_event, value) => resolve(value)))
  remote.getGlobal('kitchenRemote').emitOn(win, 7)
  assert((await got) === 7, 'callback argument')
  // Promises returned by main-process functions resolve here.
  assert((await remote.getGlobal('kitchenRemote').later('done')) === 'done', 'promise')
  // Classes construct in the main process; objects passed back are the same objects there.
  const menu = new remote.Menu()
  menu.append(new remote.MenuItem({ label: 'Remote item', click: () => {} }))
  assert(menu.items.length === 1 && menu.items[0].label === 'Remote item', 'Menu / MenuItem')
  assert(remote.getGlobal('kitchenRemote').same(win, remote.BrowserWindow.fromId(win.id)), 'object identity')
  // Errors thrown in the main process are thrown here.
  let message = ''
  try {
    remote.getGlobal('kitchenRemote').fail()
  } catch (error) {
    message = error.message
  }
  assert(message.includes('remote boom'), `error ${message}`)
  return 'ok'
}
