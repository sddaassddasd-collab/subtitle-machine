import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

let commit = process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || process.env.GIT_COMMIT || ''
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim() }
  catch { commit = 'unknown' }
}

// https://vite.dev/config/
export default defineConfig({
  define: {__APP_BUILD__: JSON.stringify({commit: commit.slice(0, 80), builtAt: new Date().toISOString()})},
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
})
