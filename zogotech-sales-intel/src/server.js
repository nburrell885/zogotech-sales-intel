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
app.use(express.static(path.join(__dirname, '..', 'public')));

let running = null;   // one refresh at a time; a second caller joins the first

app.get('/api/health', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

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
  const expected = process.env.REFRESH_TOKEN;
  const given = req.get('x-refresh-token') || req.body?.token;
  if (expected && given !== expected) return res.status(401).json({ error: 'Bad refresh token' });

  if (!running) {
    running = refresh(req.body || {}).finally(() => { running = null; });
  }
  try {
    res.json(await running);
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
  const out = [];
  for (const [name, build] of Object.entries(ENDPOINTS)) {
    const url = `https://educationdata.urban.org/api/v1${build(year)}?limit=1`;
    try {
      const r = await fetch(url, { headers: {
        Accept: 'application/json',
        'User-Agent': 'ZogoTech-Sales-Intel/0.1 (+contact: nburrell@zogotech.com)',
      } });
      const body = r.ok ? await r.json() : null;
      out.push({
        name, status: r.status, ok: r.ok,
        fields: body?.results?.[0] ? Object.keys(body.results[0]).slice(0, 10) : [],
      });
    } catch (e) {
      out.push({ name, ok: false, error: e.message });
    }
  }
  res.json({ year, endpoints: out });
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
app.listen(port, () => console.log(`ZogoTech sales intel listening on ${port}`));
