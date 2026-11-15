// Scan Electron app repositories for Electron API usage.
// usage: node scan.mjs <electron.d.ts> <reposDir> <out.json>
import fs from 'node:fs'
import path from 'node:path'

const [dts, reposDir, outFile] = process.argv.slice(2)

// ---------- catalog from electron.d.ts ----------
const src = fs.readFileSync(dts, 'utf8').split('\n')
const STATICS = new Set()
const types = {} // type -> { members:Set, events:Set, extends }
let cur = null
for (const line of src) {
  let m = line.match(/^  (?:class|interface) (\w+)(?: extends ([\w.]+))?/)
  if (m) { cur = types[m[1]] ??= { members: new Set(), events: new Set(), extends: m[2] }; continue }
  if (/^  }/.test(line)) { cur = null; continue }
  if (!cur) continue
  m = line.match(/^    (?:on|once|addListener)\(event: '([\w-]+)'/)
  if (m) { cur.events.add(m[1]); continue }
  m = line.match(/^    (static )?(?:readonly )?(\w+)\??[(:<]/)
  if (m && !['on', 'once', 'off', 'addListener', 'removeListener', 'constructor'].includes(m[2])) { cur.members.add(m[2]); if (m[1]) STATICS.add(m[2]) }
}
const all = (t, k) => { const s = new Set(); for (let x = types[t]; x; x = types[x.extends?.replace(/^.*\./, '')]) for (const v of x[k]) s.add(v); return s }
// module export -> type
const modules = {}
for (const line of src) {
  const m = line.match(/^    (?:const|class) (\w+)(?:: (?:typeof )?(\w+))?/)
  if (m && /^[a-zA-Z]/.test(m[1])) modules[m[1]] = m[2] ?? m[1]
}
for (const c of ['BrowserWindow', 'BaseWindow', 'Menu', 'MenuItem', 'Tray', 'Notification', 'MessageChannelMain', 'BrowserView', 'WebContentsView', 'TouchBar', 'ShareMenu', 'ClipboardItem', 'NativeImage', 'View', 'ImageView']) if (types[c]) modules[c] ??= c
modules.webContents = 'WebContents'; modules.session = 'Session'; modules.nativeImage = 'NativeImage'; modules.utilityProcess = 'UtilityProcess'; modules.webFrameMain = 'WebFrameMain'

// ---------- per-file scan ----------
const EXT = /\.(m?[jt]sx?|cjs|cljs|vue|svelte)$/
const SKIP = /(^|\/)(node_modules|dist|build|out|vendor|test|tests|__tests__|e2e|__mocks__|mocks|fixtures|docs|examples?|\.git|coverage|release|static\/js)(\/|$)|\.(test|spec|d)\.[jt]sx?$|\.min\.js$/
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (SKIP.test(p.slice(reposDir.length))) continue
    if (e.isDirectory()) yield* walk(p)
    else if (EXT.test(e.name)) yield p
  }
}
const IMPORT_RE = /['"]electron(?:\/(?:main|renderer|common|utility))?['"]/
// generic method names too ambiguous to attribute to BrowserWindow / WebContents instances
const STOP = new Set('on once off emit close show hide focus blur send get set has delete remove destroy toString reload stop setTitle getTitle isDestroyed then catch call apply bind push map filter find forEach keys values entries join resolve reject log error warn info debug start setTimeout addListener removeListener removeAllListeners listeners listenerCount length name id url title print paste copy cut undo redo insertText replace findIndex includes indexOf postMessage loadURL'.split(' '))
const GENERIC_EV = new Set(['error', 'exit', 'message', 'close', 'data', 'end', 'spawn', 'click'])
const winMembers = all('BrowserWindow', 'members')
const wcMembers = all('WebContents', 'members')
const sessMembers = all('Session', 'members')
const instEvents = { BrowserWindow: all('BrowserWindow', 'events'), WebContents: all('WebContents', 'events'), Tray: all('Tray', 'events'), Notification: all('Notification', 'events'), Menu: all('Menu', 'events'), MessagePortMain: all('MessagePortMain', 'events'), UtilityProcess: all('UtilityProcess', 'events'), DownloadItem: all('DownloadItem', 'events'), WebviewTag: new Set() }

function scanFile(file, text, hit) {
  const binds = {} // local name -> module export name, or '*' for namespace
  const isClj = file.endsWith('.cljs')
  if (isClj) {
    for (const m of text.matchAll(/\["electron"([^\]]*\[[^\]]*\])?[^\]]*\]/g)) {
      const refer = m[0].match(/:refer \[([^\]]*)\]/); if (refer) for (const n of refer[1].trim().split(/\s+/)) if (modules[n]) binds[n] = n
      const as = m[0].match(/:as (\S+?)\]?$/) ?? m[0].match(/:as ([\w-]+)/); if (as) binds[as[1]] = '*'
    }
  } else {
    for (const m of text.matchAll(/import\s+(?:type\s+)?([\w$]+\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*['"]electron(?:\/\w+)?['"]/g)) {
      if (/^import\s+type/.test(m[0])) continue
      if (m[1]) binds[m[1].replace(/[\s,]/g, '')] = '*'
      if (m[2]) for (const part of m[2].split(',')) { const [a, b] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/); if (a && modules[a]) binds[(b ?? a).trim()] = a }
      if (m[3]) binds[m[3]] = '*'
      if (m[4]) binds[m[4]] = '*'
    }
    for (const m of text.matchAll(/(?:const|let|var)\s+(?:\{([^}]*)\}|([\w$]+))\s*=\s*(?:require\(['"]electron(?:\/\w+)?['"]\)|window\.require\(['"]electron['"]\))/g)) {
      if (m[1]) for (const part of m[1].split(',')) { const [a, b] = part.trim().split(/\s*:\s*/); if (a && modules[a]) binds[(b ?? a).trim()] = a }
      if (m[2]) binds[m[2]] = '*'
    }
    for (const m of text.matchAll(/require\(['"]electron['"]\)\.(\w+)/g)) if (modules[m[1]]) hit(`${m[1]}`, '') // direct
    // const { app } = electron
    for (const [ns] of Object.entries(binds).filter(([, v]) => v === '*')) for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*${ns.replace('$', '\\$')}\\b`, 'g')))
      for (const part of m[1].split(',')) { const [a, b] = part.trim().split(/\s*:\s*/); if (a && modules[a]) binds[(b ?? a).trim()] = a }
  }
  const esc = (s) => s.replace(/\$/g, '\\$')
  const resolveModule = (local, member) => binds[local] === '*' ? member : binds[local]
  for (const [local, mod] of Object.entries(binds)) {
    if (isClj) {
      const target = mod === '*' ? null : mod
      if (target) {
        hit(target, '')
        for (const m of text.matchAll(new RegExp(`\\(\\.(\\w+)\\s+${esc(local)}\\b(?:\\s+"([\\w-]+)")?`, 'g'))) {
          const t = all(modules[target], 'members')
          if (['on', 'once'].includes(m[1]) && m[2]) hit(target, `on('${m[2]}')`)
          else if (t.has(m[1])) hit(target, m[1])
        }
        for (const m of text.matchAll(new RegExp(`\\b${esc(local)}/(\\w+)`, 'g'))) hit(target, m[1])
      } else {
        for (const m of text.matchAll(new RegExp(`\\(?\\.\\-?(\\w+)\\s+${esc(local)}\\b`, 'g'))) if (modules[m[1]]) hit(m[1], '')
      }
      continue
    }
    const re = mod === '*'
      ? new RegExp(`\\b${esc(local)}\\.(\\w+)(?:\\.(\\w+))?(?:\\(\\s*['"]([\\w-]+)['"])?`, 'g')
      : new RegExp(`(?<![\\w$.])${esc(local)}(?:\\.(\\w+))?(?:\\(\\s*['"]([\\w-]+)['"])?`, 'g')
    for (const m of text.matchAll(re)) {
      let modName, member, evArg
      if (mod === '*') { modName = m[1]; member = m[2]; evArg = m[3] } else { modName = mod; member = m[1]; evArg = m[2] }
      if (!modules[modName]) continue
      const t = modules[modName]
      if (!member) { hit(modName, ''); continue }
      if (['on', 'once', 'addListener', 'prependListener'].includes(member)) { hit(modName, evArg && all(t, 'events').has(evArg) ? `on('${evArg}')` : 'on'); continue }
      if (all(t, 'members').has(member) || member === 'remote') hit(modName, member)
      else hit(modName, '')
    }
    // new BrowserWindow / new Tray / ...
  }
  if (isClj) {
    for (const m of text.matchAll(/\(\.(\w+)\s+(?:\(\.-webContents\s+[\w-]+\)|[\w-]*web-?contents[\w-]*)/gi)) if (wcMembers.has(m[1])) hit('WebContents#', m[1])
    for (const m of text.matchAll(/\(\.on\s+[\w-]+\s+"([\w-]+)"/g)) for (const [cls, evs] of Object.entries(instEvents)) if (evs.has(m[1])) hit(`${cls}#`, `on('${m[1]}')`)
    for (const m of text.matchAll(/\(\.(\w+)\s+(?:win|window|main-window|\^js win|[\w-]*win)\b/g)) if (winMembers.has(m[1]) && !STOP.has(m[1])) hit('BrowserWindow#', m[1])
    return
  }
  // Instance usage
  for (const m of text.matchAll(/(?:\bwebContents|\bcontents|\bsender|\bwc|\bwebview)\??\.(\w+)(?:\(\s*['"]([\w-]+)['"])?/g)) {
    if (['on', 'once', 'addListener'].includes(m[1]) && m[2]) { if (instEvents.WebContents.has(m[2])) hit('WebContents#', `on('${m[2]}')`) }
    else if (wcMembers.has(m[1])) hit('WebContents#', m[1])
  }
  for (const m of text.matchAll(/(?:defaultSession|\bsession|\bses|fromPartition\([^)]*\))\??\.(\w+)(?:\.(\w+))?/g)) {
    if (m[1] === 'webRequest' && m[2]) hit('Session#', `webRequest.${m[2]}`)
    else if (m[1] === 'cookies' && m[2]) hit('Session#', `cookies.${m[2]}`)
    else if (m[1] === 'protocol' && m[2]) hit('Session#', `protocol.${m[2]}`)
    else if (sessMembers.has(m[1]) && !['on', 'once'].includes(m[1])) hit('Session#', m[1])
  }
  for (const m of text.matchAll(/\.(\w+)\s*\(/g)) if (winMembers.has(m[1]) && !STOP.has(m[1]) && !wcMembers.has(m[1]) && !STATICS.has(m[1])) hit('BrowserWindow#', m[1])
  for (const m of text.matchAll(/\.(?:on|once|addListener)\(\s*['"]([\w-]+)['"]/g)) {
    if (GENERIC_EV.has(m[1]) && !/webContents|contents|sender|win|window|tray|notification|child|proc|port/i.test(text.slice(Math.max(0, m.index - 30), m.index))) continue
    const owners = Object.entries(instEvents).filter(([, evs]) => evs.has(m[1])).map(([c]) => c)
    if (owners.includes('WebContents') && /webContents|contents|sender|webview/i.test(text.slice(Math.max(0, m.index - 40), m.index))) { hit('WebContents#', `on('${m[1]}')`); continue }
    const before = text.slice(Math.max(0, m.index - 40), m.index)
    if (owners.length === 1 && owners[0] === 'DownloadItem' && !/item|download/i.test(before)) continue
    if (owners.length === 1 && owners[0] === 'UtilityProcess' && !/utility/i.test(before)) continue
    if (owners.length === 1) hit(`${owners[0]}#`, `on('${m[1]}')`)
    else if (owners.includes('BrowserWindow')) hit('BrowserWindow#', `on('${m[1]}')`)
  }
}

// options and features that matter beyond API calls
const FLAG_RES = {
  'webPreferences.nodeIntegration: true': /nodeIntegration\s*:\s*true/,
  'webPreferences.contextIsolation: false': /contextIsolation\s*:\s*false/,
  'webPreferences.sandbox: false': /sandbox\s*:\s*false/,
  'webPreferences.webviewTag: true': /webviewTag\s*:\s*true/,
  'webPreferences.nodeIntegrationInSubFrames': /nodeIntegrationInSubFrames\s*:\s*true/,
  'webPreferences.nodeIntegrationInWorker': /nodeIntegrationInWorker\s*:\s*true/,
  'webPreferences.webSecurity: false': /webSecurity\s*:\s*false/,
  'webPreferences.preload': /\bpreload\s*:/,
  'webPreferences.partition': /\bpartition\s*:\s*[`'"\w]/,
  'webPreferences.additionalArguments': /additionalArguments\s*:/,
  '@electron/remote': /['"]@electron\/remote(?:\/main|\/renderer)?['"]|electron\.remote\b|enableRemoteModule\s*:\s*true/,
  '<webview> tag': /<webview[\s>]/,
  'titleBarStyle: hidden*': /titleBarStyle\s*:\s*['"]hidden/,
  'frame: false': /\bframe\s*:\s*false/,
  'transparent: true': /\btransparent\s*:\s*true/,
  'vibrancy / backgroundMaterial': /\bvibrancy\s*:|backgroundMaterial\s*:/,
  'trafficLightPosition': /trafficLightPosition/,
  '-webkit-app-region': /-webkit-app-region|WebkitAppRegion|webkitAppRegion/,
  'process.type checks': /process\.type\b/,
  'ipcRenderer.sendSync': /\.sendSync\(/,
  'electron-store': /['"]electron-store['"]/,
  'electron-updater': /['"]electron-updater['"]/,
  'electron-log': /['"]electron-log(?:\/\w+)?['"]/,
  'electron-window-state': /['"]electron-window-state['"]/,
  'electron-context-menu': /['"]electron-context-menu['"]/,
  'electron-dl': /['"]electron-dl['"]/,
  'electron-is-dev': /['"]electron-is-dev['"]/,
  'electron-squirrel-startup': /['"]electron-squirrel-startup['"]/,
  'update-electron-app': /['"]update-electron-app['"]/,
  'electron-devtools-installer': /['"]electron-devtools-installer['"]/,
  'electron-unhandled': /['"]electron-unhandled['"]/,
  '@sentry/electron': /['"]@sentry\/electron(?:\/\w+)?['"]/,
  'electron-trpc / electron-ipc libs': /['"](electron-trpc|@electron-toolkit\/[\w-]+|electron-better-ipc|electron-ipc-cat)['"]/,
  }
const NODE_RE = /(?:require\(|from\s+|import\()\s*['"](?:node:)?(fs|fs\/promises|path|os|child_process|crypto|http|https|net|tls|dns|dgram|url|util|events|stream|zlib|worker_threads|vm|readline|assert|buffer|process|cluster|v8|http2|module|perf_hooks|string_decoder|querystring|timers|async_hooks|tty|inspector)['"]/g
const NATIVE = ['node-pty', '@lydell/node-pty', 'better-sqlite3', 'sqlite3', '@vscode/sqlite3', 'keytar', 'sharp', 'node-hid', 'serialport', 'usb', 'robotjs', '@nut-tree/nut-js', 'ffi-napi', 'ref-napi', 'koffi', 'native-keymap', 'node-mac-permissions', 'macos-alias', 'windows-registry', 'winreg', 'registry-js', 'native-reg', 'fsevents', '@parcel/watcher', 'chokidar', 'nodegit', 'dugite', 'leveldown', 'classic-level', 'node-machine-id', 'drivelist', 'electron-native-auth', 'canvas', '@napi-rs/canvas', 'argon2', 'bcrypt', 'node-notifier', 'zeromq', 'grpc', '@grpc/grpc-js', 'ws', 'node-fetch', 'axios', 'got', 'electron-fetch', 'iconv-lite', 'font-list', 'node-window-manager', 'active-win', 'get-windows', 'uiohook-napi', 'macos-notification-state', 'windows-focus-assist', 'clipboard-event', 'node-gyp-build', 'bufferutil', 'utf-8-validate', '@signalapp/libsignal-client', '@signalapp/ringrtc', '@signalapp/better-sqlite3', 'fs-xattr', 'node-addon-api', 'electron-mksnapshot', 'nan', 'cpu-features', 'ssh2', 'pg', 'mysql2', 'oracledb', 'mssql', 'tedious', 'duckdb', 'mongodb', 'redis', 'ioredis', 'cassandra-driver', '@duckdb/node-api', 'rclone', 'win-ca', 'mac-ca', 'system-ca', 'node-forge', 'keyboard-layout', 'node-ipc', 'electron-edge-js', 'matrix-seshat', 'mime', 'cross-spawn', 'execa', 'shell-env', 'fix-path', 'sudo-prompt', '@vscode/sudo-prompt', 'electron-sudo', 'auto-launch', '@aptabase/electron', 'electron-reload', 'electron-serve', 'electron-next', '@electron/remote', 'menubar', 'electron-localshortcut', 'electron-spellchecker', 'tar', 'yauzl', 'adm-zip', 'unzipper', 'archiver', 'jszip', '7zip-bin', 'node-7z', 'electron-dl', 'trash', 'open', 'opn', 'node-schedule', 'bonjour', 'bonjour-service', 'mdns', 'git', 'simple-git', 'isomorphic-git', 'electron-notarize', 'tree-kill', 'ps-list', 'pidusage', 'systeminformation', 'node-disk-info', 'check-disk-space', 'diskusage', 'electron-findbar']

const result = {}
for (const repo of fs.readdirSync(reposDir).sort()) {
  const root = path.join(reposDir, repo)
  if (!fs.statSync(root).isDirectory()) continue
  const apis = {}, flags = {}, nodeMods = {}, files = []
  const hit = (mod, member) => { const k = member ? `${mod}${mod.endsWith('#') ? '' : '.'}${member}` : mod; apis[k] = (apis[k] ?? 0) + 1 }
  const deps = new Set()
  for (const f of walk(root)) {
    let text
    try { if (fs.statSync(f).size > 600_000) continue; text = fs.readFileSync(f, 'utf8') } catch { continue }
    const usesElectron = IMPORT_RE.test(text) && /require\(\s*['"]electron|from\s+['"]electron|"electron"|import\(['"]electron/.test(text)
    for (const [k, re] of Object.entries(FLAG_RES)) if (re.test(text) && (usesElectron || k.startsWith('webPreferences') || k.includes('<webview>') || k.startsWith('electron') || k.startsWith('@') || k === '-webkit-app-region' || k.startsWith('titleBar') || k.startsWith('frame') || k.startsWith('transparent'))) (flags[k] ??= []).push(path.relative(root, f))
    if (!usesElectron) continue
    files.push(path.relative(root, f))
    scanFile(f, text, hit)
    for (const m of text.matchAll(NODE_RE)) nodeMods[m[1]] = (nodeMods[m[1]] ?? 0) + 1
  }
  // dependencies from every package.json (not node_modules)
  let electronVersion = null
  const pkgs = []
  ;(function findPkg(dir, depth) {
    if (depth > 4) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) findPkg(p, depth + 1)
      else if (e.name === 'package.json' || e.name === 'deps.edn' || e.name === 'shadow-cljs.edn') pkgs.push(p)
    }
  })(root, 0)
  for (const p of pkgs) {
    if (!p.endsWith('package.json')) continue
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const [n, v] of Object.entries(j[k] ?? {})) { deps.add(n); if (n === 'electron' && !electronVersion) electronVersion = v }
    } catch {}
  }
  result[repo] = { files: files.length, electronVersion, apis, flags: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v.length])), flagFiles: flags, nodeMods, nativeDeps: NATIVE.filter((n) => deps.has(n)), electronDeps: [...deps].filter((d) => /electron/.test(d) && d !== 'electron') }
}
fs.writeFileSync(outFile, JSON.stringify(result, null, 1))
console.log(Object.entries(result).map(([r, v]) => `${r}: ${v.files} files, ${Object.keys(v.apis).length} apis, electron ${v.electronVersion}`).join('\n'))
