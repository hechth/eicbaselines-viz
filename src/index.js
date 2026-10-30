/**
 * Public entry of the `eicbaselines` package.
 *
 * Two ways in:
 *   - `mountViewer(el, {raw, corrected})` for plain JS / a bundler-less page;
 *   - the exported components + core functions for a Vue app that owns its own state.
 *
 * Everything data-related is Galaxy-agnostic here: a source is anything
 * `readParquetTable` accepts (URL, `ArrayBuffer`, `Blob`, AsyncBuffer) or a function
 * returning one. The helpers that talk to a Galaxy API live in `lib/source.js` so a
 * host can use them without this module knowing who embeds it.
 */
import { createApp, defineComponent, h, onMounted, reactive } from 'vue'

import App from './App.vue'
import ChromatogramPlot from './components/ChromatogramPlot.vue'
import { buildEicModel, decimateMinMax } from './lib/eic.js'
import { readParquetTable, resolveColumns, tableFromRows } from './lib/parquet.js'
import {
  datasetDisplayUrl,
  fetchDatasetMeta,
  groupToCsv,
  listCompanionChoices,
  listSiblingParquetDatasets,
  loadEicModel,
  resolveJobPartner,
  resolvePairIds,
} from './lib/source.js'
import { POINT_BUDGET, SERIES, SURFACE, LINE_WIDTH, themeFor } from './lib/tokens.js'

import './styles/viewer.css'

export { App, ChromatogramPlot }
export { buildEicModel, decimateMinMax }
export { readParquetTable, resolveColumns, tableFromRows }
export {
  datasetDisplayUrl,
  fetchDatasetMeta,
  groupToCsv,
  listCompanionChoices,
  listSiblingParquetDatasets,
  loadEicModel,
  resolveJobPartner,
  resolvePairIds,
}
export { POINT_BUDGET, SERIES, SURFACE, LINE_WIDTH, themeFor }
export * from './lib/format.js'

/**
 * @typedef {object} MountOptions
 * @property {object} [model]                 a model from `buildEicModel`, if the caller already has one
 * @property {*} [raw]                        source of the tool input (raw EIC table)
 * @property {*} [corrected]                  source of the tool output (baseline-removed table)
 * @property {Record<string,string>} [columnOverrides] force a column name, e.g. `{rt: 'scan_time'}`
 * @property {'light'|'dark'} [mode]          omit to follow the OS preference
 * @property {string} [title]
 * @property {{raw?: string, corrected?: string}} [labels] source names shown in the subtitle
 */

/** A source may be a value or a thunk, so loading can be deferred to the host. */
async function resolveSource(source) {
  if (typeof source === 'function') return source()
  return source
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the viewer into `element` and load a pybaselines pair.
 *
 * @param {HTMLElement} element
 * @param {MountOptions} [options]
 * @returns {{setData: (sources: {raw: *, corrected: *, labels?: object}) => Promise<void>,
 *            setModel: (model: object|null) => void, setMode: (mode: string) => void,
 *            getModel: () => object|null, destroy: () => void}}
 */
export function mountViewer(element, options = {}) {
  if (!element) throw new Error('mountViewer needs an element to mount into.')

  const followsOs = options.mode !== 'light' && options.mode !== 'dark'
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

  const state = reactive({
    model: options.model ?? null,
    loading: false,
    error: '',
    mode: followsOs && media?.matches ? 'dark' : (options.mode ?? 'light'),
    title: options.title ?? 'Baseline-removed extracted ion chromatograms',
    sources: options.labels ?? {},
  })

  let sources = { raw: options.raw, corrected: options.corrected }
  let generation = 0
  let destroyed = false

  const Host = defineComponent({
    setup() {
      onMounted(load)
      return () =>
        h(App, {
          model: state.model,
          loading: state.loading,
          error: state.error,
          mode: state.mode,
          title: state.title,
          sources: state.sources,
          'onUpdate:mode': (mode) => {
            state.mode = mode // an explicit choice stops following the OS
          },
        })
    },
  })

  const app = createApp(Host)
  app.mount(element)

  const onSchemeChange = (event) => {
    if (followsOs) state.mode = event.matches ? 'dark' : 'light'
  }
  media?.addEventListener?.('change', onSchemeChange)

  /** Load the currently set pair; a newer call always wins over an older one. */
  async function load() {
    if (!sources.raw || !sources.corrected) return undefined
    const token = ++generation
    state.loading = true
    state.error = ''
    try {
      const [raw, corrected] = await Promise.all([
        resolveSource(sources.raw),
        resolveSource(sources.corrected),
      ])
      const model = await loadEicModel({ raw, corrected }, options.columnOverrides)
      if (token !== generation || destroyed) return model
      state.model = model
      state.sources = sources.labels ?? state.sources
      return model
    } catch (error) {
      if (token === generation && !destroyed) state.error = messageOf(error)
      return undefined
    } finally {
      if (token === generation && !destroyed) state.loading = false
    }
  }

  return {
    /** Replace the pair and reload. Missing halves keep the previous value. */
    async setData(next = {}) {
      sources = { ...sources, ...next }
      return load()
    },
    setModel(model) {
      generation++
      state.model = model
      state.loading = false
      state.error = ''
    },
    setMode(mode) {
      state.mode = mode
    },
    getModel: () => state.model,
    destroy() {
      destroyed = true
      generation++
      media?.removeEventListener?.('change', onSchemeChange)
      app.unmount()
    },
  }
}

export default mountViewer
