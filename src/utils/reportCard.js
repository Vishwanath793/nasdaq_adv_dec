/**
 * Report card and validation statistics (pure). Inputs are recorded sessions with
 * their immutable snapshots and after-the-fact outcomes. Every table reports its
 * sample size; small samples are flagged rather than interpreted.
 *
 * Returns are "in the scored direction" from a reference price (first bar open after
 * the decision), before costs, unless stated otherwise. Paper P&L is after modelled costs.
 */

import { mean, median, spearman, bootstrapMeanCi, quantile } from './stats.js';

export const MIN_SAMPLE = 30;
export const SCORE_BANDS = [[80, 101, '80+'], [70, 80, '70–79'], [60, 70, '60–69'], [50, 60, '50–59'], [0, 50, '<50']];

const sampleNote = (n) => (n < MIN_SAMPLE ? `n=${n}: too small to interpret` : `n=${n}`);

/** One row per (session, symbol) from a pre-open snapshot plus its outcome. */
export function preOpenObservations(sessions, { snapshotKey = 'main', horizon = 'm30' } = {}) {
  const obs = [];
  for (const s of sessions) {
    const snap = s.snapshots?.[snapshotKey];
    const out = s.outcomes?.[snapshotKey];
    if (!snap || !out) continue;
    for (const r of snap.rows) {
      const o = out[r.symbol];
      if (!o?.available) continue;
      const dir = (r.longScore ?? -1) >= (r.shortScore ?? -1) ? 1 : -1;
      const score = dir > 0 ? r.longScore : r.shortScore;
      // Outcomes are stored in the leading direction already.
      obs.push({
        session: s.id, date: s.date, mode: s.mode, symbol: r.symbol, score, label: dir > 0 ? r.longLabel : r.shortLabel, outcome: r.outcome,
        coverage: r.coverage, eligibility: r.eligibility, dollar: r.cumDollar, marketCap: r.marketCap, setup: r.setup?.classification ?? null,
        ret: o.returns?.[horizon] ?? null, retClose: o.close, mfe: o.mfe60, mae: o.mae60, continued: o.continued,
      });
    }
  }
  return obs.filter((x) => x.ret != null && x.score != null);
}

function bandTable(obs) {
  return SCORE_BANDS.map(([lo, hi, label]) => {
    const xs = obs.filter((o) => o.score >= lo && o.score < hi);
    const rets = xs.map((o) => o.ret);
    return {
      band: label, n: xs.length, meanRet: mean(rets), medianRet: median(rets), ci90: bootstrapMeanCi(rets),
      hitRate: xs.length ? xs.filter((o) => o.ret > 0).length / xs.length : null,
      meanMfe: mean(xs.map((o) => o.mfe)), meanMae: mean(xs.map((o) => o.mae)), note: sampleNote(xs.length),
    };
  });
}

function bucketBy(obs, keyFn, label) {
  const groups = {};
  for (const o of obs) (groups[keyFn(o)] ??= []).push(o);
  return Object.entries(groups).map(([k, xs]) => ({ [label]: k, n: xs.length, meanRet: mean(xs.map((o) => o.ret)), rankCorr: spearman(xs.map((o) => o.score), xs.map((o) => o.ret)), note: sampleNote(xs.length) }));
}

const liquidityBucket = (o) => (o.dollar == null ? 'unknown' : o.dollar >= 5e6 ? '≥$5M pre-mkt' : o.dollar >= 1e6 ? '$1–5M' : o.dollar >= 2.5e5 ? '$0.25–1M' : '<$0.25M');
const capBucket = (o) => (o.marketCap == null ? 'unknown' : o.marketCap >= 1e10 ? 'large (≥$10B)' : o.marketCap >= 2e9 ? 'mid ($2–10B)' : o.marketCap >= 3e8 ? 'small ($0.3–2B)' : 'micro (<$0.3B)');

/** Paper results from ledgers (after costs). Hypothetical shorts are reported separately. */
function paperSummary(sessions) {
  const trades = [];
  const hyp = [];
  for (const s of sessions) {
    for (const p of s.paper?.state?.positions ?? []) {
      if (p.status !== 'CLOSED') continue;
      (p.hypothetical ? hyp : trades).push({ session: s.id, symbol: p.symbol, strategy: p.strategy, net: p.net, gross: p.gross, costs: p.costs });
    }
  }
  const curve = [];
  let eq = 0; let peak = 0; let maxDd = 0;
  for (const t of trades) { eq += t.net; peak = Math.max(peak, eq); maxDd = Math.min(maxDd, eq - peak); curve.push(eq); }
  const byStrategy = {};
  for (const t of trades) (byStrategy[t.strategy] ??= []).push(t.net);
  return {
    trades: trades.length, netTotal: trades.reduce((s, t) => s + t.net, 0), expectancy: mean(trades.map((t) => t.net)),
    winRate: trades.length ? trades.filter((t) => t.net > 0).length / trades.length : null, maxDrawdown: maxDd, costs: trades.reduce((s, t) => s + (t.costs ?? 0), 0),
    byStrategy: Object.entries(byStrategy).map(([k, v]) => ({ strategy: k, n: v.length, net: v.reduce((a, b) => a + b, 0), expectancy: mean(v), note: sampleNote(v.length) })),
    hypotheticalShorts: { n: hyp.length, net: hyp.reduce((s, t) => s + t.net, 0), note: 'borrow not verified: not executable, reported separately' },
    note: sampleNote(trades.length),
  };
}

/** Coverage failures and no-trade rates. */
function decisionStats(sessions) {
  let rows = 0; let noTrade = 0; let insufficient = 0; let blocked = 0; let eligible = 0;
  const reasons = {};
  for (const s of sessions) {
    for (const r of s.snapshots?.main?.rows ?? []) {
      rows++;
      if (r.outcome === 'NO TRADE') noTrade++;
      if ((r.longLabel === 'insufficient evidence') || (r.shortLabel === 'insufficient evidence')) insufficient++;
      if (r.eligibility === 'blocked') blocked++;
      const k = (r.primaryReason ?? '').split(':')[0] || '—';
      reasons[k] = (reasons[k] ?? 0) + 1;
    }
    for (const r of s.confirm?.rows ?? []) if (r.decision === 'PAPER ENTRY ELIGIBLE') eligible++;
  }
  return { rows, noTradeRate: rows ? noTrade / rows : null, insufficientRate: rows ? insufficient / rows : null, blockedRate: rows ? blocked / rows : null, paperEntries: eligible, topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8) };
}

/** Confirmation verdicts vs the subsequent move (does the 09:35 verdict add information?). */
function confirmationStats(sessions, horizon = 'm30') {
  const by = {};
  for (const s of sessions) {
    const out = s.outcomes?.confirm;
    if (!out) continue;
    for (const r of s.confirm?.rows ?? []) {
      const o = out[r.symbol];
      if (!o?.available || o.returns?.[horizon] == null) continue;
      (by[r.confirmVerdict ?? 'n/a'] ??= []).push(o.returns[horizon]);
    }
  }
  return Object.entries(by).map(([verdict, xs]) => ({ verdict, n: xs.length, meanRet: mean(xs), hitRate: xs.filter((x) => x > 0).length / xs.length, note: sampleNote(xs.length) }));
}

export function reportCard(sessions, { horizon = 'm30', snapshotKey = 'main' } = {}) {
  const obs = preOpenObservations(sessions, { snapshotKey, horizon });
  const modes = [...new Set(sessions.map((s) => s.mode))];
  return {
    generatedFor: { sessions: sessions.length, dates: sessions.map((s) => s.date), modes, horizon, snapshotKey },
    warning: modes.includes('DEMO') ? 'DEMO sessions are simulated: these numbers validate the mechanics only and say nothing about real-market performance.' : null,
    observations: obs.length,
    rankCorrelation: spearman(obs.map((o) => o.score), obs.map((o) => o.ret)),
    continuationRate: obs.length ? obs.filter((o) => o.continued).length / obs.length : null,
    bands: bandTable(obs),
    byLabel: bucketBy(obs, (o) => o.label, 'label'),
    byLiquidity: bucketBy(obs, liquidityBucket, 'liquidity'),
    byMarketCap: bucketBy(obs, capBucket, 'marketCap'),
    bySetup: bucketBy(obs, (o) => o.setup ?? 'n/a', 'setup'),
    confirmation: confirmationStats(sessions, horizon),
    decisions: decisionStats(sessions),
    paper: paperSummary(sessions),
    mfeMae: { medianMfe: median(obs.map((o) => o.mfe)), medianMae: median(obs.map((o) => o.mae)), p10Mae: quantile(obs.map((o) => o.mae), 0.1) },
  };
}

/**
 * Ablation: the same sessions re-scored under several presets. `rescored`: { preset: sessions[] } where each
 * sessions[] carries snapshots re-run under that preset (same records, same decision times).
 * Chronological split: the earliest `trainShare` of dates is "development", the rest is held out.
 */
export function ablation(rescored, { horizon = 'm30', trainShare = 0.6 } = {}) {
  const rows = [];
  for (const [preset, sessions] of Object.entries(rescored)) {
    const dates = [...new Set(sessions.map((s) => s.date))].sort();
    const cut = dates[Math.max(0, Math.floor(dates.length * trainShare) - 1)];
    const obs = preOpenObservations(sessions, { horizon });
    const dev = obs.filter((o) => o.date <= cut);
    const test = obs.filter((o) => o.date > cut);
    const topQ = (xs) => {
      if (xs.length < 5) return null;
      const thr = quantile(xs.map((o) => o.score), 0.8);
      return mean(xs.filter((o) => o.score >= thr).map((o) => o.ret));
    };
    rows.push({ preset, n: obs.length, devN: dev.length, testN: test.length, devRankCorr: spearman(dev.map((o) => o.score), dev.map((o) => o.ret)), testRankCorr: spearman(test.map((o) => o.score), test.map((o) => o.ret)), testTopQuintileRet: topQ(test), note: sampleNote(test.length) });
  }
  return rows;
}
