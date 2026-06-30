const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';

export async function exchangeCode(clientId, clientSecret, code) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json();
}

export async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  return res.json();
}

export async function fetchActivitiesAfter(accessToken, afterEpoch) {
  const all = [];
  let page = 1;

  while (true) {
    const url = new URL(STRAVA_ACTIVITIES_URL);
    url.searchParams.set('after', String(afterEpoch));
    url.searchParams.set('per_page', '200');
    url.searchParams.set('page', String(page));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Activities fetch failed: ${res.status}`);

    const batch = await res.json();
    if (batch.length === 0) break;

    all.push(...batch);

    if (batch.length < 200) break;
    page++;
  }

  return all;
}
