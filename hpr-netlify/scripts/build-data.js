// Runs on every Netlify build: pulls live data from the FRED API for all 50 states + DC
// and writes public/data.json. The key comes from the FRED_API_KEY environment variable (never committed).
const fs = require('fs');
const path = require('path');

const KEY = process.env.FRED_API_KEY;
const BASE = process.env.FRED_BASE || 'https://api.stlouisfed.org';
const INTERVAL_MS = Number(process.env.FRED_INTERVAL_MS ?? 550); // stay under FRED's ~120 requests/min
if (!KEY) { console.error('ERROR: FRED_API_KEY is not set. Add it in Netlify > Site configuration > Environment variables.'); process.exit(1); }

const CODES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextAt = 0;
async function gate() { const now = Date.now(); const at = Math.max(now, nextAt); nextAt = at + INTERVAL_MS; if (at > now) await sleep(at - now); }

async function fred(id, extra) {
  const url = `${BASE}/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${KEY}&file_type=json&${extra}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await gate();
    let res;
    try { res = await fetch(url); } catch (e) { await sleep(1500 * attempt); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(2500 * attempt); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.observations || []).filter(o => o.value !== '.' && o.value !== '').map(o => [o.date, parseFloat(o.value)]).filter(o => Number.isFinite(o[1]));
  }
  throw new Error('too many retries');
}

(async () => {
  const states = {}, failures = [];
  let done = 0;
  const total = CODES.length * 3;
  await Promise.all(CODES.map(async st => {
    const d = (states[st] = { hpi: null, pcpi: null, price: null });
    const grab = async (key, id, extra, map) => {
      try { d[key] = map(await fred(id, extra)); } catch (e) { failures.push(`${id}: ${e.message}`); }
      if (++done % 15 === 0) console.log(`  ${done}/${total} series`);
    };
    await Promise.all([
      grab('hpi', `${st}STHPI`, 'observation_start=2013-01-01', x => x),
      grab('pcpi', `${st}PCPI`, 'observation_start=2013-01-01', x => x),
      grab('price', `MEDLISPRI${st}`, 'sort_order=desc&limit=1', x => (x[0] ? { date: x[0][0], value: x[0][1] } : null))
    ]);
  }));
  const ok = CODES.filter(c => states[c].hpi && states[c].pcpi && states[c].price).length;
  console.log(`Fetched ${ok}/${CODES.length} states fully. Failures: ${failures.length}`);
  failures.slice(0, 10).forEach(f => console.log('  - ' + f));
  if (ok < 40) { console.error('ERROR: too few states loaded; refusing to publish a broken snapshot (previous deploy stays live).'); process.exit(1); }
  fs.mkdirSync(path.join(__dirname, '..', 'public'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'data.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), failures, states }));
  console.log('Wrote public/data.json');
})();
