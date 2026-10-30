/**
 * EIC model: turns a (raw input, baseline-corrected output) parquet pair into the
 * per-group chromatogram series the viewer plots.
 *
 * ## How the two tables are matched
 *
 * The pybaselines tool rewrites `intensity` in place, so the estimated baseline is
 * only recoverable by comparing the two tables row by row:
 *
 *     baseline(i) = max(0, intensity_raw(i) - intensity_corrected(i))
 *
 * (clipping at zero is exact everywhere except where the corrected intensity was
 * itself clipped to 0 by `np.maximum`, where the baseline is a lower bound).
 *
 * Matching is done on `(group_number, rt)`, which is unique within a table. If the
 * corrected table has no group column — a known bug in the tool, which lets pandas
 * drop the grouping column in `groupby().apply()` — we fall back to a positional
 * match: `groupby(group_number).apply()` emits groups in ascending key order with
 * each group sorted by `rt`, so sorting the raw table by `(group_number, rt)`
 * reproduces the corrected table's row order exactly. That fallback is only accepted
 * if the `rt` columns agree, so a mismatch is reported instead of silently drawing a
 * wrong baseline.
 */

/** Key used for every point when a table has no group column at all. */
export const UNGROUPED = '__ungrouped__'

const RT_MATCH_TOLERANCE = 1e-6

/**
 * @typedef {object} EicGroup
 * @property {string|number} id            group identifier (`group_number` value)
 * @property {string} label                short human label, e.g. `#7`
 * @property {number|null} mz              mean measured m/z of the group
 * @property {number|null} mzPpmSpread     (max-min)/mean*1e6 of the measured m/z
 * @property {number} rtMin                retention time range start (seconds)
 * @property {number} rtMax                retention time range end (seconds)
 * @property {number} rtApex               retention time of the tallest corrected peak
 * @property {number} nPoints
 * @property {number} nMatched             points found in both tables
 * @property {Float64Array} rt             sorted ascending
 * @property {Float64Array} raw            uncorrected intensity, aligned with `rt`
 * @property {Float64Array} corrected      baseline-removed intensity, NaN if unmatched
 * @property {Float64Array} baseline       `max(0, raw - corrected)`, NaN if unmatched
 * @property {number} rawMax
 * @property {number} correctedMax
 * @property {number} rawSum
 * @property {number} correctedSum
 * @property {number} removedPercent       100 * (1 - correctedSum / rawSum)
 * @property {number} clippedPoints        points where the corrected intensity hit 0
 */

/**
 * Coerce a parquet cell to a finite number, or `null`.
 * `Number(null)` is `0` and `Number('')` is `0`, so a missing value must be rejected
 * before coercion or a hole in the data silently becomes a point at zero.
 */
function toFinite(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** Read one table into flat numeric columns, dropping rows with a non-finite `rt`. */
function toColumns(table) {
  const { rows, columns } = table
  const rt = new Float64Array(rows.length)
  const intensity = new Float64Array(rows.length)
  const mz = new Float64Array(rows.length)
  const group = new Array(rows.length)
  let kept = 0
  let dropped = 0
  for (const row of rows) {
    const r = toFinite(row[columns.rt])
    if (r === null) {
      dropped++
      continue
    }
    rt[kept] = r
    const y = toFinite(row[columns.intensity])
    intensity[kept] = y === null ? NaN : y
    const m = columns.mz ? toFinite(row[columns.mz]) : null
    mz[kept] = m === null ? NaN : m
    group[kept] = columns.group ? normaliseGroup(row[columns.group]) : UNGROUPED
    kept++
  }
  return {
    rt: rt.subarray(0, kept),
    intensity: intensity.subarray(0, kept),
    mz: mz.subarray(0, kept),
    group: group.slice(0, kept),
    dropped,
    hasGroups: Boolean(columns.group),
  }
}

function normaliseGroup(value) {
  if (value === null || value === undefined || value === '') return UNGROUPED
  const n = Number(value)
  return Number.isFinite(n) ? n : String(value)
}

/**
 * Produce, for every raw row, the matching corrected intensity (NaN when absent).
 * @returns {{values: Float64Array, strategy: string, unmatched: number, warnings: string[]}}
 */
function matchCorrected(raw, corrected, rawOrder) {
  const warnings = []
  const out = new Float64Array(raw.rt.length).fill(NaN)

  if (corrected.hasGroups && raw.hasGroups) {
    // (group, rt) -> intensity
    const index = new Map()
    let duplicates = 0
    for (let i = 0; i < corrected.rt.length; i++) {
      const key = corrected.group[i]
      let byRt = index.get(key)
      if (!byRt) {
        byRt = new Map()
        index.set(key, byRt)
      }
      if (byRt.has(corrected.rt[i])) duplicates++
      else byRt.set(corrected.rt[i], corrected.intensity[i])
    }
    let unmatched = 0
    for (let i = 0; i < raw.rt.length; i++) {
      const byRt = index.get(raw.group[i])
      const v = byRt ? byRt.get(raw.rt[i]) : undefined
      if (v === undefined) unmatched++
      else out[i] = v
    }
    const total = raw.rt.length
    if (duplicates) {
      warnings.push(
        `${duplicates} duplicated (group, rt) rows in the corrected table were ignored.`,
      )
    }
    if (unmatched === 0) {
      return { values: out, strategy: 'key', unmatched, warnings }
    }
    warnings.push(
      `${unmatched} of ${total} raw points had no (group, rt) match in the corrected table.`,
    )
    if (unmatched > total * 0.1) {
      warnings.push('Falling back to positional matching because the keyed match was poor.')
    } else {
      return { values: out, strategy: 'key', unmatched, warnings }
    }
  }

  // Positional fallback: rely on groupby().apply() output ordering.
  if (corrected.rt.length !== raw.rt.length) {
    warnings.push(
      `Positional matching is impossible: the raw table has ${raw.rt.length} rows but the ` +
        `corrected table has ${corrected.rt.length}. The baseline cannot be recovered.`,
    )
    return { values: out, strategy: 'none', unmatched: raw.rt.length, warnings }
  }
  let mismatched = 0
  for (let rank = 0; rank < rawOrder.length; rank++) {
    const i = rawOrder[rank]
    if (!withinTolerance(corrected.rt[rank], raw.rt[i])) mismatched++
    else out[i] = corrected.intensity[rank]
  }
  if (mismatched > 0) {
    warnings.push(
      `Positional matching rejected: ${mismatched} of ${rawOrder.length} retention times do not ` +
        `line up between the two tables. Add a group column to the corrected table and re-run.`,
    )
    return {
      values: new Float64Array(raw.rt.length).fill(NaN),
      strategy: 'none',
      unmatched: raw.rt.length,
      warnings,
    }
  }
  return { values: out, strategy: 'positional', unmatched: 0, warnings }
}

function withinTolerance(a, b) {
  const tol = RT_MATCH_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) <= tol
}

/** Indices that sort `rt` ascending, ties broken by `group` then insertion order. */
function rankOrder(rt, group) {
  const order = Array.from(rt, (_, i) => i)
  order.sort((a, b) => {
    if (group[a] < group[b]) return -1
    if (group[a] > group[b]) return 1
    return rt[a] - rt[b] || a - b
  })
  return order
}

function groupLabel(id) {
  return id === UNGROUPED ? 'all points' : `#${id}`
}

function sortGroupIds(ids) {
  return ids.slice().sort((a, b) => {
    if (a === UNGROUPED) return -1
    if (b === UNGROUPED) return 1
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return String(a).localeCompare(String(b), undefined, { numeric: true })
  })
}

/**
 * Build the viewer model from a raw and a corrected table.
 *
 * @param {{rows: object[], columns: Record<string,string|null>}} rawTable      the tool's input
 * @param {{rows: object[], columns: Record<string,string|null>}} correctedTable the tool's output
 * @returns {{groups: EicGroup[], warnings: string[], strategy: string, totals: object}}
 */
export function buildEicModel(rawTable, correctedTable) {
  const raw = toColumns(rawTable)
  const corrected = toColumns(correctedTable)
  const warnings = []
  if (raw.dropped) {
    warnings.push(`${raw.dropped} raw rows without a finite retention time were skipped.`)
  }
  if (corrected.dropped) {
    warnings.push(
      `${corrected.dropped} corrected rows without a finite retention time were skipped.`,
    )
  }
  if (!corrected.hasGroups && raw.hasGroups) {
    warnings.push(
      'The corrected table has no group column, so rows were matched to the raw table ' +
        'positionally (retention times verified).',
    )
  }

  const rawOrder = rankOrder(raw.rt, raw.group)
  const {
    values,
    strategy,
    unmatched,
    warnings: matchWarnings,
  } = matchCorrected(raw, corrected, rawOrder)
  warnings.push(...matchWarnings)

  // Bucket raw rows by group id, in rt order.
  const byGroup = new Map()
  for (const i of rawOrder) {
    const id = raw.group[i]
    let bucket = byGroup.get(id)
    if (!bucket) {
      bucket = []
      byGroup.set(id, bucket)
    }
    bucket.push(i)
  }

  const groups = sortGroupIds([...byGroup.keys()]).map((id) =>
    buildGroup(id, byGroup.get(id), raw, values),
  )

  const totals = groups.reduce(
    (acc, g) => ({
      groups: acc.groups + 1,
      points: acc.points + g.nPoints,
      matched: acc.matched + g.nMatched,
      rawSum: acc.rawSum + g.rawSum,
      correctedSum: acc.correctedSum + g.correctedSum,
    }),
    { groups: 0, points: 0, matched: 0, rawSum: 0, correctedSum: 0 },
  )
  totals.removedPercent = totals.rawSum > 0 ? 100 * (1 - totals.correctedSum / totals.rawSum) : 0
  totals.unmatched = unmatched

  return { groups, warnings, strategy, totals }
}

function buildGroup(id, indices, raw, correctedValues) {
  const n = indices.length
  const rt = new Float64Array(n)
  const rawY = new Float64Array(n)
  const correctedY = new Float64Array(n)
  const baselineY = new Float64Array(n)

  let mzSum = 0
  let mzCount = 0
  let mzMin = Infinity
  let mzMax = -Infinity
  let rawMax = 0
  let correctedMax = 0
  let rawSum = 0
  let correctedSum = 0
  let nMatched = 0
  let clipped = 0
  let apexRt = NaN
  let apexY = -Infinity

  for (let k = 0; k < n; k++) {
    const i = indices[k]
    const y = Number.isFinite(raw.intensity[i]) ? raw.intensity[i] : NaN
    rt[k] = raw.rt[i]
    rawY[k] = y
    rawSum += y || 0
    if (y > rawMax) rawMax = y

    const c = correctedValues[i]
    if (Number.isFinite(c)) {
      nMatched++
      correctedY[k] = c
      baselineY[k] = Math.max(0, y - c)
      correctedSum += c
      if (c > correctedMax) correctedMax = c
      if (c === 0) clipped++
      if (c > apexY) {
        apexY = c
        apexRt = raw.rt[i]
      }
    } else {
      correctedY[k] = NaN
      baselineY[k] = NaN
    }

    const m = raw.mz[i]
    if (Number.isFinite(m)) {
      mzSum += m
      mzCount++
      if (m < mzMin) mzMin = m
      if (m > mzMax) mzMax = m
    }
  }

  // A fully clipped peak has no positive corrected intensity; fall back to the raw apex.
  if (!Number.isFinite(apexRt)) {
    for (let k = 0; k < n; k++) {
      if (rawY[k] > apexY) {
        apexY = rawY[k]
        apexRt = rt[k]
      }
    }
  }

  const mz = mzCount ? mzSum / mzCount : null
  return {
    id,
    label: groupLabel(id),
    mz,
    mzPpmSpread: mz && mzCount > 1 ? ((mzMax - mzMin) / mz) * 1e6 : null,
    rtMin: n ? rt[0] : NaN,
    rtMax: n ? rt[n - 1] : NaN,
    rtApex: apexRt,
    nPoints: n,
    nMatched,
    rt,
    raw: rawY,
    corrected: correctedY,
    baseline: baselineY,
    rawMax,
    correctedMax,
    rawSum,
    correctedSum,
    removedPercent: rawSum > 0 ? 100 * (1 - correctedSum / rawSum) : 0,
    clippedPoints: clipped,
  }
}

/**
 * Min/max bucket decimation.
 *
 * Chromatograms are peaky, so plain every-nth-point decimation would drop the peaks
 * that matter. This keeps the lowest and highest point of each x-bucket, which bounds
 * the visual error to the bucket width while roughly halving the point count.
 *
 * @param {ArrayLike<number>} rt sorted ascending
 * @param {ArrayLike<number>} y  may contain NaN
 * @param {number} maxPoints target budget; returns all indices when already under
 * @returns {number[]} ascending indices into `rt`/`y`
 */
export function decimateMinMax(rt, y, maxPoints) {
  const n = rt.length
  if (maxPoints <= 0 || n <= maxPoints) {
    return Array.from({ length: n }, (_, i) => i)
  }
  const buckets = Math.max(2, Math.floor(maxPoints / 2))
  const keep = new Set()
  const width = n / buckets
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * width)
    const end = Math.min(n, Math.floor((b + 1) * width))
    let minI = -1
    let maxI = -1
    let minV = Infinity
    let maxV = -Infinity
    for (let i = start; i < end; i++) {
      const v = y[i]
      if (!Number.isFinite(v)) continue
      if (v < minV) {
        minV = v
        minI = i
      }
      if (v > maxV) {
        maxV = v
        maxI = i
      }
    }
    if (minI === -1) {
      keep.add(start) // all-NaN bucket: keep one point to anchor the axis
    } else {
      keep.add(minI)
      keep.add(maxI)
    }
  }
  return [...keep].sort((a, b) => a - b)
}
