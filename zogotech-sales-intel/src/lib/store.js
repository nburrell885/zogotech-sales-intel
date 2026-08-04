// Flat JSON files on disk. No database on purpose: the whole dataset is a few
// megabytes, and a folder of JSON moves to ZogoTech infrastructure by copying it.
// Swap this module for Postgres later without touching anything that calls it.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';

async function ensure() {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
}

export async function read(name, fallback = null) {
  try {
    return JSON.parse(await readFile(path.join(DIR, `${name}.json`), 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file and rename, so a crash mid-write cannot leave a
// half-written file that the next read chokes on.
export async function write(name, data) {
  await ensure();
  const dest = path.join(DIR, `${name}.json`);
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, dest);
  return dest;
}

export async function upsertMany(name, rows, key = 'id') {
  const existing = (await read(name, [])) || [];
  const byKey = new Map(existing.map((r) => [r[key], r]));
  let added = 0;
  for (const r of rows) {
    if (!byKey.has(r[key])) added++;
    byKey.set(r[key], { ...byKey.get(r[key]), ...r });
  }
  const merged = [...byKey.values()];
  await write(name, merged);
  return { total: merged.length, added };
}
