import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      usePolling: true,
      interval: 400,
    },
    fs: {
      allow: ['..'],
    },
  },
  preview: {
    port: 4173,
  },
})
