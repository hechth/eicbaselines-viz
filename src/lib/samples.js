/**
 * Which example pairs the standalone app offers.
 *
 * A browser can only read bytes its own server serves, and it cannot list a directory, so
 * the sample selector has to be *told* what exists. `config.json` next to the app is that
 * instruction — written per checkout, naming the data this machine actually has — while the
 * pairs committed in `test-data/` are the fallback for every deployment that ships without
 * one (a Galaxy panel, a static host, a fresh clone).
 *
 * Every decision lives here rather than in `AppShell.vue` so that it is unit-testable: the
 * shell needs a mounted component and a real canvas before any of this logic can be
 * exercised, and a selector that offers a pair the viewer then cannot load is exactly the
 * failure this module exists to prevent.
 */

/** Served from the app root: `test-data/` in dev (`publicDir`), `static/` in a build. */
export const DEFAULT_CONFIG_PATH = 'config.json'

/**
 * The pairs shipped with the app, so there is always something to look at.
 *
 * Kept non-empty on purpose: the `<select>` must never render without an option, and the
 * shell dereferences `[0]` while the config is still in flight.
 */
export const BUILTIN_SAMPLES = [
  {
    id: 'multigroup',
    name: '12 groups — group column in both tables',
    raw: new URL('multigroup_input.parquet', document.baseURI).href,
    corrected: new URL('multigroup_result.parquet', document.baseURI).href,
  },
  {
    id: 'single',
    name: 'single group — corrected table without a group column',
    raw: new URL('single_input.parquet', document.baseURI).href,
    corrected: new URL('single_result_no_group.parquet', document.baseURI).href,
  },
]

/** @typedef {{id: string, name: string, raw: string, corrected: string}} SamplePair */

/** Dev-server-only URL prefix behind `server.fs.allow`; no static host serves it. */
const FS_PREFIX = '/@fs/'

/** A usable string: present, of type string, and not just whitespace. */
function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** Own keys that carry something, for a `Found: …` list — what the entry actually has. */
function keysOf(entry) {
  return Object.keys(entry).filter((key) => {
    const value = entry[key]
    return value !== null && value !== undefined && String(value).trim() !== ''
  })
}

/** `…/a/b.parquet` -> `b.parquet`; a query string is already gone, a `/@fs/` path survives. */
function baseName(url) {
  return decodeURIComponent(url.pathname.split('/').pop() ?? '')
}

/** `import.meta.env` exists only under Vite; a plain Node import of this file has none. */
function isProductionBuild() {
  return import.meta.env ? Boolean(import.meta.env.PROD) : false
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Absolute URL of the sample config.
 *
 * @param {string} [query] the `?config=` value — relative to the page, a full URL passes
 *   through untouched
 * @returns {string}
 */
export function sampleConfigUrl(query = '') {
  // A malformed `?config=` must not blank the page, so it degrades to the default path —
  // whose absence is the silent case.
  try {
    return new URL(query || DEFAULT_CONFIG_PATH, document.baseURI).href
  } catch {
    return new URL(DEFAULT_CONFIG_PATH, document.baseURI).href
  }
}

/**
 * Validate a config payload into sample pairs.
 *
 * One bad entry costs that entry alone: its siblings survive, and the reader is told which
 * line was skipped and what was expected. Never throws — a hand-written file is allowed to
 * be wrong without taking the viewer down with it.
 *
 * @param {unknown} payload the parsed JSON
 * @param {{base?: string, source?: string}} [options] `base` is the page URL entries resolve
 *   against, `source` what to call the file in a message
 * @returns {{samples: SamplePair[], notices: string[]}}
 */
export function parseSampleConfig(
  payload,
  { base = document.baseURI, source = 'the sample config' } = {},
) {
  const notices = []
  // A bare top-level array is accepted as well: the file is hand-written and `[ … ]` is the
  // shortest thing to type. The expected shape is named in the message either way.
  const entries = Array.isArray(payload) ? payload : payload?.samples
  if (!Array.isArray(entries)) {
    return {
      samples: [],
      notices: [`The sample config at ${source} must contain a "samples" array.`],
    }
  }

  /** @type {SamplePair[]} */
  const samples = []
  const taken = new Set()

  entries.forEach((entry, index) => {
    // 1-based, so the number matches the line a reader counts in their editor.
    const where = `Sample ${index + 1} of ${source}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      notices.push(`${where} was skipped: id, raw and corrected are required. Found: nothing.`)
      return
    }
    // Unknown keys are ignored: a config written for a newer viewer should not become an
    // error for an older one.
    const id = textOf(entry.id)
    const rawValue = textOf(entry.raw)
    const correctedValue = textOf(entry.corrected)
    if (!id || !rawValue || !correctedValue) {
      const found = keysOf(entry)
      notices.push(
        `${where} was skipped: id, raw and corrected are required. ` +
          `Found: ${found.length ? found.join(', ') : 'nothing'}.`,
      )
      return
    }
    // The id is the `<option value>`, so a second one is not cosmetic: two options with the
    // same value cannot be told apart by the select. Skipping beats renumbering, which would
    // give one pair a different id per config that mentions it.
    if (taken.has(id)) {
      notices.push(`${where} was skipped: the id "${id}" is already used.`)
      return
    }
    let raw
    let corrected
    try {
      // Resolved against the *page*, never against the config's own URL: a `?config=`
      // pointing somewhere else must not get to redirect which files are downloaded.
      raw = new URL(rawValue, base)
      corrected = new URL(correctedValue, base)
    } catch {
      // Quote what was written rather than what was parsed — the parsed form is the part
      // that failed, the written form is the part the reader can fix.
      notices.push(
        `Sample "${id}" of ${source} was skipped: raw and corrected must be URLs. ` +
          `Found: raw="${entry.raw}", corrected="${entry.corrected}".`,
      )
      return
    }
    // A pair is only viewable as a unit, so one `/@fs/` half is enough to drop the entry.
    // The prefix sits in the path: resolution has already put the origin in front of it.
    // `config.json` is gitignored but still copied into `static/` by the publicDir copy, so
    // without this a development config would ship and fail quietly on a Galaxy host.
    const devOnly = [raw, corrected].some((url) => url.pathname.startsWith(FS_PREFIX))
    if (isProductionBuild() && devOnly) {
      notices.push(
        `Sample "${id}" of ${source} was skipped: ${FS_PREFIX} paths are only served by the ` +
          `development server.`,
      )
      return
    }
    taken.add(id)
    samples.push({
      id,
      name: textOf(entry.name) || baseName(raw) || id,
      raw: raw.href,
      corrected: corrected.href,
    })
  })

  if (!samples.length) {
    notices.push(
      `No usable sample pairs were found in ${source}.`,
      'The built-in example pairs are used instead.',
    )
  }
  return { samples, notices }
}

/**
 * Read the sample list, falling back to `fallback` whenever the config yields nothing.
 *
 * Never rejects, and — the default fallback being the shipped pairs — never hands the
 * `<select>` an empty list either: a config that is missing, malformed or unreachable earns
 * one line beside the controls, not a blank viewer.
 *
 * @param {string} [url]
 * @param {{base?: string, fallback?: SamplePair[]}} [options]
 * @returns {Promise<{samples: SamplePair[], notices: string[]}>}
 */
export async function loadSampleList(
  url = sampleConfigUrl(),
  { base = document.baseURI, fallback = BUILTIN_SAMPLES } = {},
) {
  let response
  try {
    // Asking for JSON is what turns a missing config into a real 404: a dev server's SPA
    // fallback answers `Accept: */*` (what a bare `fetch` sends) with index.html and status
    // 200, which would otherwise be reported as a broken config rather than no config.
    response = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (error) {
    return { samples: fallback, notices: [`${url} could not be read: ${messageOf(error)}.`] }
  }

  // Nothing to read, said the server in as many words: the normal state of a Galaxy panel
  // or a static deployment, so it stays silent.
  if (response.status === 404) return { samples: fallback, notices: [] }

  if (!response.ok) {
    // Any other refusal is worth a line — a 403 from the dev server's `fs.allow` list or a
    // 500 from a failing rewrite means the file was asked for and something refused it.
    return {
      samples: fallback,
      notices: [`Sample config ${url} was not read: ${response.status} ${response.statusText}.`],
    }
  }

  const contentType = response.headers?.get?.('content-type') ?? ''
  // 200 but not JSON — a page (an SPA fallback that ignored our Accept, a Galaxy login) or
  // some other bytes. Either way there is no config here, and no reason to mention it.
  if (contentType && !contentType.includes('json')) return { samples: fallback, notices: [] }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return {
      samples: fallback,
      notices: [`Sample config ${url} is not valid JSON: ${messageOf(error)}.`],
    }
  }

  const parsed = parseSampleConfig(payload, { base, source: url })
  // A wholly unusable config is still a broken one: the fallback has to fill the selector,
  // while the notices explain why the file was not used.
  return parsed.samples.length ? parsed : { samples: fallback, notices: parsed.notices }
}
