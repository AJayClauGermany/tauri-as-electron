/**
 * globalShortcut via @tauri-apps/plugin-global-shortcut. Registration is
 * async in Tauri; register() optimistically returns true and logs failures.
 */
import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut'
import { toTauriAccelerator } from '../internal/accelerator.js'
import { report } from '../internal/runtime.js'

const registered = new Map()

export const globalShortcut = {
  register(accelerator, callback) {
    const key = toTauriAccelerator(accelerator)
    if (registered.has(key)) return false
    registered.set(key, callback)
    register(key, (event) => {
      if (event.state === 'Pressed') registered.get(key)?.()
    }).catch((error) => {
      registered.delete(key)
      report(`globalShortcut.register(${accelerator})`)(error)
    })
    return true
  },

  registerAll(accelerators, callback) {
    for (const accelerator of accelerators) globalShortcut.register(accelerator, callback)
  },

  isRegistered(accelerator) {
    return registered.has(toTauriAccelerator(accelerator))
  },

  unregister(accelerator) {
    const key = toTauriAccelerator(accelerator)
    if (!registered.delete(key)) return
    unregister(key).catch(report('globalShortcut.unregister'))
  },

  unregisterAll() {
    registered.clear()
    unregisterAll().catch(report('globalShortcut.unregisterAll'))
  },
}
