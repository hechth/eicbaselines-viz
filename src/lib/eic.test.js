import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildEicModel, decimateMinMax, UNGROUPED } from './eic.js'
import { asyncBufferFromBytes, readParquetTable, resolveColumns, tableFromRows } from './parquet.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(here, '../../test-data')

function load(name) {
  const bytes = readFileSync(resolve(dataDir, name))
  return asyncBufferFromBytes(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
}

// The multigroup fixtures mimic the tool with its group_number bug *fixed*.
const MULTI_RAW = 'multigroup_input.parquet'
const MULTI_CORRECTED = 'multigroup_result.parquet'
// The single-group fixtures are the tool's real committed test data, so the corrected
// file is missing `group_number` and exercises the positional fallback.
const SINGLE_RAW = 'single_input.parquet'
const SINGLE_CORRECTED_NO_GROUP = 'single_result_no_group.parquet'

describe('resolveColumns', () => {
  it('finds the recetox/pybaselines column names', () => {
    const { columns, missing } = resolveColumns(['mz', 'rt', 'intensity', 'group_number'])
    expect(columns).toEqual({ mz: 'mz', rt: 'rt', intensity: 'intensity', group: 'group_number' })
    expect(missing).toEqual([])
  })

  it('is case and whitespace insensitive', () => {
    const { columns } = resolveColumns(['RT', ' Intensity ', 'group_number'])
    expect(columns.rt).toBe('RT')
    expect(columns.intensity).toBe(' Intensity ')
    expect(columns.mz).toBeNull()
  })

  it('accepts common aliases', () => {
    const { columns, missing } = resolveColumns(['retention_time', 'abundance', 'group_id'])
    expect(columns.rt).toBe('retention_time')
    expect(columns.intensity).toBe('abundance')
    expect(columns.group).toBe('group_id')
    expect(missing).toEqual([])
  })

  it('honours explicit overrides', () => {
    const { columns } = resolveColumns(['mz_col', 't', 'y', 'g'], {
      mz: 'mz_col',
      rt: 't',
      intensity: 'y',
      group: 'g',
    })
    expect(columns).toEqual({ mz: 'mz_col', rt: 't', intensity: 'y', group: 'g' })
  })

  it('reports a missing required column', () => {
    const { missing } = resolveColumns(['mz', 'intensity'])
    expect(missing).toEqual(['rt'])
  })
})

describe('tableFromRows', () => {
  it('throws when rt is absent', () => {
    expect(() => tableFromRows([{ intensity: 1 }], {}, 'test')).toThrow(
      /Required column\(s\) missing/,
    )
  })

  it('throws on an empty table', () => {
    expect(() => tableFromRows([], {}, 'test')).toThrow(/contains no rows/)
  })
})

describe('readParquetTable', () => {
  it('reads the real tool input with numeric values', async () => {
    const table = await readParquetTable(load(SINGLE_RAW))
    expect(table.columns.group).toBe('group_number')
    expect(table.rows.length).toBe(2078)
    expect(typeof table.rows[0].rt).toBe('number')
    expect(Number.isFinite(table.rows[0].intensity)).toBe(true)
  })

  it('survives a corrected file that lost its group column', async () => {
    const table = await readParquetTable(load(SINGLE_CORRECTED_NO_GROUP))
    expect(table.columns.group).toBeNull()
    expect(table.columns.rt).toBe('rt')
  })
})

describe('buildEicModel', () => {
  it('splits the multigroup fixture into one group per group_number', async () => {
    const model = buildEicModel(
      await readParquetTable(load(MULTI_RAW)),
      await readParquetTable(load(MULTI_CORRECTED)),
    )
    expect(model.strategy).toBe('key')
    expect(model.groups).toHaveLength(12)
    expect(model.groups.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(model.warnings).toEqual([])
    expect(model.totals.points).toBe(4093)
    expect(model.totals.unmatched).toBe(0)
  })

  it('uses the positional fallback for the real (group-less) tool output', async () => {
    const model = buildEicModel(
      await readParquetTable(load(SINGLE_RAW)),
      await readParquetTable(load(SINGLE_CORRECTED_NO_GROUP)),
    )
    expect(model.strategy).toBe('positional')
    expect(model.groups).toHaveLength(1)
    expect(model.totals.unmatched).toBe(0)
    expect(model.warnings.join(' ')).toMatch(/no group column/i)
  })

  it('reports group mean m/z, the retention time range and the point count', async () => {
    const model = buildEicModel(
      await readParquetTable(load(MULTI_RAW)),
      await readParquetTable(load(MULTI_CORRECTED)),
    )
    const g1 = model.groups[0]
    // Values independently computed from the fixture with pandas.
    expect(g1.id).toBe(1)
    expect(g1.nPoints).toBe(217)
    expect(g1.mz).toBeCloseTo(839.8769, 3)
    expect(g1.rtMin).toBeCloseTo(608.8347, 3)
    expect(g1.rtMax).toBeCloseTo(1790.8507, 3)
    expect(g1.label).toBe('#1')
  })

  it('sorts every group by retention time ascending', async () => {
    const model = buildEicModel(
      await readParquetTable(load(MULTI_RAW)),
      await readParquetTable(load(MULTI_CORRECTED)),
    )
    for (const group of model.groups) {
      for (let i = 1; i < group.rt.length; i++) {
        expect(group.rt[i]).toBeGreaterThanOrEqual(group.rt[i - 1])
      }
    }
  })

  it('derives a non-negative baseline that never exceeds the raw signal', async () => {
    const model = buildEicModel(
      await readParquetTable(load(MULTI_RAW)),
      await readParquetTable(load(MULTI_CORRECTED)),
    )
    for (const group of model.groups) {
      for (let i = 0; i < group.rt.length; i++) {
        expect(group.baseline[i]).toBeGreaterThanOrEqual(0)
        expect(group.baseline[i]).toBeLessThanOrEqual(group.raw[i] + 1e-6)
        // raw = corrected + baseline by construction
        expect(group.corrected[i] + group.baseline[i]).toBeCloseTo(group.raw[i], 3)
      }
    }
  })

  it('always removes some baseline but never the whole signal', async () => {
    const model = buildEicModel(
      await readParquetTable(load(MULTI_RAW)),
      await readParquetTable(load(MULTI_CORRECTED)),
    )
    expect(model.totals.removedPercent).toBeGreaterThan(0)
    expect(model.totals.removedPercent).toBeLessThan(100)
    for (const group of model.groups) {
      expect(group.removedPercent).toBeGreaterThanOrEqual(0)
      expect(group.removedPercent).toBeLessThan(100)
    }
  })

  it('flags unmatched points instead of inventing a baseline', () => {
    const raw = {
      rows: [
        { rt: 1, intensity: 10, group_number: 1, mz: 100 },
        { rt: 2, intensity: 20, group_number: 1, mz: 100 },
      ],
      columns: { rt: 'rt', intensity: 'intensity', group: 'group_number', mz: 'mz' },
    }
    const corrected = {
      rows: [{ rt: 1, intensity: 4, group_number: 2 }],
      columns: { rt: 'rt', intensity: 'intensity', group: 'group_number', mz: null },
    }
    const model = buildEicModel(raw, corrected)
    expect(model.totals.unmatched).toBe(2)
    expect(Number.isNaN(model.groups[0].corrected[0])).toBe(true)
    expect(Number.isNaN(model.groups[0].baseline[0])).toBe(true)
    expect(model.warnings.join(' ')).toMatch(/no \(group, rt\) match/)
  })

  it('rejects a positional fallback whose retention times disagree', () => {
    const raw = {
      rows: [
        { rt: 1, intensity: 10, group_number: 1 },
        { rt: 2, intensity: 20, group_number: 1 },
      ],
      columns: { rt: 'rt', intensity: 'intensity', group: 'group_number', mz: null },
    }
    const corrected = {
      rows: [
        { rt: 9, intensity: 4 },
        { rt: 8, intensity: 5 },
      ],
      columns: { rt: 'rt', intensity: 'intensity', group: null, mz: null },
    }
    const model = buildEicModel(raw, corrected)
    expect(model.strategy).toBe('none')
    expect(model.totals.unmatched).toBe(2)
    expect(model.warnings.join(' ')).toMatch(/Positional matching rejected/)
  })

  it('treats a table without a group column as one group', () => {
    const raw = {
      rows: [
        { rt: 2, intensity: 20 },
        { rt: 1, intensity: 10 },
      ],
      columns: { rt: 'rt', intensity: 'intensity', group: null, mz: null },
    }
    const corrected = {
      rows: [
        { rt: 1, intensity: 4 },
        { rt: 2, intensity: 5 },
      ],
      columns: { rt: 'rt', intensity: 'intensity', group: null, mz: null },
    }
    const model = buildEicModel(raw, corrected)
    expect(model.groups).toHaveLength(1)
    expect(model.groups[0].id).toBe(UNGROUPED)
    expect(model.groups[0].mz).toBeNull()
    // matched positionally against the rt-sorted raw table, then re-sorted by rt
    expect(model.groups[0].corrected[0]).toBe(4) // rt 1
    expect(model.groups[0].corrected[1]).toBe(5) // rt 2
  })

  it('skips rows without a finite retention time', () => {
    const raw = {
      rows: [
        { rt: 1, intensity: 10, group_number: 1 },
        { rt: null, intensity: 99, group_number: 1 },
      ],
      columns: { rt: 'rt', intensity: 'intensity', group: 'group_number', mz: null },
    }
    const corrected = {
      rows: [{ rt: 1, intensity: 3, group_number: 1 }],
      columns: { rt: 'rt', intensity: 'intensity', group: 'group_number', mz: null },
    }
    const model = buildEicModel(raw, corrected)
    expect(model.groups[0].nPoints).toBe(1)
    expect(model.warnings.join(' ')).toMatch(/1 raw rows without a finite retention time/)
  })
})

describe('decimateMinMax', () => {
  it('returns every index when already within budget', () => {
    const rt = [1, 2, 3]
    expect(decimateMinMax(rt, [1, 2, 3], 10)).toEqual([0, 1, 2])
  })

  it('keeps the peak even when decimating hard', () => {
    const n = 1000
    const rt = Array.from({ length: n }, (_, i) => i)
    const y = Array.from({ length: n }, (_, i) => (i === 501 ? 1e9 : 1))
    const kept = decimateMinMax(rt, y, 40)
    expect(kept.length).toBeLessThanOrEqual(40)
    expect(kept).toContain(501)
    expect(kept).toEqual(kept.slice().sort((a, b) => a - b))
  })

  it('keeps the trough as well', () => {
    const n = 100
    const y = Array.from({ length: n }, (_, i) => (i === 44 ? -5 : 10))
    const kept = decimateMinMax(
      Array.from({ length: n }, (_, i) => i),
      y,
      20,
    )
    expect(kept).toContain(44)
  })

  it('tolerates NaN without losing real extremes', () => {
    const rt = Array.from({ length: 100 }, (_, i) => i)
    const y = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? NaN : i))
    const kept = decimateMinMax(rt, y, 20)
    expect(kept).toContain(1) // lowest non-NaN of the first bucket
    expect(kept).toContain(98) // highest non-NaN overall
  })
})
