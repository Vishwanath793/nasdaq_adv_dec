/**
 * Session orchestration and storage for DEMO, REPLAY and recorded LIVE days.
 *
 * Layout (.data/sessions/<id>/):
 *   meta.json                 what produced the session (mode, date, seed or recording)
 *   input.json.gz             assembled day input (LIVE recordings) — DEMO is regenerated from its seed
 *   snapshots/<key>.json      immutable pre-open snapshots (write-once)
 *   confirm.json              immutable 09:35 decision
 *   paper.ndjson / paper.json paper ledger event log and state
 *   outcomes.json             after-the-fact outcomes (research; never read by decisions)
 *   research/<run>/…          replays under other configurations (originals are never overwritten)
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { demoSession, DEMO_DATE } from '../utils/demoSession.js';
import { runSnapshot, runConfirmation, simulatePaper, outcomesFor } from '../utils/pipeline.js';
import { SNAPSHOT_KEYS } from '../utils/clock.js';
import { hashOf } from '../utils/stats.js';
import { readJson, writeJson, writeImmutable, appendNdjson, list, exists, DATA_DIR } from './store.js';

const dayCache = new Map();

export const sessionId = (date, mode, seed = null) => `${date}-${mode}${seed != null ? `-s${seed}` : ''}`;

/** Day input for a session: regenerated (DEMO) or loaded from its recording (LIVE/REPLAY). */
export function loadDayInput(id) {
  if (dayCache.has(id)) return dayCache.get(id);
  const meta = readJson(`sessions/${id}/meta.json`);
  if (!meta) return null;
  let day = null;
  if (meta.source?.kind === 'demo') day = demoSession({ date: meta.date, seed: meta.source.seed });
  else {
    const file = path.join(DATA_DIR, `sessions/${id}/input.json.gz`);
    if (fs.existsSync(file)) day = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  }
  if (day) { dayCache.set(id, day); if (dayCache.size > 6) dayCache.delete(dayCache.keys().next().value); }
  return day;
}

export function saveDayInput(id, day) {
  const file = path.join(DATA_DIR, `sessions/${id}/input.json.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(day)));
  dayCache.set(id, day);
}

/** Run every stage of a day through the pipeline. Pure apart from the writes under `base`. */
export function runDay(day, config, base, { onStage = () => {} } = {}) {
  const snaps = {};
  for (const key of SNAPSHOT_KEYS) {
    snaps[key] = runSnapshot(day, key, config);
    const res = writeImmutable(`${base}/snapshots/${key}.json`, snaps[key]);
    onStage({ stage: key, snapshot: snaps[key], stored: res });
  }
  const confirm = runConfirmation(day, snaps.final, config);
  const cres = writeImmutable(`${base}/confirm.json`, confirm);
  onStage({ stage: 'confirm', confirm, stored: cres });
  const paper = simulatePaper(day, confirm, config);
  if (!exists(`${base}/paper.json`)) { appendNdjson(`${base}/paper.ndjson`, paper.log); writeJson(`${base}/paper.json`, { state: paper.state, approxPrints: paper.approxPrints }); }
  onStage({ stage: 'paper', paper });
  const outcomes = { main: outcomesFor(day, snaps.main), final: outcomesFor(day, snaps.final), confirm: outcomesFor(day, confirm) };
  writeJson(`${base}/outcomes.json`, { computedAt: Date.now(), note: 'after-the-fact research outcomes; not available to any decision', ...outcomes });
  return { snapshots: snaps, confirm, paper, outcomes };
}

export function runDemo({ date = DEMO_DATE, seed = 20261019, config = {}, onStage } = {}) {
  const id = sessionId(date, 'DEMO', seed);
  const day = demoSession({ date, seed });
  dayCache.set(id, day);
  const configHash = hashOf(config);
  const already = readJson(`sessions/${id}/meta.json`);
  if (already && already.configHash !== configHash) {
    // The original stays immutable; a different configuration is a research replay.
    return { id, ...replay(id, { config, label: 'settings changed' }), replayOf: id };
  }
  writeJson(`sessions/${id}/meta.json`, { id, date, mode: 'DEMO', profile: 'DEMO', source: { kind: 'demo', seed, generator: day.generatedBy }, createdAt: Date.now(), configHash, config, dataLabel: day.dataLabel });
  const res = runDay(day, config, `sessions/${id}`, { onStage });
  return { id, ...summarise(res) };
}

/** Replay a stored session through the same functions under `config`. Stored originals are untouched. */
export function replay(id, { config = {}, label = 'replay' } = {}) {
  const day = loadDayInput(id);
  if (!day) throw new Error(`no stored input for session ${id}`);
  const runId = `${hashOf(config)}-${Date.now()}`;
  const base = `sessions/${id}/research/${runId}`;
  writeJson(`${base}/meta.json`, { runId, of: id, label, config, createdAt: Date.now() });
  const res = runDay({ ...day, mode: day.mode === 'LIVE' ? 'REPLAY' : day.mode }, config, base);
  // Determinism check against the original (same config ⇒ identical decisions).
  const orig = readJson(`sessions/${id}/snapshots/main.json`);
  const same = orig ? hashOf(orig.rows.map((r) => [r.symbol, r.longScore, r.shortScore, r.outcome])) === hashOf(res.snapshots.main.rows.map((r) => [r.symbol, r.longScore, r.shortScore, r.outcome])) : null;
  return { runId, base, identicalToOriginal: same, ...summarise(res) };
}

function summarise(res) {
  return {
    snapshots: Object.fromEntries(Object.entries(res.snapshots).map(([k, s]) => [k, { id: s.id, rows: s.rows.length }])),
    confirm: { id: res.confirm.id, eligible: res.confirm.rows.filter((r) => r.decision === 'PAPER ENTRY ELIGIBLE').map((r) => r.symbol) },
    paper: { realised: res.paper.state.realised, hypothetical: res.paper.state.hypotheticalRealised, trades: res.paper.state.trades },
  };
}

export function listSessions() {
  return list('sessions').map((id) => readJson(`sessions/${id}/meta.json`)).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function loadSession(id, { research = null } = {}) {
  const base = research ? `sessions/${id}/research/${research}` : `sessions/${id}`;
  const meta = readJson(`sessions/${id}/meta.json`);
  if (!meta) return null;
  const snapshots = Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, readJson(`${base}/snapshots/${k}.json`)]).filter(([, v]) => v));
  return {
    ...meta, id, research,
    snapshots, confirm: readJson(`${base}/confirm.json`), paper: readJson(`${base}/paper.json`), outcomes: readJson(`${base}/outcomes.json`),
    researchRuns: list(`sessions/${id}/research`).map((r) => readJson(`sessions/${id}/research/${r}/meta.json`)).filter(Boolean),
  };
}

/** Re-score sessions under each preset (ablation). Each run is stored as research. */
export function rescore(ids, presets, baseConfig = {}) {
  const out = {};
  for (const preset of presets) {
    out[preset] = ids.map((id) => {
      const day = loadDayInput(id);
      if (!day) return null;
      const config = { ...baseConfig, preset };
      const snap = runSnapshot(day, 'main', config);
      return { id, date: day.date, mode: day.mode, snapshots: { main: snap }, outcomes: { main: outcomesFor(day, snap) } };
    }).filter(Boolean);
  }
  return out;
}
