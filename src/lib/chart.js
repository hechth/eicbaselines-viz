/**
 * uPlot option/data construction, kept free of DOM and Vue so it can be unit tested.
 *
 * Two rules from the chart spec drive most of the choices here:
 *   - one y axis, ever. Raw and baseline-removed intensities share a unit, so they can
 *     legitimately share a scale; anything that could not share it gets its own panel.
 *   - decimation must not eat peaks. uPlot requires every series to share one x array,
 *     so the retained indices are the *union* of each series' min/max picks.
 */
import { decimateMinMax } from './eic.js'
import { formatCompact, formatRt } from './format.js'
import { LINE_WIDTH, POINT_BUDGET } from './tokens.js'

/** Series keys in the order they are drawn and listed in the legend. */
export const SERIES_ORDER = ['corrected', 'raw', 'baseline']

/**
 * Union of per-series min/max decimation indices, so all series keep a common x axis.
 * @param {ArrayLike<number>} rt
 * @param {ArrayLike<number>[]} seriesArrays
 * @param {number} budget
 * @returns {number[]} ascending indices
 */
export function sharedIndices(rt, seriesArrays, budget) {
  const keep = new Set()
  for (const values of seriesArrays) {
    for (const i of decimateMinMax(rt, values, budget)) keep.add(i)
  }
  return [...keep].sort((a, b) => a - b)
}

/**
 * Build the uPlot `data` array: `[x, ...visibleSeries]`.
 * NaN becomes null so uPlot draws a gap instead of a line to a bogus value.
 */
export function buildPlotData(group, { budget = POINT_BUDGET, visible } = {}) {
  const shown = SERIES_ORDER.filter((key) => (visible ? visible[key] !== false : true))
  const arrays = shown.map((key) => group[key])
  const indices = sharedIndices(group.rt, arrays, budget)

  const pick = (values) => indices.map((i) => (Number.isFinite(values[i]) ? values[i] : null))

  return {
    data: [indices.map((i) => group.rt[i]), ...arrays.map(pick)],
    seriesKeys: shown,
    indices,
    decimated: indices.length < group.rt.length,
    pointCount: indices.length,
    totalCount: group.rt.length,
  }
}

/** Y range pinned at zero: chromatogram intensity has no negative values. */
export function yRange(u, min, max) {
  const top = Number.isFinite(max) ? max : 1
  return [0, top + Math.abs(top) * 0.08]
}

/**
 * Axis tick values. Falls back to plain decimals for sub-unit scales so a tick never
 * renders as "0.000001e+3".
 */
export function rtValues(u, vals) {
  const visible = vals.filter((v) => Number.isFinite(v))
  if (!visible.length) return vals.map(() => '')
  const span = Math.max(...visible) - Math.min(...visible)
  const digits =
    span > 0 && span < 1 ? Math.min(4, Math.max(2, Math.ceil(-Math.log10(span)) + 1)) : 2
  return vals.map((v) => formatRt(v, digits))
}

export function intensityValues(u, vals) {
  return vals.map((v) => formatCompact(v))
}

/**
 * uPlot options for the chromatogram panel.
 * @param {object} theme from `themeFor()`
 * @param {{width:number, height:number, visible?:object, xLabel?:string, compact?:boolean}} options
 */
export function buildOptions(theme, { width, height, visible = {}, xLabel, compact = false } = {}) {
  const byKey = Object.fromEntries(theme.series.map((s) => [s.key, s]))
  const series = [{ label: xLabel ?? 'Retention time (s)' }]

  for (const key of SERIES_ORDER) {
    const def = byKey[key]
    if (!def) continue
    series.push({
      id: key,
      label: def.name,
      show: visible[key] !== false,
      stroke: def.color,
      // The result curve keeps the full 2px; context curves step back slightly.
      width: def.emphasis ? LINE_WIDTH : LINE_WIDTH - 0.5,
      dash: def.dashed ? [4, 3] : null,
      // The crosshair tooltip lists every series, so per-point markers would be noise.
      points: { show: false },
    })
  }

  return {
    width,
    height,
    title: '',
    series,
    scales: {
      x: { time: false, distr: 1 },
      y: { range: yRange, auto: true },
    },
    axes: [
      {
        label: compact ? '' : (xLabel ?? 'Retention time (s)'),
        labelSize: compact ? 0 : 18,
        labelGap: 6,
        size: compact ? 26 : 40,
        // Minimum pixels between ticks; this is what keeps the scale readable when the
        // window is narrow (a Galaxy side panel) and the range is long.
        space: compact ? 60 : 90,
        gap: 4,
        // Retention time is in seconds, so whole-second, minute and hour steps read best.
        incrs: [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200],
        values: rtValues,
        // uPlot draws tick labels on the canvas, so the ink token has to travel with
        // the options; CSS cannot reach them.
        stroke: theme.textSecondary,
        // uPlot's sides run clockwise from the top: 0 top, 1 right, 2 bottom, 3 left.
        side: 2,
        grid: { show: true, stroke: theme.grid, width: 1 },
        ticks: { show: false },
      },
      {
        label: compact ? '' : 'Intensity',
        labelSize: compact ? 0 : 18,
        labelGap: 6,
        size: compact ? 46 : 62,
        space: compact ? 30 : 42,
        gap: 6,
        values: intensityValues,
        stroke: theme.textSecondary,
        side: 3,
        grid: { show: true, stroke: theme.grid, width: 1 },
        ticks: { show: false },
      },
    ],
    cursor: {
      // Drag to zoom on x, double click to reset; the vertical hairline doubles as
      // the crosshair the tooltip reads from.
      drag: { x: true, y: false, setSelect: false },
      focus: { dist: 20 },
      points: { show: false },
      stroke: theme.axis,
      width: 1,
    },
    select: {
      show: true,
      stroke: theme.axis,
      fill: theme.mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(11,11,11,0.08)',
      width: 1,
    },
    legend: { show: false }, // the Vue legend owns this; uPlot's cannot carry line keys
    padding: [0, 0, 0, 0],
  }
}

/**
 * Values at the crosshair position, for the one shared tooltip.
 *
 * `plotIndex` is an index into the (possibly decimated) plotted arrays, so it is mapped
 * back through `indices` before reading the full-resolution group — the tooltip must
 * report the real measured point, never a decimated stand-in.
 *
 * @param {object} group
 * @param {Array<{key:string,name:string,color:string}>} seriesDefs
 * @param {number|null} plotIndex index into the plotted data
 * @param {number[]} indices plotted index -> group index
 */
export function readCursor(group, seriesDefs, plotIndex, indices) {
  if (plotIndex == null || plotIndex < 0 || plotIndex >= indices.length) return null
  const gi = indices[plotIndex]
  return {
    groupIndex: gi,
    rt: group.rt[gi],
    rows: seriesDefs.map((def) => {
      const value = group[def.key]?.[gi]
      return {
        key: def.key,
        name: def.name,
        color: def.color,
        value: Number.isFinite(value) ? value : null,
      }
    }),
  }
}
