/**
 * Node's `os.constants.signals` for the platform the app runs on, and the
 * lookups `child_process` needs (`'SIGTERM'` ⇄ 15).
 */
import { platform } from '../process.js'

const LINUX = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17,
  SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
  SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
}

const DARWIN = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 10, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: 30, SIGSEGV: 11, SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 20, SIGCONT: 19,
  SIGSTOP: 17, SIGTSTP: 18, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 16, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
  SIGPROF: 27, SIGWINCH: 28, SIGIO: 23, SIGINFO: 29, SIGSYS: 12,
}

const WIN32 = { SIGHUP: 1, SIGINT: 2, SIGILL: 4, SIGABRT: 22, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15, SIGBREAK: 21, SIGWINCH: 28 }

export const signals = Object.freeze(platform === 'darwin' ? { ...DARWIN } : platform === 'win32' ? { ...WIN32 } : { ...LINUX })

/** `'SIGTERM'` / 15 → 15; throws Node's error for an unknown signal. */
export function signalNumber(signal, fallback = 'SIGTERM') {
  const value = signal ?? fallback
  if (typeof value === 'number' && Number.isInteger(value)) return value
  const number = signals[String(value).toUpperCase()]
  if (number === undefined) {
    const error = new TypeError(`Unknown signal: ${value}`)
    error.code = 'ERR_UNKNOWN_SIGNAL'
    throw error
  }
  return number
}

/** 15 → `'SIGTERM'` (null for null). */
export function signalName(number) {
  if (number === null || number === undefined) return null
  return Object.keys(signals).find((name) => signals[name] === number && name !== 'SIGIOT' && name !== 'SIGPOLL') ?? null
}
