<script setup>
/**
 * Main panel: one focused EIC with the raw and baseline-removed traces overlayed, a
 * top selector to switch or pin EICs, and a table view carrying every value without
 * any hovering.
 */
import { computed, ref, watch } from 'vue'

import ChromatogramPlot from './components/ChromatogramPlot.vue'
import {
  formatCompact,
  formatInteger,
  formatMz,
  formatPercent,
  formatPpm,
  formatRt,
} from './lib/format.js'
import { groupToCsv } from './lib/source.js'
import { SERIES } from './lib/tokens.js'

const props = defineProps({
  model: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  mode: { type: String, default: 'light' },
  title: { type: String, default: 'Baseline-removed extracted ion chromatograms' },
  /** Labels for the two source tables, shown in the subtitle. */
  sources: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['update:mode'])

/** Cap on rendered point rows; the CSV export always carries the whole window. */
const POINT_CAP = 400

const focusedId = ref(null)
const pinned = ref([])
const visible = ref({ corrected: true, raw: true, baseline: true })
const showTable = ref(false)
const pointWindow = ref({ min: null, max: null })
const sort = ref({ key: 'id', dir: 1 })
const mainPlot = ref(null)

const groups = computed(() => props.model?.groups ?? [])

const focused = computed(() => {
  const list = groups.value
  if (!list.length) return null
  const found = list.find((g) => g.id === focusedId.value)
  return found ?? list[0]
})

const pinnedGroups = computed(() =>
  pinned.value
    .filter((id) => id !== focused.value?.id)
    .map((id) => groups.value.find((g) => g.id === id))
    .filter(Boolean),
)

watch(focused, (group) => {
  if (group) focusedId.value = group.id
})

// A new file should not keep a selection that no longer exists.
watch(groups, (list) => {
  if (!list.some((g) => g.id === focusedId.value)) focusedId.value = list[0]?.id ?? null
  pinned.value = pinned.value.filter((id) => list.some((g) => g.id === id))
})

const sortedGroups = computed(() => {
  const { key, dir } = sort.value
  return groups.value.slice().sort((a, b) => {
    const av = key === 'id' ? numericId(a.id) : (a[key] ?? -Infinity)
    const bv = key === 'id' ? numericId(b.id) : (b[key] ?? -Infinity)
    return (av > bv ? 1 : av < bv ? -1 : 0) * dir
  })
})

function numericId(id) {
  const n = Number(id)
  return Number.isFinite(n) ? n : String(id)
}

function toggleSort(key) {
  sort.value = sort.value.key === key ? { key, dir: -sort.value.dir } : { key, dir: 1 }
}

function optionLabel(group) {
  const mz = group.mz === null ? 'm/z n/a' : `m/z ${formatMz(group.mz)}`
  return `${group.label} · ${mz} · RT ${formatRt(group.rtMin)}–${formatRt(group.rtMax)} s · ${group.nPoints} pts`
}

/** Pin/unpin a group, defaulting to the focused one (the chip passes an explicit id). */
function togglePin(id) {
  const target = id ?? focused.value?.id
  if (target === null || target === undefined) return
  pinned.value = pinned.value.includes(target)
    ? pinned.value.filter((p) => p !== target)
    : [...pinned.value, target]
}

function isPinned(id) {
  return pinned.value.includes(id)
}

function focusAndUnpin(id) {
  focusedId.value = id
  pinned.value = pinned.value.filter((p) => p !== id)
}

/** Rows of the focused EIC inside the visible x range, for the on-page table view. */
const pointRows = computed(() => {
  const group = focused.value
  if (!group) return { rows: [], total: 0, truncated: false }
  const { min, max } = pointWindow.value
  const all = []
  for (let i = 0; i < group.rt.length; i++) {
    const rt = group.rt[i]
    if (min !== null && rt < min) continue
    if (max !== null && rt > max) continue
    all.push(i)
  }
  return {
    rows: all.slice(0, POINT_CAP),
    total: all.length,
    truncated: all.length > POINT_CAP,
  }
})

const tableCaption = computed(() => {
  const group = focused.value
  if (!group) return ''
  const { total, truncated } = pointRows.value
  return truncated
    ? `First ${POINT_CAP} of ${formatInteger(total)} points of ${group.label} in the plotted window (download the CSV for all of them)`
    : `All ${formatInteger(total)} points of ${group.label} in the plotted window`
})

function downloadCsv() {
  const group = focused.value
  if (!group) return
  const blob = new Blob([groupToCsv(group)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `eic-${String(group.id).replace(/[^\w.-]+/g, '_')}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function onZoom(range) {
  pointWindow.value = range
}

function cycleMode() {
  emit('update:mode', props.mode === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <div class="eicb-root" :data-eic-theme="mode">
    <header class="eicb-head">
      <div class="eicb-head__text">
        <h1 class="eicb-title">{{ title }}</h1>
        <p class="eicb-subtitle">
          <template v-if="sources.raw || sources.corrected">
            raw: {{ sources.raw || '—' }} · baseline removed: {{ sources.corrected || '—' }}
          </template>
          <template v-else-if="model">
            {{ formatInteger(model.totals.groups) }} EIC groups ·
            {{ formatInteger(model.totals.points) }} points · rows matched by
            {{ model.strategy }}
          </template>
          <template v-else>
            Select an input and a baseline-removed parquet table to start.
          </template>
        </p>
      </div>
      <button class="eicb-button" type="button" :aria-pressed="mode === 'dark'" @click="cycleMode">
        {{ mode === 'dark' ? 'Dark' : 'Light' }}
      </button>
    </header>

    <!-- Hosts (the standalone app, a Galaxy panel with extra settings) add controls
         inside the themed frame, so they inherit the same tokens. -->
    <slot name="toolbar"></slot>

    <p v-if="loading" class="eicb-banner" role="status">Reading parquet tables…</p>
    <p v-if="error" class="eicb-banner eicb-banner--error" role="alert">{{ error }}</p>

    <div v-if="model?.warnings?.length" class="eicb-banner">
      <strong>Data notes</strong>
      <ul>
        <li v-for="(warning, i) in model.warnings" :key="i">{{ warning }}</li>
      </ul>
    </div>

    <template v-if="focused">
      <div class="eicb-controls">
        <label class="eicb-field">
          <span class="eicb-field__label">EIC</span>
          <select v-model="focusedId" class="eicb-select eicb-select--eic">
            <option v-for="group in sortedGroups" :key="String(group.id)" :value="group.id">
              {{ optionLabel(group) }}
            </option>
          </select>
        </label>

        <button
          class="eicb-button"
          type="button"
          :aria-pressed="isPinned(focused.id)"
          @click="togglePin()">
          {{ isPinned(focused.id) ? 'Unpin' : 'Pin to compare' }}
        </button>

        <div class="eicb-field">
          <span class="eicb-field__label">Traces</span>
          <div class="eicb-checks">
            <label v-for="series in SERIES" :key="series.key" class="eicb-check">
              <input v-model="visible[series.key]" type="checkbox" />
              <span
                class="eicb-key"
                :style="{
                  background: mode === 'dark' ? series.dark : series.light,
                  color: mode === 'dark' ? series.dark : series.light,
                }"
                :data-dashed="series.dashed ? 'true' : 'false'"
                aria-hidden="true"></span>
              {{ series.name }}
            </label>
          </div>
        </div>

        <div class="eicb-field">
          <span class="eicb-field__label">View</span>
          <div class="eicb-checks">
            <button class="eicb-button" type="button" @click="mainPlot?.zoomToPeak()">
              Zoom to peak
            </button>
            <button class="eicb-button" type="button" @click="mainPlot?.resetZoom()">
              Reset zoom
            </button>
            <button
              class="eicb-button"
              type="button"
              :aria-pressed="showTable"
              @click="showTable = !showTable">
              Table
            </button>
          </div>
        </div>
      </div>

      <div v-if="pinned.length" class="eicb-chips" aria-label="Pinned EICs">
        <span>Pinned</span>
        <span v-for="group in pinnedGroups" :key="String(group.id)" class="eicb-chip">
          {{ group.label }} · {{ formatMz(group.mz) }}
          <button type="button" :aria-label="`Remove ${group.label}`" @click="togglePin(group.id)">
            ×
          </button>
        </span>
      </div>

      <section class="eicb-panel" aria-label="Focused chromatogram">
        <div class="eicb-panel__head">
          <h2 class="eicb-panel__title">
            EIC {{ focused.label }} — m/z {{ formatMz(focused.mz) }}
          </h2>
          <span class="eicb-panel__meta">
            RT {{ formatRt(focused.rtMin) }}–{{ formatRt(focused.rtMax) }} s ·
            {{ formatInteger(focused.nPoints) }} points
          </span>
        </div>

        <ul class="eicb-legend">
          <li
            v-for="series in SERIES"
            :key="series.key"
            :data-off="visible[series.key] ? null : ''">
            <span
              class="eicb-key"
              :style="{
                background: mode === 'dark' ? series.dark : series.light,
                color: mode === 'dark' ? series.dark : series.light,
              }"
              :data-dashed="series.dashed ? 'true' : 'false'"
              aria-hidden="true"></span>
            {{ series.name }}
          </li>
        </ul>

        <ChromatogramPlot
          ref="mainPlot"
          :group="focused"
          :mode="mode"
          :visible="visible"
          :height="380"
          @zoom="onZoom" />

        <dl class="eicb-stats">
          <div class="eicb-stat eicb-stat--hero">
            <dt>Baseline removed</dt>
            <dd>{{ formatPercent(focused.removedPercent) }}</dd>
            <span class="eicb-stat__note">
              of total raw intensity · {{ formatCompact(focused.rawSum - focused.correctedSum) }}
              absolute
            </span>
          </div>
          <div class="eicb-stat">
            <dt>m/z (group mean)</dt>
            <dd>{{ formatMz(focused.mz) }}</dd>
            <span class="eicb-stat__note">
              {{
                focused.mzPpmSpread === null
                  ? 'single m/z'
                  : `spread ${formatPpm(focused.mzPpmSpread)} ppm`
              }}
            </span>
          </div>
          <div class="eicb-stat">
            <dt>RT range</dt>
            <dd>{{ formatRt(focused.rtMax - focused.rtMin) }} s</dd>
            <span class="eicb-stat__note"> apex at {{ formatRt(focused.rtApex) }} s </span>
          </div>
          <div class="eicb-stat">
            <dt>Peak height</dt>
            <dd>{{ formatCompact(focused.correctedMax) }}</dd>
            <span class="eicb-stat__note">raw max {{ formatCompact(focused.rawMax) }}</span>
          </div>
          <div class="eicb-stat">
            <dt>Points clipped to 0</dt>
            <dd>{{ formatInteger(focused.clippedPoints) }}</dd>
            <span class="eicb-stat__note">
              baseline is a lower bound there ·
              {{ formatInteger(focused.nMatched) }}/{{ formatInteger(focused.nPoints) }} matched
            </span>
          </div>
        </dl>
      </section>

      <section
        v-for="group in pinnedGroups"
        :key="String(group.id)"
        class="eicb-panel"
        :aria-label="`Pinned chromatogram ${group.label}`">
        <div class="eicb-panel__head">
          <h2 class="eicb-panel__title">EIC {{ group.label }} — m/z {{ formatMz(group.mz) }}</h2>
          <span class="eicb-panel__meta">
            RT {{ formatRt(group.rtMin) }}–{{ formatRt(group.rtMax) }} s
          </span>
          <span class="eicb-panel__spacer"></span>
          <button class="eicb-link" type="button" @click="focusAndUnpin(group.id)">focus</button>
        </div>
        <ChromatogramPlot
          :group="group"
          :mode="mode"
          :visible="visible"
          :compact="true"
          :height="150" />
      </section>

      <section v-if="showTable" class="eicb-panel" aria-label="Data table">
        <div class="eicb-panel__head">
          <h2 class="eicb-panel__title">Points of {{ focused.label }}</h2>
          <span class="eicb-panel__spacer"></span>
          <button class="eicb-button" type="button" @click="downloadCsv">Download CSV</button>
        </div>
        <div class="eicb-tablewrap">
          <table class="eicb-table">
            <caption>
              {{
                tableCaption
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">RT (s)</th>
                <th scope="col">Raw</th>
                <th scope="col">Baseline removed</th>
                <th scope="col">Estimated baseline</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in pointRows.rows" :key="i">
                <td>{{ formatRt(focused.rt[i], 3) }}</td>
                <td>{{ formatInteger(Math.round(focused.raw[i])) }}</td>
                <td>{{ formatInteger(Math.round(focused.corrected[i])) }}</td>
                <td>{{ formatInteger(Math.round(focused.baseline[i])) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="eicb-note">Zooming the chart narrows this table to the plotted window.</p>
      </section>

      <section class="eicb-panel" aria-label="All EIC groups">
        <div class="eicb-panel__head">
          <h2 class="eicb-panel__title">All EIC groups</h2>
          <span class="eicb-panel__meta">
            {{ formatInteger(sortedGroups.length) }} groups ·
            {{ formatPercent(model.totals.removedPercent) }} of total intensity removed
          </span>
        </div>
        <div class="eicb-tablewrap">
          <table class="eicb-table">
            <caption>
              Every group in the pair, with the group mean m/z and its retention time range.
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <button class="eicb-link" type="button" @click="toggleSort('id')">Group</button>
                </th>
                <th scope="col">
                  <button class="eicb-link" type="button" @click="toggleSort('mz')">m/z</button>
                </th>
                <th scope="col">
                  <button class="eicb-link" type="button" @click="toggleSort('rtMin')">
                    RT min
                  </button>
                </th>
                <th scope="col">
                  <button class="eicb-link" type="button" @click="toggleSort('rtMax')">
                    RT max
                  </button>
                </th>
                <th scope="col">
                  <button class="eicb-link" type="button" @click="toggleSort('nPoints')">
                    Points
                  </button>
                </th>
                <th scope="col">
                  <button class="eicb-link" type="button" @click="toggleSort('removedPercent')">
                    Removed
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="group in sortedGroups"
                :key="String(group.id)"
                :data-active="group.id === focused.id ? '' : null">
                <td>
                  <button class="eicb-link" type="button" @click="focusedId = group.id">
                    {{ group.label }}
                  </button>
                </td>
                <td>{{ formatMz(group.mz) }}</td>
                <td>{{ formatRt(group.rtMin) }}</td>
                <td>{{ formatRt(group.rtMax) }}</td>
                <td>{{ formatInteger(group.nPoints) }}</td>
                <td>{{ formatPercent(group.removedPercent) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <p v-else-if="!loading && !error" class="eicb-empty">No data loaded.</p>
  </div>
</template>
