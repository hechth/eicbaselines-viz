import path from 'node:path'
import { defineConfig } from 'vite'

const env = {
  GALAXY_DATASET_ID: '',
  GALAXY_KEY: '',
  GALAXY_ROOT: 'http://127.0.0.1:8080',
}

Object.keys(env).forEach((key) => {
  if (process.env[key]) {
    env[key] = process.env[key]
  } else {
    console.log(`${key} not available. Please provide as environment variable.`)
  }
})

// Directories outside this project that development may serve as `/@fs/…` URLs, e.g.
// `LOCAL_DATA_DIRS=/home/me/galaxytools`. Optional, and deliberately *not* part of `env`
// above: that block announces every unset variable on every start, and announcing an
// optional setting would be noise. `/@fs/` is a dev-server feature — neither `vite preview`
// nor a static host serves it — so a config that names one is for development only.
const localDataDirs = (process.env.LOCAL_DATA_DIRS ?? '')
  .split(',')
  // Both forms people actually write: a comma list by hand, a `PATH`-style list copied
  // out of a shell profile.
  .flatMap((part) => part.split(path.delimiter))
  .map((dir) => dir.trim())
  .filter(Boolean)

// Standalone development talks to a real Galaxy through the dev-server proxy so that
// the browser never trips over CORS. A `key` is appended when one is configured.
const proxyGalaxy = () => ({
  changeOrigin: true,
  rewrite: (path) => {
    if (env.GALAXY_KEY) {
      const separator = path.includes('?') ? '&' : '?'
      return `${path}${separator}key=${env.GALAXY_KEY}`
    }
    return path
  },
  target: env.GALAXY_ROOT,
})

// https://vitejs.dev/config/
export const viteConfigCharts = defineConfig({
  base: './',
  build: {
    outDir: './static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: () => 'app.js',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  define: {
    'process.env.credentials': JSON.stringify(env.GALAXY_KEY ? 'omit' : 'include'),
    'process.env.dataset_id': JSON.stringify(env.GALAXY_DATASET_ID),
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    // `fs.allow` *replaces* Vite's default (the workspace root), so this project has to be
    // named alongside any extra directory or the app can no longer serve its own sources.
    // A relative entry is resolved against the config root by Vite itself, hence `'.'`.
    // Set only when the variable is set, to leave the default allow-list untouched.
    ...(localDataDirs.length ? { fs: { allow: ['.', ...localDataDirs] } } : {}),
    proxy: {
      // /api covers the history/dataset metadata, /datasets the raw parquet download.
      '/api': proxyGalaxy(),
      '/datasets': proxyGalaxy(),
    },
  },
})
