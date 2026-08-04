// IPEDS via the Urban Institute Education Data Portal.
//
// No API key and no signup. The API is open and unauthenticated:
//   https://educationdata.urban.org/api/v1/{topic}/{source}/{endpoint}/{year}/?filters
//
// Licence: Open Data Commons Attribution (ODC-By) v1.0. Attribution is a
// condition of use, so ATTRIBUTION below must appear wherever this data is shown.

const BASE = 'https://educationdata.urban.org/api/v1';

export const ATTRIBUTION =
  'Integrated Postsecondary Education Data System, Education Data Portal, ' +
  'Urban Institute, made available under the ODC Attribution License.';

async function get(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(Number(process.env.IPEDS_TIMEOUT_MS || 20000)),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ZogoTech-Sales-Intel/0.1 (+contact: nburrell@zogotech.com)',
    },
  });
  if (!res.ok) throw new Error(`IPEDS ${path} returned ${res.status}`);
  return res.json();
}

// Results are paginated with a `next` URL. Cap the follow count so a bad
// filter cannot walk the entire national dataset.
async function pageAll(path, params = {}, cap = Number(process.env.IPEDS_PAGE_CAP || 12)) {
  let body = await get(path, params);
  const out = [...(body.results || [])];
  for (let i = 0; i < cap && body.next; i++) {
    const res = await fetch(body.next, {
      signal: AbortSignal.timeout(Number(process.env.IPEDS_TIMEOUT_MS || 20000)),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) break;
    body = await res.json();
    out.push(...(body.results || []));
  }
  return out;
}

// Endpoint names are listed on the Colleges page of the documentation. Run
// `npm run probe:ipeds` to confirm which of these respond before relying on them.
export const ENDPOINTS = {
  directory: (year) => `/college-university/ipeds/directory/${year}/`,
  enrollment: (year) => `/college-university/ipeds/fall-enrollment/${year}/`,
  gradRates: (year) => `/college-university/ipeds/grad-rates/${year}/`,
  outcome: (year) => `/college-university/ipeds/outcome-measures/${year}/`,
  ratio: (year) => `/college-university/ipeds/student-faculty-ratio/${year}/`,
};

// Every degree-granting two-year institution, which is the ZogoTech universe.
// institution_level 2 is "at least 2 but less than 4 years".
export async function communityColleges(year, { fips } = {}) {
  return pageAll(ENDPOINTS.directory(year), { institution_level: 2, fips });
}

export async function directoryFor(unitids, year) {
  // The API accepts a comma separated list on filter variables.
  return pageAll(ENDPOINTS.directory(year), { unitid: unitids.join(',') });
}

export async function metricsFor(unitids, year, endpoint = 'gradRates') {
  const build = ENDPOINTS[endpoint];
  if (!build) throw new Error(`Unknown IPEDS endpoint: ${endpoint}`);
  return pageAll(build(year), { unitid: unitids.join(',') });
}

// Reduce whatever the metric endpoint returns into one row per institution.
// Kept separate from fetching so the shape can change without touching callers.
export function summarise(rows) {
  const by = new Map();
  for (const r of rows) {
    const id = r.unitid;
    if (!by.has(id)) by.set(id, { unitid: id, year: r.year, rows: [] });
    by.get(id).rows.push(r);
  }
  return [...by.values()];
}


// ---- Graduation rates ------------------------------------------------------
// The GR component reports many rows per institution (cohort, race, sex), so the
// rate has to be derived. Field names shift between portal releases, so this
// tries the known shapes in order and records which one it used rather than
// silently producing a number nobody can trace.

const RATE_FIELDS = ['grad_rate', 'graduation_rate', 'grad_rate_150'];
const NUM_PAIRS = [
  ['grad_cohort_ct', 'grad_cohort'],
  ['completers_150pct', 'cohort'],
  ['grad_150', 'grad_cohort'],
  ['completers', 'cohort'],
];

export function completionRate(rows) {
  if (!rows || !rows.length) return null;

  // A published rate on any row wins.
  for (const f of RATE_FIELDS) {
    const vals = rows.map((r) => r[f]).filter((v) => typeof v === 'number' && v >= 0);
    if (vals.length) {
      const v = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { rate: v > 1 ? v : v * 100, method: f, rows: vals.length };
    }
  }

  // Otherwise sum completers over cohort across the rows.
  for (const [num, den] of NUM_PAIRS) {
    let n = 0, d = 0, used = 0;
    for (const r of rows) {
      if (typeof r[num] === 'number' && typeof r[den] === 'number' && r[den] > 0) {
        n += r[num]; d += r[den]; used++;
      }
    }
    if (d > 0) return { rate: (n / d) * 100, method: `${num}/${den}`, rows: used };
  }
  return null;
}

// One completion rate per institution, for the unit IDs given.
export async function completionByUnit(unitids, year, endpoint = 'gradRates') {
  // Chunked: 400 comma separated IDs makes a URL long enough for some gateways
  // to reject, and the response is large enough to be worth not holding at once.
  const CHUNK = Number(process.env.IPEDS_CHUNK || 40);
  const rows = [];
  for (let i = 0; i < unitids.length; i += CHUNK) {
    const part = await metricsFor(unitids.slice(i, i + CHUNK), year, endpoint).catch(() => []);
    rows.push(...part);
  }
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.unitid)) by.set(r.unitid, []);
    by.get(r.unitid).push(r);
  }
  const out = [];
  for (const [unitid, rs] of by) {
    const c = completionRate(rs);
    if (c) out.push({ unitid, rate: Math.round(c.rate * 10) / 10, method: c.method, rows: c.rows });
  }
  return out;
}
