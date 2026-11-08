import { defineConfig } from 'vite'
import tauriElectron from 'tauri-electron/vite'

export default defineConfig({
  plugins: [tauriElectron({ preload: 'src/preload.mjs' })],
  server: {
    port: 1421,
    strictPort: true,
  },
})
