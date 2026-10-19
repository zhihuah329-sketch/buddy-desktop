import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/**
 * The page is served by the app's own server, so the dev server proxies the API
 * instead of duplicating it. A relative `/api` path works in both modes, which
 * keeps the production build free of any host assumption.
 */
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5179,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5178',
        changeOrigin: false
      }
    }
  }
})
