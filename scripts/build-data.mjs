import { writeFile, mkdir } from 'node:fs/promises';
import { refreshAccessToken, fetchActivitiesAfter } from './strava.mjs';
import { isWithinRadius } from './geo.mjs';
import { loadEnvLocal } from './load-env.mjs';
import { encryptWithPassword } from './encrypt.mjs';
import {
  WORK_LAT,
  WORK_LNG,
  RADIUS_METERS,
  COMMUTE_TYPES,
  TARGET_SECONDS_PER_DAY,
  FETCH_AFTER_EPOCH,
} from './config.mjs';

const WORK_COORD = [WORK_LAT, WORK_LNG];

function isQualifyingActivity(activity) {
  if (!COMMUTE_TYPES.includes(activity.type)) return false;
  return (
    isWithinRadius(activity.start_latlng, WORK_COORD, RADIUS_METERS) ||
    isWithinRadius(activity.end_latlng, WORK_COORD, RADIUS_METERS)
  );
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function isWeekday(dateString) {
  const day = new Date(`${dateString}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return day >= 1 && day <= 5;
}

function mondayOf(dateString) {
  const d = new Date(`${dateString}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return dateStr(d);
}

// start_date_local strings encode wall-clock local time in UTC-format,
// so getUTCHours()/getUTCMinutes() on a ms timestamp derived from them
// gives the correct local time-of-day.
function fmtTimeOfDay(ms) {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function enumerateDates(fromDateString, toDateString) {
  const dates = [];
  const cur = new Date(`${fromDateString}T00:00:00Z`);
  const end = new Date(`${toDateString}T00:00:00Z`);
  while (cur <= end) {
    dates.push(dateStr(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function main() {
  await loadEnvLocal();

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
  const pagePassword = process.env.PAGE_PASSWORD;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN env vars'
    );
  }
  if (!pagePassword) {
    throw new Error('Missing PAGE_PASSWORD env var');
  }

  const refreshed = await refreshAccessToken(clientId, clientSecret, refreshToken);
  const activities = await fetchActivitiesAfter(refreshed.access_token, FETCH_AFTER_EPOCH);

  const qualifying = activities.filter(isQualifyingActivity);

  const byDate = new Map();
  for (const a of qualifying) {
    const date = a.start_date_local.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(a);
  }
  for (const acts of byDate.values()) {
    acts.sort((x, y) => x.start_date_local.localeCompare(y.start_date_local));
  }

  const fromDate = dateStr(new Date(FETCH_AFTER_EPOCH * 1000));
  const toDate = dateStr(new Date());

  const dayHours = [];
  for (const date of enumerateDates(fromDate, toDate)) {
    if (!isWeekday(date)) continue;

    const acts = byDate.get(date) ?? [];
    let hours;
    let arrival = null;
    let departure = null;
    let amDistance = null;
    let pmDistance = null;
    const commuted = acts.length >= 2;
    if (commuted) {
      const first = acts[0];
      const last = acts[acts.length - 1];
      const firstEnd = new Date(first.start_date_local).getTime() + first.elapsed_time * 1000;
      const lastStart = new Date(last.start_date_local).getTime();
      hours = (lastStart - firstEnd) / 3600000;
      arrival = fmtTimeOfDay(firstEnd);
      departure = fmtTimeOfDay(lastStart);
      amDistance = first.distance;
      pmDistance = last.distance;
    } else {
      hours = TARGET_SECONDS_PER_DAY / 3600;
    }
    dayHours.push({ date, hours, commuted, arrival, departure, amDistance, pmDistance });
  }

  const byWeek = new Map();
  for (const { date, hours, commuted, arrival, departure, amDistance, pmDistance } of dayHours) {
    const weekStart = mondayOf(date);
    if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
    byWeek.get(weekStart).push({
      date,
      hours: Math.round(hours * 100) / 100,
      commuted,
      arrival,
      departure,
      amDistance,
      pmDistance,
    });
  }

  const weeklyHours = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, days]) => ({
      weekStart,
      hours: Math.round(days.reduce((s, d) => s + d.hours, 0) * 100) / 100,
      days,
    }));

  const encrypted = encryptWithPassword(JSON.stringify(weeklyHours), pagePassword);

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../data/weekly-hours.json', import.meta.url),
    JSON.stringify(encrypted, null, 2) + '\n'
  );

  console.log(`Wrote ${weeklyHours.length} weeks (${qualifying.length} qualifying rides of ${activities.length} fetched).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
