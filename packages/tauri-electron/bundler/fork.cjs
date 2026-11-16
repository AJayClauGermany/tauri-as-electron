/**
 * Fork entry points: the modules the app starts with
 * `utilityProcess.fork(...)` / `child_process.fork(...)`. They run in a real
 * Node.js, so each one is bundled for Node (Node built-ins stay external,
 * `electron` becomes src/fork/electron.js) into a `.cjs` file, next to the
 * child bootstrap (src/fork/bootstrap.js → `bootstrap.cjs`):
 *
 * - development: `node_modules/.tauri-electron/fork/` (absolute `dir` in the manifest),
 * - build: `src-tauri/electron-resources/fork/`, shipped as `<resources>/fork/`
 *   by the `"resources": { "electron-resources/": "" }` mapping.
 *
 * The bundler plugins put the manifest in `__TAURI_ELECTRON_APP__.fork`
 * (`{ dir, bootstrap, entries: { '/src/worker.js': 'src/worker.cjs' } }`);
 * src/internal/fork.js maps the path the app's code computes onto it.
 *
 * Entry points are found in the app's source when the path is static: a
 * `fork(` call whose first argument is `path.join(__dirname, 'worker.js')`,
 * `path.resolve(import.meta.dirname, ...)`, `__dirname + '/worker.js'`, a
 * template literal, `new URL('./worker.js', import.meta.url)`,
 * `require.resolve('./worker.js')`, or a `const` holding one of those. The
 * `fork` option of the plugins lists others. A `.js` path also finds a
 * `.ts` / `.mts` / `.cts` source of the same name.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'src')
/** The child bootstrap and the child's `electron`. */
const FORK_BOOTSTRAP = path.join(SRC, 'fork', 'bootstrap.js')
const FORK_ELECTRON = path.join(SRC, 'fork', 'electron.js')
const BOOTSTRAP_NAME = 'bootstrap'

/** Where the fork files go: in development a cache folder, in a build the staged resources. */
const DEV_DIR = path.join('node_modules', '.tauri-electron', 'fork')
const BUILD_DIR = path.join('src-tauri', 'electron-resources', 'fork')

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/

const UTILITY_FORK = /\butilityProcess\s*\.\s*fork\s*\(/

const FORK_CALL = /(?<![\w$])fork\s*\(/g

// --- a tiny expression reader -------------------------------------------------------------------

const OPEN = { '(': ')', '[': ']', '{': '}' }

/** Skip a quoted string or template literal starting at `i`; returns the index after it. */
function skipString(code, i) {
  const quote = code[i]
  let j = i + 1
  while (j < code.length) {
    const c = code[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === quote) return j + 1
    if (quote === '`' && c === '$' && code[j + 1] === '{') {
      j = skipBalanced(code, j + 1)
      continue
    }
    if (c === '\n' && quote !== '`') return j
    j++
  }
  return j
}

/** Skip a balanced bracket group starting at `i` (an opening bracket). */
function skipBalanced(code, i) {
  const stack = [OPEN[code[i]]]
  let j = i + 1
  while (j < code.length && stack.length) {
    const c = code[j]
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(code, j)
      continue
    }
    if (OPEN[c]) stack.push(OPEN[c])
    else if (c === stack.at(-1)) stack.pop()
    j++
  }
  return j
}

/**
 * The expression starting at `i`, up to a top-level `,` `)` `;` (or, with
 * `newline`, a line break).
 */
function readExpression(code, i, { newline = false } = {}) {
  let j = i
  while (j < code.length) {
    const c = code[j]
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(code, j)
      continue
    }
    if (OPEN[c]) {
      j = skipBalanced(code, j)
      continue
    }
    if (c === ',' || c === ')' || c === ';' || c === ']' || c === '}' || (newline && c === '\n')) break
    j++
  }
  return code.slice(i, j).trim()
}

/** Top-level parts of `text` separated by `separator` (',' or '+'). */
function splitTop(text, separator) {
  const parts = []
  let start = 0
  let j = 0
  while (j < text.length) {
    const c = text[j]
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(text, j)
      continue
    }
    if (OPEN[c]) {
      j = skipBalanced(text, j)
      continue
    }
    if (c === separator) {
      parts.push(text.slice(start, j).trim())
      start = j + 1
    }
    j++
  }
  parts.push(text.slice(start).trim())
  return parts.filter((part) => part !== '')
}

/** `name(args)` → args text, when `text` is exactly one such call. */
function callArguments(text, name) {
  const match = new RegExp(`^(?:${name})\\s*\\(`).exec(text)
  if (!match) return null
  const open = match[0].length - 1
  const end = skipBalanced(text, open)
  if (end !== text.length) return null
  return text.slice(open + 1, end - 1)
}

const STRING = /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1$/
const PLAIN_TEMPLATE = /^`([^`$\\]*)`$/

function literal(text) {
  const quoted = STRING.exec(text)
  if (quoted) return quoted[2].replace(/\\(.)/g, '$1')
  const template = PLAIN_TEMPLATE.exec(text)
  return template ? template[1] : null
}

/**
 * Evaluate a path expression of the source file `file` (project-relative,
 * POSIX, starting with '/'). Returns `{ path }` (a project path),
 * `{ text }` (a string literal) or null when it is not static.
 */
function evaluate(text, ctx, depth = 0) {
  if (depth > 8 || !text) return null
  text = text.trim()
  while (text.startsWith('(') && skipBalanced(text, 0) === text.length) text = text.slice(1, -1).trim()
  const value = literal(text)
  if (value !== null) return { text: value }
  if (/^(?:__dirname|import\.meta\.dirname)$/.test(text)) return { path: path.posix.dirname(ctx.file) }
  if (/^(?:__filename|import\.meta\.filename)$/.test(text)) return { path: ctx.file }
  let args = callArguments(text, '(?:[\\w$]+\\.)?fileURLToPath')
  if (args !== null) return evaluate(args, ctx, depth + 1)
  if (/^import\.meta\.url$/.test(text)) return { path: ctx.file }
  args = callArguments(text, 'new\\s+URL')
  if (args !== null) {
    const [relative, base] = splitTop(args, ',')
    const rel = literal(relative ?? '')
    const from = evaluate(base ?? '', ctx, depth + 1)
    if (rel === null || !from?.path) return null
    return { path: path.posix.join(path.posix.dirname(from.path), rel) }
  }
  args = callArguments(text, 'require\\.resolve')
  if (args !== null) {
    const rel = literal(splitTop(args, ',')[0] ?? '')
    return rel !== null && rel.startsWith('.') ? { path: path.posix.join(path.posix.dirname(ctx.file), rel) } : null
  }
  args = callArguments(text, '(?:[\\w$]+\\.)?(?:posix\\.)?dirname')
  if (args !== null) {
    const inner = evaluate(args, ctx, depth + 1)
    return inner?.path ? { path: path.posix.dirname(inner.path) } : null
  }
  args = callArguments(text, '(?:[\\w$]+\\.)?(?:posix\\.)?(?:join|resolve)')
  if (args !== null) {
    const parts = splitTop(args, ',').map((part) => evaluate(part, ctx, depth + 1))
    if (!parts.length || parts.some((part) => !part) || !parts[0].path) return null
    return { path: path.posix.join(parts[0].path, ...parts.slice(1).map((part) => part.path ?? part.text)) }
  }
  if (text.startsWith('`') && text.endsWith('`')) return concatenate(templateParts(text.slice(1, -1)), ctx, depth)
  const sum = splitTop(text, '+')
  if (sum.length > 1) return concatenate(sum, ctx, depth)
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const init = ctx.declarations(text)
    return init ? evaluate(init, ctx, depth + 1) : null
  }
  return null
}

/** `${a}/b` → ['a', "'/b'"] (as expressions). */
function templateParts(body) {
  const parts = []
  let j = 0
  let start = 0
  while (j < body.length) {
    if (body[j] === '$' && body[j + 1] === '{') {
      if (j > start) parts.push(JSON.stringify(body.slice(start, j)))
      const end = skipBalanced(body, j + 1)
      parts.push(body.slice(j + 2, end - 1))
      j = start = end
      continue
    }
    j++
  }
  if (start < body.length) parts.push(JSON.stringify(body.slice(start)))
  return parts
}

function concatenate(parts, ctx, depth) {
  const values = parts.map((part) => evaluate(part, ctx, depth + 1))
  if (!values.length || values.some((value) => !value) || !values[0].path) return null
  return { path: path.posix.normalize(values.map((value) => value.path ?? value.text).join('')) }
}

/** `const name = <expression>` (or let / var) in `code`. */
function declarationsOf(code) {
  const cache = new Map()
  return (name) => {
    if (!cache.has(name)) {
      const match = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*`).exec(code)
      cache.set(name, match ? readExpression(code, match.index + match[0].length, { newline: true }) : null)
    }
    return cache.get(name)
  }
}

/** The source file for a fork path: as written, or with another source extension. */
function sourceFileFor(root, key) {
  const exact = path.join(root, key)
  const isFile = (file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }
  if (isFile(exact)) return exact
  const bare = exact.replace(SOURCE_EXTENSION, '')
  for (const extension of SOURCE_EXTENSIONS) if (isFile(bare + extension)) return bare + extension
  return null
}

/**
 * Fork entry points in one source file: `[{ key, file }]`, `key` being the
 * project path the app's code computes, `file` the source on disk.
 * @param {string} code
 * @param {string} file absolute path of the source file
 * @param {string} root project root
 */
function forkEntriesInSource(code, file, root) {
  if (!code.includes('fork')) return []
  const found = []
  const ctx = { file: '/' + path.relative(root, file).split(path.sep).join('/'), declarations: declarationsOf(code) }
  for (const match of code.matchAll(FORK_CALL)) {
    const argument = readExpression(code, match.index + match[0].length)
    const value = evaluate(argument, ctx)
    if (!value?.path) continue
    const key = path.posix.normalize(value.path)
    const source = sourceFileFor(root, key)
    if (source && path.resolve(source) !== path.resolve(file)) found.push({ key, file: source })
  }
  return found
}

/** Whether `code` forks at all (utilityProcess.fork, or child_process with a fork call). */
function mentionsFork(code) {
  if (!code.includes('fork')) return false
  FORK_CALL.lastIndex = 0
  return UTILITY_FORK.test(code) || (code.includes('child_process') && FORK_CALL.test(code))
}

// --- the plan --------------------------------------------------------------------------------------

/** The output name of an entry: its project path without the extension (`src/worker`). */
function outputName(key) {
  return key.replace(/^\/+/, '').replace(SOURCE_EXTENSION, '').replace(/[^\w./-]/g, '_')
}

/**
 * What to build: `{ entries: [{ key, file, name }], needed }`. `scan` is the
 * plugins' source scan (its `forks` and `forkCalls`); `option` the plugins'
 * `fork` option: `false` for nothing, or extra project-relative files.
 */
function forkPlan(root, option, scan) {
  if (option === false) return { entries: [], needed: false }
  const result = typeof scan === 'function' ? scan() : scan
  const byKey = new Map(result?.forks ?? [])
  for (const extra of [option ?? []].flat().filter(Boolean)) {
    const file = path.resolve(root, extra)
    const key = '/' + path.relative(root, file).split(path.sep).join('/')
    byKey.set(key, file)
    // The compiled name the app's code uses for a TypeScript source.
    const js = key.replace(/\.([cm]?)tsx?$/, (_, kind) => `.${kind}js`)
    if (js !== key && !byKey.has(js)) byKey.set(js, file)
  }
  const entries = []
  const names = new Map()
  for (const [key, file] of byKey) {
    let name = names.get(file)
    if (!name) {
      name = outputName(key)
      names.set(file, name)
    }
    entries.push({ key, file, name })
  }
  return { entries, needed: entries.length > 0 || Boolean(result?.forkCalls) }
}

/** Unique `{ name: file }` for the bundler, the bootstrap included. */
function forkInputs(plan) {
  const input = { [BOOTSTRAP_NAME]: FORK_BOOTSTRAP }
  for (const entry of plan.entries) input[entry.name] = entry.file
  return input
}

/** Where the fork files go (absolute), or null in a build that does not ship `electron-resources`. */
function forkOutDir(root, dev) {
  if (dev) return path.join(root, DEV_DIR)
  return fs.existsSync(path.join(root, 'src-tauri', 'electron-resources')) ? path.join(root, BUILD_DIR) : null
}

/** The manifest for `__TAURI_ELECTRON_APP__.fork`, or null when nothing is built. */
function forkManifest(plan, { dev, outDir }) {
  if (!plan.needed || !outDir) return null
  return {
    dir: dev ? outDir : null,
    bootstrap: `${BOOTSTRAP_NAME}.cjs`,
    entries: Object.fromEntries(plan.entries.map((entry) => [entry.key, `${entry.name}.cjs`])),
  }
}

/**
 * `__dirname` & co. in a fork entry: the app's folder in the child (the
 * project in development, `<resources>/app` in a build), which the main
 * process passes as `TAURI_ELECTRON_APP_ROOT`.
 */
function appPathExpression(projectPath) {
  return `((typeof process !== "undefined" && process.env.TAURI_ELECTRON_APP_ROOT || "") + ${JSON.stringify(projectPath)})`
}

module.exports = {
  FORK_BOOTSTRAP,
  FORK_ELECTRON,
  BOOTSTRAP_NAME,
  DEV_DIR,
  BUILD_DIR,
  forkEntriesInSource,
  mentionsFork,
  forkPlan,
  forkInputs,
  forkOutDir,
  forkManifest,
  appPathExpression,
  // for tests
  evaluatePathExpression: (text, file, code = '') => evaluate(text, { file, declarations: declarationsOf(code) }),
}
