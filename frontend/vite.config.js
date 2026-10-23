import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import oxlint from 'vite-plugin-oxlint'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    oxlint(),
  ],

  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
