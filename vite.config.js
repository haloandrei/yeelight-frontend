import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/ui/',
  build: {
    outDir: '/home/pi/yeelight-ui/ui',
    emptyOutDir: true
  }
})
