// One-time: exchange an OAuth consent for a refresh token, then put that token
// in GOOGLE_REFRESH_TOKEN. Run locally, never on the server.
import 'dotenv/config';
import http from 'node:http';
import { authClient, SCOPES } from '../src/lib/gmail.js';

const oauth = authClient();
const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
console.log('\nOpen this URL, approve, and the token will print here:\n\n' + url + '\n');

http.createServer(async (req, res) => {
  const code = new URL(req.url, 'http://localhost:5555').searchParams.get('code');
  if (!code) { res.end('waiting'); return; }
  const { tokens } = await oauth.getToken(code);
  res.end('Done. You can close this tab.');
  console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
  process.exit(0);
}).listen(5555, () => console.log('Listening on http://localhost:5555/oauth2callback'));
