import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const host = loadEnv(mode, '.', 'TAURI_DEV_HOST').TAURI_DEV_HOST
  return {
    plugins: [vue()],
    optimizeDeps: { entries: ['index.html'] },
    clearScreen: false,
    server: {
      port: 5173,
      strictPort: true,
      host: host || '127.0.0.1',
      hmr: host ? { host, port: 5174, protocol: 'ws' } : undefined,
      watch: { ignored: ['**/src-tauri/**'] },
    },
    build: { target: 'es2020' },
  }
})
