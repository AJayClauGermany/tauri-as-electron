// Dev only, first module of the hidden main-process page under the webpack /
// rspack plugin: mirrors its console to the terminal running the build (the
// window has no visible devtools; Electron developers expect main-process logs
// there). Kept dependency-free so it also reports errors thrown while the rest
// loads. The plugin writes the address of its log listener into
// electron-main.html.
const endpoint = document.querySelector('meta[name="tauri-electron-log"]')?.content

function send(level, args) {
  const text = args
    .map((a) => {
      if (a instanceof Error) return a.stack || String(a)
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  fetch(endpoint, { method: 'POST', body: JSON.stringify({ level, text }) }).catch(() => {})
}

if (endpoint) {
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      original(...args)
      send(level, args)
    }
  }
  addEventListener('error', (e) => send('error', [e.error || e.message]))
  addEventListener('unhandledrejection', (e) => send('error', ['Unhandled rejection:', e.reason]))
}
