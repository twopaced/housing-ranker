// Runtime live call to the FRED API: re-checks the latest median listing price and house price index
// for one state, so the app can show the #1 result is still current. Key stays server-side.
const CODES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']);
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const st = String((event.queryStringParameters || {}).state || '').toUpperCase();
  if (!CODES.has(st)) return json(400, { error: 'state must be a valid 2-letter code' });
  const key = process.env.FRED_API_KEY;
  if (!key) return json(500, { error: 'FRED_API_KEY is not set on the server' });
  const base = process.env.FRED_BASE || 'https://api.stlouisfed.org';
  const latest = async id => {
    const res = await fetch(`${base}/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=1`);
    if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
    const j = await res.json();
    const o = (j.observations || []).find(x => x.value !== '.');
    if (!o) throw new Error(`FRED ${id}: no data`);
    return { date: o.date, value: parseFloat(o.value) };
  };
  try {
    const [price, hpi] = await Promise.all([latest(`MEDLISPRI${st}`), latest(`${st}STHPI`)]);
    return json(200, { state: st, price, hpi, checkedAt: new Date().toISOString() });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
