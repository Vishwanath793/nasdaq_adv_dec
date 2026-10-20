/**
 * File storage under .data/ (gitignored). JSON documents, append-only NDJSON logs,
 * and immutable snapshots (written once; a second write with different content is refused).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const DATA_DIR = path.resolve(process.env.NQ_DATA_DIR ?? path.join(process.cwd(), '.data'));

const full = (rel) => path.join(DATA_DIR, rel);
const ensureDir = (file) => fs.mkdirSync(path.dirname(file), { recursive: true });

export function readJson(rel, fallback = null) {
  try { return JSON.parse(fs.readFileSync(full(rel), 'utf8')); } catch { return fallback; }
}

export function writeJson(rel, value) {
  const file = full(rel);
  ensureDir(file);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function exists(rel) { return fs.existsSync(full(rel)); }

/** Write once. Returns { written:true } or { written:false, reason }. Identical content is a no-op. */
export function writeImmutable(rel, value) {
  const file = full(rel);
  const body = JSON.stringify(value);
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file, 'utf8');
    return prev === body ? { written: false, reason: 'identical snapshot already stored' } : { written: false, reason: 'snapshot already exists and is immutable; store corrections as a separate research version' };
  }
  ensureDir(file);
  fs.writeFileSync(file, body, { flag: 'wx' });
  return { written: true };
}

export function appendNdjson(rel, records) {
  const file = full(rel);
  ensureDir(file);
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) return;
  fs.appendFileSync(file, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function readNdjson(rel) {
  const file = full(rel);
  let text;
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  else if (fs.existsSync(`${file}.gz`)) text = zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8');
  else return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line after a crash is skipped */ }
  }
  return out;
}

export function gzipFile(rel) {
  const file = full(rel);
  if (!fs.existsSync(file)) return false;
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file)));
  fs.unlinkSync(file);
  return true;
}

export function list(relDir) {
  try { return fs.readdirSync(full(relDir)); } catch { return []; }
}

export function sizeOf(relDir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
    }
  };
  try { walk(full(relDir)); } catch { /* missing dir */ }
  return total;
}
