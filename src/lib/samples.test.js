import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUILTIN_SAMPLES,
  DEFAULT_CONFIG_PATH,
  loadSampleList,
  parseSampleConfig,
  sampleConfigUrl,
} from './samples.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(here, '../../test-data')

// Everything resolves against this page, so no expectation depends on the runner's origin.
const BASE = 'http://localhost:5173/app/'
const CONFIG_URL = 'http://localhost:5173/app/config.json'
const SOURCE = CONFIG_URL

/** @returns {object} a Response carrying `payload`, or throwing from `json()` if it cannot parse */
function response(
  payload,
  { status = 200, statusText = 'OK', contentType = 'application/json' } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => {
      if (payload instanceof Error) throw payload
      return payload
    },
  }
}

const calls = []

function stubFetch(result) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      calls.push({ url, init })
      if (result instanceof Error) throw result
      return result
    }),
  )
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('built-in samples', () => {
  it('offers exactly the pairs that ship in test-data/', () => {
    // The third entry pointed at copies of the pybaselines test data, which are not
    // committed: offering a pair the server does not have is the bug this guards.
    expect(BUILTIN_SAMPLES.map((s) => s.id)).toEqual(['multigroup', 'single'])
    expect(BUILTIN_SAMPLES.map((s) => s.raw.split('/').pop())).toEqual([
      'multigroup_input.parquet',
      'single_input.parquet',
    ])
    expect(BUILTIN_SAMPLES.map((s) => s.corrected.split('/').pop())).toEqual([
      'multigroup_result.parquet',
      'single_result_no_group.parquet',
    ])
  })
})

describe('sampleConfigUrl', () => {
  // `sampleConfigUrl` resolves against the page itself, so only the path is asserted here —
  // the origin belongs to whoever serves the app.
  const pathOf = (url) => new URL(url).pathname

  it('names the config next to the page by default', () => {
    expect(pathOf(sampleConfigUrl())).toBe(`/${DEFAULT_CONFIG_PATH}`)
    expect(sampleConfigUrl('')).toBe(sampleConfigUrl())
  })

  it('applies a ?config= value, and survives a malformed one', () => {
    const named = new URL(sampleConfigUrl('setup/samples.json'))
    expect(named.origin).toBe(new URL(document.baseURI).origin)
    expect(named.pathname.endsWith('/setup/samples.json')).toBe(true)
    expect(sampleConfigUrl('https://example.dev/s.json')).toBe('https://example.dev/s.json')
    // A space cannot appear in a URL; `?config=http://%20invalid` decodes to exactly that.
    expect(sampleConfigUrl('http:// invalid')).toBe(sampleConfigUrl())
  })
})

describe('parseSampleConfig', () => {
  it('reads a well-formed list', () => {
    const { samples, notices } = parseSampleConfig(
      {
        samples: [
          {
            id: 'multi',
            name: '12 groups',
            raw: 'multigroup_input.parquet',
            corrected: 'multigroup_result.parquet',
          },
        ],
      },
      { base: BASE, source: SOURCE },
    )
    expect(samples).toEqual([
      {
        id: 'multi',
        name: '12 groups',
        raw: 'http://localhost:5173/app/multigroup_input.parquet',
        corrected: 'http://localhost:5173/app/multigroup_result.parquet',
      },
    ])
    expect(notices).toEqual([])
  })

  it('accepts a bare array as well', () => {
    const { samples } = parseSampleConfig(
      [{ id: 'a', raw: 'a_input.parquet', corrected: 'a_result.parquet' }],
      { base: BASE, source: SOURCE },
    )
    expect(samples).toHaveLength(1)
  })

  it('takes a bare name from the page URL, and passes an absolute URL through', () => {
    const { samples } = parseSampleConfig(
      {
        samples: [
          { id: 'rel', raw: 'input.parquet', corrected: 'result.parquet' },
          {
            id: 'abs',
            raw: 'https://example.dev/a/input.parquet',
            corrected: '/datasets/abc/display',
          },
        ],
      },
      { base: BASE, source: SOURCE },
    )
    expect(samples[0].raw).toBe('http://localhost:5173/app/input.parquet')
    expect(samples[1].raw).toBe('https://example.dev/a/input.parquet')
    // Root-absolute on purpose: resolving against the page keeps a `?config=` pointing
    // elsewhere from redirecting which files get downloaded.
    expect(samples[1].corrected).toBe('http://localhost:5173/datasets/abc/display')
  })

  it('keeps a /@fs/ URL, which the dev server does serve', () => {
    const upstream = '/@fs/home/me/galaxytools/tools/pybaselines/test-data/input.parquet'
    const { samples, notices } = parseSampleConfig(
      { samples: [{ id: 'up', raw: upstream, corrected: `${upstream}x` }] },
      { base: BASE, source: SOURCE },
    )
    expect(samples[0].raw).toBe(`http://localhost:5173${upstream}`)
    expect(notices).toEqual([])
  })

  it('names a pair by its files when no name is given', () => {
    const { samples } = parseSampleConfig(
      { samples: [{ id: 'a', raw: '/x/y/single_input.parquet', corrected: 'y_result.parquet' }] },
      { base: BASE, source: SOURCE },
    )
    expect(samples[0].name).toBe('single_input.parquet')
  })

  it('skips an incomplete entry and keeps its siblings', () => {
    const { samples, notices } = parseSampleConfig(
      {
        samples: [
          { id: 'a', raw: 'a_input.parquet', corrected: 'a_result.parquet' },
          { id: 'b', name: 'no raw here' },
          { id: 'c', raw: 'c_input.parquet', corrected: 'c_result.parquet' },
        ],
      },
      { base: BASE, source: SOURCE },
    )
    expect(samples.map((s) => s.id)).toEqual(['a', 'c'])
    expect(notices).toEqual([
      `Sample 2 of ${SOURCE} was skipped: id, raw and corrected are required. Found: id, name.`,
    ])
  })

  it('calls a non-object empty of usable keys', () => {
    const { notices } = parseSampleConfig(
      { samples: ['just a string'] },
      { base: BASE, source: SOURCE },
    )
    expect(notices[0]).toBe(
      `Sample 1 of ${SOURCE} was skipped: id, raw and corrected are required. Found: nothing.`,
    )
  })

  it('skips a repeated id once, never renumbering it', () => {
    const { samples, notices } = parseSampleConfig(
      {
        samples: [
          { id: 'single', raw: 'a.parquet', corrected: 'b.parquet' },
          { id: 'single', raw: 'c.parquet', corrected: 'd.parquet' },
          { id: 'other', raw: 'e.parquet', corrected: 'f.parquet' },
        ],
      },
      { base: BASE, source: SOURCE },
    )
    expect(samples.map((s) => s.id)).toEqual(['single', 'other'])
    expect(notices).toEqual([`Sample 2 of ${SOURCE} was skipped: the id "single" is already used.`])
  })

  it('skips an entry whose values are not URLs, quoting what was written', () => {
    const { samples, notices } = parseSampleConfig(
      { samples: [{ id: 'lsrpls', raw: 'http://', corrected: '../x' }] },
      { base: BASE, source: SOURCE },
    )
    expect(samples).toEqual([])
    expect(notices[0]).toBe(
      `Sample "lsrpls" of ${SOURCE} was skipped: raw and corrected must be URLs. ` +
        `Found: raw="http://", corrected="../x".`,
    )
  })

  it('ignores keys it does not know, for forward compatibility', () => {
    const { samples, notices } = parseSampleConfig(
      {
        samples: [
          {
            id: 'a',
            raw: 'a.parquet',
            corrected: 'b.parquet',
            baseline: 'c.parquet',
            note: 'soon',
          },
        ],
      },
      { base: BASE, source: SOURCE },
    )
    expect(samples).toEqual([
      {
        id: 'a',
        name: 'a.parquet',
        raw: 'http://localhost:5173/app/a.parquet',
        corrected: 'http://localhost:5173/app/b.parquet',
      },
    ])
    expect(notices).toEqual([])
  })

  it('reports an empty list, and says what replaces it', () => {
    const { samples, notices } = parseSampleConfig({ samples: [] }, { base: BASE, source: SOURCE })
    expect(samples).toEqual([])
    expect(notices).toEqual([
      `No usable sample pairs were found in ${SOURCE}.`,
      'The built-in example pairs are used instead.',
    ])
  })

  it('names the expected shape for anything that is not a list', () => {
    expect(parseSampleConfig({}, { base: BASE, source: SOURCE }).notices).toEqual([
      `The sample config at ${SOURCE} must contain a "samples" array.`,
    ])
    expect(parseSampleConfig('nope', { base: BASE, source: SOURCE }).samples).toEqual([])
    expect(parseSampleConfig(null, { base: BASE, source: SOURCE }).samples).toEqual([])
  })
})

describe('loadSampleList', () => {
  const payload = {
    samples: [{ id: 'a', name: 'A', raw: 'a.parquet', corrected: 'b.parquet' }],
  }

  it('asks for JSON, which is what makes a missing file a real 404', async () => {
    stubFetch(response({ samples: [] }))
    await loadSampleList(CONFIG_URL, { base: BASE })
    expect(calls[0].url).toBe(CONFIG_URL)
    expect(calls[0].init.headers.Accept).toBe('application/json')
  })

  it('defaults to the config next to the page', async () => {
    stubFetch(response(payload))
    await loadSampleList()
    expect(calls[0].url.endsWith('/config.json')).toBe(true)
  })

  it('uses the list it was given, silently', async () => {
    stubFetch(response(payload))
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples).toEqual([
      {
        id: 'a',
        name: 'A',
        raw: 'http://localhost:5173/app/a.parquet',
        corrected: 'http://localhost:5173/app/b.parquet',
      },
    ])
    expect(notices).toEqual([])
  })

  // A deployment without a config file is the normal case, so it must not say anything:
  // `notices` is what the shell renders, and an empty array renders nothing.
  it('treats a page instead of a file as no config', async () => {
    stubFetch(response('<!doctype html>', { contentType: 'text/html' }))
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples).toBe(BUILTIN_SAMPLES)
    expect(notices).toEqual([])
  })

  it('treats a missing config as no config', async () => {
    stubFetch(response('', { status: 404, statusText: 'Not Found', contentType: 'text/html' }))
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples).toBe(BUILTIN_SAMPLES)
    expect(notices).toEqual([])
  })

  it('reports any other refusal', async () => {
    stubFetch(response('boom', { status: 500, statusText: 'Internal Server Error' }))
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples).toBe(BUILTIN_SAMPLES)
    expect(notices).toEqual([
      `Sample config ${CONFIG_URL} was not read: 500 Internal Server Error.`,
    ])
  })

  it('reports a file that is not JSON', async () => {
    const error = new SyntaxError('Unexpected token < in JSON at position 0')
    stubFetch(response(error))
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples).toBe(BUILTIN_SAMPLES)
    expect(notices).toEqual([`Sample config ${CONFIG_URL} is not valid JSON: ${error.message}.`])
  })

  it('reports a server that never answered', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples).toBe(BUILTIN_SAMPLES)
    expect(notices).toEqual([`${CONFIG_URL} could not be read: Failed to fetch.`])
  })

  it('keeps the fallback when every entry was unusable, with the reason', async () => {
    stubFetch(response({ samples: [{ id: 'x', name: 'incomplete' }] }))
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples).toBe(BUILTIN_SAMPLES)
    expect(notices).toEqual([
      `Sample 1 of ${CONFIG_URL} was skipped: id, raw and corrected are required. Found: id, name.`,
      `No usable sample pairs were found in ${CONFIG_URL}.`,
      'The built-in example pairs are used instead.',
    ])
  })

  it('passes a partial failure through, entries and all', async () => {
    stubFetch(
      response({
        samples: [
          { id: 'good', raw: 'a.parquet', corrected: 'b.parquet' },
          { id: 'bad', name: 'nothing else' },
        ],
      }),
    )
    const { samples, notices } = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(samples.map((s) => s.id)).toEqual(['good'])
    expect(notices).toHaveLength(1)
  })

  // `config.json` is gitignored but still copied into `static/` by the publicDir copy, so a
  // development config can end up on a host that has no `/@fs/`.
  it('serves a /@fs/ entry in development only', async () => {
    const mixed = {
      samples: [
        {
          id: 'upstream',
          raw: '/@fs/home/me/galaxytools/input.parquet',
          corrected: '/@fs/home/me/galaxytools/result.parquet',
        },
        { id: 'shipped', raw: 'single_input.parquet', corrected: 'single_result.parquet' },
      ],
    }
    stubFetch(response(mixed))
    const dev = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(dev.samples.map((s) => s.id)).toEqual(['upstream', 'shipped'])
    expect(dev.notices).toEqual([])

    vi.stubEnv('PROD', true)
    stubFetch(response(mixed))
    const built = await loadSampleList(CONFIG_URL, { base: BASE })
    expect(built.samples.map((s) => s.id)).toEqual(['shipped'])
    expect(built.notices).toEqual([
      `Sample "upstream" of ${CONFIG_URL} was skipped: /@fs/ paths are only served by the ` +
        `development server.`,
    ])
  })
})

// No AppShell component test: `@vue/test-utils` is not a dependency and the viewer needs a
// real canvas (uPlot), so the shell is verified in a browser instead — see the note in the
// README's known limitations. Every decision it would have covered lives in this module.
describe('the example config', () => {
  it('parses as written, which is what the README promises', () => {
    const text = readFileSync(resolve(dataDir, 'config.example.json'), 'utf-8')
    const { samples, notices } = parseSampleConfig(JSON.parse(text), {
      base: BASE,
      source: 'config.example.json',
    })
    expect(notices).toEqual([])
    expect(samples.map((s) => s.id)).toEqual(['multigroup', 'upstream'])
    // A bare name next to the config, and an upstream file behind the dev server.
    expect(samples[0].raw).toBe('http://localhost:5173/app/multigroup_input.parquet')
    expect(samples[1].raw).toContain('/@fs/home/YOU/')
  })
})
