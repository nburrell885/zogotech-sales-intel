// Endpoint names on the Education Data Portal change between releases, so
// confirm which respond before wiring a report to them.
import { ENDPOINTS } from '../src/lib/ipeds.js';

const year = Number(process.argv[2] || 2022);
const BASE = 'https://educationdata.urban.org/api/v1';

const CANDIDATES = {
  ...ENDPOINTS,
  completers: (y) => `/college-university/ipeds/completers/${y}/`,
  gradRates200: (y) => `/college-university/ipeds/grad-rates-200pct/${y}/`,
  admissions: (y) => `/college-university/ipeds/admissions-enrollment/${y}/`,
  finance: (y) => `/college-university/ipeds/academic-libraries/${y}/`,
};

for (const [name, build] of Object.entries(CANDIDATES)) {
  const url = `${BASE}${build(year)}?limit=1`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = res.ok ? await res.json() : null;
    const keys = body?.results?.[0] ? Object.keys(body.results[0]).slice(0, 8).join(', ') : '';
    console.log(`${res.ok ? 'OK  ' : 'FAIL'} ${res.status}  ${name.padEnd(14)} ${build(year)}`);
    if (keys) console.log(`        fields: ${keys}`);
  } catch (e) {
    console.log(`ERR      ${name.padEnd(14)} ${e.message}`);
  }
}
