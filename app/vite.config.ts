import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the built app runs from any subdirectory
// (deployed to https://high-street-consulting.github.io/marc-resiliency-study/ by .github/workflows)
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
  },
})
