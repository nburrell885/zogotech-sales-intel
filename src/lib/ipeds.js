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
    signal: AbortSignal.timeout(Number(process.env.IPEDS_TIMEOUT_MS || 45000)),
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
      signal: AbortSignal.timeout(Number(process.env.IPEDS_TIMEOUT_MS || 45000)),
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
// The portal's column names are not published anywhere reachable and shift
// between releases, so nothing here is hardcoded to a field name. The shape is
// inspected at runtime and every decision is recorded, so a wrong answer can be
// traced instead of appearing as a silent zero.
//
// Three things have to be right, and getting any of them wrong yields nonsense:
//   1. Use the "all students" total row, not the race and sex breakdowns, which
//      the total already contains.
//   2. Use one cohort window. IPEDS reports completion at 100%, 150% and 200%
//      of normal time; averaging across them is meaningless.
//   3. Divide completers by the adjusted cohort, not by anything else numeric.

const ALL = 99;

// Value meaning "all" on a disaggregating column, whatever it is called.
const isAll = (v) => v === ALL || v === '99' || v === 99 || v == null;

function classify(rows) {
  const keys = Object.keys(rows[0] || {});
  const numeric = keys.filter((k) => rows.some((r) => typeof r[k] === 'number'));

  // Columns that split the data rather than measure it.
  const groupKeys = keys.filter((k) => /^(race|sex|ftpt|gender|ethnicity)$/i.test(k));

  // The cohort window: 100 / 150 / 200 percent, or a year count.
  const windowKey = keys.find((k) => /(cohort_years|years_to|pct_time|time_pct|percent_time|cohort_pct)/i.test(k))
    || keys.find((k) => /^(cohort|level_of_study)$/i.test(k) && !numeric.includes(k));

  // A published rate beats computing one.
  const rateKey = numeric.find((k) => /rate/i.test(k) && !/(cohort|count|_ct)$/i.test(k));

  // Denominator: the cohort. Numerator: the completers.
  const denKey = numeric.find((k) => /cohort/i.test(k)
    && !/(_ct$|_count$|completers|pct|rate|years)/i.test(k));
  const numKey = numeric.find((k) => /(completers|completions|_ct$|grad_150|graduates)/i.test(k));

  return { keys, numeric, groupKeys, windowKey, rateKey, denKey, numKey };
}

// Prefer the total row; fall back to everything if the data is not split.
function totals(rows, groupKeys) {
  if (!groupKeys.length) return rows;
  const t = rows.filter((r) => groupKeys.every((k) => isAll(r[k])));
  return t.length ? t : rows;
}

// Prefer 150% of normal time, which is the Student Right-to-Know standard.
// For a two-year college that is three years.
function oneWindow(rows, windowKey) {
  if (!windowKey) return { rows, window: null };
  const vals = [...new Set(rows.map((r) => r[windowKey]))];
  if (vals.length <= 1) return { rows, window: vals[0] ?? null };
  const prefer = [150, '150', 3, '3', 6, '6', 4, '4', 200, '200', 100, '100'];
  for (const p of prefer) {
    if (vals.includes(p)) return { rows: rows.filter((r) => r[windowKey] === p), window: p };
  }
  const pick = vals[0];
  return { rows: rows.filter((r) => r[windowKey] === pick), window: pick };
}

export function graduationRate(rows) {
  if (!rows || !rows.length) return null;
  const f = classify(rows);
  const t = totals(rows, f.groupKeys);
  const w = oneWindow(t, f.windowKey);
  const use = w.rows;
  if (!use.length) return null;

  const diag = {
    window: w.window, windowKey: f.windowKey,
    groupedBy: f.groupKeys, rowsUsed: use.length, rowsSeen: rows.length,
  };

  if (f.rateKey) {
    const vals = use.map((r) => r[f.rateKey]).filter((v) => typeof v === 'number' && v >= 0);
    if (vals.length) {
      const v = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { rate: v > 1 ? v : v * 100, method: f.rateKey, ...diag };
    }
  }

  if (f.numKey && f.denKey) {
    let n = 0, d = 0;
    for (const r of use) {
      if (typeof r[f.numKey] === 'number' && typeof r[f.denKey] === 'number' && r[f.denKey] > 0) {
        n += r[f.numKey]; d += r[f.denKey];
      }
    }
    if (d > 0) return { rate: (n / d) * 100, method: `${f.numKey}/${f.denKey}`, ...diag };
  }

  // Nothing usable: hand back what was seen so it can be reported, not swallowed.
  return { rate: null, method: null, fields: f.keys, numeric: f.numeric, ...diag };
}

export const completionRate = graduationRate;

export async function completionByUnit(unitids, year, endpoint = 'gradRates') {
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
    const c = graduationRate(rs);
    if (c && c.rate != null) {
      out.push({ unitid, rate: Math.round(c.rate * 10) / 10, method: c.method, window: c.window });
    }
  }
  return out;
}

// ---- Endpoint discovery ----------------------------------------------------
// Endpoint names and the newest year carrying data both shift between portal
// releases, and guessing wrong produces an empty report that looks like a bug.
// Probe a single institution across the candidates and use whatever answers.

const COMPLETION_CANDIDATES = [
  'grad-rates', 'grad-rates-200pct', 'completers', 'outcome-measures',
];

export async function discoverCompletion({
  unitid = 100654,
  years = [2022, 2021, 2020, 2019, 2018],
  ms = 30000,
} = {}) {
  const tried = [];
  for (const endpoint of COMPLETION_CANDIDATES) {
    for (const year of years) {
      const url = `${BASE}/college-university/ipeds/${endpoint}/${year}/?unitid=${unitid}`;
      try {
        const r = await fetch(url, {
          signal: AbortSignal.timeout(ms),
          headers: { Accept: 'application/json',
            'User-Agent': 'ZogoTech-Sales-Intel/0.1 (+contact: nburrell@zogotech.com)' },
        });
        if (!r.ok) { tried.push({ endpoint, year, status: r.status }); continue; }
        const body = await r.json();
        const rows = body.results || [];
        if (!rows.length) { tried.push({ endpoint, year, rows: 0 }); continue; }
        // Only useful if a rate can actually be derived from these rows.
        const c = graduationRate(rows);
        const ok = !!(c && c.rate != null);
        tried.push({
          endpoint, year, rows: rows.length, usable: ok,
          method: c?.method || null,
          numericFields: c?.numericFields || null,
        });
        if (ok) return { endpoint, year, method: c.method, fields: Object.keys(rows[0]), tried };
      } catch (e) {
        tried.push({ endpoint, year, error: e.name === 'TimeoutError' ? 'timeout' : e.message });
      }
    }
  }
  return { endpoint: null, year: null, tried };
}

// Same as completionByUnit but against a discovered endpoint path.
export async function completionByPath(unitids, endpoint, year) {
  const CHUNK = Number(process.env.IPEDS_CHUNK || 40);
  const rows = [];
  for (let i = 0; i < unitids.length; i += CHUNK) {
    const part = await pageAll(
      `/college-university/ipeds/${endpoint}/${year}/`,
      { unitid: unitids.slice(i, i + CHUNK).join(',') },
    ).catch(() => []);
    rows.push(...part);
  }
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.unitid)) by.set(r.unitid, []);
    by.get(r.unitid).push(r);
  }
  const out = [];
  for (const [unitid, rs] of by) {
    const c = graduationRate(rs);
    if (c && c.rate != null) out.push({ unitid, rate: Math.round(c.rate * 10) / 10, method: c.method, rows: c.rows });
  }
  return out;
}
