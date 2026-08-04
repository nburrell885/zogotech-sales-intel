import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read } from './lib/store.js';
import { refresh } from './jobs/refresh.js';
import { authClient, SCOPES } from './lib/gmail.js';
import { ENDPOINTS } from './lib/ipeds.js';
import { reviewBatch } from './lib/plans.js';
import { FEEDS, isLeadershipMove } from './lib/leadership.js';
import { write } from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
// The landing page is the sales dashboard, not an index. Redirecting rather
// than serving it at / keeps one canonical URL per report.
app.get('/', (_req, res) => res.redirect(302, '/sales-dashboard.html'));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, p) {
    // Reports and scripts change on every deploy; never let a browser hold an old copy.
    if (/\.(html|js)$/.test(p)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

let running = null;      // one refresh at a time; a second caller joins the first
let lastRun = 0;         // ms timestamp of the last completed refresh

// How often the app refreshes itself, and how often a person is allowed to
// force one from the page. The team button is rate limited rather than
// token guarded, so anyone can click it and nobody can hammer Pipedrive.
const EVERY_MIN = Number(process.env.REFRESH_EVERY_MINUTES || 60);
const MIN_GAP_MIN = Number(process.env.REFRESH_MIN_GAP_MINUTES || 10);

async function runRefresh(opts = {}) {
  if (!running) {
    running = refresh(opts)
      .then((r) => { lastRun = Date.now(); return r; })
      .finally(() => { running = null; });
  }
  return running;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// What the server can see. Reports presence and length only, never a value.
app.get('/api/config', (_req, res) => {
  const seen = (k) => {
    const v = process.env[k];
    return v ? { set: true, length: String(v).trim().length } : { set: false };
  };
  res.json({
    build: 'browser-oauth-2',      // bump this whenever server.js changes
    pipedrive: { token: seen('PIPEDRIVE_API_TOKEN'), domain: process.env.PIPEDRIVE_DOMAIN || null },
    anthropic: seen('ANTHROPIC_API_KEY'),
    google: {
      clientId: seen('GOOGLE_CLIENT_ID'),
      clientSecret: seen('GOOGLE_CLIENT_SECRET'),
      refreshToken: seen('GOOGLE_REFRESH_TOKEN'),
      user: process.env.GMAIL_USER || null,
      label: process.env.GMAIL_LABEL || null,
    },
    refreshToken: seen('REFRESH_TOKEN'),
    dataDir: process.env.DATA_DIR || './data',
  });
});

// Everything the reports read.
app.get('/api/data', async (_req, res) => {
  const data = await read('snapshot');
  if (!data) return res.status(404).json({ error: 'No snapshot yet. Run a refresh.' });
  res.json(data);
});

// Just the freshness, for the refresh button to poll cheaply.
app.get('/api/status', async (_req, res) => {
  const data = await read('snapshot');
  res.json({
    pulledAt: data?.pulledAt ?? null,
    refreshing: !!running,
    autoRefreshMinutes: EVERY_MIN,
    minGapMinutes: MIN_GAP_MIN,
    pipedriveConfigured: !!process.env.PIPEDRIVE_API_TOKEN,
    googleConfigured: !!process.env.GOOGLE_REFRESH_TOKEN,
    counts: data ? {
      open: data.deals.open.length,
      won: data.deals.won.length,
      lost: data.deals.lost.length,
      bids: data.rfp?.bids?.length ?? 0,
    } : null,
    errors: data?.errors ?? [],
  });
});

// The refresh button. Guarded by a shared token so a public URL cannot be used
// to hammer Pipedrive from outside.
app.post('/api/refresh', async (req, res) => {
  const clean = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '');
  const expected = clean(process.env.REFRESH_TOKEN);
  const given = clean(req.get('x-refresh-token') || req.body?.token);
  const force = req.query.force === '1' || req.body?.force === true;

  // Forcing past the rate limit is the only thing that needs the token.
  if (force && expected && given !== expected) {
    return res.status(401).json({ error: 'Bad refresh token', hint: 'Forcing a refresh needs the token.' });
  }

  const sinceMin = (Date.now() - lastRun) / 60000;
  if (!force && lastRun && sinceMin < MIN_GAP_MIN) {
    const data = await read('snapshot');
    return res.json({
      skipped: true,
      reason: `Data was refreshed ${Math.round(sinceMin)} minute(s) ago. ` +
              `It refreshes on its own every ${EVERY_MIN} minutes.`,
      pulledAt: data?.pulledAt ?? null,
      nextAllowedInMinutes: Math.ceil(MIN_GAP_MIN - sinceMin),
    });
  }

  try {
    res.json(await runRefresh(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Strategic plan review ------------------------------------------------
// A batch of 20 takes 10 to 30 minutes, so it runs in the background and the
// page polls. Results are written after each school, not at the end.
let planRun = null;

app.get('/api/plans', async (_req, res) => {
  const data = await read('plans', { results: [], total: 0, startedAt: null });
  res.json({ ...data, running: !!planRun });
});

app.post('/api/plans', async (req, res) => {
  if (planRun) return res.status(409).json({ error: 'A review is already running.' });

  const schools = (req.body?.schools || [])
    .map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  if (!schools.length) return res.status(400).json({ error: 'No schools given.' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set in Railway.' });
  }

  await write('plans', { results: [], total: schools.length, startedAt: new Date().toISOString() });

  planRun = reviewBatch(schools, async (results, total) => {
    await write('plans', { results, total, startedAt: new Date().toISOString() });
  }).then(async (results) => {
    await write('plans', {
      results, total: schools.length,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });
  }).catch((e) => console.error('plan review failed:', e.message))
    .finally(() => { planRun = null; });

  res.json({ started: true, total: schools.length });
});

// Accounts the app already knows about, for the school picker.
app.get('/api/accounts', async (_req, res) => {
  const data = await read('snapshot');
  const open = data?.deals?.open || [];
  const seen = new Map();
  for (const d of open) if (d.org && !seen.has(d.org)) seen.set(d.org, { name: d.org, arr: d.arr });
  res.json({ accounts: [...seen.values()].sort((a, b) => (b.arr || 0) - (a.arr || 0)) });
});

// ---- Google consent, done in the browser -----------------------------------
// The OAuth dance normally needs a local script. These two routes do it from the
// deployed app instead, so nothing has to be run from a terminal.
const redirectUri = (req) =>
  `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}/oauth2callback`;

app.get('/auth/google', (req, res) => {
  try {
    const oauth = authClient(redirectUri(req));
    res.redirect(oauth.generateAuthUrl({
      access_type: 'offline', prompt: 'consent', scope: SCOPES,
    }));
  } catch (e) {
    res.status(500).send(page('Not configured', `<p>${e.message}</p>
      <p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway first, then come back.</p>`));
  }
});

app.get('/oauth2callback', async (req, res) => {
  if (req.query.error) return res.status(400).send(page('Refused', `<p>${req.query.error}</p>`));
  try {
    const oauth = authClient(redirectUri(req));
    const { tokens } = await oauth.getToken(req.query.code);
    if (!tokens.refresh_token) {
      return res.send(page('No refresh token returned', `<p>Google only issues one on the first
        approval. Revoke this app at <a href="https://myaccount.google.com/permissions">Google
        account permissions</a>, then visit /auth/google again.</p>`));
    }
    res.send(page('Copy this into Railway', `
      <p>Add it as a variable named <b>GOOGLE_REFRESH_TOKEN</b>, then redeploy.</p>
      <textarea readonly onclick="this.select()">${tokens.refresh_token}</textarea>
      <p class="warn">Shown once. Copy it now.</p>`));
  } catch (e) {
    res.status(500).send(page('Exchange failed', `<p>${e.message}</p>`));
  }
});

// ---- feed check, in the browser -------------------------------------------
app.get('/api/probe/feeds', async (_req, res) => {
  const run = async (f) => {
    const started = Date.now();
    try {
      const r = await fetch(f.url, {
        signal: AbortSignal.timeout(12000),
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*',
          'User-Agent': 'ZogoTech-Sales-Intel/0.1 (+contact: nburrell@zogotech.com)' },
      });
      const body = r.ok ? await r.text() : '';
      const items = (body.match(/<item[\s>]/gi) || body.match(/<entry[\s>]/gi) || []).length;
      return { name: f.name, url: f.url, ok: r.ok, status: r.status, items, ms: Date.now() - started };
    } catch (e) {
      return { name: f.name, url: f.url, ok: false, ms: Date.now() - started,
        error: e.name === 'TimeoutError' ? 'timed out' : e.message };
    }
  };
  const out = [];
  for (let i = 0; i < FEEDS.length; i += 4) {
    out.push(...await Promise.all(FEEDS.slice(i, i + 4).map(run)));
  }
  res.json({
    totalItems: out.reduce((a, f) => a + (f.items || 0), 0),
    working: out.filter((f) => f.ok && f.items).length + ' of ' + out.length,
    dead: out.filter((f) => !f.ok || !f.items).map((f) => f.name),
    feeds: out,
  });
});

// ---- IPEDS endpoint check, in the browser ----------------------------------
app.get('/api/probe/ipeds', async (req, res) => {
  // Probe the way the app actually queries: filtered by unit ID. Unfiltered,
  // these are national tables and the row count alone times out, which says
  // nothing about whether the endpoint works.
  const years = String(req.query.years || '2022,2021,2020,2019').split(',').map(Number);
  const unitid = String(req.query.unitid || '100654');   // Alabama A&M, always present
  const ms = Number(req.query.timeout || 25000);

  const CANDIDATES = {
    ...ENDPOINTS,
    completers: (y) => `/college-university/ipeds/completers/${y}/`,
    gradRates200: (y) => `/college-university/ipeds/grad-rates-200pct/${y}/`,
    outcomeMeasures: (y) => `/college-university/ipeds/outcome-measures/${y}/`,
  };

  const hit = async (name, build, year) => {
    const url = `https://educationdata.urban.org/api/v1${build(year)}?unitid=${unitid}`;
    const started = Date.now();
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(ms),
        headers: { Accept: 'application/json',
          'User-Agent': 'ZogoTech-Sales-Intel/0.1 (+contact: nburrell@zogotech.com)' },
      });
      if (!r.ok) return { name, year, ok: false, status: r.status, ms: Date.now() - started };
      const b = await r.json();
      const rows = b.results || [];
      return {
        name, year, ok: rows.length > 0, status: r.status, ms: Date.now() - started,
        rows: rows.length,
        fields: rows[0] ? Object.keys(rows[0]) : [],
      };
    } catch (e) {
      return { name, year, ok: false, ms: Date.now() - started,
        error: e.name === 'TimeoutError' ? `no response within ${ms}ms` : e.message };
    }
  };

  const jobs = [];
  for (const [name, build] of Object.entries(CANDIDATES)) {
    for (const y of years) jobs.push(hit(name, build, y));
  }
  const all = await Promise.all(jobs);

  // For each endpoint, the most recent year that actually returned rows.
  const best = {};
  for (const r of all) {
    if (!r.ok) continue;
    if (!best[r.name] || r.year > best[r.name].year) best[r.name] = r;
  }

  res.json({
    unitid,
    usable: Object.values(best).map((r) => ({ endpoint: r.name, year: r.year, fields: r.fields })),
    unusable: Object.keys(CANDIDATES).filter((n) => !best[n]),
    detail: all,
  });
});

function page(title, body) {
  return `<!DOCTYPE html><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:0 20px;
  color:#0F2438;line-height:1.6}h1{font-size:24px;color:#123B63}
  textarea{width:100%;height:110px;font-family:ui-monospace,monospace;font-size:12px;
  padding:12px;border:1px solid #DCE7F1;border-radius:10px;background:#FBFCFE}
  .warn{color:#D66A16;font-weight:600}a{color:#1D5488}</style>
  <h1>${title}</h1>${body}`;
}

// A background job must never take the site down. Node exits on an unhandled
// rejection by default, so a failure inside a scheduled refresh would kill the
// process and every report with it.
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection (ignored, site stays up):', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception (ignored, site stays up):', err?.message || err);
});

const port = Number(process.env.PORT || 3000);

// Bind explicitly to 0.0.0.0. A platform proxy cannot reach a server listening
// only on localhost, which shows up as a 502 with a perfectly healthy container.
app.listen(port, '0.0.0.0', async () => {
  console.log(`ZogoTech sales intel listening on 0.0.0.0:${port}`);
  console.log(`PORT env: ${process.env.PORT || '(not set, defaulted to 3000)'}`);
  console.log(`DATA_DIR: ${process.env.DATA_DIR || './data'}`);

  // Refresh on its own so nobody has to remember to click anything. Kept inside
  // the app rather than as a platform cron, so it moves with the code.
  if (EVERY_MIN > 0) {
    const tick = () => runRefresh()
      .then((r) => console.log('scheduled refresh done', r?.pulledAt ?? ''))
      .catch((e) => console.error('scheduled refresh failed:', e.message));

    const existing = await read('snapshot');
    if (!existing) {
      // Wait properly before the first pull. A heavy refresh seconds after boot
      // competes with the platform's own health checks and can look like a dead app.
      const delay = Number(process.env.REFRESH_BOOT_DELAY_MS || 45000);
      console.log(`no snapshot on disk; first pull in ${Math.round(delay / 1000)}s`);
      setTimeout(tick, delay);
    } else {
      lastRun = Date.parse(existing.pulledAt) || 0;
      console.log(`snapshot on disk from ${existing.pulledAt}`);
    }
    setInterval(tick, EVERY_MIN * 60 * 1000);
    console.log(`auto refresh every ${EVERY_MIN} minutes`);
  }
});
