/** shell, implemented with @tauri-apps/plugin-opener. */
import { openUrl, openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { NotImplementedError, report } from '../internal/runtime.js'

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

  trashItem() {
    return Promise.reject(new NotImplementedError('shell.trashItem'))
  },

  writeShortcutLink() {
    throw new NotImplementedError('shell.writeShortcutLink')
  },

  readShortcutLink() {
    throw new NotImplementedError('shell.readShortcutLink')
  },
}
