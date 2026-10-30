import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Library build: one ESM bundle plus one stylesheet, ready to be imported by a host
 * app (or by the Galaxy visualization wrapper, which lives in the
 * galaxy-visualizations repository and installs this package from npm).
 *
 * Runtime dependencies stay external — a host that already bundles Vue must not get a
 * second copy of it, and hyparquet/uplot resolve from the host's node_modules.
 */
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    sourcemap: true,
    minify: false,
    lib: {
      entry: 'src/index.js',
      name: 'eicbaselines',
      formats: ['es'],
      fileName: () => 'eicbaselines.js',
    },
    rollupOptions: {
      external: ['vue', 'hyparquet', 'uplot'],
      output: {
        assetFileNames: (info) =>
          info.names?.some((n) => n.endsWith('.css')) ? 'eicbaselines[extname]' : '[name][extname]',
      },
    },
  },
})
