/**
 * A tiny `process` global for code written for Electron's main process.
 *
 * The most common use by far is `process.platform === 'darwin'` in the
 * `window-all-closed` handler. `@tauri-apps/plugin-os` exposes the platform
 * synchronously (it is injected by the plugin's init script), so these values
 * are available immediately.
 */
import { platform as osPlatform, arch as osArch, version as osVersion } from '@tauri-apps/plugin-os'
import { exit as processExit } from '@tauri-apps/plugin-process'
import { inTauri } from './internal/runtime.js'

const PLATFORM_MAP = { macos: 'darwin', windows: 'win32', linux: 'linux', ios: 'ios', android: 'android' }
const ARCH_MAP = { x86_64: 'x64', x86: 'ia32', aarch64: 'arm64', arm: 'arm', riscv64: 'riscv64' }

function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function guessPlatform() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Mac/.test(ua)) return 'darwin'
  if (/Win/.test(ua)) return 'win32'
  return 'linux'
}

export const platform = inTauri ? safe(() => PLATFORM_MAP[osPlatform()] ?? osPlatform(), guessPlatform()) : guessPlatform()
export const arch = inTauri ? safe(() => ARCH_MAP[osArch()] ?? osArch(), 'x64') : 'x64'

const exitHandlers = []

export const processShim = {
  platform,
  arch,
  type: 'browser',
  env: {},
  argv: [],
  execPath: '',
  pid: 0,
  versions: { 'tauri-electron': '0.1.0' },
  resourcesPath: '',
  defaultApp: false,
  sandboxed: false,
  contextIsolated: false,
  cwd: () => '/',
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  on(name, fn) {
    if (name === 'exit') exitHandlers.push(fn)
    return processShim
  },
  once(name, fn) {
    return processShim.on(name, fn)
  },
  off() {
    return processShim
  },
  removeListener() {
    return processShim
  },
  emitWarning: (warning) => console.warn(warning),
  exit(code = 0) {
    for (const fn of exitHandlers) fn(code)
    processExit(code)
  },
  hrtime: Object.assign(
    (prev) => {
      const now = performance.now()
      const sec = Math.floor(now / 1000)
      const ns = Math.floor((now % 1000) * 1e6)
      return prev ? [sec - prev[0], ns - prev[1]] : [sec, ns]
    },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  ),
  uptime: () => performance.now() / 1000,
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
  // Electron additions (renderer & main)
  getProcessMemoryInfo: () => Promise.resolve({ residentSet: 0, private: 0, shared: 0 }),
  getSystemMemoryInfo: () => ({ total: 0, free: 0 }),
  getHeapStatistics: () => ({ totalHeapSize: 0, totalHeapSizeExecutable: 0, totalPhysicalSize: 0, totalAvailableSize: 0, usedHeapSize: 0, heapSizeLimit: 0, mallocedMemory: 0, peakMallocedMemory: 0, doesZapGarbage: false }),
  getBlinkMemoryInfo: () => ({ allocated: 0, total: 0 }),
  getCPUUsage: () => ({ percentCPUUsage: 0, idleWakeupsPerSecond: 0 }),
  getCreationTime: () => (typeof performance !== 'undefined' ? performance.timeOrigin : Date.now()),
  takeHeapSnapshot: () => false,
  crash() {},
  hang() {},
  setFdLimit() {},
  mas: false,
  windowsStore: false,
  getSystemVersion: () => (inTauri ? safe(osVersion, '') : ''),
}

/**
 * Fill in what only the native side knows (tauri-plugin-electron):
 * argv, env, execPath, pid, cwd. `type` is 'browser' in the main process
 * and 'renderer' in windows, like Electron.
 */
export function applyProcessInfo(info, extra = {}) {
  const target = installProcessShim()
  if (!info) return target
  if (Array.isArray(info.argv)) target.argv = [...info.argv]
  if (info.env) Object.assign(target.env, info.env)
  if (info.execPath) target.execPath = info.execPath
  if (info.pid) target.pid = info.pid
  if (info.cwd) target.cwd = () => info.cwd
  if (info.resourcesPath) target.resourcesPath = info.resourcesPath
  Object.assign(target, extra)
  return target
}

/** Install `globalThis.process` unless something (e.g. a bundler) already did. */
export function installProcessShim() {
  if (typeof globalThis.process === 'undefined' || !globalThis.process.platform) {
    const existingEnv = globalThis.process?.env
    globalThis.process = processShim
    if (existingEnv) Object.assign(processShim.env, existingEnv)
  }
  return globalThis.process
}

export default processShim
