/**
 * Loading the two parquet tables.
 *
 * A Galaxy visualization is bound to exactly one dataset, but this viewer needs the
 * pybaselines *pair* — the input (raw) and the output (baseline removed). So the entry
 * point hands us the dataset it was opened on and we resolve its partner here:
 *
 *   1. an explicit companion id from the visualization settings, if the host offers one;
 *   2. job provenance — the input of the job that produced this dataset, or, when this
 *      dataset *is* the input, the job's `outfile`;
 *   3. the parquet datasets of the same history, for the user to pick from.
 *
 * Galaxy ids arrive already encoded and are used as-is: `create_encoded_id` truncates
 * the digest, so decoding and re-encoding does not necessarily reproduce the id the
 * client holds.
 */
import { buildEicModel } from './eic.js'
import { readParquetTable } from './parquet.js'

/** The pybaselines tool's own parameter names, used to pick among job inputs/outputs. */
const INPUT_PARAM = 'infile'
const OUTPUT_PARAM = 'outfile'

/** Galaxy data type for a parquet file (`datatypes_conf.xml`). */
export const PARQUET_EXTENSIONS = new Set(['parquet'])

/**
 * `${root}api/datasets/{id}/display` — the uploaded bytes.
 *
 * `preview` defaults to false, and parquet is a Binary datatype, so the stored file is
 * served verbatim; `to_ext` would only add download headers around the same bytes.
 */
export function datasetDisplayUrl(root, datasetId) {
  return `${root ?? '/'}api/datasets/${encodeURIComponent(datasetId)}/display`
}

export function datasetMetaUrl(root, datasetId) {
  return `${root ?? '/'}api/datasets/${encodeURIComponent(datasetId)}`
}

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) {
    throw new Error(`Request for ${url} failed: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

export async function fetchDatasetMeta(root, datasetId) {
  return getJson(datasetMetaUrl(root, datasetId))
}

/**
 * The parquet datasets of a history, newest first.
 *
 * `/api/datasets?history_id=…&q=extension&qv=parquet` is used rather than
 * `/api/histories/{id}/contents`, because the contents endpoint only honours `q`/`qv`
 * when `v=dev` is passed and silently ignores them otherwise. The extension check is
 * repeated client side anyway: an older Galaxy that ignores the filter should still not
 * offer a tabular file.
 *
 * @returns {Promise<Array<{id: string, name: string, extension: string}>>}
 */
export async function listSiblingParquetDatasets(root, historyId, excludeId) {
  if (!historyId) return []
  const params = new URLSearchParams({
    history_id: historyId,
    q: 'extension',
    qv: 'parquet',
    limit: '1000',
    order: '-update_time', // the summary view this endpoint defaults to carries `extension`
  })
  const payload = await getJson(`${root ?? '/'}api/datasets?${params}`)
  const rows = Array.isArray(payload) ? payload : (payload?.contents ?? [])
  return rows
    .filter((row) => row.id !== excludeId && (row.state ?? 'ok') === 'ok')
    .filter((row) => PARQUET_EXTENSIONS.has(row.extension ?? row.file_ext ?? ''))
    .map((row) => ({ id: row.id, name: row.name, extension: row.extension ?? 'parquet' }))
}

/** `[{name, dataset: {src, id}}]` -> the entry whose tool parameter matches, else the only one. */
function pickAssociation(entries, paramName) {
  const usable = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.dataset?.id)
  const named = usable.find((entry) => entry.name === paramName)
  if (named) return named.dataset.id
  // Nothing named: usable only if the answer cannot be ambiguous.
  return usable.length === 1 ? usable[0].dataset.id : null
}

/**
 * The dataset on the far side of the job that touched this one.
 *
 * @param {'inputs'|'outputs'} direction `inputs` when this dataset is the tool output,
 *   `outputs` when it is the tool input.
 * @returns {Promise<string|null>} an encoded dataset id, or null when provenance is not
 *   available (no job, no permission, anonymous history) — the caller then falls back.
 */
export async function resolveJobPartner(root, datasetId, direction = 'inputs') {
  try {
    const meta = await fetchDatasetMeta(root, datasetId)
    const jobId = meta?.creating_job
    if (!jobId) return null
    const entries = await getJson(
      `${root ?? '/'}api/jobs/${encodeURIComponent(jobId)}/${direction}`,
    )
    return pickAssociation(entries, direction === 'inputs' ? INPUT_PARAM : OUTPUT_PARAM)
  } catch {
    return null
  }
}

/**
 * Resolve the partner of `datasetId`, in whichever direction the provenance allows.
 * @returns {Promise<{raw: string|null, corrected: string|null, via: string}>}
 */
export async function resolvePairIds(root, datasetId, settings = {}) {
  const explicitRaw = settings.input_dataset_id ?? settings.raw_dataset_id ?? null
  const explicitCorrected = settings.output_dataset_id ?? settings.corrected_dataset_id ?? null
  if (explicitRaw && explicitCorrected) {
    return { raw: explicitRaw, corrected: explicitCorrected, via: 'settings' }
  }

  // Most common case: the visualization was opened on the pybaselines output.
  const asOutput = await resolveJobPartner(root, datasetId, 'inputs')
  if (asOutput) {
    return { raw: explicitRaw ?? asOutput, corrected: datasetId, via: 'provenance' }
  }

  // Opened on the input instead: the corrected table is that job's output.
  const asInput = await resolveJobPartner(root, datasetId, 'outputs')
  if (asInput) {
    return { raw: datasetId, corrected: explicitCorrected ?? asInput, via: 'provenance' }
  }

  return { raw: explicitRaw ?? datasetId, corrected: explicitCorrected, via: 'incomplete' }
}

/**
 * Parquet sources of the same history, for a manual picker when provenance failed.
 */
export async function listCompanionChoices(root, datasetId) {
  const meta = await fetchDatasetMeta(root, datasetId).catch(() => null)
  return listSiblingParquetDatasets(root, meta?.history_id, datasetId)
}

/**
 * Build the viewer model from two already-resolved parquet sources.
 * @param {{raw: object, corrected: object}} sources each accepted by `readParquetTable`
 * @param {Record<string, string>} [columnOverrides]
 */
export async function loadEicModel(sources, columnOverrides = {}) {
  if (!sources?.raw || !sources?.corrected) {
    throw new Error('Both a raw and a baseline-corrected source are required.')
  }
  const [rawTable, correctedTable] = await Promise.all([
    readParquetTable(sources.raw, columnOverrides),
    readParquetTable(sources.corrected, columnOverrides),
  ])
  const model = buildEicModel(rawTable, correctedTable)
  if (!model.groups.length) {
    throw new Error('No EIC groups could be built from these tables.')
  }
  return model
}

/** CSV export of one group, for the table view / offline inspection. */
export function groupToCsv(group) {
  const lines = ['group_number,mz,rt,intensity_raw,intensity_corrected,intensity_baseline']
  for (let i = 0; i < group.rt.length; i++) {
    lines.push(
      [
        group.id,
        group.mz ?? '',
        group.rt[i],
        finite(group.raw[i]),
        finite(group.corrected[i]),
        finite(group.baseline[i]),
      ].join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

function finite(value) {
  return Number.isFinite(value) ? String(value) : ''
}
