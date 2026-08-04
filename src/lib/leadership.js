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

// General news feeds carry only the ~10 most recent articles, so a single pull
// sees far too little to find leadership moves reliably. Google News search
// feeds solve that: a targeted query returns a much deeper result set, free and
// without a key. The general feeds stay as a backstop for anything the queries miss.

const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// Three layers, in order of how much we trust them.
//
// 1. The publications themselves, including their leadership sections. These are
//    the sources that matter, but a feed only exposes the ~10 newest items.
// 2. The same publications searched by name, which reaches their archive rather
//    than just today's front page. Same journalism, deeper window.
// 3. Open searches, which catch local papers announcing a hire at a college
//    nobody national has covered. That is often where these stories actually break.

const PUBLICATIONS = [
  { name: 'Higher Ed Dive',            url: 'https://www.highereddive.com/feeds/news/' },
  { name: 'Higher Ed Dive · Leadership', url: 'https://www.highereddive.com/feeds/topic/leadership/' },
  { name: 'Inside Higher Ed',          url: 'https://www.insidehighered.com/rss/feed/ihe' },
  { name: 'Community College Daily',   url: 'https://www.ccdaily.com/feed/' },
  { name: 'CC Daily · Leadership',     url: 'https://www.ccdaily.com/category/leadership/feed/' },
  { name: 'ACCT',                      url: 'https://www.acct.org/rss.xml' },
  { name: 'CC Daily · Governance',     url: 'https://www.ccdaily.com/category/governance/feed/' },
  { name: 'Higher Ed Dive · Policy',   url: 'https://www.highereddive.com/feeds/topic/policy-legal/' },
];

// Named sources, searched by site so we reach their archives.
const SITE_SEARCHES = [
  ['Higher Ed Dive',        'site:highereddive.com'],
  ['Inside Higher Ed',      'site:insidehighered.com'],
  ['Community College Daily','site:ccdaily.com'],
  ['ACCT',                  'site:acct.org'],
  ['Chronicle',             'site:chronicle.com'],
].map(([name, site]) => ({
  name: `${name} · archive`,
  url: gnews(`${site} (president OR provost OR chancellor OR "chief information officer") (named OR appointed OR interim OR retires OR "steps down")`),
  search: true,
}));

// Open searches, for the local coverage the trade press never picks up.
const OPEN_SEARCHES = [
  '"community college" "named president"',
  '"community college" "new president" appointed',
  '"community college" president "steps down" OR retires OR resigns',
  '"community college" "presidential search" finalists',
  '"community college" "interim president"',
  '"community college" provost named OR appointed',
  '"community college" "chief information officer" named OR appointed OR hired',
  '"community college" CIO named OR appointed OR "steps down"',
  '"community college" "chief technology officer" named OR appointed',
  '"community college" "institutional research" director named OR appointed OR hired',
  '"community college" "institutional effectiveness" named OR appointed',
  '"community college" "chief academic officer" named OR appointed',
  '"community college" "vice president of student services" named OR appointed',
  '"technical college" "named president" OR "new president"',
].map((q) => ({ name: `Open search: ${q.slice(0, 40)}`, url: gnews(q), search: true, open: true }));

export const FEEDS = [...PUBLICATIONS, ...SITE_SEARCHES, ...OPEN_SEARCHES];

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
    const rawTitle = tag(b, 'title');
    return {
      // Google News suffixes every headline with " - Publisher"
      title: rawTitle.replace(/\s+-\s+[^-]{2,40}$/, '').trim(),
      publisher: (rawTitle.match(/\s+-\s+([^-]{2,40})$/) || [])[1] || null,
      link,
      summary: tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'),
      published: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'),
    };
  });
}

// Two-year institutions only. A president named at a research university is
// noise here, and the open searches pull plenty of them.
const TWO_YEAR = [
  'community college', 'technical college', 'junior college', 'city college',
  'county college', 'state college', 'technical and community',
  'community and technical', 'ccd', 'community college district',
];

export function isCommunityCollege(item) {
  const hay = `${item.title} ${item.summary}`;
  return TWO_YEAR.some((k) => new RegExp(k.replace(/ /g, '\\s+'), 'i').test(hay));
}

export function isLeadershipMove(item) {
  const hay = `${item.title} ${item.summary}`;
  const titles = TITLES.filter((t) => word(t).test(hay));
  const events = EVENTS.filter((e) => word(e).test(hay));
  // The title must be in the headline: a passing mention in the body is noise.
  const inHeadline = TITLES.some((t) => word(t).test(item.title));
  return {
    titles, events,
    twoYear: isCommunityCollege(item),
    isMove: inHeadline && events.length > 0,
  };
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

export async function ingest({ orgs = [], days = 365, aliases = {} } = {}) {
  // Batched rather than all at once: thirteen simultaneous fetches is enough to
  // trip rate limits and enough concurrency to matter on a small container.
  const sources = [];
  const BATCH = Number(process.env.FEED_BATCH || 4);
  for (let i = 0; i < FEEDS.length; i += BATCH) {
    sources.push(...await Promise.all(FEEDS.slice(i, i + BATCH).map((f) => readFeed(f))));
  }
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
        source: item.publisher || src.name,
        via: src.name,
        layer: src.open ? 'open search' : (src.search ? 'named source archive' : 'publication feed'),
        title: item.title,
        link: item.link,
        summary: item.summary.slice(0, 400),
        published: when ? new Date(when).toISOString().slice(0, 10) : null,
        titles: flag.titles,
        events: flag.events,
        twoYear: flag.twoYear,
        feed: src.name,
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
