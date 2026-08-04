// The refresh. Everything the reports read is produced here and written to
// disk, so a page load never waits on Pipedrive.

import 'dotenv/config';
import { snapshot } from '../lib/pipedrive.js';
import { communityColleges, directoryFor, metricsFor, completionByUnit,
  discoverCompletion, completionByPath, ATTRIBUTION } from '../lib/ipeds.js';
import { reconcile } from '../lib/match.js';
import { ingest } from '../lib/rfp.js';
import { ingest as ingestLeadership } from '../lib/leadership.js';
import { read, write } from '../lib/store.js';

const IPEDS_YEAR = Number(process.env.IPEDS_YEAR || 2022);

// Pipedrive pipeline IDs carry the business type. Override with
// PIPELINE_NEW / PIPELINE_UPSELL if the numbering differs.
const PIPELINE_NAMES = {
  [Number(process.env.PIPELINE_NEW || 2)]: 'New Sales',
  [Number(process.env.PIPELINE_UPSELL || 5)]: 'Upsells',
};

// Pipedrive stores ARR on the deal alongside `value`, which is contract value.
// Anything reported as ARR must come from `arr`, never from `value`.
const money = (d) => ({
  arr: d.arr ?? null,
  acv: d.acv ?? null,
  mrr: d.mrr ?? null,
  tcv: d.value ?? null,
});

// Which pipelines count as new business. Everything else is treated as upsell.
// Set NEW_PIPELINE_IDS in the environment if the split is different.
const NEW_PIPELINES = String(process.env.NEW_PIPELINE_IDS || '2')
  .split(',').map((x) => Number(x.trim())).filter(Boolean);

const dealType = (pid) =>
  pid == null ? 'unknown' : (NEW_PIPELINES.includes(Number(pid)) ? 'new' : 'upsell');

function shapeDeal(d, users) {
  const owner = users.find((u) => u.id === (d.owner_id?.id ?? d.owner_id));
  return {
    id: d.id,
    title: d.title,
    org: d.org_id?.name ?? d.org_name ?? null,
    orgId: d.org_id?.value ?? d.org_id?.id ?? d.org_id ?? null,
    ownerId: d.owner_id?.id ?? d.owner_id ?? null,
    owner: owner?.name ?? null,
    status: d.status,
    stage: d.stage_id?.name ?? d.stage_id ?? null,
    pipelineId: d.pipeline_id?.id ?? d.pipeline_id ?? null,
    pipelineId: d.pipeline_id?.id ?? d.pipeline_id ?? null,
    probability: d.probability ?? null,
    expectedClose: d.expected_close_date ?? null,
    addTime: d.add_time ?? null,
    updateTime: d.update_time ?? null,
    wonTime: d.won_time ?? null,
    lostTime: d.lost_time ?? null,
    lostReason: d.lost_reason ?? null,
    origin: d.origin ?? null,
    dealType: dealType(d.pipeline_id?.id ?? d.pipeline_id),
    ...money(d),
  };
}

export async function refresh({ includeRfp = true, includeIpeds = true } = {}) {
  const started = Date.now();
  const errors = [];

  // ---- Pipedrive -----------------------------------------------------------
  const pd = await snapshot();
  const users = pd.users || [];
  const deals = {
    open: pd.deals.open.map((d) => shapeDeal(d, users)),
    won: pd.deals.won.map((d) => shapeDeal(d, users)),
    lost: pd.deals.lost.map((d) => shapeDeal(d, users)),
  };

  // Latest note per account, deal note winning where one exists. Most notes in
  // this CRM hang off the organisation, so a deal-only rollup misses half of them.
  const notesByOrg = new Map();
  for (const n of pd.notes) {
    const orgId = n.org_id?.value ?? n.org_id;
    if (!orgId) continue;
    const prev = notesByOrg.get(orgId);
    const better = !prev
      || (n.deal_id && !prev.deal_id)
      || (!!n.deal_id === !!prev.deal_id && n.add_time > prev.add_time);
    if (better) notesByOrg.set(orgId, n);
  }

  const nextByDeal = new Map();
  for (const a of pd.activities.upcoming) {
    const id = a.deal_id;
    if (!id) continue;
    const prev = nextByDeal.get(id);
    if (!prev || (a.due_date || '') < (prev.due_date || '')) nextByDeal.set(id, a);
  }

  // Owner per organisation, taken from its open deals. The prospecting reports
  // know an institution but not a rep, and this is the only link between them.
  const orgOwner = new Map();
  for (const d of [...deals.open, ...deals.won, ...deals.lost]) {
    if (d.orgId && d.owner && !orgOwner.has(d.orgId)) {
      orgOwner.set(d.orgId, { ownerId: d.ownerId, owner: d.owner });
    }
  }

  // ---- IPEDS ---------------------------------------------------------------
  let ipeds = { attribution: ATTRIBUTION, year: IPEDS_YEAR, matched: [], review: [], metrics: [] };
  if (includeIpeds) {
    try {
      const universe = await communityColleges(IPEDS_YEAR);
      const orgs = pd.orgs.map((o) => ({ id: o.id, name: o.name }));
      const rec = await reconcile(orgs, universe, {
        sourceName: (o) => o.name,
        targetName: (i) => i.inst_name || i.institution_name || i.name,
      });
      const unitids = rec.matched.map((m) => m.target.unitid).filter(Boolean);
      // Completion rate per institution, so accounts can be ranked by it.
      // Everything below the threshold is a school with the exact problem the
      // product solves, which is the whole point of pulling IPEDS at all.
      const LOW = Number(process.env.IPEDS_LOW_GRAD_RATE || 40);

      // Work out which endpoint and year actually carry usable rates, rather
      // than assuming and reporting zeros when the assumption is wrong.
      const found = await discoverCompletion({ years: [IPEDS_YEAR, 2021, 2020, 2019, 2018] })
        .catch((e) => ({ endpoint: null, error: e.message, tried: [] }));

      const completion = (unitids.length && found.endpoint)
        ? await completionByPath(
            unitids.slice(0, Number(process.env.IPEDS_MAX || 300)),
            found.endpoint, found.year,
          ).catch((e) => { errors.push(`IPEDS completion: ${e.message}`); return []; })
        : [];

      if (!found.endpoint) {
        errors.push('IPEDS: no completion endpoint returned usable rows. See ipeds.discovery.');
      }
      const rateBy = new Map(completion.map((c) => [c.unitid, c]));
      const metrics = completion;
      ipeds = {
        attribution: ATTRIBUTION,
        year: IPEDS_YEAR,
        universe: universe.length,
        lowThreshold: LOW,
        discovery: found,
        completionEndpoint: found.endpoint,
        completionYear: found.year,
        matched: rec.matched.map((m) => {
          const c = rateBy.get(m.target.unitid);
          const own = orgOwner.get(m.source.id) || {};
          return {
            orgId: m.source.id,
            orgName: m.source.name,
            owner: own.owner ?? null,
            unitid: m.target.unitid,
            ipedsName: m.target.inst_name || m.target.institution_name,
            state: m.target.fips ?? null,
            score: m.score,
            gradRate: c ? c.rate : null,
            gradMethod: c ? c.method : null,
            belowThreshold: c ? c.rate < LOW : null,
          };
        }),
        review: rec.review.map((m) => ({
          orgName: m.source.name,
          candidate: m.target?.inst_name || m.target?.institution_name || null,
          score: m.score,
        })),
        metrics,
      };
    } catch (e) {
      errors.push(`IPEDS: ${e.message}`);
    }
  }

  // ---- RFPSchoolWatch ------------------------------------------------------
  let rfp = await read('rfp', { bids: [] });
  if (includeRfp) {
    try {
      const fresh = await ingest({
        days: Number(process.env.RFP_DAYS || 60),
        orgs: pd.orgs.map((o) => ({ id: o.id, name: o.name })),
      });
      // Keep the earliest sighting of a bid we have seen before.
      const prior = new Map((rfp.bids || []).map((b) => [b.docId, b]));
      for (const b of fresh.bids) {
        const own = b.pipedriveOrgId ? orgOwner.get(b.pipedriveOrgId) : null;
        prior.set(b.docId, { ...prior.get(b.docId), ...b, owner: own?.owner ?? null });
      }
      rfp = { ...fresh, bids: [...prior.values()] };
    } catch (e) {
      errors.push(`RFP: ${e.message}`);
    }
  }

  // ---- leadership changes -------------------------------------------------
  let leadership = await read('leadership', { moves: [], sources: [] });
  try {
    const aliases = (await read('aliases', {})) || {};
    delete aliases._comment;
    const fresh = await ingestLeadership({
      orgs: pd.orgs.map((o) => ({ id: o.id, name: o.name, owner: orgOwner.get(o.id)?.owner ?? null })),
    pipelines: [...new Set(pd.stages.map((x) => x.pipeline_id))].filter(Boolean)
      .map((id) => ({ id, name: PIPELINE_NAMES[id] || `Pipeline ${id}` })),
      days: Number(process.env.LEADERSHIP_DAYS || 365),
      aliases,
    });
    // keep anything already seen, so a feed dropping an item does not lose it
    const prior = new Map((leadership.moves || []).map((m) => [m.link || m.title, m]));
    for (const m of fresh.moves) {
      const own = m.orgId ? orgOwner.get(m.orgId) : null;
      prior.set(m.link || m.title, { ...prior.get(m.link || m.title), ...m, owner: own?.owner ?? null });
    }
    leadership = { ...fresh, moves: [...prior.values()] };
  } catch (e) {
    errors.push(`Leadership: ${e.message}`);
  }

  const data = {
    pulledAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    errors,
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email })),
    stages: pd.stages.map((s) => ({ id: s.id, name: s.name, pipelineId: s.pipeline_id })),
    newPipelines: NEW_PIPELINES,
    deals,
    leads: pd.leads,
    orgs: pd.orgs.map((o) => ({ id: o.id, name: o.name })),
    notes: [...notesByOrg.entries()].map(([orgId, n]) => ({
      orgId,
      dealId: n.deal_id ?? null,
      level: n.deal_id ? 'deal' : 'account',
      addTime: n.add_time,
      content: n.content,
    })),
    nextSteps: [...nextByDeal.entries()].map(([dealId, a]) => ({
      dealId, type: a.type, subject: a.subject, dueDate: a.due_date, dueTime: a.due_time,
    })),
    activities: pd.activities.done.map((a) => ({
      id: a.id, dealId: a.deal_id ?? null, orgId: a.org_id ?? null, type: a.type,
      subject: a.subject, doneTime: a.marked_as_done_time, ownerId: a.owner_id,
      note: a.note ?? null,
    })),
    ipeds,
    rfp,
    leadership,
  };

  await write('snapshot', data);
  await write('rfp', rfp);
  await write('leadership', leadership);
  return { pulledAt: data.pulledAt, tookMs: data.tookMs, errors, counts: {
    open: deals.open.length, won: deals.won.length, lost: deals.lost.length,
    leads: (pd.leads || []).length, notes: data.notes.length,
    bids: (rfp.bids || []).length, ipedsMatched: ipeds.matched.length,
    leadershipMoves: (leadership.moves || []).length,
  } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refresh()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
