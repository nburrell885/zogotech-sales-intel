import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read } from './lib/store.js';
import { refresh } from './jobs/refresh.js';

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

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`ZogoTech sales intel listening on ${port}`));
