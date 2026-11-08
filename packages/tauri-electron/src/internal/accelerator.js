/**
 * Convert an Electron accelerator ("CommandOrControl+Shift+Z") to the syntax
 * understood by Tauri's menu and global-shortcut parsers. The two are almost
 * identical; only a few modifier/key aliases differ.
 */
const MODIFIERS = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
}

const KEYS = {
  plus: '=',
  return: 'Enter',
  esc: 'Escape',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  volumeup: 'AudioVolumeUp',
  volumedown: 'AudioVolumeDown',
  volumemute: 'AudioVolumeMute',
  medianexttrack: 'MediaTrackNext',
  mediaprevioustrack: 'MediaTrackPrevious',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause',
}

export function toTauriAccelerator(accelerator) {
  if (!accelerator) return undefined
  return String(accelerator)
    .split('+')
    .map((part, index, parts) => {
      // "CmdOrCtrl++" splits into ['CmdOrCtrl', '', ''] - treat as Plus.
      if (part === '' && index === parts.length - 1) return '='
      if (part === '') return null
      const lower = part.toLowerCase()
      if (index < parts.length - 1 && MODIFIERS[lower]) return MODIFIERS[lower]
      return KEYS[lower] ?? part
    })
    .filter(Boolean)
    .join('+')
}
