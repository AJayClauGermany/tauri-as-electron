/**
 * webUtils. Files dropped on a page come from Tauri's native drag & drop
 * event (see bootstrap.js), which knows their paths; Electron exposes them
 * through webUtils.getPathForFile().
 */
const paths = new WeakMap()

export function registerFilePath(file, path) {
  paths.set(file, path)
  return file
}

export const webUtils = {
  getPathForFile(file) {
    return paths.get(file) ?? file?.path ?? ''
  },
}
