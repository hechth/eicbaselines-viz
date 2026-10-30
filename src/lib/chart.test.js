import { describe, expect, it } from 'vitest'

import {
  buildOptions,
  buildPlotData,
  intensityValues,
  readCursor,
  rtValues,
  SERIES_ORDER,
  sharedIndices,
  yRange,
} from './chart.js'
import { formatMz } from './format.js'
import { themeFor } from './tokens.js'

/** A group shaped like the output of `buildGroup`, small enough to check by hand. */
function fakeGroup(overrides = {}) {
  const rt = Float64Array.from([10, 20, 30, 40, 50])
  const raw = Float64Array.from([100, 120, 400, 130, 110])
  const corrected = Float64Array.from([20, 24, 300, 26, 0])
  const baseline = Float64Array.from([80, 96, 100, 104, 110])
  return {
    id: 1,
    label: '#1',
    mz: 839.8769,
    rt,
    raw,
    corrected,
    baseline,
    rtMin: 10,
    rtMax: 50,
    rtApex: 30,
    rawMax: 400,
    correctedMax: 300,
    correctedSum: 370,
    rawSum: 860,
    ...overrides,
  }
}

describe('sharedIndices', () => {
  it('keeps every index when the budget is not exceeded', () => {
    const group = fakeGroup()
    expect(sharedIndices(group.rt, [group.raw], 100)).toEqual([0, 1, 2, 3, 4])
  })

  it('unions the picks of all series, so no series loses its peak', () => {
    // A tall spike only in `raw` and a deep trough only in `corrected`.
    const n = 200
    const rt = Float64Array.from({ length: n }, (_, i) => i)
    const raw = new Float64Array(n).fill(10)
    const corrected = new Float64Array(n).fill(10)
    raw[37] = 900
    corrected[141] = 0
    const indices = sharedIndices(rt, [raw, corrected], 40)

    expect(indices).toEqual([...new Set(indices)].sort((a, b) => a - b))
    expect(indices).toContain(37)
    expect(indices).toContain(141)
    expect(indices.length).toBeLessThanOrEqual(80)
  })

  it('tolerates NaN without dropping the whole bucket', () => {
    const rt = Float64Array.from([1, 2, 3, 4, 5, 6])
    const values = Float64Array.from([NaN, NaN, 5, 1, NaN, 3])
    const indices = sharedIndices(rt, [values], 4)
    expect(indices).toContain(2)
    expect(indices).toContain(3)
  })
})

describe('buildPlotData', () => {
  it('plots x first and one array per visible series', () => {
    const built = buildPlotData(fakeGroup())
    expect(built.seriesKeys).toEqual(SERIES_ORDER)
    expect(built.data.length).toBe(4)
    expect(Array.from(built.data[0])).toEqual([10, 20, 30, 40, 50])
    expect(built.decimated).toBe(false)
  })

  it('drops hidden series from the data and the key list', () => {
    const built = buildPlotData(fakeGroup(), {
      visible: { corrected: true, raw: false, baseline: true },
    })
    expect(built.seriesKeys).toEqual(['corrected', 'baseline'])
    expect(built.data.length).toBe(3)
  })

  it('turns NaN into null so gaps are drawn as gaps', () => {
    const group = fakeGroup()
    group.corrected[2] = NaN
    const built = buildPlotData(group, {
      visible: { corrected: true, raw: false, baseline: false },
    })
    expect(built.data[1]).toEqual([20, 24, null, 26, 0])
  })

  it('reports how much was decimated', () => {
    const built = buildPlotData(fakeGroup(), { budget: 4 })
    expect(built.decimated).toBe(true)
    expect(built.totalCount).toBe(5)
    expect(built.pointCount).toBe(built.indices.length)
  })
})

describe('axis ranges and ticks', () => {
  it('pins the y axis at zero and leaves headroom above the apex', () => {
    expect(yRange(null, 0, 250)).toEqual([0, 270])
  })

  it('survives an empty chart', () => {
    expect(yRange(null, undefined, undefined)).toEqual([0, 1.08])
  })

  it('adds decimals back when the visible span is under a second', () => {
    expect(rtValues(null, [60, 60.25, 60.5]).join('|')).toBe('60|60.25|60.5')
    expect(rtValues(null, [100, 200, 300]).join('|')).toBe('100|200|300')
    expect(rtValues(null, [NaN, NaN]).join('|')).toBe('|')
  })

  it('keeps intensity ticks compact', () => {
    expect(intensityValues(null, [0, 1500, 4e8]).join('|')).toBe('0|1.5k|400M')
  })
})

describe('readCursor', () => {
  const defs = [
    { key: 'corrected', name: 'Baseline removed', color: '#2a78d6' },
    { key: 'raw', name: 'Raw EIC (with baseline)', color: '#eb6834' },
  ]

  it('reports the real measured point behind a decimated index', () => {
    const group = fakeGroup()
    const indices = [1, 3] // only points 2 and 4 are plotted
    const reading = readCursor(group, defs, 1, indices)
    expect(reading.groupIndex).toBe(3)
    expect(reading.rt).toBe(40)
    expect(reading.rows.map((r) => r.value)).toEqual([26, 130])
  })

  it('marks unmatched points without a value instead of inventing one', () => {
    const group = fakeGroup()
    group.corrected[0] = NaN
    const reading = readCursor(group, defs, 0, [0])
    expect(reading.rows[0].value).toBeNull()
    expect(reading.rows[1].value).toBe(100)
  })

  it('returns null when the crosshair is off the data', () => {
    expect(readCursor(fakeGroup(), defs, null, [0])).toBeNull()
    expect(readCursor(fakeGroup(), defs, 5, [0])).toBeNull()
  })
})

describe('buildOptions', () => {
  const theme = themeFor('light')

  it('draws the series in the documented order with the legend left to Vue', () => {
    const options = buildOptions(theme, { width: 800, height: 360 })
    // Series 0 is the x axis itself, which carries a label but no id.
    expect(options.series[0].label).toBe('Retention time (s)')
    expect(options.series.slice(1).map((s) => s.id)).toEqual(SERIES_ORDER)
    expect(options.legend.show).toBe(false)
    expect(options.scales.x.time).toBe(false)
  })

  it('has exactly one y axis, on the left, with retention time underneath', () => {
    const options = buildOptions(theme, { width: 800, height: 360 })
    expect(options.axes.filter((axis) => axis.side === 3).length).toBe(1)
    expect(options.axes[0].side).toBe(2) // 0 would put the time axis on top
  })

  it('spaces ticks far enough apart that their labels cannot collide', () => {
    const options = buildOptions(theme, { width: 400, height: 360 })
    expect(options.axes[0].space).toBeGreaterThanOrEqual(60)
    expect(options.axes[1].space).toBeGreaterThanOrEqual(30)
  })

  it('hides a series the legend switched off', () => {
    const options = buildOptions(theme, {
      width: 800,
      height: 360,
      visible: { corrected: true, raw: true, baseline: false },
    })
    expect(options.series.find((s) => s.id === 'baseline').show).toBe(false)
    expect(options.series.find((s) => s.id === 'raw').show).toBe(true)
  })

  it('gives the result curve the thicker line and the derived curve a dash', () => {
    const options = buildOptions(theme, { width: 800, height: 360 })
    expect(options.series.find((s) => s.id === 'corrected').width).toBeGreaterThan(
      options.series.find((s) => s.id === 'raw').width,
    )
    expect(options.series.find((s) => s.id === 'baseline').dash).not.toBeNull()
  })

  it('drops the chrome in compact small multiples', () => {
    const options = buildOptions(theme, { width: 400, height: 140, compact: true })
    expect(options.axes[0].label).toBe('')
    expect(options.axes[1].label).toBe('')
    expect(options.axes[0].size).toBeLessThan(40)
  })
})

describe('formatMz', () => {
  it('keeps the four decimals at which adducts differ', () => {
    expect(formatMz(839.87691)).toBe('839.8769')
    expect(formatMz(null)).toBe('–')
  })
})
