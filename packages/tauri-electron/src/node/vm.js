/**
 * Node's `vm` on the webview's own engine. A context is a hidden same-origin
 * `<iframe>`: a separate realm with its own globals and built-ins (an
 * `Array` made inside fails `instanceof Array` outside, as in Node), that
 * runs code synchronously and shares objects with the page by reference.
 *
 * The contextified object's properties are mirrored onto the iframe's
 * global as accessors, so code inside reads and writes them live; globals
 * the code creates (`var x`, `function f() {}`, `globalThis.y = …`) are
 * copied back onto the object when a run ends and mirrored from then on.
 *
 * Code runs as eval code of the context's realm (it returns the completion
 * value, like a Script); top-level `let` / `const` / `class` become `var` so
 * they persist in the context between runs as a Script's do.
 *
 * Limits (documented in API-COVERAGE.md): `timeout` and `breakOnSigint`
 * cannot interrupt synchronous code in the same thread and are ignored; a
 * context also has the browser's globals (`setTimeout`, `fetch`, …) next to
 * the object's; globals created later by asynchronous code inside a context
 * reach the object at the next run; contexts need a document (main process,
 * renderer windows), so in worker threads only `runInThisContext` and
 * `compileFunction` work; the declarations of strict-mode code ('use
 * strict' first) stay in their run, as in eval; the page's
 * Content-Security-Policy must allow `'unsafe-eval'`. Neither this nor
 * Node's `vm` is a security boundary.
 */
import { Buffer } from './buffer.js'
import { NotImplementedError, warnOnce } from '../internal/runtime.js'

/** Contextified object → its Context. */
const contexts = new WeakMap()

/** Removes a context's iframe once its object is garbage-collected. */
const frames = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((frame) => frame.remove()) : null

/** Objects of `runInNewContext` kept alive while the promise their code returned is pending. */
const pending = new Set()

const weak = (value) => (typeof WeakRef === 'function' ? new WeakRef(value) : { deref: () => value })

function typeError(code, message) {
  const error = new TypeError(message)
  error.code = code
  return error
}

/** The CSP refused eval: say what to change. */
function explainEval(error) {
  if (error?.name !== 'EvalError') return error
  const explained = new NotImplementedError('vm', {
    reason: 'unsupported',
    hint: "The page's Content-Security-Policy forbids evaluating code: add 'unsafe-eval' to its script-src (tauri.conf.json app.security.csp).",
  })
  explained.cause = error
  return explained
}

function warnUnsupported(options) {
  if (options && typeof options === 'object' && options.timeout !== undefined) {
    warnOnce('vm.timeout', 'vm: the `timeout` option is ignored: synchronous code in the same thread cannot be interrupted in a webview.')
  }
}

function withSourceUrl(code, filename) {
  const source = String(code)
  if (!filename || /\/\/[#@] sourceURL=/.test(source)) return source
  return `${source}\n//# sourceURL=${String(filename).replace(/\s/g, '%20')}`
}

function filenameOf(options, fallback = 'evalmachine.<anonymous>') {
  if (typeof options === 'string') return options
  return options?.filename ?? fallback
}

/** Whether a `/` at `i` starts a regular expression (judged by the code before it). */
function regexStart(code, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  if (j < 0) return true
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(code[j])) return true
  const word = /[A-Za-z_$][\w$]*$/.exec(code.slice(Math.max(0, j - 10), j + 1))?.[0]
  return Boolean(word && /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(word))
}

/** Index past the string, template, comment or regular expression at `i`, or -1. */
function skipToken(code, i) {
  const ch = code[i]
  if (ch === '/' && code[i + 1] === '/') {
    const end = code.indexOf('\n', i)
    return end === -1 ? code.length : end
  }
  if (ch === '/' && code[i + 1] === '*') {
    const end = code.indexOf('*/', i + 2)
    return end === -1 ? code.length : end + 2
  }
  if (ch === '"' || ch === "'") {
    let j = i + 1
    while (j < code.length && code[j] !== ch && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1
    return j + 1
  }
  if (ch === '`') {
    let j = i + 1
    while (j < code.length && code[j] !== '`') {
      if (code[j] === '\\') j += 2
      else if (code[j] === '$' && code[j + 1] === '{') {
        let depth = 1
        j += 2
        while (j < code.length && depth) {
          const skipped = skipToken(code, j)
          if (skipped !== -1) j = skipped
          else {
            if (code[j] === '{') depth++
            else if (code[j] === '}') depth--
            j++
          }
        }
      } else j++
    }
    return j + 1
  }
  if (ch === '/' && regexStart(code, i)) {
    let j = i + 1
    let inClass = false
    while (j < code.length && code[j] !== '\n') {
      if (code[j] === '\\') j++
      else if (code[j] === '[') inClass = true
      else if (code[j] === ']') inClass = false
      else if (code[j] === '/' && !inClass) break
      j++
    }
    j++
    while (j < code.length && /[a-z]/i.test(code[j])) j++
    return j
  }
  return -1
}

/**
 * Top-level `let` / `const` / `class` declarations → `var`. Code runs as
 * eval code here, whose lexical declarations end with the run; a Node
 * Script's stay in its context for the next run (a REPL's variables). The
 * rewrite is used only when it still compiles.
 */
function persistDeclarations(code) {
  if (!/\b(?:let|const|class)\b/.test(code) || /^\s*(?:(['"])use strict\1)/.test(code)) return code
  let out = ''
  let from = 0
  let depth = 0
  let classEnd = null // the depth whose closing brace ends a rewritten class declaration
  const boundary = (at) => {
    let j = at - 1
    while (j >= 0 && /[ \t]/.test(code[j])) j--
    return j < 0 || /[;}\n\r]/.test(code[j]) || code[j] === '{'
  }
  for (let i = 0; i < code.length; i++) {
    const skipped = skipToken(code, i)
    if (skipped !== -1) {
      i = skipped - 1
      continue
    }
    const ch = code[i]
    if (ch === '{' || ch === '(' || ch === '[') depth++
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--
      if (ch === '}' && classEnd !== null && depth === classEnd) {
        out += code.slice(from, i + 1) + ';'
        from = i + 1
        classEnd = null
      }
    } else if (depth === 0 && /[lc]/.test(ch) && (i === 0 || !/[\w$.]/.test(code[i - 1])) && boundary(i)) {
      const declaration = /^(let|const)(\s+)(?=[A-Za-z_$[{])/.exec(code.slice(i, i + 12))
      if (declaration) {
        out += code.slice(from, i) + 'var' + declaration[2]
        from = i + declaration[0].length
        i = from - 1
        continue
      }
      const klass = /^class\s+([A-Za-z_$][\w$]*)/.exec(code.slice(i, i + 200))
      if (klass) {
        out += code.slice(from, i) + `var ${klass[1]} = `
        from = i
        classEnd = 0
      }
    }
  }
  const rewritten = out + code.slice(from)
  if (rewritten === code) return code
  try {
    // eslint-disable-next-line no-new-func
    new Function(rewritten)
    return rewritten
  } catch {
    return code
  }
}

/** Node checks syntax when a Script is created; `new Function` compiles without running. */
function checkSyntax(code) {
  try {
    // A hashbang is valid at the start of a script, not of a function body.
    // eslint-disable-next-line no-new-func
    new Function(String(code).replace(/^#![^\n]*/, ''))
  } catch (error) {
    throw explainEval(error)
  }
}

class Context {
  /** `sandbox`: the contextified object, or null for a context that is its own global (DONT_CONTEXTIFY). */
  constructor(sandbox) {
    if (typeof document === 'undefined' || !document.createElement) {
      throw new NotImplementedError('vm.createContext', {
        reason: 'unsupported',
        hint: 'A vm context is an iframe, and worker threads have no document: create contexts in the main process or a window (runInThisContext and compileFunction work everywhere).',
      })
    }
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'display:none !important'
    ;(document.body ?? document.documentElement).appendChild(frame)
    this.frame = frame
    this.global = frame.contentWindow
    this.sandbox = sandbox ? weak(sandbox) : { deref: () => null }
    /** The realm's own globals, never copied back. */
    this.builtins = new Set(Reflect.ownKeys(this.global))
    /** Keys mirrored as accessors → the global's original descriptor (to restore). */
    this.mirrored = new Map()
    /** Keys the window does not let us redefine (window, document, location, top): put in a with-scope. */
    this.shadowed = new Set()
    if (sandbox) frames?.register(sandbox, frame)
  }

  mirror(key) {
    const ref = this.sandbox
    const original = Object.getOwnPropertyDescriptor(this.global, key)
    try {
      Object.defineProperty(this.global, key, {
        configurable: true,
        enumerable: true,
        get: () => ref.deref()?.[key],
        set: (value) => {
          const target = ref.deref()
          if (target) target[key] = value
        },
      })
      this.mirrored.set(key, original)
    } catch {
      this.shadowed.add(key)
    }
  }

  /** The object's current properties → the global (before a run). */
  syncIn() {
    const sandbox = this.sandbox.deref()
    if (!sandbox) return
    const keys = new Set(Reflect.ownKeys(sandbox))
    for (const key of keys) if (!this.mirrored.has(key) && !this.shadowed.has(key)) this.mirror(key)
    for (const [key, original] of this.mirrored) {
      if (keys.has(key)) continue
      // Deleted from the object: gone from the context too (the realm's own value comes back).
      delete this.global[key]
      if (original) Object.defineProperty(this.global, key, original)
      this.mirrored.delete(key)
    }
    for (const key of this.shadowed) if (!keys.has(key)) this.shadowed.delete(key)
  }

  /** Globals the code created or deleted → the object (after a run). */
  syncOut() {
    const sandbox = this.sandbox.deref()
    if (!sandbox) return
    for (const key of Reflect.ownKeys(this.global)) {
      if (this.builtins.has(key) || this.mirrored.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(this.global, key)
      if (!descriptor) continue
      sandbox[key] = 'value' in descriptor ? descriptor.value : this.global[key]
      if (descriptor.configurable) {
        delete this.global[key]
        this.mirror(key)
      }
    }
    for (const key of [...this.mirrored.keys()]) {
      if (Object.prototype.hasOwnProperty.call(this.global, key) || this.builtins.has(key)) continue
      // `delete x` inside the context.
      delete sandbox[key]
      this.mirrored.delete(key)
    }
  }

  /** A function of this realm evaluating `source` in a with-scope holding the shadowed keys. */
  scopedEval(source) {
    const ref = this.sandbox
    const scope = Object.create(null)
    for (const key of this.shadowed) {
      Object.defineProperty(scope, key, {
        get: () => ref.deref()?.[key],
        set: (value) => {
          const target = ref.deref()
          if (target) target[key] = value
        },
      })
    }
    // eslint-disable-next-line no-new-func
    const run = new this.global.Function('__tauriElectronScope', '__tauriElectronCode', 'with (__tauriElectronScope) return eval(__tauriElectronCode)')
    return run(scope, source)
  }

  run(code, filename) {
    this.syncIn()
    const source = withSourceUrl(persistDeclarations(String(code)), filename)
    try {
      return this.shadowed.size ? this.scopedEval(source) : this.global.eval(source)
    } catch (error) {
      throw explainEval(error)
    } finally {
      this.syncOut()
    }
  }
}

function contextOf(contextified, name = 'contextifiedObject') {
  const context = contextified && typeof contextified === 'object' ? contexts.get(contextified) : undefined
  if (!context) throw typeError('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be an vm.Context`)
  return context
}

export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'),
  DONT_CONTEXTIFY: Symbol('vm_context_no_contextify'),
})

/**
 * Turn `contextObject` into a context (`vm.isContext(obj)` is then true)
 * and return it. With `vm.constants.DONT_CONTEXTIFY`, the context's own
 * global object is returned instead.
 */
export function createContext(contextObject = {}, options) {
  if (contextObject === constants.DONT_CONTEXTIFY) {
    // The context's global is its own object: nothing to mirror (and it lives as long as the page).
    const context = new Context(null)
    contexts.set(context.global, context)
    return context.global
  }
  if (contextObject === null || (typeof contextObject !== 'object' && typeof contextObject !== 'function')) {
    throw typeError('ERR_INVALID_ARG_TYPE', 'The "contextObject" argument must be of type object')
  }
  if (contexts.has(contextObject)) return contextObject
  void options // name, origin, codeGeneration, microtaskMode: nothing to apply them to
  contexts.set(contextObject, new Context(contextObject))
  return contextObject
}

export function isContext(object) {
  if (object === null || (typeof object !== 'object' && typeof object !== 'function')) {
    throw typeError('ERR_INVALID_ARG_TYPE', 'The "object" argument must be of type object')
  }
  return contexts.has(object)
}

export function runInContext(code, contextifiedObject, options) {
  warnUnsupported(options)
  return contextOf(contextifiedObject).run(code, filenameOf(options))
}

export function runInNewContext(code, contextObject, options) {
  warnUnsupported(options)
  const sandbox = createContext(contextObject ?? {})
  const result = contextOf(sandbox).run(code, filenameOf(options))
  // A promise from the context's realm needs the realm until it settles.
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    pending.add(sandbox)
    const release = () => pending.delete(sandbox)
    try {
      result.then(release, release)
    } catch {
      release()
    }
  }
  return result
}

export function runInThisContext(code, options) {
  warnUnsupported(options)
  try {
    // Indirect eval: the page's global scope.
    return (0, eval)(withSourceUrl(persistDeclarations(String(code)), filenameOf(options)))
  } catch (error) {
    throw explainEval(error)
  }
}

/**
 * `vm.compileFunction(code, params, options)`: a function whose body is
 * `code`, compiled in `options.parsingContext` (default: this realm), with
 * `options.contextExtensions` objects in scope.
 */
export function compileFunction(code, params = [], options = {}) {
  const context = options.parsingContext ? contextOf(options.parsingContext, 'options.parsingContext') : null
  context?.syncIn()
  const realm = context ? context.global : globalThis
  const names = [...params].map(String)
  const extensions = [...(options.contextExtensions ?? [])]
  const body = withSourceUrl(code, options.filename)
  try {
    if (!extensions.length) return new realm.Function(...names, body)
    let source = `return function (${names.join(', ')}) {\n${body}\n}`
    for (let i = extensions.length - 1; i >= 0; i--) source = `with (__tauriElectronExtensions[${i}]) {\n${source}\n}`
    return new realm.Function('__tauriElectronExtensions', source)(extensions)
  } catch (error) {
    throw explainEval(error)
  }
}

export class Script {
  constructor(code, options = {}) {
    this._code = String(code ?? '')
    this._filename = filenameOf(options)
    checkSyntax(this._code)
    if (options && typeof options === 'object') {
      if (options.cachedData) this.cachedDataRejected = true
      if (options.produceCachedData) {
        this.cachedDataProduced = false
        this.cachedData = Buffer.alloc(0)
      }
    }
    this.sourceMapURL = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(this._code)?.[1]
  }

  runInThisContext(options) {
    return runInThisContext(this._code, { ...options, filename: this._filename })
  }

  runInContext(contextifiedObject, options) {
    return runInContext(this._code, contextifiedObject, { ...options, filename: this._filename })
  }

  runInNewContext(contextObject, options) {
    return runInNewContext(this._code, contextObject, { ...options, filename: this._filename })
  }

  /** No code cache here: an empty buffer, which Node's `cachedData` option then rejects. */
  createCachedData() {
    return Buffer.alloc(0)
  }
}

export function measureMemory() {
  return Promise.reject(new NotImplementedError('vm.measureMemory', { reason: 'unsupported', hint: 'The webview does not report memory per context.' }))
}

function moduleClass(name) {
  return class {
    constructor() {
      throw new NotImplementedError(`vm.${name}`, {
        reason: 'unsupported',
        hint: 'vm modules are experimental in Node (--experimental-vm-modules) and have no webview equivalent: bundle the module, or evaluate a script with vm.Script.',
      })
    }
  }
}

export const SourceTextModule = moduleClass('SourceTextModule')
export const SyntheticModule = moduleClass('SyntheticModule')
export const Module = moduleClass('Module')

const vm = {
  Script,
  createContext,
  isContext,
  runInContext,
  runInNewContext,
  runInThisContext,
  compileFunction,
  measureMemory,
  constants,
  SourceTextModule,
  SyntheticModule,
  Module,
}

export default vm
