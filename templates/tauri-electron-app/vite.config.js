import { defineConfig } from 'vite'
import tauriElectron from 'tauri-electron/vite'

export default defineConfig({
  plugins: [
    // Aliases `electron` to tauri-electron and injects src/preload.js into
    // every page except electron-main.html (the hidden main-process page).
    tauriElectron({ preload: 'src/preload.js' }),
  ],
  server: {
    port: 1420,
    strictPort: true,
  },
})
