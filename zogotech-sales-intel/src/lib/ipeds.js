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
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`IPEDS ${path} returned ${res.status}`);
  return res.json();
}

// Results are paginated with a `next` URL. Cap the follow count so a bad
// filter cannot walk the entire national dataset.
async function pageAll(path, params = {}, cap = 40) {
  let body = await get(path, params);
  const out = [...(body.results || [])];
  for (let i = 0; i < cap && body.next; i++) {
    const res = await fetch(body.next, { headers: { Accept: 'application/json' } });
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
