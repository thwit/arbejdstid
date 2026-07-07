import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadEnvLocal } from './load-env.mjs';
import { encryptWithPassword, decryptWithPassword } from './encrypt.mjs';

const CHECKINS_URL = new URL('../data/manual-checkins.json', import.meta.url);

// If the Shortcut re-fires for the same (date, type) within this many
// minutes of the previous trigger, treat it as GPS jitter and average the
// times together rather than overwriting.
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

  // GPS jitter can make the Shortcut re-fire the same geofence trigger
  // several times within a few minutes. If the new time is close to the
  // existing one for this (date, type), average them (weighted by how many
  // samples already went into the existing value) instead of overwriting.
  // A trigger well outside the jitter window is a genuine new value and
  // replaces the old one outright.
  const existing = checkins.find((c) => c.date === date && c.type === type);
  const next = checkins.filter((c) => !(c.date === date && c.type === type));

  let mergedTime = time;
  let samples = 1;
  if (existing && Math.abs(toMinutes(time) - toMinutes(existing.time)) <= JITTER_WINDOW_MINUTES) {
    const existingSamples = existing.samples ?? 1;
    const avgMinutes =
      (toMinutes(existing.time) * existingSamples + toMinutes(time)) / (existingSamples + 1);
    mergedTime = toTimeStr(avgMinutes);
    samples = existingSamples + 1;
  }

  next.push({ date, type, time: mergedTime, samples, recordedAt: new Date().toISOString() });
  next.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

  const encrypted = encryptWithPassword(JSON.stringify(next), pagePassword);
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(CHECKINS_URL, JSON.stringify(encrypted, null, 2) + '\n');

  console.log(`Recorded ${type} at ${time} on ${date}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
