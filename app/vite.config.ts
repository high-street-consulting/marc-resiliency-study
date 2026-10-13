import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the built site runs from any subdirectory
// (deployed to https://high-street-consulting.github.io/marc-resiliency-study/ by .github/workflows).
// Two pages: the landing page at the root and the Explorer under /explorer/.
export default defineConfig({
  base: './',
  plugins: [react()],
  // @arcgis/core must not be esbuild-prebundled: it breaks the SDK's render
  // workers in dev (map queries work but the canvas never paints).
  optimizeDeps: {
    exclude: ['@arcgis/core'],
  },
  build: {
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      input: {
        landing: 'index.html',
        explorer: 'explorer/index.html',
      },
    },
  },
})
