# State Housing Market Ranker (Netlify)
Netlify runs `node scripts/build-data.js` on every build, which pulls FRED data (house price index, per-capita income,
median listing price for all states) into `public/data.json`. The page scores states in the browser. A Netlify
Function (`netlify/functions/live-check.js`) makes a runtime FRED call to re-verify the #1 result.
Environment variable required (Netlify > Site configuration > Environment variables): `FRED_API_KEY`
