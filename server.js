// State Housing Market Ranker — zero-dependency Node server (Node >= 18).
// Serves the UI and proxies the FRED API so the API key never reaches the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const FRED_KEY = process.env.FRED_API_KEY || '';
const FRED_BASE = process.env.FRED_BASE || 'https://api.stlouisfed.org';
const INTERVAL_MS = Number(process.env.FRED_INTERVAL_MS ?? 550); // ~110 requests/min, under FRED's 120/min limit
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'cache.json');
const TTL_MS = 24 * 60 * 60 * 1000;

const STATES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',
  DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',
  VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'
};
const CODES = Object.keys(STATES);
const TOTAL_CALLS = CODES.length * 3;

// ---------- FRED client (rate-limited, with retry) ----------
let nextAt = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gate() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + INTERVAL_MS;
  if (at > now) await sleep(at - now);
}
async function fred(seriesId, extra) {
  const url = `${FRED_BASE}/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${FRED_KEY}&file_type=json&${extra}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await gate();
    const res = await fetch(url);
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * attempt); continue; }
    if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
    const json = await res.json();
    return (json.observations || [])
      .filter(o => o.value !== '.' && o.value !== '')
      .map(o => ({ date: o.date, value: parseFloat(o.value) }))
      .filter(o => Number.isFinite(o.value));
  }
  throw new Error(`FRED ${seriesId}: too many retries`);
}

// ---------- Data cache / warm-up ----------
const store = { status: 'idle', done: 0, total: TOTAL_CALLS, fetchedAt: null, failures: [], data: {}, error: null };

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.fetchedAt && Date.now() - new Date(c.fetchedAt).getTime() < TTL_MS && c.data) {
      Object.assign(store, { status: 'ready', done: TOTAL_CALLS, fetchedAt: c.fetchedAt, failures: c.failures || [], data: c.data });
      return true;
    }
  } catch (_) {}
  return false;
}

async function warmUp() {
  if (store.status === 'loading') return;
  if (!FRED_KEY) { Object.assign(store, { status: 'error', error: 'FRED_API_KEY is not set on the server.' }); return; }
  Object.assign(store, { status: 'loading', done: 0, failures: [], error: null });
  const data = {};
  const failures = [];
  const tick = () => { store.done++; };
  await Promise.all(CODES.map(async st => {
    const d = (data[st] = { hpi: null, pcpi: null, price: null });
    const safe = async (key, id, extra, map) => {
      try { d[key] = map(await fred(id, extra)); }
      catch (e) { failures.push(`${id}: ${e.message}`); }
      tick();
    };
    await Promise.all([
      safe('hpi', `${st}STHPI`, 'observation_start=2013-01-01', x => x),
      safe('pcpi', `${st}PCPI`, 'observation_start=2013-01-01', x => x),
      safe('price', `MEDLISPRI${st}`, 'sort_order=desc&limit=1', x => x[0] || null)
    ]);
  }));
  const okStates = CODES.filter(c => data[c].hpi && data[c].pcpi && data[c].price).length;
  if (okStates === 0) {
    Object.assign(store, { status: 'error', error: 'FRED returned no usable data. Check the API key and network access.', failures });
    return;
  }
  Object.assign(store, { status: 'ready', fetchedAt: new Date().toISOString(), failures, data });
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: store.fetchedAt, failures, data })); } catch (_) {}
}

// ---------- Decision model ----------
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const shiftYears = (date, n) => `${Number(date.slice(0, 4)) - n}${date.slice(4)}`;
const norm = (v, lo, hi) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function metricsFor(d, N) {
  const hpi = d.hpi, byDate = new Map(hpi.map(o => [o.date, o.value]));
  const end = hpi[hpi.length - 1];
  const startVal = byDate.get(shiftYears(end.date, N));
  if (startVal === undefined) return null;
  const g = (end.value / startVal) ** (1 / N) - 1;
  const yoys = [];
  for (const o of hpi) {
    if (o.date <= shiftYears(end.date, N) || o.date > end.date) continue;
    const prior = byDate.get(shiftYears(o.date, 1));
    if (prior !== undefined) yoys.push(o.value / prior - 1);
  }
  const v = std(yoys);
  const pc = d.pcpi, pBy = new Map(pc.map(o => [o.date, o.value]));
  const pEnd = pc[pc.length - 1];
  const pStart = pBy.get(shiftYears(pEnd.date, N));
  if (pStart === undefined || yoys.length < 2) return null;
  const incG = (pEnd.value / pStart) ** (1 / N) - 1;
  return { g, v, incG, gap: incG - g, hpiEnd: end.date, incomeEnd: pEnd.date, income: pEnd.value, price: d.price.value };
}

function rank({ budget, horizon, minIncome, weight }) {
  const w = weight / 10;
  const excluded = { 'missing data': 0, 'over budget': 0, 'below minimum income': 0, 'not enough history': 0 };
  const rows = [];
  for (const code of CODES) {
    const d = store.data[code];
    if (!d || !d.hpi || !d.hpi.length || !d.pcpi || !d.pcpi.length || !d.price) { excluded['missing data']++; continue; }
    if (d.price.value > budget) { excluded['over budget']++; continue; }
    if (d.pcpi[d.pcpi.length - 1].value < minIncome) { excluded['below minimum income']++; continue; }
    const m = metricsFor(d, horizon);
    if (!m) { excluded['not enough history']++; continue; }
    rows.push({ code, state: STATES[code], ...m });
  }
  const range = k => [Math.min(...rows.map(x => x[k])), Math.max(...rows.map(x => x[k]))];
  const [gLo, gHi] = range('g'), [vLo, vHi] = range('v'), [aLo, aHi] = range('gap');
  for (const x of rows) {
    const G = norm(x.g, gLo, gHi), S = 1 - norm(x.v, vLo, vHi), A = norm(x.gap, aLo, aHi);
    x.score = 100 * (0.8 * (w * G + (1 - w) * S) + 0.2 * A);
  }
  rows.sort((a, b) => b.score - a.score || a.v - b.v);
  const top = rows.slice(0, 5).map((x, i) => ({
    rank: i + 1, code: x.code, state: x.state, score: r(x.score, 1), cagrPct: r(x.g * 100), volPct: r(x.v * 100),
    incomeCagrPct: r(x.incG * 100), gapPts: r(x.gap * 100), listingPrice: Math.round(x.price), perCapitaIncome: Math.round(x.income),
    hpiThrough: x.hpiEnd, incomeThrough: x.incomeEnd
  }));
  const warnings = [];
  if (rows.length === 0) warnings.push('No states pass your filters. Raise the budget cap or lower the minimum income.');
  else if (rows.length < 5) warnings.push(`Only ${rows.length} state(s) pass your filters, so fewer than 5 are ranked. Loosen the budget or income filter for a fuller list.`);
  const failedStates = CODES.filter(c => !(store.data[c] && store.data[c].hpi && store.data[c].pcpi && store.data[c].price)).length;
  if (failedStates) warnings.push(`${failedStates} state(s) were skipped because FRED data was missing or failed to load.`);
  let why = '';
  if (top.length) {
    const t = top[0];
    const lean = weight >= 6 ? `your growth-leaning weight (${weight}/10) rewards its appreciation` : weight <= 4 ? `your stability-leaning weight (${weight}/10) rewards its low volatility` : `your balanced weight (${weight}/10) splits credit between growth and stability`;
    why = `${t.state} ranks #1 of ${rows.length} qualifying states with a score of ${t.score}. Over ${horizon} years its home prices grew ${t.cagrPct}% per year (KPI 1) with ${t.volPct}% year-over-year volatility (KPI 2), and ${lean}. Per-capita income grew ${t.incomeCagrPct}% per year, a gap of ${t.gapPts >= 0 ? '+' : ''}${t.gapPts} points versus prices (KPI 3), and its median listing price of $${t.listingPrice.toLocaleString('en-US')} is under your $${budget.toLocaleString('en-US')} cap.`;
    if (top[1]) why += ` The runner-up is ${top[1].state} at ${top[1].score}.`;
  }
  return { top, qualifying: rows.length, totalStates: CODES.length, excluded, warnings, why, inputs: { budget, horizon, minIncome, weight }, fetchedAt: store.fetchedAt };
}

// ---------- HTTP ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/status') {
    return send(res, 200, { status: store.status, done: store.done, total: store.total, fetchedAt: store.fetchedAt, error: store.error, failureCount: store.failures.length });
  }
  if (url.pathname === '/api/rank') {
    if (store.status !== 'ready') return send(res, 503, { error: store.error || 'Data is still loading from FRED.', status: store.status, done: store.done, total: store.total });
    const q = url.searchParams;
    const inputs = { budget: Number(q.get('budget')), horizon: Number(q.get('horizon')), minIncome: Number(q.get('minIncome')), weight: Number(q.get('weight')) };
    const bad =
      !(inputs.budget >= 50000 && inputs.budget <= 5000000) ? 'Budget must be between $50,000 and $5,000,000.' :
      ![3, 5, 10].includes(inputs.horizon) ? 'Time horizon must be 3, 5, or 10 years.' :
      !(inputs.minIncome >= 0 && inputs.minIncome <= 200000) ? 'Minimum income must be between $0 and $200,000.' :
      !(Number.isInteger(inputs.weight) && inputs.weight >= 0 && inputs.weight <= 10) ? 'Weight must be a whole number from 0 to 10.' : null;
    if (bad) return send(res, 400, { error: bad });
    return send(res, 200, rank(inputs));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'index.html');
    return fs.readFile(file, (err, buf) => {
      if (err) return send(res, 500, { error: 'index.html missing' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf);
    });
  }
  send(res, 404, { error: 'Not found' });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on ${PORT}`);
  if (!loadCache()) warmUp();
});
