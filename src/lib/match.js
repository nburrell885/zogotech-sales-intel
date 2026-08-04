// Matching institution names between three systems that spell them differently:
// Pipedrive ("Tallahassee State College"), RFPSchoolWatch ("State University of
// New York") and IPEDS ("Tallahassee Community College"). Never auto-accept a
// weak match; put it in a review queue instead.

const NOISE = [
  'the', 'a', 'of', 'at', 'and',
  'community', 'college', 'colleges', 'university', 'universities',
  'technical', 'institute', 'state', 'district', 'system', 'office',
  'campus', 'main', 'inc', 'llc',
];

export function normalise(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim();
}

// Distinctive tokens only: what is left once every word that appears on half
// the institutions in the country is removed.
export function tokens(name = '') {
  return normalise(name)
    .split(' ')
    .filter((t) => t.length > 2 && !NOISE.includes(t));
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / (A.size + B.size - hit);
}

// "Northwest Arkansas Community College" -> "nacc". Acronyms are how reps
// actually write these names, and token overlap scores them at zero.
function acronym(name = '') {
  return normalise(name).split(' ').filter(Boolean).map((w) => w[0]).join('');
}

export function score(left, right) {
  const ln = normalise(left), rn = normalise(right);
  if (ln && ln === rn) return 1;

  const lt = tokens(left), rt = tokens(right);

  // One side is an acronym of the other.
  const la = normalise(left).replace(/\s/g, ''), ra = normalise(right).replace(/\s/g, '');
  if ((la.length <= 8 && la === acronym(right)) || (ra.length <= 8 && ra === acronym(left))) {
    return 0.82;   // strong, but land it in review rather than accepting blind
  }

  if (!lt.length || !rt.length) return 0;
  let s = jaccard(lt, rt);
  if (lt.every((t) => rt.includes(t)) || rt.every((t) => lt.includes(t))) s = Math.max(s, 0.9);

  // Guard against over-stripping. "Tallahassee Community College" and
  // "Tallahassee State College" both reduce to one token and would otherwise
  // score a perfect match, which is luck rather than evidence.
  const thin = Math.min(lt.length, rt.length) <= 1;
  if (thin && s >= 0.85) s = 0.8;

  return s;
}

// Returns { matched, review, unmatched }. Anything between the two thresholds
// is surfaced for a human rather than guessed at.
//
// Async and yielding on purpose. Comparing every source against every target is
// O(n x m) and blocks the event loop long enough for a hosting platform to
// decide the app is dead and return 502. Two changes fix that: an inverted token
// index so only plausible candidates are scored, and a yield every so often so
// the web server keeps answering while this runs.
export async function reconcile(sources, targets, {
  sourceName = (x) => x.name,
  targetName = (x) => x.name,
  accept = 0.85,
  consider = 0.55,
  aliases = {},
  yieldEvery = 200,
} = {}) {
  const alias = new Map(
    Object.entries(aliases).map(([k, v]) => [normalise(k), normalise(v)]),
  );

  // token -> indices of targets containing it, plus an exact-name lookup
  const index = new Map();
  const exact = new Map();
  targets.forEach((t, i) => {
    const name = targetName(t);
    exact.set(normalise(name), i);
    for (const tok of new Set(tokens(name))) {
      if (!index.has(tok)) index.set(tok, []);
      index.get(tok).push(i);
    }
  });

  const matched = [], review = [], unmatched = [];
  let seen = 0;

  for (const s of sources) {
    if (++seen % yieldEvery === 0) await new Promise((r) => setImmediate(r));

    const raw = sourceName(s);
    const canonical = alias.get(normalise(raw));

    // An alias is a human decision, so it beats anything the scorer produces.
    if (canonical && exact.has(canonical)) {
      matched.push({ source: s, target: targets[exact.get(canonical)], score: 1 });
      continue;
    }
    const self = exact.get(normalise(raw));
    if (self !== undefined) {
      matched.push({ source: s, target: targets[self], score: 1 });
      continue;
    }

    // Only targets sharing a distinctive token are worth scoring.
    const candidates = new Set();
    for (const tok of new Set(tokens(raw))) {
      for (const i of index.get(tok) || []) candidates.add(i);
    }

    let best = null, bestScore = 0;
    for (const i of candidates) {
      const v = score(raw, targetName(targets[i]));
      if (v > bestScore) { bestScore = v; best = targets[i]; }
    }

    if (bestScore >= accept) matched.push({ source: s, target: best, score: +bestScore.toFixed(3) });
    else if (bestScore >= consider) review.push({ source: s, target: best, score: +bestScore.toFixed(3) });
    else unmatched.push({ source: s, score: +bestScore.toFixed(3) });
  }
  return { matched, review, unmatched };
}
