import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadEnvLocal } from './load-env.mjs';
import { encryptWithPassword, decryptWithPassword } from './encrypt.mjs';

const CHECKINS_URL = new URL('../data/manual-checkins.json', import.meta.url);

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

  // Last write for a given (date, type) wins, so re-firing a Shortcut
  // (e.g. the automation re-triggers) just overwrites the previous value.
  const next = checkins.filter((c) => !(c.date === date && c.type === type));
  next.push({ date, type, time, recordedAt: new Date().toISOString() });
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
