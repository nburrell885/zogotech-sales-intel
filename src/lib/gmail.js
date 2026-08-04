// Read-only Gmail access, scoped to a single label.
//
// The app can never send, delete, or read anything outside the label. That
// matters because the mailbox belongs to ZogoTech, not to us: register the
// OAuth client in THEIR Google Cloud project so nothing has to be rebuilt at
// handover, and expect their Workspace admin to have to approve it.

import { google } from 'googleapis';

export const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

export function authClient(redirectUri) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set');
  }
  const oauth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
    redirectUri || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5555/oauth2callback',
  );
  if (GOOGLE_REFRESH_TOKEN) oauth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth;
}

function gmail() {
  return google.gmail({ version: 'v1', auth: authClient() });
}

async function labelId(api, name) {
  const { data } = await api.users.labels.list({ userId: 'me' });
  const hit = (data.labels || []).find((l) => l.name === name);
  if (!hit) throw new Error(`Gmail label "${name}" not found on this account`);
  return hit.id;
}

// `days` drives both the one-time backfill and the scheduled run. Backfill is
// the same query with a wider window, not a separate code path.
export async function listMessages({ label = process.env.GMAIL_LABEL, days = 60 } = {}) {
  const api = gmail();
  const id = await labelId(api, label);
  const out = [];
  let pageToken;
  do {
    const { data } = await api.users.messages.list({
      userId: 'me',
      labelIds: [id],
      q: `newer_than:${days}d`,
      maxResults: 100,
      pageToken,
    });
    out.push(...(data.messages || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

// Returns every CSV attachment on a message, decoded to a string.
// The PDF is ignored on purpose: it is the same data formatted for humans.
export async function csvAttachments(messageId) {
  const api = gmail();
  const { data: msg } = await api.users.messages.get({
    userId: 'me', id: messageId, format: 'full',
  });

  const found = [];
  const walk = (part) => {
    if (!part) return;
    const name = part.filename || '';
    if (name.toLowerCase().endsWith('.csv') && part.body?.attachmentId) {
      found.push({ name, attachmentId: part.body.attachmentId });
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);

  const headers = Object.fromEntries(
    (msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
  );

  const files = [];
  for (const f of found) {
    const { data } = await api.users.messages.attachments.get({
      userId: 'me', messageId, id: f.attachmentId,
    });
    files.push({
      name: f.name,
      text: Buffer.from(data.data, 'base64url').toString('utf8'),
    });
  }
  return { messageId, date: headers.date, subject: headers.subject, files };
}
