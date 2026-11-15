import fs from 'node:fs'; import path from 'node:path'
const [reposDir, scanFile] = process.argv.slice(2)
const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'))
const PATS = {
  webviewTag: /<webview[\s>]|webviewTag\s*:\s*true/, views: /new (WebContentsView|BrowserView)\b|addBrowserView|contentView\.addChildView/,
  utility: /utilityProcess\.fork/, capture: /desktopCapturer|setDisplayMediaRequestHandler/, safeStorage: /safeStorage\.(encrypt|decrypt)String/,
  protoFile: /registerFileProtocol|net\.fetch\(\s*(pathToFileURL|url\.pathToFileURL|['"`]file:)|interceptFileProtocol/, protoHandle: /protocol\.handle\(/,
  webRequest: /webRequest\.on\w+\(/, cookies: /\.cookies\.(get|set|remove)\(/, download: /will-download/, certErr: /certificate-error|setCertificateVerifyProc/, login: /on\(\s*['"]login['"]/,
  fsStream: /\bcreate(Read|Write)Stream\(/, fsWatch: /\bfs\w*\.watch(File)?\(|chokidar|@parcel\/watcher/, fsFd: /\bfs\w*\.(open|openSync|fsync|fsyncSync|read|readSync|write|writeSync|fstat|fstatSync|close|closeSync)\(/,
  workerThreads: /['"](node:)?worker_threads['"]/, fork: /child_process['"][\s\S]{0,400}\bfork\(|\bcp\.fork\(|\bchildProcess\.fork\(|\bfork\(\s*(path|require\.resolve|__dirname|join)/, http2: /['"](node:)?http2['"]/, vm: /['"](node:)?vm['"]/,
  printToPDF: /printToPDF/, capturePage: /capturePage/, notifClick: /new Notification\([\s\S]{0,300}\.on\(\s*['"](click|action|reply)/,
  sendSync: /\.sendSync\(/, titleBarOverlay: /titleBarOverlay/,
}
const SKIP = /(^|\/)(node_modules|dist|build|out|vendor|test|tests|__tests__|e2e|__mocks__|fixtures|docs|\.git|coverage|\.claude)(\/|$)|\.(test|spec|d)\.[jt]sx?$|\.min\.js$/
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (SKIP.test(p)) continue; if (e.isDirectory()) yield* walk(p); else if (/\.(m?[jt]sx?|cjs|vue|html|cljs)$/.test(e.name)) yield p } }
const out = {}
for (const repo of Object.keys(scan)) {
  const hits = {}
  for (const f of walk(path.join(reposDir, repo))) { let t; try { if (fs.statSync(f).size > 800000) continue; t = fs.readFileSync(f, 'utf8') } catch { continue } for (const [k, re] of Object.entries(PATS)) if (re.test(t)) hits[k] = (hits[k] ?? 0) + 1 }
  const s = scan[repo]
  out[repo] = { hits, nodeIntegration: !!s.flags['webPreferences.nodeIntegration: true'], ctxIsoOff: !!s.flags['webPreferences.contextIsolation: false'], remote: !!s.flags['@electron/remote'], native: s.nativeDeps, libs: ['electron-updater', 'electron-store', 'electron-log', 'electron-window-state', 'electron-dl', 'electron-context-menu', '@sentry/electron'].filter((l) => s.flags[l]), nodeMods: Object.keys(s.nodeMods) }
  console.log(repo.padEnd(22), JSON.stringify(out[repo].hits), out[repo].nodeIntegration ? 'NODEINT' : '', out[repo].ctxIsoOff ? 'CTXOFF' : '', out[repo].remote ? 'REMOTE' : '', '| libs:', out[repo].libs.join(','), '| native:', s.nativeDeps.filter((n) => !['axios', 'ws', 'node-fetch', 'open', 'jszip', 'archiver', 'adm-zip', 'tar', 'iconv-lite', 'execa', 'got', 'mime', 'cross-spawn', 'shell-env', 'fix-path', 'simple-git', 'isomorphic-git', 'node-forge', 'tree-kill', 'yauzl', 'unzipper', '7zip-bin', 'electron-dl', '@electron/remote', 'auto-launch', 'electron-reload', 'electron-next', 'electron-notarize', 'electron-localshortcut', 'electron-fetch', 'electron-mksnapshot', 'sudo-prompt', '@vscode/sudo-prompt', 'node-addon-api', 'nan', 'bufferutil', 'utf-8-validate', 'node-notifier'].includes(n)).join(','))
}
fs.writeFileSync(path.join(path.dirname(scanFile), 'blockers.json'), JSON.stringify(out, null, 1))
