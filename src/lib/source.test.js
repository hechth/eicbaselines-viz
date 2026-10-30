import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  datasetDisplayUrl,
  datasetMetaUrl,
  groupToCsv,
  listCompanionChoices,
  listSiblingParquetDatasets,
  resolveJobPartner,
  resolvePairIds,
} from './source.js'

const calls = []

/** Serve canned JSON per URL fragment; anything unlisted answers 404. */
function stubApi(routes) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      calls.push(url)
      const key = Object.keys(routes).find((fragment) => url.includes(fragment))
      if (!key) return { ok: false, status: 404, statusText: 'Not Found' }
      return { ok: true, status: 200, json: async () => routes[key] }
    }),
  )
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dataset urls', () => {
  it('asks for the bytes of a dataset', () => {
    expect(datasetDisplayUrl('/', 'deadbeefcafe')).toBe('/api/datasets/deadbeefcafe/display')
    expect(datasetDisplayUrl('https://galaxy.example/', 'abc')).toBe(
      'https://galaxy.example/api/datasets/abc/display',
    )
  })

  it('uses the encoded id untouched', () => {
    // Galaxy truncates its id digests, so a decode/re-encode round trip is not stable.
    expect(datasetMetaUrl('/', 'f9eab12c8d34ef5a')).toBe('/api/datasets/f9eab12c8d34ef5a')
  })
})

describe('listSiblingParquetDatasets', () => {
  const contents = [
    { id: 'a', name: 'corrected', state: 'ok', extension: 'parquet' },
    { id: 'b', name: 'raw', state: 'ok', extension: 'parquet' },
    { id: 'c', name: 'table', state: 'ok', extension: 'tabular' },
    { id: 'd', name: 'broken', state: 'error', extension: 'parquet' },
    { id: 'bound', name: 'this one', state: 'ok', extension: 'parquet' },
  ]

  beforeEach(() => stubApi({ '/api/datasets?': contents }))

  it('keeps only usable parquet datasets, and never the bound one', async () => {
    const rows = await listSiblingParquetDatasets('/', 'hist1', 'bound')
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('asks the endpoint that actually applies filters', async () => {
    await listSiblingParquetDatasets('/', 'hist1', 'bound')
    // The history-contents endpoint ignores q/qv unless v=dev, so it is not used here.
    expect(calls[0]).toContain('/api/datasets?')
    expect(calls[0]).toContain('history_id=hist1')
    expect(calls[0]).toContain('q=extension')
    expect(calls[0]).toContain('qv=parquet')
  })

  it('drops a file the server still sent as non-parquet', async () => {
    stubApi({ '/api/datasets?': [{ id: 't', name: 'tab', state: 'ok', extension: 'tabular' }] })
    expect(await listSiblingParquetDatasets('/', 'hist1', 'bound')).toEqual([])
  })

  it('returns nothing without a history', async () => {
    expect(await listSiblingParquetDatasets('/', undefined, 'x')).toEqual([])
  })
})

describe('resolveJobPartner', () => {
  const meta = { id: 'bound', creating_job: 'job1', history_id: 'hist1' }

  it('follows the job that produced the dataset and prefers its `infile`', async () => {
    stubApi({
      '/api/datasets/bound': meta,
      '/api/jobs/job1/inputs': [
        { name: 'outfile', dataset: { src: 'hda', id: 'other' } },
        { name: 'infile', dataset: { src: 'hda', id: 'rawid' } },
      ],
    })
    expect(await resolveJobPartner('/', 'bound', 'inputs')).toBe('rawid')
    expect(calls[1]).toBe('/api/jobs/job1/inputs')
  })

  it('walks the other way when the dataset is the tool input', async () => {
    stubApi({
      '/api/datasets/bound': meta,
      '/api/jobs/job1/outputs': [{ name: 'outfile', dataset: { src: 'hda', id: 'corrected' } }],
    })
    expect(await resolveJobPartner('/', 'bound', 'outputs')).toBe('corrected')
  })

  it('accepts an unnamed single input', async () => {
    stubApi({
      '/api/datasets/bound': meta,
      '/api/jobs/job1/inputs': [{ name: 'whatever', dataset: { src: 'hda', id: 'only' } }],
    })
    expect(await resolveJobPartner('/', 'bound', 'inputs')).toBe('only')
  })

  it('refuses to guess between two unnamed inputs', async () => {
    stubApi({
      '/api/datasets/bound': meta,
      '/api/jobs/job1/inputs': [
        { name: 'a', dataset: { src: 'hda', id: 'one' } },
        { name: 'b', dataset: { src: 'hda', id: 'two' } },
      ],
    })
    expect(await resolveJobPartner('/', 'bound', 'inputs')).toBeNull()
  })

  it('degrades to null instead of throwing when provenance is unavailable', async () => {
    stubApi({ '/api/datasets/bound': { id: 'bound', creating_job: null } })
    expect(await resolveJobPartner('/', 'bound', 'inputs')).toBeNull()
    expect(calls.length).toBe(1)
  })

  it('degrades to null when the jobs API refuses the request', async () => {
    stubApi({ '/api/datasets/bound': meta })
    expect(await resolveJobPartner('/', 'bound', 'inputs')).toBeNull()
  })
})

describe('resolvePairIds', () => {
  const meta = { id: 'bound', creating_job: 'job1', history_id: 'hist1' }
  const provenance = {
    '/api/datasets/bound': meta,
    '/api/jobs/job1/inputs': [{ name: 'infile', dataset: { src: 'hda', id: 'rawid' } }],
  }

  it('takes an explicit pair from the settings without calling the API', async () => {
    stubApi({})
    const pair = await resolvePairIds('/', 'bound', {
      input_dataset_id: 'rawid',
      output_dataset_id: 'corr',
    })
    expect(pair).toEqual({ raw: 'rawid', corrected: 'corr', via: 'settings' })
    expect(calls.length).toBe(0)
  })

  it('treats the bound dataset as the output when its job has an input', async () => {
    stubApi(provenance)
    expect(await resolvePairIds('/', 'bound')).toEqual({
      raw: 'rawid',
      corrected: 'bound',
      via: 'provenance',
    })
  })

  it('treats the bound dataset as the input when only the job output exists', async () => {
    stubApi({
      '/api/datasets/bound': meta,
      '/api/jobs/job1/outputs': [{ name: 'outfile', dataset: { src: 'hda', id: 'corr' } }],
    })
    expect(await resolvePairIds('/', 'bound')).toEqual({
      raw: 'bound',
      corrected: 'corr',
      via: 'provenance',
    })
  })

  it('reports an incomplete pair rather than inventing one', async () => {
    stubApi({ '/api/datasets/bound': { id: 'bound', creating_job: null } })
    expect(await resolvePairIds('/', 'bound')).toEqual({
      raw: 'bound',
      corrected: null,
      via: 'incomplete',
    })
  })
})

describe('listCompanionChoices', () => {
  it('looks the history up from the bound dataset', async () => {
    stubApi({
      '/api/datasets/bound': { id: 'bound', history_id: 'hist9' },
      '/api/datasets?': [{ id: 'x', name: 'other', state: 'ok', extension: 'parquet' }],
    })
    expect(await listCompanionChoices('/', 'bound')).toEqual([
      { id: 'x', name: 'other', extension: 'parquet' },
    ])
  })

  it('returns nothing when the dataset itself cannot be read', async () => {
    stubApi({})
    expect(await listCompanionChoices('/', 'nope')).toEqual([])
  })
})

describe('groupToCsv', () => {
  it('writes one row per point, with the derived baseline', () => {
    const group = {
      id: 3,
      mz: 839.8769,
      rt: Float64Array.from([608.8347, 609.1]),
      raw: Float64Array.from([100, 120]),
      corrected: Float64Array.from([20, NaN]),
      baseline: Float64Array.from([80, NaN]),
    }
    const csv = groupToCsv(group)
    expect(csv.split('\n')).toEqual([
      'group_number,mz,rt,intensity_raw,intensity_corrected,intensity_baseline',
      '3,839.8769,608.8347,100,20,80',
      '3,839.8769,609.1,120,,',
      '',
    ])
  })
})
