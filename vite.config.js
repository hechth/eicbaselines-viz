import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

import { viteConfigCharts } from './vite.config.charts.js'

export default defineConfig({
  ...viteConfigCharts,
  // The sample pair doubles as the standalone app's default data, so it is served
  // from the app root instead of being copied into a second directory.
  publicDir: 'test-data',
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.{js,ts}'],
  },
})
