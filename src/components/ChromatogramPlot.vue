<script setup>
/**
 * One chromatogram panel: raw EIC, baseline-removed curve and the derived baseline,
 * sharing a single y axis (they share a unit, so a second scale would be a lie).
 *
 * Direct labels and the tooltip are HTML overlays rather than canvas text: they then
 * wear the ink tokens instead of the series colour, they stay selectable, and assistive
 * tech can read them.
 *
 * Overlay geometry is derived from the visible scale range and the `.u-over` box rather
 * than from uPlot's `valToPos`, whose return basis differs between the x and y axes.
 * Both scales here are linear, so the mapping is exact.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

import { buildOptions, buildPlotData, readCursor, SERIES_ORDER } from '../lib/chart.js'
import { formatCompact, formatIntensity, formatRt, formatRtClock } from '../lib/format.js'
import { themeFor } from '../lib/tokens.js'

const props = defineProps({
  group: { type: Object, required: true },
  mode: { type: String, default: 'light' },
  visible: { type: Object, default: () => ({}) },
  xLabel: { type: String, default: 'Retention time (s)' },
  compact: { type: Boolean, default: false },
  height: { type: Number, default: 360 },
})

const emit = defineEmits(['zoom'])

const root = ref(null)
const host = ref(null)
const tooltip = ref(null)
const apexLabel = ref(null)
const chart = shallowRef(null)
const plot = shallowRef(null) // last {data, indices, seriesKeys, ...}

let observer = null
let fullRange = null

/** Linear value -> pixel mapping inside `.u-over`, the plotting area. */
function project(instance, value, scaleKey) {
  const scale = instance.scales[scaleKey]
  const over = host.value?.querySelector('.u-over')
  const span = scale.max - scale.min
  if (!over || !Number.isFinite(span) || span === 0) return null
  const fraction = (value - scale.min) / span
  return scaleKey === 'x'
    ? { offset: over.offsetLeft + fraction * over.clientWidth }
    : { offset: over.offsetTop + (1 - fraction) * over.clientHeight }
}

function measure() {
  const width = root.value?.clientWidth ?? 640
  return { width: Math.max(280, width), height: props.height }
}

function create() {
  destroy()
  if (!host.value) return
  // Every series is always in the data; the checkboxes only toggle `show`. Hiding a
  // series from the data would re-decimate the remaining ones and, worse, leave a
  // switched-off trace with no columns to switch back on.
  const built = buildPlotData(props.group)
  plot.value = built
  const { width, height } = measure()
  const options = buildOptions(themeFor(props.mode), {
    width,
    height,
    visible: props.visible,
    xLabel: props.xLabel,
    compact: props.compact,
  })
  // uPlot keeps its hooks in the options object and fires `ready` while constructing,
  // so they have to exist before there is an instance. Every callback receives the
  // instance as its first argument, which is why none of them close over one.
  options.hooks = {
    setCursor: [onCursor],
    draw: [paintOverlays],
    setScale: [onSetScale],
    ready: [onReady],
  }
  chart.value = new uPlot(options, built.data, host.value)
}

function onSetScale(instance, scaleKey) {
  if (scaleKey !== 'x') return
  paintOverlays(instance)
  emitZoom(instance)
}

function onReady(instance) {
  fullRange = { min: instance.scales.x.min, max: instance.scales.x.max }
  paintOverlays(instance)
  emitZoom(instance)
}

function destroy() {
  chart.value?.destroy()
  chart.value = null
}

function emitZoom(instance) {
  if (!instance) return
  emit('zoom', { min: instance.scales.x.min, max: instance.scales.x.max })
}

/** The one tooltip lists every visible series at the crosshair's x. */
function onCursor(instance) {
  const el = tooltip.value
  if (!el) return
  const left = instance.cursor.left
  const top = instance.cursor.top
  const reading = readCursor(
    props.group,
    seriesDefs(),
    instance.cursor.idx,
    plot.value?.indices ?? [],
  )
  if (left == null || left < 0 || top == null || top < 0 || !reading) {
    el.hidden = true
    return
  }
  el.replaceChildren(buildTooltip(reading))
  el.hidden = false
  const over = host.value?.querySelector('.u-over')
  const width = el.offsetWidth
  // Flip to the left of the crosshair before overflowing the panel.
  const flip = over && left + width + 18 > over.clientWidth
  el.style.left = `${(over?.offsetLeft ?? 0) + left + (flip ? -width - 12 : 12)}px`
  el.style.top = `${Math.max(0, (over?.offsetTop ?? 0) + top - el.offsetHeight / 2)}px`
}

/** The tooltip lists the traces that are actually on the chart, in legend order. */
function seriesDefs() {
  return themeFor(props.mode).series.filter((s) => props.visible[s.key] !== false)
}

function buildTooltip(reading) {
  const list = document.createElement('ul')
  list.className = 'eicb-tip__rows'
  for (const row of reading.rows) {
    const li = document.createElement('li')
    li.className = 'eicb-tip__row'

    const key = document.createElement('span')
    key.className = 'eicb-key'
    key.style.background = row.color
    key.style.color = row.color
    if (row.key === 'baseline') key.dataset.dashed = 'true'

    const name = document.createElement('span')
    name.className = 'eicb-tip__name'
    name.textContent = row.name

    const value = document.createElement('span')
    value.className = 'eicb-tip__value'
    value.textContent = formatIntensity(row.value)

    li.append(key, name, value)
    list.append(li)
  }

  const wrap = document.createElement('div')
  const x = document.createElement('p')
  x.className = 'eicb-tip__x'
  // Both spellings of the same reading: seconds to match the axis, mm:ss to scan.
  x.textContent = `RT ${formatRt(reading.rt)} s · ${formatRtClock(reading.rt)}`
  wrap.append(x, list)
  return wrap
}

/**
 * Direct label on the apex of the baseline-removed curve — the one value worth
 * labelling. The coloured dot carries identity; the text stays ink.
 */
function paintOverlays(instance) {
  const el = apexLabel.value
  const group = props.group
  if (!el) return
  if (props.compact || props.visible.corrected === false || !(group.correctedMax > 0)) {
    el.hidden = true
    return
  }
  const indices = plot.value?.indices ?? []
  let apexValue = -Infinity
  let apexRt = NaN
  for (const gi of indices) {
    const y = group.corrected[gi]
    if (Number.isFinite(y) && y > apexValue) {
      apexValue = y
      apexRt = group.rt[gi]
    }
  }
  const x = Number.isFinite(apexRt) ? project(instance, apexRt, 'x') : null
  const y = project(instance, apexValue, 'y')
  if (!x || !y) {
    el.hidden = true
    return
  }
  el.querySelector('.eicb-apex__text').textContent =
    `apex ${formatRt(apexRt)} s · ${formatCompact(apexValue)}`
  // Un-hide, then measure: a hidden element has no width to flip with. A peak near the
  // right edge (the usual case, since the apex is late in the run) gets the label on the
  // inside instead of clipped at the panel edge.
  el.hidden = false
  const width = el.offsetWidth
  const available = root.value?.clientWidth ?? Infinity
  const preferred = x.offset + 8
  const left = preferred + width > available - 4 ? x.offset - width - 8 : preferred
  el.style.left = `${Math.max(4, left)}px`
  el.style.top = `${Math.max(0, y.offset - el.offsetHeight - 10)}px`
}

function resetZoom() {
  if (!chart.value || !fullRange) return
  chart.value.setScale('x', { min: fullRange.min, max: fullRange.max })
}

/** Zoom to a window centred on the corrected apex. */
function zoomToPeak() {
  const instance = chart.value
  if (!instance || !Number.isFinite(props.group.rtApex)) return
  const span = (props.group.rtMax - props.group.rtMin) * 0.12
  instance.setScale('x', { min: props.group.rtApex - span, max: props.group.rtApex + span })
}

function onWheel(event) {
  // Plain wheeling must keep scrolling the Galaxy panel; Ctrl/Cmd + wheel zooms.
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const instance = chart.value
  if (!instance) return
  const scale = instance.scales.x
  const centre = instance.posToVal(instance.cursor.left ?? 0, 'x')
  const anchor = Number.isFinite(centre) ? centre : (scale.min + scale.max) / 2
  const factor = event.deltaY > 0 ? 1.25 : 1 / 1.25
  const half = ((scale.max - scale.min) * factor) / 2
  instance.setScale('x', { min: anchor - half, max: anchor + half })
}

onMounted(() => {
  create()
  host.value?.addEventListener('wheel', onWheel, { passive: false })
  observer = new ResizeObserver(() => {
    const { width, height } = measure()
    chart.value?.setSize({ width, height })
    if (chart.value) paintOverlays(chart.value)
  })
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  host.value?.removeEventListener('wheel', onWheel)
  destroy()
})

watch(
  () => props.group,
  () => {
    const instance = chart.value
    if (!instance) return
    const built = buildPlotData(props.group)
    plot.value = built
    // `true` re-fits the axes: a different EIC is a different data range.
    instance.setData(built.data, true)
    fullRange = { min: instance.scales.x.min, max: instance.scales.x.max }
    emitZoom(instance)
  },
)

watch(
  () => props.visible,
  (visible) => {
    const instance = chart.value
    if (!instance) return
    // Every series is in the data, so a toggle never resamples — and series 0 is the
    // x axis, hence the offset.
    const shown = plot.value?.seriesKeys ?? []
    SERIES_ORDER.forEach((key, i) => {
      if (shown.includes(key)) instance.setSeries(i + 1, { show: visible[key] !== false })
    })
    paintOverlays(instance)
  },
  { deep: true },
)

// Colours are baked into the uPlot options, so a scheme change rebuilds the chart.
watch(() => props.mode, create)

watch(
  () => props.height,
  () => {
    const { width, height } = measure()
    chart.value?.setSize({ width, height })
  },
)

defineExpose({ resetZoom, zoomToPeak })
</script>

<template>
  <div ref="root" class="eicb-plot">
    <div ref="host"></div>
    <div ref="tooltip" class="eicb-tip" hidden></div>
    <div v-if="!compact" ref="apexLabel" class="eicb-apex" hidden>
      <span class="eicb-apex__dot" aria-hidden="true"></span>
      <span class="eicb-apex__text"></span>
    </div>
  </div>
</template>
