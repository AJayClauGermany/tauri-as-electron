// The app's worker scripts, as `(projectPath) => import(...)`. The bundler
// plugins replace this module (Vite: its load hook; webpack / rspack:
// bundler/worker-entries-loader.cjs) with the scripts they found. It must
// not import anything statically, or that would run before the worker's
// 'init' message.
export default function loadEntry() {
  return undefined
}
