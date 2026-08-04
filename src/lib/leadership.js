// Leadership changes at community colleges.
//
// There is no single source, so this reads several public feeds and filters them
// down to leadership moves, then matches the institution against Pipedrive.
// A new president is a real buying trigger; KCKCC and Imperial Valley are both
// live examples in the current pipeline.
//
// Feed URLs move. Anything that fails is reported per source rather than taking
// the whole pull down, and /api/probe/feeds shows which are responding.

import { reconcile } from './match.js';

export const FEEDS = [
  { name: 'Higher Ed Dive',        url: 'https://www.highereddive.com/feeds/news/' },
  { name: 'Inside Higher Ed',      url: 'https://www.insidehighered.com/rss/feed/ihe' },
  { name: 'Community College Daily', url: 'https://www.ccdaily.com/feed/' },
  { name: 'ACCT',                  url: 'https://www.acct.org/rss.xml' },
];

// A move is a title plus an event word. Either alone produces noise: "president"
// appears in half of all higher ed headlines.
const TITLES = [
  'president', 'presidential', 'chancellor', 'chancellorship', 'provost',
  'vice president', 'vp of', 'superintendent',
  'chief information officer', 'cio', 'chief academic officer',
  'institutional research', 'institutional effectiveness', 'dean of',
  'chief data officer', 'vice chancellor',
];
// Verb forms matter: "selects" and "selected" are both common in these headlines.
const EVENTS = [
  'name', 'names', 'named', 'naming',
  'appoint', 'appoints', 'appointed', 'appointment',
  'select', 'selects', 'selected', 'selection',
  'pick', 'picks', 'picked', 'choose', 'chooses', 'chosen',
  'hire', 'hires', 'hired', 'welcome', 'welcomes',
  'promote', 'promotes', 'promoted', 'elevate', 'elevates',
  'join', 'joins', 'joining', 'succeed', 'succeeds', 'tapped',
  'takes over', 'takes the helm', 'to lead', 'set to lead',
  'step down', 'steps down', 'stepping down', 'stepped down',
  'resign', 'resigns', 'resigned', 'retire', 'retires', 'retiring', 'retirement',
  'depart', 'departs', 'departing', 'exit', 'exits', 'leaves', 'leaving',
  'new president', 'next president', 'incoming', 'interim', 'search', 'finalists',
];

const word = (k) => new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');

function strip(x = '') {
  return String(x)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : '';
};

// Minimal RSS and Atom parsing. Not worth a dependency for two element shapes.
function parseFeed(xml) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi)
    || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return items.map((b) => {
    let link = tag(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : '';
    }
    return {
      title: tag(b, 'title'),
      link,
      summary: tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'),
      published: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'),
    };
  });
}

export function isLeadershipMove(item) {
  const hay = `${item.title} ${item.summary}`;
  const titles = TITLES.filter((t) => word(t).test(hay));
  const events = EVENTS.filter((e) => word(e).test(hay));
  // The title must be in the headline: a passing mention in the body is noise.
  const inHeadline = TITLES.some((t) => word(t).test(item.title));
  return { titles, events, isMove: inHeadline && events.length > 0 };
}

async function readFeed(feed, ms = 15000) {
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(ms),
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'User-Agent': 'ZogoTech-Sales-Intel/0.1 (+contact: nburrell@zogotech.com)',
      },
    });
    if (!res.ok) return { ...feed, ok: false, error: `HTTP ${res.status}`, items: [] };
    return { ...feed, ok: true, items: parseFeed(await res.text()) };
  } catch (e) {
    return { ...feed, ok: false, error: e.name === 'TimeoutError' ? 'timed out' : e.message, items: [] };
  }
}

export async function ingest({ orgs = [], days = 120, aliases = {} } = {}) {
  const sources = await Promise.all(FEEDS.map((f) => readFeed(f)));
  const cutoff = Date.now() - days * 86400000;
  const seen = new Set();
  const moves = [];

  for (const src of sources) {
    for (const item of src.items) {
      const when = Date.parse(item.published);
      if (when && when < cutoff) continue;
      const key = (item.link || item.title).trim();
      if (!key || seen.has(key)) continue;

      const flag = isLeadershipMove(item);
      if (!flag.isMove) continue;
      seen.add(key);
      moves.push({
        source: src.name,
        title: item.title,
        link: item.link,
        summary: item.summary.slice(0, 400),
        published: when ? new Date(when).toISOString().slice(0, 10) : null,
        titles: flag.titles,
        events: flag.events,
      });
    }
  }

  // Match the headline against account names. The institution is almost always
  // named in the headline, so scoring the headline against each account works.
  const { matched, review } = await reconcile(moves, orgs, {
    sourceName: (m) => m.title,
    targetName: (o) => o.name,
    aliases,
    accept: 0.5,      // a headline carries a lot of other words
    consider: 0.3,
  });
  const hit = new Map(matched.map((m) => [m.source.title, m]));
  const maybe = new Map(review.map((m) => [m.source.title, m]));

  return {
    pulledAt: new Date().toISOString(),
    sources: sources.map((s) => ({ name: s.name, ok: s.ok, error: s.error || null, items: s.items.length })),
    moves: moves
      .map((m) => {
        const h = hit.get(m.title), q = maybe.get(m.title);
        return {
          ...m,
          orgId: h?.target?.id ?? null,
          orgName: h?.target?.name ?? null,
          candidate: q?.target?.name ?? null,
          matchScore: h?.score ?? q?.score ?? 0,
        };
      })
      .sort((a, b) => (b.orgId ? 1 : 0) - (a.orgId ? 1 : 0) || (b.published || '').localeCompare(a.published || '')),
  };
}
