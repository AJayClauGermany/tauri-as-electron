/** shell, implemented with @tauri-apps/plugin-opener (trashItem: tauri-plugin-electron). */
import { openUrl, openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { NotImplementedError, report } from '../internal/runtime.js'
import { native } from '../internal/native.js'

/** True when an invoke error means tauri-plugin-electron is missing or not permitted. */
export function isMissingPluginError(error) {
  return /plugin electron not found|not found.*electron|electron\.[a-z_]+ not allowed|command .* not found/i.test(String(error?.message ?? error))
}

export const shell = {
  async openExternal(url) {
    await openUrl(String(url))
  },

  /** Resolves with '' on success or an error message, like Electron. */
  async openPath(path) {
    try {
      await openPath(String(path))
      return ''
    } catch (error) {
      return String(error?.message ?? error)
    }
  },

  showItemInFolder(path) {
    revealItemInDir(String(path)).catch(report('shell.showItemInFolder'))
  },

  beep() {
    // No native beep in Tauri; a short WebAudio tone is the closest thing.
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      osc.frequency.value = 880
      osc.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.1)
      osc.onended = () => ctx.close()
    } catch {
      /* audio unavailable */
    }
  },

  /** Via tauri-plugin-electron (the `trash` crate). */
  async trashItem(path) {
    try {
      await native('trash_item', { path: String(path) })
    } catch (error) {
      if (isMissingPluginError(error)) throw new NotImplementedError('shell.trashItem', { reason: 'plugin', hint: 'Register tauri-plugin-electron in src-tauri/src/lib.rs.' })
      // Electron's message, with the native reason attached.
      throw new Error('Failed to move item to trash', { cause: error })
    }
  },

  writeShortcutLink() {
    throw new NotImplementedError('shell.writeShortcutLink', { reason: 'unimplemented', hint: 'Windows .lnk files need a Rust command.' })
  },

  readShortcutLink() {
    throw new NotImplementedError('shell.readShortcutLink', { reason: 'unimplemented', hint: 'Windows .lnk files need a Rust command.' })
  },
}
