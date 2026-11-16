/**
 * Vite: the trusted-origins renderer script (see ./trusted.cjs), built by a
 * separate Vite build of one virtual entry as a classic script (lib mode,
 * IIFE), with tauri-electron's plugin and the project's aliases and
 * defines. Other Vite plugins of the project are not applied to it.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The project's own Vite (the one running the plugin), else ours. */
async function loadVite(root) {
  try {
    const resolved = createRequire(path.join(root, 'package.json')).resolve('vite')
    return await import(pathToFileURL(resolved).href)
  } catch {
    return import('vite')
  }
}

/**
 * Build the script. `plugin` is the tauri-electron Vite plugin factory,
 * `options` its options, `entry` the virtual module that imports what a
 * renderer page starts with, `resolved` the outer build's resolved config
 * and `dev` whether the outer build is the development server.
 * Resolves to the script's code.
 */
export async function buildTrustedRenderer({ plugin, options, entry, resolved, dev }) {
  const { build } = await loadVite(resolved.root)
  const output = await build({
    configFile: false,
    root: resolved.root,
    mode: resolved.mode,
    logLevel: 'warn',
    clearScreen: false,
    envDir: resolved.envDir,
    publicDir: false,
    resolve: { alias: resolved.resolve?.alias ?? [] },
    define: resolved.define,
    plugins: [plugin({ ...options, __trustedRenderer: { dev } })],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      modulePreload: false,
      target: resolved.build?.target,
      minify: resolved.build?.minify,
      sourcemap: dev ? 'inline' : false,
      lib: { entry, name: '__tauriElectronTrusted', formats: ['iife'], fileName: () => 'trusted-renderer.js' },
      rollupOptions: { input: entry },
    },
  })
  const outputs = [output].flat()
  for (const result of outputs) {
    const chunk = result?.output?.find((item) => item.type === 'chunk')
    if (chunk) return chunk.code
  }
  throw new Error('tauri-electron: the trusted-origins renderer script was not built')
}
