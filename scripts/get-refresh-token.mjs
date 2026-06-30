import http from 'node:http';
import { exchangeCode } from './strava.mjs';
import { loadEnvLocal } from './load-env.mjs';

await loadEnvLocal();

const PORT = 8787;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const clientId = process.env.STRAVA_CLIENT_ID;
const clientSecret = process.env.STRAVA_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET env vars before running this script.');
  process.exit(1);
}

const authorizeUrl = new URL('https://www.strava.com/oauth/authorize');
authorizeUrl.searchParams.set('client_id', clientId);
authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('approval_prompt', 'auto');
authorizeUrl.searchParams.set('scope', 'activity:read_all');

console.log('\nOpen this URL in your browser and authorize the app:\n');
console.log(authorizeUrl.toString());
console.log(`\nWaiting for the OAuth callback on ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Authorization failed. You can close this tab.');
    console.error('Authorization failed:', error ?? 'no code returned');
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const token = await exchangeCode(clientId, clientSecret, code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorized. You can close this tab and return to the terminal.');

    console.log('Success! Save this refresh token as the STRAVA_REFRESH_TOKEN GitHub secret:\n');
    console.log(token.refresh_token);
    console.log();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Token exchange failed. Check the terminal.');
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT);
