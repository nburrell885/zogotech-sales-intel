// Pipedrive REST client.
//
// Deliberately uses the REST API rather than the MCP connector: the connector
// cannot reach leads or field definitions, and it is built for an interactive
// session rather than a scheduled refresh.

const BASE = 'https://api.pipedrive.com';

function requireToken() {
  const t = process.env.PIPEDRIVE_API_TOKEN;
  if (!t) throw new Error('PIPEDRIVE_API_TOKEN is not set');
  return t;
}

async function call(path, params = {}, { version = 'v2' } = {}) {
  const url = new URL(`${BASE}/api/${version}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('api_token', requireToken());

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) {
    // Pipedrive rate limits per token. Back off once rather than failing the run.
    const wait = Number(res.headers.get('retry-after') || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return call(path, params, { version });
  }
  if (!res.ok) {
    throw new Error(`Pipedrive ${version}${path} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// v2 endpoints page with an opaque cursor; v1 endpoints page with start/limit.
async function pageAll(path, params = {}, { version = 'v2', limit = 500, cap = 20 } = {}) {
  const out = [];
  if (version === 'v2') {
    let cursor;
    for (let i = 0; i < cap; i++) {
      const body = await call(path, { ...params, limit, cursor }, { version });
      out.push(...(body.data || []));
      cursor = body.additional_data?.next_cursor;
      if (!cursor) break;
    }
  } else {
    for (let i = 0; i < cap; i++) {
      const body = await call(path, { ...params, limit, start: i * limit }, { version });
      out.push(...(body.data || []));
      if (!body.additional_data?.pagination?.more_items_in_collection) break;
    }
  }
  return out;
}

export const pipedrive = {
  // Deals carry `arr`, `acv` and `mrr` alongside `value`. `value` is contract
  // value and runs roughly three times ARR, which is the whole reason these
  // reports exist. Never total on `value` and call it ARR.
  deals: (status) => pageAll('/deals', { status, sort_by: 'update_time', sort_direction: 'desc' }),

  activities: (params = {}) => pageAll('/activities', params),

  // Notes are v1 only, and most of them hang off the organisation rather than
  // the deal, so always pull the lot and roll up rather than filtering by deal.
  notes: () => pageAll('/notes', { sort: 'add_time DESC' }, { version: 'v1', limit: 100 }),

  organizations: () => pageAll('/organizations'),

  // Leads are not exposed by the MCP connector but are available here, which
  // removes the manual CSV export step entirely.
  leads: () => pageAll('/leads', {}, { version: 'v1', limit: 100 }),

  stages: () => pageAll('/stages'),

  users: () => pageAll('/users', {}, { version: 'v1', limit: 100 }),
};

// Pull everything a refresh needs, in parallel where the API allows it.
export async function snapshot() {
  const [open, won, lost, notes, orgs, stages, users, leads] = await Promise.all([
    pipedrive.deals('open'),
    pipedrive.deals('won'),
    pipedrive.deals('lost'),
    pipedrive.notes(),
    pipedrive.organizations(),
    pipedrive.stages(),
    pipedrive.users(),
    pipedrive.leads().catch(() => []), // leads can be disabled per account
  ]);

  const activities = await pipedrive.activities({ done: true, limit: 500 });
  const upcoming = await pipedrive.activities({ done: false, limit: 500 });

  return {
    pulledAt: new Date().toISOString(),
    deals: { open, won, lost },
    activities: { done: activities, upcoming },
    notes,
    orgs,
    stages,
    users,
    leads,
  };
}
