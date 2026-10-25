import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import oxlint from 'vite-plugin-oxlint'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    oxlint(),
  ],

  build: {
    // Three.js is fetched through React.lazy for the Neural Core and globe.
    // The application entry remains well below 500 kB; this limit covers the
    // one deferred renderer runtime without hiding growth in the app shell.
    chunkSizeWarningLimit: 650,
  },

  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
