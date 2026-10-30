<script setup>
/**
 * Standalone app shell — not part of the library entry.
 *
 * `mountViewer()` assumes a host that already knows which two parquet tables belong
 * together. A page opened directly has no such knowledge (and a browser cannot list a
 * directory), so this shell supplies the missing step: a hand-picked pair, or one of the
 * sample pairs — those come from `config.json` when the app ships one, else from the pairs
 * committed in `test-data/` (see `lib/samples.js`). The controls are handed to the viewer's
 * `toolbar` slot so they wear the same theme tokens as everything below them.
 */
import { onBeforeUnmount, reactive, ref } from 'vue'

import App from './App.vue'
import { loadEicModel } from './lib/source.js'
import { BUILTIN_SAMPLES, loadSampleList, sampleConfigUrl } from './lib/samples.js'

/** A URL in the query string wins over both the picker and the sample. */
function urlFromQuery(name) {
  const value = new URLSearchParams(window.location.search).get(name)
  return value ? new URL(value, document.baseURI).href : ''
}

const media = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null

/** `?mode=light|dark` overrides the OS preference — also how a dark host checks the theme. */
function initialMode() {
  const forced = new URLSearchParams(window.location.search).get('mode')
  if (forced === 'light' || forced === 'dark') return forced
  return media?.matches ? 'dark' : 'light'
}

const mode = ref(initialMode())

function onSchemeChange(event) {
  mode.value = event.matches ? 'dark' : 'light'
}
media?.addEventListener('change', onSchemeChange)

const sampleId = ref(BUILTIN_SAMPLES[0].id)
const files = { raw: null, corrected: null }
const state = reactive({
  model: null,
  loading: true,
  error: '',
  notices: [],
  samples: BUILTIN_SAMPLES,
  sources: {
    raw: urlFromQuery('raw'),
    corrected: urlFromQuery('corrected'),
  },
})

/** A picker or a manual sample change wins over a config that arrives late. */
let touched = false

/** `…/a/b.parquet` -> `b.parquet`, so the subtitle says which files are on screen. */
function nameOf(source) {
  if (source instanceof File) return source.name
  if (typeof source !== 'string') return ''
  return decodeURIComponent(source.split('?')[0].split('/').pop() ?? '')
}

let generation = 0

/** The pair is always replaced as a unit: half a pair is not a viewable state. */
async function load() {
  const { raw, corrected } = state.sources
  if (!raw || !corrected) {
    state.model = null
    state.error = 'Both a raw input table and a baseline-removed output table are needed.'
    return
  }
  const token = ++generation
  state.loading = true
  state.error = ''
  try {
    const model = await loadEicModel({ raw, corrected })
    if (token !== generation) return
    state.model = model
    state.sources = { raw: nameOf(raw), corrected: nameOf(corrected) }
  } catch (error) {
    if (token !== generation) return
    state.model = null
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (token === generation) state.loading = false
  }
}

function onSampleChange(event) {
  touched = true
  const sample = state.samples.find((s) => s.id === event.target.value)
  if (!sample) return
  sampleId.value = sample.id
  files.raw = null
  files.corrected = null
  for (const input of document.querySelectorAll('.shell__file')) input.value = ''
  state.sources = { raw: sample.raw, corrected: sample.corrected }
  load()
}

function onFile(event, key) {
  touched = true
  const [file] = Array.from(event.target.files ?? [])
  if (!file) return
  files[key] = file
  state.sources = { ...state.sources, [key]: file }
  load()
}

/**
 * Read the sample config before loading anything.
 *
 * Waiting is deliberate: loading the built-ins first would download one pair and then
 * another, and would swap the options under a user who had already picked one.
 */
async function bootstrap() {
  const { samples, notices } = await loadSampleList(sampleConfigUrl(urlFromQuery('config')))
  state.samples = samples
  state.notices = notices
  const chosen = samples.find((s) => s.id === sampleId.value) ?? samples[0]
  sampleId.value = chosen.id
  if (!touched) {
    // `?raw=&corrected=` still win, per half: a link to one table keeps the other from the
    // chosen pair rather than failing for want of a second URL.
    state.sources = {
      raw: state.sources.raw || chosen.raw,
      corrected: state.sources.corrected || chosen.corrected,
    }
  }
  await load()
}

onBeforeUnmount(() => media?.removeEventListener('change', onSchemeChange))

bootstrap()
</script>

<template>
  <App
    v-model:mode="mode"
    :model="state.model"
    :loading="state.loading"
    :error="state.error"
    :sources="state.sources">
    <template #toolbar>
      <div class="shell__sources">
        <label class="shell__field">
          <span class="shell__label">Example pair</span>
          <select class="shell__control" :value="sampleId" @change="onSampleChange">
            <option v-for="sample in state.samples" :key="sample.id" :value="sample.id">
              {{ sample.name }}
            </option>
          </select>
        </label>
        <label class="shell__field">
          <span class="shell__label">Raw input parquet</span>
          <input
            class="shell__control shell__file"
            type="file"
            accept=".parquet"
            @change="onFile($event, 'raw')" />
        </label>
        <label class="shell__field">
          <span class="shell__label">Baseline-removed parquet</span>
          <input
            class="shell__control shell__file"
            type="file"
            accept=".parquet"
            @change="onFile($event, 'corrected')" />
        </label>
        <p class="shell__hint">
          Or point the page at any two URLs with <code>?raw=&amp;corrected=</code>.
        </p>
        <!-- Config notes wear the shell's own chrome rather than the viewer's banners: the
             `error` prop means "nothing loaded", and the other banner is driven by
             `model.warnings`, so it would disappear exactly when the config is the problem. -->
        <ul v-if="state.notices.length" class="shell__notices" role="status">
          <li v-for="(notice, i) in state.notices" :key="i">{{ notice }}</li>
        </ul>
      </div>
    </template>
  </App>
</template>

<style>
/* Only the chrome above the library root; everything inside `.eicb-root` themes
   itself. uPlot's stylesheet comes in with the plot component. */
body {
  margin: 0;
  background: #f9f9f7;
}

@media (prefers-color-scheme: dark) {
  body {
    background: #0d0d0d;
  }
}

.shell__sources {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 18px;
  padding: 12px;
  border: 1px solid var(--eicb-border);
  border-radius: 10px;
  background: var(--eicb-surface);
}

.shell__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.shell__label {
  color: var(--eicb-text-secondary);
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.shell__control {
  max-width: 46vw;
  padding: 6px 8px;
  border: 1px solid var(--eicb-border);
  border-radius: 8px;
  background: var(--eicb-plane);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
}

.shell__hint {
  margin: 0;
  color: var(--eicb-muted);
  font-size: 12px;
}

/* Own line under the controls: a notice has to be readable, not squeezed into the row. */
.shell__notices {
  flex: 1 0 100%;
  margin: 0;
  padding-left: 20px;
  color: var(--eicb-text-secondary);
  font-size: 12px;
}
</style>
