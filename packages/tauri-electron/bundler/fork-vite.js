/**
 * The Vite plugin's build of fork entry points (see fork.cjs): a separate
 * Vite build for Node (SSR mode, CommonJS output, dependencies bundled, Node
 * built-ins external), with `electron` aliased to the child's module and
 * `__dirname` & co. pointing at the app's files. In development it watches
 * and rebuilds.
 */
import path from 'node:path'
import shared from './shared.cjs'
import fork from './fork.cjs'

const { rewritePathGlobals, mentionsPathGlobals } = shared
const { FORK_ELECTRON, forkInputs, appPathExpression } = fork

const SOURCE_FILE = /\.(m?[jt]sx?|cjs|cts)$/
const toPosix = (p) => p.split(path.sep).join('/')

/** `__dirname` & co. in the app's own sources → the app's folder in the child. */
function appPaths(root) {
  return {
    name: 'tauri-electron:fork-paths',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!SOURCE_FILE.test(file) || file.includes('/node_modules/') || !file.startsWith(root) || !mentionsPathGlobals(code)) return null
      const relative = '/' + toPosix(path.relative(root, file))
      const result = rewritePathGlobals(code, path.posix.dirname(relative), relative, appPathExpression)
      return result === code ? null : { code: result, map: null }
    },
  }
}

/** The Vite config of the fork build. */
export function forkViteConfig({ root, plan, outDir, dev, watch = false }) {
  return {
    configFile: false,
    root,
    mode: dev ? 'development' : 'production',
    logLevel: 'warn',
    clearScreen: false,
    publicDir: false,
    resolve: {
      alias: [{ find: /^electron(\/(main|common|utility|renderer))?$/, replacement: FORK_ELECTRON }],
    },
    plugins: [appPaths(root)],
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: false,
      sourcemap: dev ? 'inline' : false,
      reportCompressedSize: false,
      target: 'node18',
      watch: watch ? {} : null,
      rollupOptions: {
        input: forkInputs(plan),
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs', exports: 'auto' },
      },
    },
  }
}

/**
 * Build the fork entries into `outDir`. With `watch`, resolves once the
 * first build is written and returns the watcher (call `close()` on it).
 */
export async function buildForks(options) {
  const { build } = await import('vite')
  const result = await build(forkViteConfig(options))
  if (!options.watch) return null
  const watcher = result
  await new Promise((resolve, reject) => {
    const onEvent = (event) => {
      if (event.code === 'END') {
        watcher.off?.('event', onEvent)
        resolve()
      } else if (event.code === 'ERROR') {
        event.result?.close?.()
        watcher.off?.('event', onEvent)
        reject(event.error)
      }
    }
    watcher.on('event', onEvent)
  })
  // Later rebuilds report their errors without stopping the dev server.
  watcher.on('event', (event) => {
    if (event.code === 'ERROR') console.error('[tauri-electron] fork entry build failed:', event.error?.message ?? event.error)
    event.result?.close?.()
  })
  return watcher
}
