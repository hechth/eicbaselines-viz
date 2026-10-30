/**
 * Parquet reading helpers.
 *
 * Deliberately thin: `hyparquet` already returns plain row objects, so this module
 * only adds (a) a small `AsyncBuffer` wrapper so we can read from an `ArrayBuffer`
 * or `Blob` as well as a URL, and (b) column normalisation, because EIC tables come
 * out of pandas/recetox with a conventional set of names that users may rename.
 */
import { parquetReadObjects } from 'hyparquet'

/** Column aliases, keyed by canonical name. First match wins. */
export const COLUMN_ALIASES = {
  mz: ['mz', 'mz_mean', 'precursor_mz', 'mass', 'm/z'],
  rt: ['rt', 'retention_time', 'retentiontime', 'time'],
  intensity: ['intensity', 'abundance', 'peak_area', 'value'],
  group: ['group_number', 'group', 'group_id', 'feature_id', 'aplcms_group'],
}

/** Columns without which the viewer cannot draw anything. */
const REQUIRED = ['rt', 'intensity']

/**
 * Realm-safe type tag, e.g. 'ArrayBuffer' or 'Float64Array'.
 * `instanceof` breaks when the bytes were created in another realm (a test runner's
 * Node context, an iframe, a worker), which silently yields `undefined` buffers.
 */
function typeTag(value) {
  return Object.prototype.toString.call(value).slice(8, -1)
}

const VIEW_TAGS = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'DataView',
])

/**
 * Wrap an `ArrayBuffer`/`ArrayBufferView` as a hyparquet `AsyncBuffer`.
 * hyparquet exposes `asyncBufferFromFile`/`asyncBufferFromUrl` but no synchronous
 * wrapper for bytes we already hold (fetched datasets, file inputs), so we supply one.
 */
export function asyncBufferFromBytes(bytes) {
  const tag = typeTag(bytes)
  if (tag !== 'ArrayBuffer' && !VIEW_TAGS.has(tag)) {
    throw new Error(`Expected an ArrayBuffer or typed array, got ${tag || typeof bytes}.`)
  }
  // Respect a view's own window into its buffer, not just the whole buffer.
  const buffer = tag === 'ArrayBuffer' ? bytes : bytes.buffer
  const offset = tag === 'ArrayBuffer' ? 0 : bytes.byteOffset
  const byteLength = tag === 'ArrayBuffer' ? bytes.byteLength : bytes.byteLength
  return {
    byteLength,
    // hyparquet's contract is `slice(start, end) -> ArrayBuffer` (it hands the result
    // straight to `new DataView`), so this must stay an ArrayBuffer, not a view.
    async slice(start = 0, end = byteLength) {
      return buffer.slice(offset + start, offset + end)
    },
  }
}

/**
 * Resolve canonical column names against the columns actually present in a table.
 * Matching is case-insensitive and whitespace tolerant.
 *
 * @param {string[]} columns column names as found in the file
 * @param {Record<string, string>} [overrides] user supplied `{ mz: 'mz_col', ... }`
 * @returns {{columns: Record<string, string|null>, missing: string[]}}
 */
export function resolveColumns(columns, overrides = {}) {
  const lookup = new Map(columns.map((c) => [String(c).trim().toLowerCase(), c]))
  const resolved = {}
  const missing = []
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    const override = overrides[canonical]
    const wanted = override != null ? String(override).trim().toLowerCase() : null
    let found = wanted && lookup.has(wanted) ? lookup.get(wanted) : null
    if (!found) {
      for (const alias of aliases) {
        if (lookup.has(alias)) {
          found = lookup.get(alias)
          break
        }
      }
    }
    resolved[canonical] = found ?? null
    if (!found && REQUIRED.includes(canonical)) {
      missing.push(canonical)
    }
  }
  return { columns: resolved, missing }
}

/**
 * Turn raw parquet rows into a `{ rows, columns }` table with resolved column names.
 * @throws if a required column (`rt`, `intensity`) cannot be found.
 */
export function tableFromRows(rows, columnOverrides = {}, sourceLabel = 'table') {
  if (!rows || !rows.length) {
    throw new Error(`The parquet ${sourceLabel} contains no rows.`)
  }
  const allColumns = Object.keys(rows[0])
  const { columns, missing } = resolveColumns(allColumns, columnOverrides)
  if (missing.length) {
    throw new Error(
      `Required column(s) missing from ${sourceLabel}: ${missing.join(', ')}. Found: ${allColumns.join(', ')}.`,
    )
  }
  return { rows, columns, allColumns }
}

/**
 * Read a parquet table into row objects plus the resolved column map.
 *
 * @param {string | ArrayBuffer | ArrayBufferView | Blob | {slice:Function,byteLength:number}} source
 *        a URL, raw bytes, a `Blob`, or a hyparquet `AsyncBuffer`
 * @param {Record<string, string>} [columnOverrides]
 */
export async function readParquetTable(source, columnOverrides = {}) {
  const rows = await parquetReadObjects({ file: await toAsyncBuffer(source) })
  return tableFromRows(rows, columnOverrides, 'file')
}

/** Parquet magic bytes, also written at the end of the file. */
const PARQUET_MAGIC = 'PAR1'

/**
 * The first `length` bytes of an `ArrayBuffer`/`ArrayBufferView`, without copying.
 * A view's own window matters here, exactly as in `asyncBufferFromBytes`.
 */
function headOf(bytes, length) {
  const isBuffer = typeTag(bytes) === 'ArrayBuffer'
  const buffer = isBuffer ? bytes : bytes.buffer
  const offset = isBuffer ? 0 : bytes.byteOffset
  const byteLength = isBuffer ? buffer.byteLength : bytes.byteLength
  return new Uint8Array(buffer, offset, Math.min(length, byteLength))
}

/**
 * Reject anything that is not parquet by its magic bytes, whichever way it arrived.
 * hyparquet validates only the copy in the footer, so this exists to name the problem
 * instead: the wrong file from a picker reads as `parquet file invalid (footer != PAR1)`,
 * and a git symlink checked out without `core.symlinks` is a text file holding a path.
 *
 * @param {ArrayBuffer | ArrayBufferView} bytes
 * @param {string} [where] what to name in the message, e.g. `The response from ${url}`
 */
function assertParquetBytes(bytes, where = 'The parquet source') {
  const head = headOf(bytes, PARQUET_MAGIC.length)
  const magic = [...PARQUET_MAGIC].map((char) => char.charCodeAt(0))
  if (!magic.every((byte, i) => head[i] === byte)) {
    throw new Error(`${where} does not start with "PAR1", so it is not a parquet file.`)
  }
}

async function toAsyncBuffer(source) {
  if (typeof source === 'string') {
    const bytes = await fetchBytes(source)
    assertParquetBytes(bytes, `The response from ${source}`)
    return asyncBufferFromBytes(bytes)
  }
  const tag = typeTag(source)
  // Blob/File first: it has `arrayBuffer()` but no `byteLength`, so order matters.
  if (source && typeof source.arrayBuffer === 'function') {
    const bytes = await source.arrayBuffer()
    assertParquetBytes(bytes)
    return asyncBufferFromBytes(bytes)
  }
  if (tag === 'ArrayBuffer' || VIEW_TAGS.has(tag)) {
    assertParquetBytes(source)
    return asyncBufferFromBytes(source)
  }
  if (source && typeof source.slice === 'function' && typeof source.byteLength === 'number') {
    return source // already an AsyncBuffer
  }
  throw new Error('Unsupported parquet source: expected a URL, Blob, ArrayBuffer or AsyncBuffer.')
}

/**
 * Fetch the bytes behind a URL, rejecting a response that is a page rather than a file.
 * hyparquet would be handed index.html and complain about the file instead of the URL,
 * which is worth avoiding on its own; the magic-byte check is in `toAsyncBuffer`, because
 * a wrong file picked from disk deserves the same treatment.
 */
async function fetchBytes(url) {
  // Asking for bytes outright is what makes a missing file a real 404: a dev server's SPA
  // fallback only answers with index.html when the client would accept that (`Accept: */*`).
  const response = await fetch(url, { headers: { Accept: 'application/octet-stream' } })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) {
    // Some hosts serve a page whatever we ask for: an nginx SPA fallback, a Galaxy login.
    throw new Error(
      `${url} returned text/html, not parquet — the URL does not resolve to a file, so the ` +
        `server answered with the app page. Serve the file from test-data/ or select it below.`,
    )
  }
  return response.arrayBuffer()
}
