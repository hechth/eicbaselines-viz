/**
 * Number formatting for chromatography values.
 *
 * Axis ticks stay compact (a 4e8 intensity is unreadable as "400,000,000"), while
 * tooltips and the table show full precision — the compact form is never the only
 * place a value is reachable.
 */

const SI = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
]

const thousands = new Intl.NumberFormat('en-US')

/** Compact intensity for axis ticks and stat tiles: 1234567 -> "1.2M". */
export function formatCompact(value, digits = 2) {
  if (!Number.isFinite(value)) return '–'
  const abs = Math.abs(value)
  if (abs === 0) return '0'
  if (abs < 1) return trimZeros(value.toFixed(Math.max(digits, 3)))
  for (const [threshold, suffix] of SI) {
    if (abs >= threshold) {
      const scaled = value / threshold
      // Three significant digits max; a tick label never needs more.
      return `${trimZeros(scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : digits))}${suffix}`
    }
  }
  return trimZeros(value.toFixed(value >= 100 ? 0 : 1))
}

/** Full intensity for tooltips and tables: 1234567.89 -> "1,234,567.89". */
export function formatIntensity(value) {
  if (!Number.isFinite(value)) return '–'
  const abs = Math.abs(value)
  if (abs !== 0 && abs < 1) return value.toPrecision(3)
  return thousands.format(roundTo(value, 2))
}

/** m/z keeps four decimals, the precision at which adducts actually differ. */
export function formatMz(value) {
  if (!Number.isFinite(value)) return '–'
  return value.toFixed(4)
}

/** m/z spread inside one group, in ppm — the scale on which feature grouping is judged. */
export function formatPpm(value) {
  if (!Number.isFinite(value)) return '–'
  return trimZeros(value.toFixed(value >= 10 ? 0 : 1))
}

/** Retention time in seconds, as plotted on the x axis. */
export function formatRt(value, digits = 2) {
  if (!Number.isFinite(value)) return '–'
  return trimZeros(value.toFixed(digits))
}

/** Retention time as mm:ss, for tooltips where seconds alone are hard to read. */
export function formatRtClock(value) {
  if (!Number.isFinite(value)) return '–'
  const sign = value < 0 ? '-' : ''
  const total = Math.abs(value)
  const minutes = Math.floor(total / 60)
  const seconds = total - minutes * 60
  return `${sign}${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

export function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '–'
  return `${value.toFixed(digits)}%`
}

export function formatInteger(value) {
  if (!Number.isFinite(value)) return '–'
  return thousands.format(value)
}

function roundTo(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function trimZeros(text) {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}
