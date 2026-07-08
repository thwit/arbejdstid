import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { refreshAccessToken, fetchActivitiesAfter } from './strava.mjs';
import { isWithinRadius } from './geo.mjs';
import { loadEnvLocal } from './load-env.mjs';
import { encryptWithPassword, decryptWithPassword } from './encrypt.mjs';
import {
  WORK_LAT,
  WORK_LNG,
  RADIUS_METERS,
  COMMUTE_TYPES,
  TARGET_SECONDS_PER_DAY,
  FETCH_AFTER_EPOCH,
} from './config.mjs';

const WORK_COORD = [WORK_LAT, WORK_LNG];

// Same jitter/alternation tolerance as scripts/record-checkin.mjs, applied
// here when merging Strava-derived legs with manual check-in legs for a day.
const JITTER_WINDOW_MINUTES = 10;

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

function toMinutes(time) {
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
}

// Manual check-ins recorded by the iOS Shortcut (geofence arrive/leave
// automations), for days that aren't fully covered by qualifying Strava
// rides. Keyed by date -> chronological list of { type, time } legs. A day
// can have more than one arrival/departure pair (e.g. a long lunch or an
// off-site appointment).
async function loadManualCheckins(pagePassword) {
  let raw;
  try {
    raw = await readFile(new URL('../data/manual-checkins.json', import.meta.url), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  const payload = JSON.parse(raw);
  const checkins = JSON.parse(decryptWithPassword(payload, pagePassword));

  const byDate = new Map();
  for (const { date, type, time } of checkins) {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ type, time });
  }
  for (const legs of byDate.values()) {
    legs.sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  }
  return byDate;
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

// Each qualifying Strava ride represents one leg of a commute: if it starts
// near work, it's a departure (leaving work); if it ends near work, it's an
// arrival (arriving at work).
function stravaLegsFor(acts) {
  const legs = [];
  for (const act of acts) {
    const start = new Date(act.start_date_local).getTime();
    const end = start + act.elapsed_time * 1000;
    const startsNearWork = isWithinRadius(act.start_latlng, WORK_COORD, RADIUS_METERS);
    if (startsNearWork) {
      legs.push({
        type: 'departure',
        time: fmtTimeOfDay(start),
        biked: true,
        manual: false,
        distance: act.distance,
        activityId: act.id,
      });
    } else {
      legs.push({
        type: 'arrival',
        time: fmtTimeOfDay(end),
        biked: true,
        manual: false,
        distance: act.distance,
        activityId: act.id,
      });
    }
  }
  return legs;
}

function manualLegsFor(events) {
  return events.map(({ type, time }) => ({
    type,
    time,
    biked: false,
    manual: true,
    distance: null,
    activityId: null,
  }));
}

// Merges Strava-derived and manual legs for a day into one chronological,
// alternating (arrival, departure, arrival, ...) sequence. When two legs of
// the same type land within the jitter window (e.g. a Strava ride and a
// Shortcut check-in for the same event), the Strava leg wins since it's the
// more precise source. A same-type leg well outside the jitter window
// breaks the expected alternation and is dropped as noise.
function mergeLegs(stravaLegs, manualLegs) {
  const all = [...stravaLegs, ...manualLegs].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  const merged = [];
  for (const leg of all) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === leg.type) {
      const diff = Math.abs(toMinutes(leg.time) - toMinutes(prev.time));
      if (diff <= JITTER_WINDOW_MINUTES) {
        if (leg.biked && !prev.biked) merged[merged.length - 1] = leg;
        continue;
      }
      continue; // same type, far apart -> alternation violation, ignore
    }
    merged.push(leg);
  }
  return merged;
}

// Pairs up alternating arrival/departure legs into complete work intervals.
// A trailing unmatched arrival (still at work / away and not yet back) is
// left unpaired; the frontend resolves it into a live or assumed interval.
function pairLegs(legs) {
  const pairs = [];
  let openArrival = null;
  for (const leg of legs) {
    if (leg.type === 'arrival') {
      if (openArrival == null) openArrival = leg;
    } else if (openArrival != null) {
      pairs.push({ arrival: openArrival, departure: leg });
      openArrival = null;
    }
  }
  return pairs;
}

function pairsHours(pairs, date) {
  return pairs.reduce((sum, { arrival, departure }) => {
    const arrivalMs = new Date(`${date}T${arrival.time}:00Z`).getTime();
    const departureMs = new Date(`${date}T${departure.time}:00Z`).getTime();
    return sum + (departureMs - arrivalMs) / 3600000;
  }, 0);
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
  const manualByDate = await loadManualCheckins(pagePassword);

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
    const legs = mergeLegs(stravaLegsFor(acts), manualLegsFor(manualByDate.get(date) ?? []));
    const pairs = pairLegs(legs);
    const commuted = pairs.length > 0;
    const hours = commuted ? pairsHours(pairs, date) : TARGET_SECONDS_PER_DAY / 3600;

    dayHours.push({ date, hours, commuted, legs });
  }

  const byWeek = new Map();
  for (const { date, hours, commuted, legs } of dayHours) {
    const weekStart = mondayOf(date);
    if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
    byWeek.get(weekStart).push({
      date,
      hours: Math.round(hours * 100) / 100,
      commuted,
      legs,
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
