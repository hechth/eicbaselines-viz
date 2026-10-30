import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncBufferFromBytes, readParquetTable } from './parquet.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(here, '../../test-data')
// The tool's real committed test data, same fixture as eic.test.js.
const SINGLE_RAW = 'single_input.parquet'

const HTML = new TextEncoder().encode(
  '<!doctype html><html lang="en"><head><title>eicbaselines</title></head><body></body></html>',
)
// What a git symlink looks like checked out without `core.symlinks`: text, not parquet.
const WRONG = new TextEncoder().encode('../data/corrected.parquet')

const calls = []

/**
 * A `Response` holding only what `fetchBytes` reads: status, content type and body.
 * The JSON stub in source.test.js cannot serve bytes, so this module keeps its own.
 */
function httpResponse({ status = 200, statusText = 'OK', contentType, bytes = new Uint8Array() }) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? (contentType ?? null) : null),
    },
    // A Node `Buffer` is a view into a pooled buffer, so only its own window is the body.
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }
}

/** Serve canned bytes per URL fragment; anything unlisted answers 404. */
function stubBytes(routes) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      calls.push({ url, init })
      const key = Object.keys(routes).find((fragment) => url.includes(fragment))
      if (!key) return httpResponse({ status: 404, statusText: 'Not Found' })
      return httpResponse(routes[key])
    }),
  )
}

/** The rejection message of a call that is expected to fail. */
async function rejectionMessage(promise) {
  const error = await promise.then(
    () => null,
    (reason) => reason,
  )
  expect(error).toBeInstanceOf(Error)
  return error.message
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readParquetTable from a url', () => {
  const url = 'http://localhost:5173/test-data/single_input.parquet'

  it('blames the url instead of the file when the server answers with the app page', async () => {
    // The reported bug: a dev server SPA fallback answers a bad URL with 200 + index.html.
    stubBytes({ single_input: { contentType: 'text/html;charset=utf-8', bytes: HTML } })
    const message = await rejectionMessage(readParquetTable(url))
    expect(message).toContain(url)
    expect(message).toContain('server answered with the app page')
    // hyparquet's footer complaint puts the user off the trail: the URL is wrong.
    expect(message).not.toContain('footer != PAR1')
  })

  it('names the response when the bytes behind it are not parquet', async () => {
    stubBytes({
      single_input: { contentType: 'application/octet-stream', bytes: WRONG },
    })
    const message = await rejectionMessage(readParquetTable(url))
    expect(message).toBe(
      `The response from ${url} does not start with "PAR1", so it is not a parquet file.`,
    )
  })

  it('copes with a body shorter than the magic bytes', async () => {
    // Two gzip bytes: long enough to be a real answer, too short to hold 'PAR1'.
    stubBytes({
      single_input: {
        contentType: 'application/octet-stream',
        bytes: Uint8Array.from([0x1f, 0x8b]),
      },
    })
    const message = await rejectionMessage(readParquetTable(url))
    expect(message).toContain('does not start with "PAR1"')
    expect(message).not.toContain('RangeError')
  })

  it('copes with an empty body', async () => {
    stubBytes({ single_input: { contentType: 'application/octet-stream' } })
    const message = await rejectionMessage(readParquetTable(url))
    expect(message).toContain('does not start with "PAR1"')
  })

  it('reports the status code before looking at anything else', async () => {
    // With `Accept: application/octet-stream` a missing file is a real 404, and that is
    // the clearest thing we can say about it, whatever the body would have held.
    stubBytes({})
    const message = await rejectionMessage(readParquetTable('http://localhost:5173/nope.parquet'))
    expect(message).toBe('Failed to fetch http://localhost:5173/nope.parquet: 404 Not Found')
  })

  it('asks the server for bytes instead of a page', async () => {
    stubBytes({ single_input: { contentType: 'text/html', bytes: HTML } })
    await rejectionMessage(readParquetTable(url))
    expect(calls[0].url).toBe(url)
    expect(calls[0].init.headers.Accept).toBe('application/octet-stream')
  })

  it('reads parquet served over http like any other source', async () => {
    stubBytes({
      single_input: {
        contentType: 'application/octet-stream',
        bytes: readFileSync(resolve(dataDir, SINGLE_RAW)),
      },
    })
    const table = await readParquetTable(url)
    expect(table.columns.group).toBe('group_number')
    expect(table.rows.length).toBe(2078)
    expect(typeof table.rows[0].intensity).toBe('number')
    expect(calls.length).toBe(1)
  })

  it('reads parquet served without a content type', async () => {
    stubBytes({ single_input: { bytes: readFileSync(resolve(dataDir, SINGLE_RAW)) } })
    expect((await readParquetTable(url)).rows.length).toBe(2078)
  })
})

describe('parquet sources', () => {
  it('rejects foreign bytes whichever container they arrive in', async () => {
    const containers = [
      new Blob([WRONG]), // what a file picker hands us
      Uint8Array.from(WRONG), // a view, so the byte offset matters
      WRONG.buffer.slice(WRONG.byteOffset, WRONG.byteOffset + WRONG.byteLength),
    ]
    for (const source of containers) {
      const message = await rejectionMessage(readParquetTable(source))
      expect(message).toBe(
        'The parquet source does not start with "PAR1", so it is not a parquet file.',
      )
    }
  })

  it('reads parquet picked from disk', async () => {
    const table = await readParquetTable(new Blob([readFileSync(resolve(dataDir, SINGLE_RAW))]))
    expect(table.columns.group).toBe('group_number')
    expect(table.rows.length).toBe(2078)
  })

  it('reads parquet handed over as an async buffer', async () => {
    const bytes = readFileSync(resolve(dataDir, SINGLE_RAW))
    const table = await readParquetTable(asyncBufferFromBytes(bytes))
    expect(table.rows.length).toBe(2078)
  })

  it('leaves foreign bytes inside an async buffer to hyparquet', async () => {
    // Deliberate: checking an AsyncBuffer we were handed means a `slice()` per read for a
    // message we can already give at every entry point that takes raw bytes.
    const message = await rejectionMessage(readParquetTable(asyncBufferFromBytes(WRONG)))
    expect(message).not.toContain('does not start with "PAR1"')
  })

  // `toAsyncBuffer` is module-private, so its rejection is reached through the entry point.
  it('rejects a source that is not a url, blob, buffer or async buffer', async () => {
    for (const source of [42, null, {}]) {
      const message = await rejectionMessage(readParquetTable(source))
      expect(message).toBe(
        'Unsupported parquet source: expected a URL, Blob, ArrayBuffer or AsyncBuffer.',
      )
    }
  })

  it('rejects bytes that are neither a buffer nor a view', () => {
    expect(() => asyncBufferFromBytes('PAR1')).toThrow(
      'Expected an ArrayBuffer or typed array, got String.',
    )
    expect(() => asyncBufferFromBytes(undefined)).toThrow(
      'Expected an ArrayBuffer or typed array, got Undefined.',
    )
  })

  it('keeps the window of a view into a larger buffer', async () => {
    const bytes = readFileSync(resolve(dataDir, SINGLE_RAW))
    const padded = new Uint8Array(bytes.byteLength + 8)
    padded.set(bytes, 4)
    const view = padded.subarray(4, 4 + bytes.byteLength)
    const table = await readParquetTable(asyncBufferFromBytes(view))
    expect(table.rows.length).toBe(2078)
  })

  it('reads a parquet window inside a larger buffer', async () => {
    // The magic bytes have to be found at `byteOffset`, not at the start of the holding
    // buffer, or this reads four zero bytes and is rejected as foreign.
    const bytes = readFileSync(resolve(dataDir, SINGLE_RAW))
    const padded = new Uint8Array(bytes.byteLength + 8)
    padded.set(bytes, 4)
    const table = await readParquetTable(padded.subarray(4, 4 + bytes.byteLength))
    expect(table.rows.length).toBe(2078)
  })
})
