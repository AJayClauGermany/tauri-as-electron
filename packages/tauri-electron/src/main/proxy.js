/**
 * session.setProxy / app.setProxy → the proxy Tauri gives a webview when it
 * is created (`proxyUrl`, http:// or socks5:// only), so it applies to
 * windows created afterwards, and to net.fetch / session.fetch.
 *
 * Electron's `proxyRules` (`[scheme=]host:port[,…][;…]`) can name a proxy
 * per URL scheme; a webview takes one proxy for everything, so the rule
 * without a scheme wins, then `https=`, then `http=`. `pac_script`,
 * `auto_detect` and `proxyBypassRules` are not supported (warned once);
 * `direct` and `system` mean no explicit proxy.
 */
import { warnOnce } from '../internal/runtime.js'

const SCHEMES = { http: 'http', socks5: 'socks5', socks: 'socks5', socks4: 'socks5' }

/** One `[scheme://]host[:port]` entry → `{ url, type }`, or null. */
function parseProxyUri(entry) {
  const match = /^(?:([a-z0-9]+):\/\/)?([^\s/:]+|\[[^\]]+\])(?::(\d+))?\/?$/i.exec(entry.trim())
  if (!match) return null
  const scheme = (match[1] ?? 'http').toLowerCase()
  if (scheme === 'direct') return null
  const type = SCHEMES[scheme]
  if (!type) {
    warnOnce(`proxy-scheme-${scheme}`, `session.setProxy(): '${scheme}://' proxies are not supported by Tauri webviews (only http:// and socks5://); ignored.`)
    return null
  }
  if (scheme === 'socks4') warnOnce('proxy-socks4', 'session.setProxy(): socks4 proxies are used as socks5.')
  const port = match[3] ?? (type === 'http' ? '80' : '1080')
  return { url: `${type}://${match[2]}:${port}`, type, host: match[2], port: Number(port) }
}

/** Electron's proxy config → `{ url, type, host, port }` or null (direct). */
export function parseProxyConfig(config = {}) {
  if (typeof config === 'string') config = { proxyRules: config }
  const mode = config.mode ?? (config.pacScript ? 'pac_script' : config.proxyRules ? 'fixed_servers' : 'direct')
  if (mode === 'pac_script' || mode === 'auto_detect') {
    warnOnce(`proxy-${mode}`, `session.setProxy({ mode: '${mode}' }) is not supported in tauri-electron (webviews take one fixed proxy); using no explicit proxy.`)
    return null
  }
  if (mode !== 'fixed_servers') return null
  if (config.proxyBypassRules) warnOnce('proxy-bypass', 'session.setProxy(): proxyBypassRules are ignored; Tauri webviews proxy every request.')
  const rules = {}
  for (const rule of String(config.proxyRules ?? '').split(';').map((r) => r.trim()).filter(Boolean)) {
    const eq = rule.indexOf('=')
    const scheme = eq > 0 && !rule.slice(0, eq).includes('/') ? rule.slice(0, eq).trim().toLowerCase() : ''
    const list = scheme ? rule.slice(eq + 1) : rule
    const first = list.split(',').map(parseProxyUri).find(Boolean)
    if (first && !(scheme in rules)) rules[scheme] = first
  }
  const chosen = rules[''] ?? rules.https ?? rules.http ?? Object.values(rules)[0] ?? null
  if (chosen && new Set(Object.values(rules).map((r) => r.url)).size > 1) {
    warnOnce('proxy-per-scheme', `session.setProxy(): Tauri webviews take one proxy for every scheme; using ${chosen.url}.`)
  }
  return chosen
}

/** What `resolveProxy(url)` reports: `PROXY host:port`, `SOCKS5 host:port` or `DIRECT`. */
export function describeProxy(proxy, url) {
  if (!proxy) return 'DIRECT'
  if (url && /^(?:file|data|blob|tauri|about):/i.test(String(url))) return 'DIRECT'
  return `${proxy.type === 'socks5' ? 'SOCKS5' : 'PROXY'} ${proxy.host}:${proxy.port}`
}
