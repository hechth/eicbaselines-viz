import { readParquetTable } from '/home/hechth/dev/eicbaselines-viz/src/lib/parquet.js'
const base = 'http://localhost:5183/'
const res = await fetch(new URL('config.json', base), { headers: { Accept: 'application/json' } })
console.log(`config.json -> ${res.status} ${res.headers.get('content-type')}`)
const cfg = await res.json()
for (const s of cfg.samples) {
  for (const half of ['raw', 'corrected']) {
    const url = new URL(s[half], base).href
    try {
      const t = await readParquetTable(url)
      console.log(`  OK   ${s.id}.${half}: ${t.rows.length} rows, cols ${Object.values(t.columns).filter(Boolean).join(',')}`)
    } catch (e) { console.log(`  FAIL ${s.id}.${half}: ${e.message}`) }
  }
}
