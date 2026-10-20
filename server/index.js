/**
 * Backend: REST + SSE for the analyzer UI. Secrets stay here; the browser only
 * ever sees booleans for which sources are configured.
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadEnv, configured } from '../src/core/env.js';
import { budgetStatus } from '../src/core/http.js';
import { SOURCES, MODES, PROFILE_FEATURES } from '../src/core/registry.js';
import { runProbe } from '../src/core/probe.js';
import { readJson, sizeOf, list } from '../src/core/store.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { runDemo, replay, listSessions, loadSession, loadDayInput, rescore } from '../src/core/sessions.js';
import { createLiveSession } from '../src/core/liveSession.js';
import { reportCard, ablation } from '../src/utils/reportCard.js';
import { FACTORS, GROUPS, PRESETS, LABEL_POLICY, SCORE_VERSION } from '../src/utils/conviction.js';
import { FEATURE_VERSION } from '../src/utils/features.js';
import { DEMO_DATE, DEMO_CASES } from '../src/utils/demoSession.js';
import { sessionTimes, formatEt, formatIst, phaseAt, etParts, dayStatus } from '../src/utils/clock.js';
import { buildSeries, barsBetween } from '../src/utils/series.js';
import { fetchSymbolDirectory, eligibleUniverse } from '../src/core/providers/nasdaqTrader.js';

loadEnv();
const PORT = Number(process.env.PORT ?? 3101);
const app = express();
app.use(express.json({ limit: '1mb' }));

// Same-origin guard for state-changing routes (the UI is served from this origin or the Vite proxy).
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  const host = req.get('x-forwarded-host') ?? req.get('host');
  if (origin && !origin.endsWith(`//${host}`) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return res.status(403).json({ error: 'cross-origin request refused' });
  next();
});

// ---------- SSE
const clients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => broadcast({ type: 'clock', at: Date.now() }), 15_000).unref();

const live = createLiveSession({ getConfig: () => loadSettings(), onEvent: broadcast });

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(e.status ?? 500).json({ error: e.message }); }
};
const notFound = (m) => Object.assign(new Error(m), { status: 404 });

// ---------- status & registry
app.get('/api/status', wrap(() => {
  const now = Date.now();
  const date = etParts(now).date;
  const times = sessionTimes(date);
  return {
    now, nowEt: formatEt(now, true), nowIst: formatIst(now, true), date, dayStatus: dayStatus(date), phase: phaseAt(now, times),
    configured: configured(), live: live.status(), sessions: listSessions().slice(0, 30),
    versions: { score: SCORE_VERSION, feature: FEATURE_VERSION }, storageBytes: sizeOf(''),
  };
}));
app.get('/api/registry', wrap(() => ({ sources: SOURCES, modes: MODES, profileFeatures: PROFILE_FEATURES, probe: readJson('probe-results.json'), budget: budgetStatus(), configured: configured() })));
app.post('/api/probe', wrap(() => runProbe()));
app.get('/api/budget', wrap(() => budgetStatus()));

// ---------- settings & scoring dictionary
app.get('/api/settings', wrap(() => ({ settings: loadSettings(), defaults: DEFAULT_SETTINGS })));
app.put('/api/settings', wrap((req) => ({ settings: saveSettings(req.body ?? {}) })));
app.get('/api/dictionary', wrap(() => ({
  groups: GROUPS, presets: PRESETS, labelPolicy: LABEL_POLICY, scoreVersion: SCORE_VERSION, featureVersion: FEATURE_VERSION,
  factors: FACTORS.map(({ fn, ...f }) => f),
})));

// ---------- sessions
app.get('/api/sessions', wrap(() => listSessions()));
app.get('/api/sessions/:id', wrap((req) => {
  const s = loadSession(req.params.id, { research: req.query.research ?? null });
  if (!s) throw notFound('session not found');
  // Rows are large; strip per-factor detail from the list view (fetched per stock on demand).
  const slimRows = (snap) => snap && { ...snap, rows: snap.rows.map(({ scores, features, gates, ...r }) => ({ ...r, gateSummary: gates.gates.map((g) => [g.key, g.state]) })) };
  return {
    ...s,
    snapshots: Object.fromEntries(Object.entries(s.snapshots).map(([k, v]) => [k, slimRows(v)])),
    confirm: s.confirm && { ...s.confirm, rows: s.confirm.rows.map(({ strategies, confirmation, window, ...r }) => ({ ...r, window: window?.available ? { ret5Pct: window.ret5Pct, vwap: window.vwap, rvol: window.rvol?.ok ? window.rvol.rvol : null, orHigh: window.orHigh, orLow: window.orLow, auction: window.auction } : window })) },
  };
}));

app.post('/api/demo', wrap((req) => {
  const { date = DEMO_DATE, seed = 20261019 } = req.body ?? {};
  const out = runDemo({ date, seed: Number(seed), config: loadSettings() });
  broadcast({ type: 'session', id: out.id });
  return out;
}));
app.get('/api/demo/cases', wrap(() => DEMO_CASES));
app.post('/api/sessions/:id/replay', wrap((req) => replay(req.params.id, { config: { ...loadSettings(), ...(req.body?.config ?? {}) }, label: req.body?.label ?? 'replay from UI' })));

// ---------- stock detail (full row + chart series)
app.get('/api/sessions/:id/stock/:symbol', wrap((req) => {
  const s = loadSession(req.params.id, { research: req.query.research ?? null });
  if (!s) throw notFound('session not found');
  const key = req.query.snapshot ?? 'main';
  const snap = s.snapshots[key];
  const row = snap?.rows.find((r) => r.symbol === req.params.symbol);
  const confirmRow = s.confirm?.rows.find((r) => r.symbol === req.params.symbol) ?? null;
  const day = loadDayInput(req.params.id);
  let chart = null;
  if (day?.instruments[req.params.symbol]) {
    const inst = day.instruments[req.params.symbol];
    const times = sessionTimes(day.date);
    // The chart shows what was known at the snapshot for the pre-market, and the regular session after the fact.
    const series = buildSeries({ scope: inst.scope, trades: inst.today?.trades, bars: inst.today?.bars, coverage: inst.today?.coverage });
    const bars = barsBetween(series, times.preMarketStart, times.open + 90 * 60_000).filter((b) => b.c != null).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, knownAtSnapshot: (b.availableAt ?? b.t) <= (snap?.asOf ?? Infinity) }));
    const vwapPath = (from, to) => { let pv = 0; let v = 0; return bars.filter((b) => b.t >= from && b.t < to).map((b) => { pv += b.c * b.v; v += b.v; return { t: b.t, vwap: v ? pv / v : null }; }); };
    chart = {
      bars, pmVwap: vwapPath(times.preMarketStart, times.open), rthVwap: vwapPath(times.open, Infinity),
      times: { open: times.open, windowEnd: times.windowEnd, snapshotAt: snap?.asOf ?? null, earlyAuction: times.earlyAuction, main: times.main },
      prevClose: inst.prevClose?.price ?? null, coverage: inst.today?.coverage ?? [],
      noii: (inst.noii ?? []).map((m) => ({ t: m.t, paired: m.pairedShares, imbalance: m.imbalanceShares, side: m.imbalanceSide, ref: m.referencePrice, near: m.nearPrice || null, far: m.farPrice || null })),
      news: (inst.news ?? []).map((n) => ({ headline: n.headline, url: n.url, source: n.source, publishedAt: n.publishedAt, firstSeenAt: n.firstSeenAt, demo: n.demo ?? false })),
      demoCase: inst.demoCase ?? null, cumulativeCheck: inst.cumulativeCheck ?? null,
    };
  }
  return { session: { id: s.id, mode: s.mode, date: s.date }, snapshotKey: key, snapshotAsOf: snap?.asOf, row: row ?? null, confirm: confirmRow, chart, snapshotsAvailable: Object.keys(s.snapshots) };
}));

// ---------- report card & validation
app.get('/api/reportcard', wrap((req) => {
  const ids = req.query.ids ? String(req.query.ids).split(',') : listSessions().map((x) => x.id);
  const sessions = ids.map((id) => loadSession(id)).filter(Boolean).map((x) => ({ ...x, paper: x.paper }));
  return reportCard(sessions, { horizon: req.query.horizon ?? 'm30', snapshotKey: req.query.snapshot ?? 'main' });
}));
app.post('/api/ablation', wrap((req) => {
  const ids = req.body?.ids ?? listSessions().map((x) => x.id);
  const presets = req.body?.presets ?? ['gapOnly', 'gapRvol', 'priceVolumeNoNews', 'equalGroups', 'volumeFirst', 'fullFree'];
  return { presets, rows: ablation(rescore(ids, presets, loadSettings()), { horizon: req.body?.horizon ?? 'm30' }) };
}));

// ---------- live
app.post('/api/live/prepare', wrap(async () => { const ok = await live.prepare(); return { ok, status: live.status() }; }));
app.post('/api/live/stop', wrap(() => { live.stop(); return live.status(); }));
app.post('/api/live/kill', wrap((req) => ({ ledger: live.kill(req.body?.on !== false) })));
app.post('/api/live/close-all', wrap(() => ({ ledger: live.closeAll() })));
app.get('/api/live', wrap(() => live.status()));

// ---------- universe
app.get('/api/universe', wrap(async (req) => {
  const stored = list('universe').sort().at(-1);
  if (stored && !req.query.refresh) return { ...readJson(`universe/${stored}`), file: stored };
  const dir = await fetchSymbolDirectory();
  const u = eligibleUniverse(dir.rows, { includeAdrs: loadSettings().universe.includeAdrs });
  const byType = {};
  for (const r of dir.rows) byType[r.securityType] = (byType[r.securityType] ?? 0) + 1;
  return { createdAt: dir.createdAt, fetchedAt: dir.fetchedAt, eligible: u.eligible.length, etfs: u.etfs.length, excluded: u.excluded.length, byType, sample: u.eligible.slice(0, 50).map((r) => [r.symbol, r.name, r.securityType, r.marketCategory, r.financialStatus]), note: 'Nasdaq-listed ≠ Nasdaq-100; Nasdaq-100 constituents need licensed data (not included).' };
}));

// ---------- static UI (after `npm run build`)
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`nasdaq-adv-dec backend on http://localhost:${PORT}`));
