/**
 * The analysis pipeline (pure). Live collection, the DEMO session and replay all
 * call these same functions with a "day" object, so a replay reproduces what the
 * live run decided from the records available at each decision time.
 *
 * day = { date, mode, profile, instruments: { SYM: inst }, benchmarks: [...], universe, calendar? }
 */

import { sessionTimes, SNAPSHOT_LABEL, DEFAULT_SCHEDULE, formatEt, formatIst } from './clock.js';
import { computeFeatures, FEATURE_VERSION } from './features.js';
import { scoreStock, configHash, SCORE_VERSION, DEFAULT_PRESET, PRESETS } from './conviction.js';
import { evaluateGates } from './tradeability.js';
import { preOpenOutcome, decideOpening } from './decision.js';
import { openingWindowFeatures, windowReturn } from './confirmation.js';
import { emptyLedger, orderEvents, stepMarket, applyEvent } from './paperLedger.js';
import { cleanRiskSettings, positionSize } from './risk.js';
import { buildSeries, barsBetween } from './series.js';
import { etToUtc } from './clock.js';
import { hashOf } from './stats.js';

export const PIPELINE_VERSION = 'pipe-1.0.0';

export function dayContext(day, schedule = DEFAULT_SCHEDULE) {
  const times = sessionTimes(day.date, schedule, day.calendar ?? null);
  return { date: day.date, times, dataMode: day.mode };
}

const stockSymbols = (day) => Object.keys(day.instruments).filter((s) => !day.instruments[s].meta?.benchmark);

/** Strip heavy/internal fields from features before they go into an immutable snapshot. */
export function slimFeatures(f) {
  const { series, news, profile, orderflow, ...rest } = f;
  return {
    ...rest,
    seriesSource: series?.source, seriesStats: series?.stats,
    profile: profile ? { estimated: profile.estimated, poc: profile.poc, valueLow: profile.valueLow, valueHigh: profile.valueHigh } : null,
    orderflow: orderflow ? { method: orderflow.method, estBuyVolume: orderflow.estBuyVolume, estSellVolume: orderflow.estSellVolume, unclassifiedVolume: orderflow.unclassifiedVolume, coverage: orderflow.coverage, imbalance: orderflow.imbalance } : null,
    newsCount: news?.length ?? 0,
  };
}

/** Benchmarks' moves and tracked-universe breadth at asOf. */
export function marketAt(day, asOf, ctx) {
  const market = {};
  for (const b of day.benchmarks ?? []) {
    const inst = day.instruments[b];
    if (!inst) continue;
    const f = computeFeatures(inst, asOf, ctx);
    market[b] = { gapPct: f.gapPct, distVwapPct: f.distVwapPct, cutoffLagMs: f.cutoffLagMs, rvol: f.rvol?.ok ? f.rvol.rvol : null, feed: inst.scope?.feed };
  }
  return market;
}

function breadthOf(featureList, { maxLagMs = 120_000 } = {}) {
  let up = 0; let down = 0; let flat = 0; let excluded = 0; let aboveVwap = 0; let withVwap = 0; const gaps = [];
  for (const f of featureList) {
    if (f.gapPct == null || f.cutoffLagMs == null || f.cutoffLagMs > maxLagMs) { excluded++; continue; }
    if (f.gapPct > 0.1) up++; else if (f.gapPct < -0.1) down++; else flat++;
    gaps.push(f.gapPct);
    if (f.distVwapPct != null) { withVwap++; if (f.distVwapPct > 0) aboveVwap++; }
  }
  const counted = up + down + flat;
  const bucket = (lo, hi) => gaps.filter((g) => g >= lo && g < hi).length;
  return {
    counted, up, down, flat, excluded, total: featureList.length,
    aboveVwapShare: withVwap ? aboveVwap / withVwap : null,
    gapDistribution: { '≤−5%': bucket(-Infinity, -5), '−5…−2%': bucket(-5, -2), '−2…0%': bucket(-2, 0), '0…2%': bucket(0, 2), '2…5%': bucket(2, 5), '≥5%': bucket(5, Infinity) },
    note: 'tracked universe only — not the whole Nasdaq market',
  };
}

/**
 * One immutable pre-open snapshot. key: 'preliminary' | 'earlyAuction' | 'main' | 'final' (or asOf override).
 * config: { preset, groupWeights, factorsOff, gates, risk }
 */
export function runSnapshot(day, key, config = {}, { asOf: asOfOverride = null, publishedAt = null, schedule } = {}) {
  const ctx = dayContext(day, schedule);
  const asOf = asOfOverride ?? ctx.times[key];
  const market = marketAt(day, asOf, ctx);
  const syms = stockSymbols(day);
  const features = syms.map((s) => computeFeatures(day.instruments[s], asOf, ctx));
  const breadth = breadthOf(features);
  const scoreCtx = { ...ctx, market, breadth, dataMode: day.mode === 'DEMO' || day.mode === 'REPLAY' ? 'LIVE' : day.mode };
  const risk = cleanRiskSettings(config.risk);
  const rows = features.map((f) => {
    const scored = scoreStock(f, scoreCtx, config);
    const dir = scored.leading;
    const lead = dir > 0 ? scored.long : scored.short;
    // Indicative order size for the slippage gate: risk budget at a 1-ATR stop.
    const ref = f.refPrice;
    const atr = f.hist?.atr14;
    const orderShares = ref && atr ? positionSize({ entry: ref, stop: ref - dir * atr * 0.5, settings: risk }).qty || null : null;
    const gates = evaluateGates(f, { dataMode: f.scope?.delayMs ? 'DELAYED' : day.mode, gates: config.gates, direction: dir, orderShares });
    const outcome = preOpenOutcome(scored, gates);
    return {
      symbol: f.symbol, name: f.meta?.name, securityType: f.meta?.securityType, sector: f.meta?.sector, sectorEtf: f.meta?.sectorEtf, marketCap: f.meta?.marketCap,
      floatAsOf: day.instruments[f.symbol].float?.asOf ?? null, floatKind: day.instruments[f.symbol].float?.kind ?? null, demoCase: f.meta?.demoCase ?? null,
      gapPct: f.gapPct, gapAtr: f.gapAtr, refPrice: f.refPrice, prevClose: f.prevClose,
      cumDollar: f.cumDollar, cumVolume: f.cumVolume, rvol: f.rvol?.ok ? f.rvol.rvol : null, rvolSample: f.rvol?.sample ?? null, rvolReason: f.rvol?.ok ? null : f.rvol?.reason,
      spreadBps: f.quote?.spreadBps ?? null,
      catalyst: lead.factors.find((x) => x.key === 'catalyst')?.evidence ?? null,
      catalystDetail: lead.factors.find((x) => x.key === 'catalyst')?.detail ?? lead.factors.find((x) => x.key === 'catalyst')?.reason ?? null,
      auction: f.auction?.available ? { side: f.auction.side, persistence: f.auction.persistence, imbalanceToPaired: f.auction.imbalanceToPaired, nearFarAvailable: f.auction.nearFarAvailable } : null,
      longScore: scored.long.adjustedScore, longRaw: scored.long.rawScore, longLabel: scored.long.label.label,
      shortScore: scored.short.adjustedScore, shortRaw: scored.short.rawScore, shortLabel: scored.short.label.label,
      volumeScore: lead.volumeEvidenceScore, coverage: lead.coverage.profile, coverageDetail: lead.coverage,
      quality: { cutoffLagMs: f.cutoffLagMs, observed: f.preMarketObserved, gaps: f.coverageGaps.length, delayed: Boolean(f.scope?.delayMs), feed: f.scope?.feed, stats: f.seriesStats },
      setup: scored.setup,
      eligibility: gates.status, primaryReason: gates.primaryReason ?? outcome.reasons[0] ?? null,
      gates, outcome: outcome.outcome, outcomeReasons: outcome.reasons,
      scores: { long: scored.long, short: scored.short },
      features: slimFeatures(f),
    };
  });
  rows.sort((a, b) => Math.max(b.longScore ?? 0, b.shortScore ?? 0) - Math.max(a.longScore ?? 0, a.shortScore ?? 0));
  const cfg = { preset: config.preset ?? DEFAULT_PRESET, groupWeights: config.groupWeights ?? null, factorsOff: config.factorsOff ?? [] };
  const id = `${day.date}-${key}-${configHash(cfg)}-${hashOf({ asOf, mode: day.mode, n: rows.length })}`;
  return {
    id, kind: 'preopen', key, label: SNAPSHOT_LABEL[key] ?? key, date: day.date, asOf, asOfEt: formatEt(asOf), asOfIst: formatIst(asOf),
    publishedAt: publishedAt ?? asOf, mode: day.mode, profile: day.profile, dataLabel: day.dataLabel ?? null,
    scoreVersion: SCORE_VERSION, featureVersion: FEATURE_VERSION, pipelineVersion: PIPELINE_VERSION, configHash: configHash(cfg), config: cfg, presetLabel: PRESETS[cfg.preset]?.label,
    market, breadth, universe: { name: day.universe?.name, tracked: syms.length, totalEligible: day.universe?.totalEligible ?? null, note: day.universe?.note ?? null },
    rows,
  };
}

/** The sealed 09:35 confirmation. `pre`: the final pre-open snapshot (its features and scores are reused, never recomputed with later data). */
export function runConfirmation(day, pre, config = {}, { publishedAt = null, schedule, ledgerDay = {} } = {}) {
  const ctx = dayContext(day, schedule);
  const at = ctx.times.confirmPublish;
  const syms = stockSymbols(day);
  const market = {};
  for (const b of day.benchmarks ?? []) if (day.instruments[b]) market[b] = windowReturn(openingWindowFeatures(day.instruments[b], ctx));
  const preRows = new Map((pre?.rows ?? []).map((r) => [r.symbol, r]));
  const inputs = syms.map((s) => {
    const inst = day.instruments[s];
    const pr = preRows.get(s);
    const preF = pr?.features ?? null;
    const w = openingWindowFeatures(inst, ctx, preF);
    const fNow = computeFeatures(inst, at, ctx); // only for entry gates at the seal: halt, quote, spread, borrow, freshness
    const gates = {
      1: evaluateGates({ ...fNow, preMarketObserved: 1, activeMinutes: 99 }, { dataMode: inst.scope?.delayMs ? 'DELAYED' : day.mode, gates: { ...config.gates, maxSpreadBps: cleanRiskSettings(config.risk).maxSpreadBps }, direction: 1 }),
      [-1]: evaluateGates({ ...fNow, preMarketObserved: 1, activeMinutes: 99 }, { dataMode: inst.scope?.delayMs ? 'DELAYED' : day.mode, gates: { ...config.gates, maxSpreadBps: cleanRiskSettings(config.risk).maxSpreadBps }, direction: -1 }),
    };
    return { symbol: s, sector: inst.meta?.sector, w, pre: preF, preScore: pr?.scores ?? null, market, gates, borrow: inst.borrow };
  });
  const result = decideOpening(inputs, { strategies: config.strategies, risk: config.risk, decision: config.decision, day: ledgerDay });
  const byInput = new Map(inputs.map((x) => [x.symbol, x]));
  const rows = result.decisions.map((d) => {
    const inp = byInput.get(d.symbol);
    const pr = preRows.get(d.symbol);
    return {
      ...d,
      preOutcome: pr?.outcome ?? null, preLongScore: pr?.longScore ?? null, preShortScore: pr?.shortScore ?? null,
      window: inp.w.available ? { ...inp.w, quote: inp.w.quote?.available ? { bid: inp.w.quote.bid, ask: inp.w.quote.ask, spreadBps: inp.w.quote.spreadBps } : null } : { available: false, reason: inp.w.reason },
    };
  });
  return {
    id: `${day.date}-confirm-${pre?.configHash ?? 'nopre'}`, kind: 'confirm', key: 'confirm', label: SNAPSHOT_LABEL.confirm, date: day.date,
    windowFrom: ctx.times.open, windowTo: ctx.times.windowEnd, sealAt: at, sealEt: formatEt(at), sealIst: formatIst(at), publishedAt: publishedAt ?? at,
    graceMs: at - ctx.times.windowEnd, preSnapshotId: pre?.id ?? null, mode: day.mode, profile: day.profile,
    scoreVersion: SCORE_VERSION, pipelineVersion: PIPELINE_VERSION, market, rows, settings: result.settings,
  };
}

/** Market events after `from` for paper simulation: real trades + quotes when present, else prints derived from bars (labelled). */
export function marketStream(day, symbols, from, to) {
  const out = [];
  for (const s of symbols) {
    const inst = day.instruments[s];
    if (!inst) continue;
    for (const q of inst.today?.quotes ?? []) if (q.t >= from && q.t < to) out.push({ kind: 'quote', symbol: s, t: q.t, bid: q.bid, ask: q.ask, bidSize: q.bidSize * ((inst.scope?.quoteSizeUnit === 'round_lots') ? (inst.meta?.roundLot ?? 100) : 1), askSize: q.askSize * ((inst.scope?.quoteSizeUnit === 'round_lots') ? (inst.meta?.roundLot ?? 100) : 1) });
    if (inst.today?.trades?.length) {
      for (const t of inst.today.trades) if (t.t >= from && t.t < to && !t.correction) out.push({ kind: 'trade', symbol: s, t: t.t, price: t.price, size: t.size });
    } else {
      // Bars only: approximate the minute's prints as open → first extreme → second extreme → close (order unknown; labelled approximate).
      for (const b of inst.today?.bars ?? []) {
        if (b.t < from || b.t >= to || b.c == null) continue;
        const upFirst = b.c >= b.o;
        const seq = upFirst ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
        seq.forEach((p, i) => out.push({ kind: 'trade', symbol: s, t: b.t + [5_000, 20_000, 40_000, 55_000][i], price: p, size: Math.max(1, Math.round(b.v / 4)), approx: true }));
      }
    }
  }
  return out.sort((a, b) => a.t - b.t || (a.kind === 'quote' ? -1 : 1));
}

/** Simulate the paper ledger from the sealed decision through the square-off. */
export function simulatePaper(day, confirm, config = {}, { ledger = 'day' } = {}) {
  const risk = cleanRiskSettings(config.risk);
  const state = emptyLedger(day.date, ledger);
  const log = [];
  const push = (e) => { log.push(e); applyEvent(state, e); };
  push({ type: 'decided', at: confirm.publishedAt });
  const expiresAt = etToUtc(day.date, `${risk.entryUntil}:00`);
  const squareOffAt = etToUtc(day.date, `${risk.squareOffAt}:00`);
  for (const e of orderEvents(state, confirm.rows, { publishedAt: confirm.publishedAt, latencyMs: risk.latencyMs, expiresAt })) push(e);
  const syms = [...new Set(state.orders.map((o) => o.symbol))];
  const stream = marketStream(day, syms, confirm.publishedAt, etToUtc(day.date, '16:00:00'));
  for (const m of stream) for (const e of stepMarket(state, m, risk, { squareOffAt })) log.push(e);
  return { state, log, approxPrints: stream.some((m) => m.approx), streamEvents: stream.length };
}

/** After-the-fact outcomes for research (never available to the decisions they evaluate). */
export function outcomesFor(day, snapshot, { horizonsMin = [5, 15, 30, 60] } = {}) {
  const ctx = dayContext(day);
  const out = {};
  const decisionAt = snapshot.kind === 'confirm' ? snapshot.sealAt : ctx.times.open;
  for (const r of snapshot.rows) {
    const inst = day.instruments[r.symbol];
    if (!inst) continue;
    const series = buildSeries({ scope: inst.scope, trades: inst.today?.trades, bars: inst.today?.bars, coverage: inst.today?.coverage });
    const after = barsBetween(series, decisionAt, etToUtc(day.date, '16:00:00')).filter((b) => b.c != null);
    if (!after.length) { out[r.symbol] = { available: false }; continue; }
    const entry = after[0].o;
    const dir = snapshot.kind === 'confirm' ? r.direction : ((r.longScore ?? 0) >= (r.shortScore ?? 0) ? 1 : -1);
    const ret = (min) => { const b = after.filter((x) => x.t < decisionAt + min * 60_000).at(-1); return b ? (dir * (b.c - entry) / entry) * 100 : null; };
    const first60 = after.filter((x) => x.t < decisionAt + 60 * 60_000);
    const mfe = Math.max(...first60.map((b) => (dir > 0 ? b.h - entry : entry - b.l))) / entry * 100;
    const mae = Math.min(...first60.map((b) => (dir > 0 ? b.l - entry : entry - b.h))) / entry * 100;
    out[r.symbol] = {
      available: true, direction: dir, entryRef: entry, entryRefNote: 'first bar open after the decision time (not a fill)',
      returns: Object.fromEntries(horizonsMin.map((h) => [`m${h}`, ret(h)])), close: (dir * (after.at(-1).c - entry) / entry) * 100,
      mfe60: mfe, mae60: mae,
      continued: ret(60) == null ? null : ret(60) > 0,
    };
  }
  return out;
}
