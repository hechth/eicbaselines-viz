/**
 * Design tokens for the chromatogram viewer.
 *
 * Colours are a validated categorical palette (OKLab CVD separation and normal-vision
 * floors checked in both modes against the two surfaces below). Series identity never
 * rides on colour alone: every series also has a legend entry and a row in the table
 * view, and the emphasis series carries a direct label.
 */

export const SERIES = [
  {
    key: 'corrected',
    name: 'Baseline removed',
    light: '#2a78d6',
    dark: '#3987e5',
    // The result the tool produced, so it gets the accent slot and the full 2px line.
    emphasis: true,
  },
  { key: 'raw', name: 'Raw EIC (with baseline)', light: '#eb6834', dark: '#d95926' },
  {
    key: 'baseline',
    name: 'Estimated baseline',
    light: '#1baf7a',
    dark: '#199e70',
    // Derived (raw − removed), so it reads as a reference curve, not a measurement.
    dashed: true,
  },
]

export const SURFACE = {
  light: {
    surface: '#fcfcfb',
    plane: '#f9f9f7',
    textPrimary: '#0b0b0b',
    textSecondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
  },
  dark: {
    surface: '#1a1a19',
    plane: '#0d0d0d',
    textPrimary: '#ffffff',
    textSecondary: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
  },
}

export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif'

/** Line width in CSS pixels — the 2px line spec. */
export const LINE_WIDTH = 2

/** Point budget per visible series before min/max decimation kicks in. */
export const POINT_BUDGET = 4000

/**
 * Resolve the token set for a colour scheme.
 * @param {'light'|'dark'} mode
 */
export function themeFor(mode) {
  const surface = SURFACE[mode] ?? SURFACE.light
  return {
    mode,
    ...surface,
    series: SERIES.map((s) => ({ ...s, color: mode === 'dark' ? s.dark : s.light })),
  }
}
