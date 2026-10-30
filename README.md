# eicbaselines

Interactive viewer for **baseline-removed extracted ion chromatograms**: it shows the raw
EIC, the baseline-removed curve and the estimated baseline of a pybaselines run, side by
side on one axis, for every EIC group in the file.

The intended input is the pair of parquet files produced by the
[pybaselines Galaxy tool](https://github.com/RECETOX/galaxytools/tree/main/tools/pybaselines):
its input (`infile`) and its output (`outfile`).

```bash
npm install eicbaselines
```

- Standalone app: `npm run dev` (or `npm run build:app` and serve `static/`).
- Library: `import { mountViewer } from 'eicbaselines'` plus `eicbaselines/style.css`.
- Galaxy: wrapped by `packages/eicbaselines` in [galaxy-visualizations](https://github.com/galaxyproject/galaxy-visualizations).

## What the tool actually does (and why two files are needed)

`pybaselines.xml` overwrites the intensity column in place:

```python
baseline, params = func(y, lam=..., max_iter=...)
group["intensity"] = np.maximum(np.zeros_like(y), y - baseline)
```

The main output contains only the corrected curve, so the baseline is recoverable by
comparing the two tables row by row:

```
baseline(i) = max(0, raw(i) - corrected(i))
```

That identity is exact except where the corrected intensity was clipped to zero by
`np.maximum` (negative residuals). There the true baseline is *at least* the difference,
so the drawn baseline is a lower bound for clipped points — the "clipped to 0" stat tile
says how many points that affects.

## Matching the two tables

Rows are joined on `(group_number, rt)`. If the corrected table has no group column —
pandas drops the grouping column in `groupby(...).apply()` in the current tool — the
viewer falls back to a positional match, which is only accepted after verifying that
every retention time lines up. A rejected fallback is reported in the data notes instead
of drawing a wrong baseline.

Column names are matched case- and alias-insensitively (`mz`, `mz_mean`; `rt`,
`retention_time`; `intensity`, `abundance`; `group_number`, `group`, `feature_id`, …)
and can be overridden explicitly with `columnOverrides`.

## Standalone app

```bash
npm run dev          # http://localhost:5173, bundled sample pair
npm run build:app    # static build in ./static
```

The page reads two sources, in this order:

1. `?raw=<url>&corrected=<url>` — any two reachable parquet tables (a half that is missing
   is taken from the chosen pair);
2. the two file pickers at the top;
3. `test-data/config.json`, when the app ships one — see [Sample config](#sample-config);
4. the sample pairs shipped with the app (`test-data/`, served from the app root).

`?mode=light|dark` pins the colour scheme, otherwise the OS preference is followed;
`?config=<url>` reads the sample list from somewhere other than `config.json` beside the page.

### Sample config

`config.json` next to the app is what the sample selector offers:

```json
{
  "samples": [
    {
      "id": "multigroup",
      "name": "12 groups — group column in both tables",
      "raw": "multigroup_input.parquet",
      "corrected": "multigroup_result.parquet"
    }
  ]
}
```

- `id` is required and must be unique — it is the `<option value>`. A repeated id is skipped,
  never renamed.
- `name` is optional and defaults to the file name of `raw`.
- `raw` and `corrected` are required. A relative value resolves against **the page's own
  URL**, so a bare file name is looked up next to the app; absolute URLs and `/@fs/…` paths
  work as they are.
- A bare top-level array is accepted instead of the `samples` key, and unknown keys are
  ignored, so a newer file does not break an older viewer.

```bash
cp test-data/config.example.json test-data/config.json
```

`test-data/config.example.json` is committed and shows both kinds of entry; `config.json`
itself is gitignored because it names paths on your machine. JSON has no comments, so the
example carries its explanation in a `_comment` key, which the viewer ignores.

One constraint explains the rest of the design: a browser can only read the bytes its own
server serves. In development and in a `static/` build that means files under `test-data/`;
anything else has to be reachable by URL or chosen with the file pickers, which are the
zero-config way to open a one-off pair. A path the server does not serve used to be answered
with the app's own `index.html`, which is why the viewer now reports that a URL returned a
web page instead of parquet.

To read a file that lives outside this project — a pybaselines checkout, say — the dev server
has to allow its directory:

```bash
LOCAL_DATA_DIRS=/home/me/galaxytools npm run dev
```

Entries are separated by commas or `PATH` delimiters. `/@fs/…` URLs are **development-only**:
neither `vite preview` nor a static host serves them, so a `config.json` containing one must
not be deployed (a production build drops those entries and says why).

Environment variables `vite.config.charts.js` reads, all optional (the first three print a
note on every start when unset):

- `GALAXY_ROOT` — the Galaxy instance the dev server proxies `/api` and `/datasets` to, so
  the standalone page can talk to a real Galaxy without tripping over CORS (default
  `http://127.0.0.1:8080`).
- `GALAXY_KEY` — appended as `?key=` to every proxied request, for a dev instance whose
  session cookie the browser does not send.
- `GALAXY_DATASET_ID` — compiled into the app build as `process.env.dataset_id`. Nothing in
  this repository reads it yet; the standalone page takes its pair from the query string,
  the pickers or the sample list.
- `LOCAL_DATA_DIRS` — directories development may serve as `/@fs/…` (see above). Optional by
  design, so it prints nothing when unset and leaves Vite's default allow-list untouched.

`static/` is gitignored build output written by `npm run build:app`, and its copy of
`test-data/` — the parquet files and any `config.json` — is what a static deployment actually
serves. Regenerate it after changing either; a stale one still offers the older file set.

## Library

```js
import { mountViewer } from 'eicbaselines'
import 'eicbaselines/style.css'

const viewer = mountViewer(document.querySelector('#viewer'), {
  // URL, ArrayBuffer, Blob/File, or a function returning one of those
  raw: '/api/datasets/abc/display',
  corrected: '/api/datasets/def/display',
  labels: { raw: 'raw.parquet', corrected: 'corrected.parquet' },
})

viewer.setMode('dark')
await viewer.setData({ raw: file, corrected: otherFile })
viewer.getModel() // groups, totals, warnings
viewer.destroy()
```

For a Vue app that owns its own state, the components are exported as well:
`App` (the whole viewer, props `model`/`loading`/`error`/`mode`/`sources`, slot `toolbar`)
and `ChromatogramPlot` (one panel, props `group`/`mode`/`visible`/`compact`/`height`).

The pure core is exported too — `buildEicModel`, `readParquetTable`, `groupToCsv`,
`themeFor`, and the Galaxy helpers `resolvePairIds`, `resolveJobPartner`,
`listSiblingParquetDatasets`, `datasetDisplayUrl`.

## Galaxy integration

A Galaxy visualization is bound to exactly one dataset, but this view needs two. The
wrapper therefore resolves the partner dataset server-side, in this order:

1. explicit settings (`input_dataset_id` / `output_dataset_id`) when the host supplies them;
2. job provenance — when opened on the pybaselines output, the job's `infile` input
   (`GET /api/jobs/{id}/inputs`); when opened on the input, the job's `outfile`
   (`…/outputs`);
3. the parquet datasets of the same history, listed for a manual pick.

Galaxy ids arrive encoded and are used as-is — decoding and re-encoding is not lossless.
Authentication relies on the session cookie of the page embedding the visualization.

## Tests

```bash
npm test
npm run lint    # prettier --check; `npm run prettier` rewrites those same files
```

CI runs both, plus the library build, on Node 20, 22 and 24. There is no 18 job: Vite 8
and its Vue plugin require `^20.19.0 || >=22.12.0` and cannot build there.

106 tests cover the parquet reading, the join (keyed and positional, including the tool's
real committed output without a group column), the decimation, the chart options, the Galaxy
partner resolution and the sample config — its schema, its URL resolution, and the difference
between a config that is absent and a config that is broken. The fixtures in `test-data/`
were generated with the real pybaselines tool (`lsrpls`, λ = 600, max_iter = 50); the
single-group pair is the tool's own test data.

## Known limitations

- The corrected table of the current pybaselines tool may lack `group_number`; matching
  then relies on the row order of `groupby(...).apply()` and is verified after the fact.
  This is a tool bug, fixed separately; the keyed join is the primary path.
- The estimated baseline is a lower bound at clipped points (see above). The tool's
  optional `output_baseline` table carries the exact values; this viewer does not read
  that third file.
- Long chromatograms are decimated for drawing (min/max per bucket, shared index set
  across traces), so a spike narrower than one bucket may not be visible at full-file
  zoom; the tooltip and table always report real measured points, and the CSV export has
  every row.
- The Galaxy `job inputs`/`outputs` endpoints need a logged-in session; without one the
  viewer falls back to the history listing.
- Component-level rendering is verified in a headless browser, not in the unit suite:
  uPlot needs a real canvas.
