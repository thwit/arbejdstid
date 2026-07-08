import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadEnvLocal } from './load-env.mjs';
import { encryptWithPassword, decryptWithPassword } from './encrypt.mjs';

const CHECKINS_URL = new URL('../data/manual-checkins.json', import.meta.url);

// If the Shortcut re-fires within this many minutes of the last trigger for
// the day, treat it as GPS jitter (either the same geofence event firing
// twice, or the boundary flickering and misfiring the other automation too)
// and average it into the last trigger rather than recording it as a
// separate leg.
const JITTER_WINDOW_MINUTES = 10;

function toMinutes(time) {
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
}

function toTimeStr(minutes) {
  const rounded = Math.round(minutes);
  const hh = String(Math.floor(rounded / 60)).padStart(2, '0');
  const mm = String(rounded % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function loadCheckins(pagePassword) {
  let raw;
  try {
    raw = await readFile(CHECKINS_URL, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const payload = JSON.parse(raw);
  return JSON.parse(decryptWithPassword(payload, pagePassword));
}

async function main() {
  await loadEnvLocal();

  const pagePassword = process.env.PAGE_PASSWORD;
  const date = process.env.CHECKIN_DATE;
  const type = process.env.CHECKIN_TYPE;
  const time = process.env.CHECKIN_TIME;

  if (!pagePassword) throw new Error('Missing PAGE_PASSWORD env var');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error(`Invalid CHECKIN_DATE: ${date}`);
  if (type !== 'arrival' && type !== 'departure') throw new Error(`Invalid CHECKIN_TYPE: ${type}`);
  if (!/^\d{2}:\d{2}$/.test(time ?? '')) throw new Error(`Invalid CHECKIN_TIME: ${time}`);

  const checkins = await loadCheckins(pagePassword);

  // A day can have more than one arrival/departure pair (e.g. leaving for a
  // long lunch or an off-site appointment and coming back), so check-ins
  // aren't deduped by (date, type) anymore — they form a chronological
  // sequence of legs that should alternate arrival, departure, arrival, ...
  //
  // A new trigger is compared against the *last* logged leg for the day:
  //  - different type from the last leg -> a genuine new leg, append it.
  //  - same type, within the jitter window -> GPS jitter, average it into
  //    the last leg instead of recording a separate one.
  //  - same type, well outside the jitter window -> breaks the expected
  //    alternation (e.g. geofence noise from the *other* automation firing
  //    near a genuine event of the opposite type) and is ignored.
  const dayLegs = checkins
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.date === date)
    .sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  const last = dayLegs[dayLegs.length - 1] ?? null;

  let next;
  if (last && last.type === type) {
    const diff = Math.abs(toMinutes(time) - toMinutes(last.time));
    if (diff > JITTER_WINDOW_MINUTES) {
      console.log(
        `Ignoring ${type} at ${time} on ${date}: last leg that day was already ${last.type} at ${last.time}, more than ${JITTER_WINDOW_MINUTES} minutes ago.`
      );
      return;
    }
    const existingSamples = last.samples ?? 1;
    const avgMinutes =
      (toMinutes(last.time) * existingSamples + toMinutes(time)) / (existingSamples + 1);
    const merged = {
      date,
      type,
      time: toTimeStr(avgMinutes),
      samples: existingSamples + 1,
      recordedAt: new Date().toISOString(),
    };
    next = checkins.map((c, index) => (index === last.index ? merged : c));
    console.log(`Merged jittered ${type} at ${time} on ${date} into ${merged.time}.`);
  } else {
    next = [
      ...checkins,
      { date, type, time, samples: 1, recordedAt: new Date().toISOString() },
    ];
    console.log(`Recorded ${type} at ${time} on ${date}.`);
  }

  next.sort((a, b) => a.date.localeCompare(b.date) || toMinutes(a.time) - toMinutes(b.time));

  const encrypted = encryptWithPassword(JSON.stringify(next), pagePassword);
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(CHECKINS_URL, JSON.stringify(encrypted, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
