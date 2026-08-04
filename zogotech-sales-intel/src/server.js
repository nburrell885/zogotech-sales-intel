import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read } from './lib/store.js';
import { refresh } from './jobs/refresh.js';
import { authClient, SCOPES } from './lib/gmail.js';
import { ENDPOINTS } from './lib/ipeds.js';

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

// ---- IPEDS endpoint check, in the browser ----------------------------------
app.get('/api/probe/ipeds', async (req, res) => {
  const year = Number(req.query.year || process.env.IPEDS_YEAR || 2022);
  const ms = Number(req.query.timeout || 12000);

  // In parallel with a hard timeout each. Sequentially and unbounded, one slow
  // endpoint holds the whole page until the gateway gives up.
  const probe = async ([name, build]) => {
    const url = `https://educationdata.urban.org/api/v1${build(year)}?limit=1`;
    const started = Date.now();
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(ms),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ZogoTech-Sales-Intel/0.1 (+contact: nburrell@zogotech.com)',
        },
      });
      const body = r.ok ? await r.json() : null;
      return {
        name, ok: r.ok, status: r.status, ms: Date.now() - started,
        count: body?.count ?? null,
        fields: body?.results?.[0] ? Object.keys(body.results[0]).slice(0, 10) : [],
      };
    } catch (e) {
      return {
        name, ok: false, ms: Date.now() - started,
        error: e.name === 'TimeoutError' ? `no response within ${ms}ms` : e.message,
      };
    }
  };

  const endpoints = await Promise.all(Object.entries(ENDPOINTS).map(probe));
  res.json({
    year,
    working: endpoints.filter((e) => e.ok).map((e) => e.name),
    failing: endpoints.filter((e) => !e.ok).map((e) => e.name),
    endpoints,
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

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`ZogoTech sales intel listening on ${port}`);

  // Refresh on its own so nobody has to remember to click anything. Kept inside
  // the app rather than as a platform cron, so it moves with the code.
  if (EVERY_MIN > 0) {
    const tick = () => runRefresh()
      .then((r) => console.log('scheduled refresh done', r?.pulledAt ?? ''))
      .catch((e) => console.error('scheduled refresh failed:', e.message));

    const existing = await read('snapshot');
    if (!existing) {
      console.log('no snapshot on disk, pulling one now');
      setTimeout(tick, 5000);          // let the app finish booting first
    } else {
      lastRun = Date.parse(existing.pulledAt) || 0;
    }
    setInterval(tick, EVERY_MIN * 60 * 1000);
    console.log(`auto refresh every ${EVERY_MIN} minutes`);
  }
});
