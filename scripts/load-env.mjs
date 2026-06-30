import { readFile } from 'node:fs/promises';

export async function loadEnvLocal() {
  let text;
  try {
    text = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return; // no .env.local, nothing to load
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
