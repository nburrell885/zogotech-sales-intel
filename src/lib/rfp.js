// RFPSchoolWatch ingestion.
//
// The daily alert carries a CSV attachment with a proper 13 column schema, so
// there is nothing to scrape. The PDF and the HTML body are the same data
// formatted for people; both are ignored.

import { parse } from 'csv-parse/sync';
import { listMessages, csvAttachments } from './gmail.js';
import { reconcile } from './match.js';
import { read } from './store.js';

const COLUMNS = {
  'Doc ID': 'docId',
  'Title': 'title',
  'Bid URL': 'bidUrl',
  'Document URL': 'documentUrl',
  'Bid Documents': 'documentsLink',
  'Publish Date': 'publishDate',
  'Pre-bid Date': 'preBidDate',
  'Due Date': 'dueDate',
  'Memo': 'memo',
  'Bid Type': 'bidType',
  'Institution': 'institution',
  'State': 'state',
  'Market Sectors': 'sectors',
};

// Words that make a bid worth a human opening it. Tune freely; this is the
// only place relevance is decided.
const KEYWORDS = [
  'analytic', 'data warehouse', 'business intelligence', 'dashboard',
  'institutional research', 'student success', 'retention', 'completion',
  'reporting', 'enrollment management', 'predictive', 'sis', 'ellucian',
  'banner', 'colleague', 'workday student', 'data governance',
  'institutional effectiveness', 'data platform', 'etl', 'warehouse',
];

const usDate = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};

export function parseCsv(text) {
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  return rows.map((r) => {
    const out = {};
    for (const [from, to] of Object.entries(COLUMNS)) out[to] = r[from] ?? '';
    out.publishDate = usDate(out.publishDate);
    out.dueDate = usDate(out.dueDate);
    out.preBidDate = usDate(out.preBidDate);
    return out;
  });
}

// Substring matching is not safe here: "sis" appears inside "assist", which is
// in the boilerplate footer of every single alert. Match on word boundaries,
// and score the title far above the memo since the memo is mostly boilerplate.
const BOILERPLATE = /bid support help desk|rfpschoolwatch\.com|update your account/gi;

const boundary = (k) =>
  new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');

export function scoreBid(bid) {
  const title = String(bid.title || '');
  const sectors = String(bid.sectors || '');
  const memo = String(bid.memo || '').replace(BOILERPLATE, ' ');

  const hits = KEYWORDS.filter((k) => boundary(k).test(`${title} ${sectors} ${memo}`));
  const titleHits = KEYWORDS.filter((k) => boundary(k).test(title));
  const higherEd = /higher education/i.test(sectors);

  return {
    hits,
    titleHits,
    higherEd,
    // A hit only in the memo is weak evidence; a hit in the title is the signal.
    relevant: higherEd && titleHits.length > 0,
    worthAGlance: higherEd && hits.length > 0,
  };
}

// Pull, parse, dedupe on Doc ID, score, and match the institution against
// Pipedrive organisations. A bid from an account already in the CRM is the
// whole point: it should reach the rep who owns it.
export async function ingest({ days = 60, orgs = [] } = {}) {
  const messages = await listMessages({ days });
  const seen = new Map();
  let attachments = 0;

  for (const m of messages) {
    const { date, files } = await csvAttachments(m.id);
    for (const f of files) {
      attachments++;
      for (const bid of parseCsv(f.text)) {
        if (!bid.docId) continue;
        // Same bid repeats across days; keep the first sighting.
        if (!seen.has(bid.docId)) seen.set(bid.docId, { ...bid, firstSeen: date });
      }
    }
  }

  const bids = [...seen.values()].map((b) => ({ ...b, ...scoreBid(b) }));
  const aliases = (await read('aliases', {})) || {};
  delete aliases._comment;
  const { matched, review } = await reconcile(bids, orgs, {
    sourceName: (b) => b.institution,
    targetName: (o) => o.name,
    aliases,
  });

  const byDoc = new Map(matched.map((m) => [m.source.docId, m]));
  const inReview = new Map(review.map((m) => [m.source.docId, m]));

  return {
    pulledAt: new Date().toISOString(),
    messages: messages.length,
    attachments,
    bids: bids.map((b) => {
      const hit = byDoc.get(b.docId);
      const maybe = inReview.get(b.docId);
      return {
        ...b,
        pipedriveOrgId: hit?.target?.id ?? null,
        pipedriveOrgName: hit?.target?.name ?? null,
        matchScore: hit?.score ?? maybe?.score ?? 0,
        needsReview: !hit && !!maybe,
        reviewCandidate: maybe?.target?.name ?? null,
      };
    }),
  };
}
