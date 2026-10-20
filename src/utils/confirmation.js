/**
 * Opening-window confirmation (pure). The window is [09:30:00, 09:35:00) ET; the
 * decision is sealed at publishAt = 09:35:00 + grace and only uses records that
 * were available by then (late prints after the seal are ignored here and logged).
 *
 * Auction volume: kept separate when auction prints are identifiable (trade
 * conditions). IEX does not take part in the Nasdaq opening cross, so an IEX window
 * has no cross volume; a SIP minute bar at 09:30 includes an inseparable cross
 * contribution and is labelled so. Historical baselines use the same policy.
 */

import { buildSeries, minuteGrid, totals, barsBetween } from './series.js';
import { sameTimeRvol } from './baseline.js';
import { quoteFeatures } from './features.js';
import { clamp, mean, sum, isNum } from './stats.js';

const MIN = 60_000;
const pct = (a, b) => (isNum(a) && isNum(b) && b ? ((a - b) / b) * 100 : null);

export function openingWindowFeatures(inst, ctx, pre = null) {
  const { times, date } = ctx;
  const from = times.open;
  const to = times.windowEnd;
  const publishAt = times.confirmPublish;
  const scope = inst.scope;
  const series = buildSeries({ scope, trades: inst.today?.trades, bars: inst.today?.bars, coverage: inst.today?.coverage }, publishAt);
  const lateRecords = [...(inst.today?.bars ?? []), ...(inst.today?.trades ?? [])].filter((r) => r.t >= from && r.t < to && (r.availableAt ?? r.t) > publishAt).length;
  const grid = minuteGrid(series, from, to);
  const candles = grid.map((g) => (g.bar && g.bar.c != null ? { t: g.t, o: g.bar.o, h: g.bar.h, l: g.bar.l, c: g.bar.c, v: g.bar.v, auctionV: g.bar.auctionV ?? null } : null));
  const have = candles.filter(Boolean);
  const w = { symbol: inst.symbol, from, to, publishAt, lateRecordsIgnored: lateRecords, candles, missingMinutes: grid.filter((g) => g.state === 'missing').length, zeroMinutes: grid.filter((g) => g.state === 'zero').length };
  if (!have.length) return { ...w, available: false, reason: lateRecords ? `${lateRecords} window record(s) only arrive after the seal (delayed or late feed): not usable for this decision` : grid.every((g) => g.state === 'missing') ? 'window not observed' : 'no trades in the opening window (halted, delayed opening or no venue activity)' };
  const tot = totals(series, from, to);
  w.available = true;
  w.complete = w.missingMinutes === 0;
  w.open = have[0].o;
  w.orHigh = Math.max(...have.map((c) => c.h));
  w.orLow = Math.min(...have.map((c) => c.l));
  w.close = have.at(-1).c;
  w.ret5Pct = pct(w.close, w.open);
  const range = w.orHigh - w.orLow;
  w.closePos = range > 0 ? (w.close - w.orLow) / range : 0.5;
  w.upperWickPct = range > 0 ? ((w.orHigh - Math.max(w.open, w.close)) / range) * 100 : 0;
  w.lowerWickPct = range > 0 ? ((Math.min(w.open, w.close) - w.orLow) / range) * 100 : 0;
  const pv = sum(have.map((c) => c.v * c.c));
  w.volume = tot.volume;
  w.dollar = tot.dollar;
  w.vwap = barsBetween(series, from, to).reduce((s, b) => s + (b.vw ?? b.c ?? 0) * b.v, 0) / Math.max(1, tot.volume) || pv / Math.max(1, tot.volume);
  w.vwapDistPct = pct(w.close, w.vwap);
  w.minuteVolumes = candles.map((c) => (c ? c.v : null));
  w.minuteReturns = candles.map((c) => (c ? pct(c.c, c.o) : null));
  w.auction = scope?.feed === 'iex'
    ? { policy: 'IEX feed: no Nasdaq opening-cross volume in this window', separated: true, volume: 0 }
    : series.source === 'trades'
      ? { policy: 'auction prints identified by trade condition and excluded from continuous volume', separated: true, volume: sum(have.map((c) => c.auctionV ?? 0)) }
      : { policy: 'minute bars: 09:30 bar includes an inseparable opening-cross contribution', separated: false, volume: null };
  w.continuousVolume = w.auction.separated ? w.volume - (w.auction.volume ?? 0) : null;
  const history = (inst.history ?? []).map((h) => ({ date: h.date, series: buildSeries({ scope: h.scope ?? scope, trades: h.trades, bars: h.bars, coverage: h.coverage }) }));
  w.rvol = sameTimeRvol({ today: series, history, date, t: to, startTime: '09:30:00', corporateActions: inst.corporateActions, config: { floorShares: 5_000 } });
  const prevClose = inst.prevClose?.price;
  w.officialOpenGapPct = pct(w.open, prevClose);
  w.atr14 = pre?.hist?.atr14 ?? null;
  w.orRangeAtr = w.atr14 ? range / w.atr14 : null;
  w.vwapExtensionAtr = w.atr14 ? (w.close - w.vwap) / w.atr14 : null;
  const pmRate = pre?.vol30 != null ? pre.vol30 / 30 : null;
  w.transition = pmRate ? (w.volume / 5) / Math.max(1, pmRate) : null; // opening volume rate vs the last 30 pre-market minutes
  const q = quoteFeatures(inst.today?.quotes, publishAt, { roundLot: inst.meta?.roundLot ?? 100, sizeUnit: scope?.quoteSizeUnit ?? 'shares', lookbackMs: 5 * MIN });
  w.quote = q;
  w.spreadChange = q.medianSpreadBps != null && pre?.quote?.medianSpreadBps ? q.medianSpreadBps / pre.quote.medianSpreadBps : null;
  w.ltp = w.close;
  return w;
}

/** Benchmarks' window returns: { QQQ: { ret5Pct }, XLK: {…} }. */
export const windowReturn = (w) => (w?.available ? { ret5Pct: w.ret5Pct, vwapDistPct: w.vwapDistPct } : null);

const r2 = (n) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(2));

/**
 * Confirmation score for direction `dir`, with explanations. `pre`: the pre-market score
 * for that direction (scoreDirection output) — used only to report contradiction.
 */
export function confirmOpening(w, dir, { market = {}, sectorEtf = null, pre = null } = {}) {
  if (!w?.available) return { score: null, verdict: 'no data', reasons: [w?.reason ?? 'opening window unavailable'], factors: [] };
  const factors = [];
  const add = (key, group, label, value, detail) => factors.push({ key, group, label, value: value == null ? null : clamp(value, 0, 1), detail, status: value == null ? 'missing' : 'used' });
  const move = dir * w.ret5Pct;
  add('direction', 'price', 'Move since the open in direction', 0.5 + 0.5 * clamp(move / 1, -1, 1), `${r2(w.ret5Pct)}% open→09:35`);
  add('closePos', 'price', 'Close location in the 5-minute range', dir > 0 ? w.closePos : 1 - w.closePos, `close at ${Math.round(w.closePos * 100)}% of the range`);
  const wick = dir > 0 ? w.upperWickPct : w.lowerWickPct;
  add('wick', 'price', 'Rejection wick against direction', 1 - clamp(wick / 50, 0, 1), `${r2(wick)}% of the range`);
  const consistent = w.minuteReturns.filter((r) => r != null && Math.sign(r) === dir).length;
  add('consistency', 'price', 'Minutes moving in direction', consistent / 5, `${consistent} of 5 minutes`);
  add('rvol', 'volume', 'Opening-window RVOL', w.rvol?.ok ? 0.5 + 0.5 * clamp(Math.log(w.rvol.rvol) / Math.log(3), -1, 1) * (move > 0 ? 1 : -1) : null, w.rvol?.ok ? `RVOL ${r2(w.rvol.rvol)} over ${w.rvol.sample} sessions (amplifies the price move)` : w.rvol?.reason);
  // Push vs pullback volume inside the window.
  let push = 0; let pull = 0; let pn = 0; let qn = 0;
  for (const c of w.candles) { if (!c || c.c === c.o) continue; if (Math.sign(c.c - c.o) === dir) { push += c.v; pn++; } else { pull += c.v; qn++; } }
  const ratio = pn && qn ? (push / pn) / (pull / qn) : pn ? 3 : qn ? 0.33 : null;
  add('pushPull', 'volume', 'Push vs pullback volume (window)', ratio == null ? null : 0.5 + 0.5 * clamp(Math.log(ratio) / Math.log(2), -1, 1), `ratio ${r2(ratio)}`);
  add('vwap', 'vwap', 'On the right side of regular-session VWAP', 0.5 + 0.5 * clamp((dir * (w.vwapDistPct ?? 0)) / 0.3, -1, 1), `${r2(w.vwapDistPct)}% from session VWAP ${r2(w.vwap)}`);
  add('extension', 'vwap', 'Not over-extended from VWAP', w.vwapExtensionAtr == null ? null : 1 - clamp((dir * w.vwapExtensionAtr - 0.5) / 1, 0, 1), `${r2(w.vwapExtensionAtr)} ATR from VWAP`);
  const qqq = market.QQQ?.ret5Pct;
  add('market', 'market', 'QQQ in the same direction', qqq == null ? null : 0.5 + 0.5 * clamp((dir * qqq) / 0.3, -1, 1), `QQQ ${r2(qqq)}% in the window`);
  const sec = sectorEtf ? market[sectorEtf]?.ret5Pct : null;
  add('sector', 'market', 'Sector ETF in the same direction', sec == null ? null : 0.5 + 0.5 * clamp((dir * sec) / 0.4, -1, 1), sectorEtf ? `${sectorEtf} ${r2(sec)}%` : 'no sector mapping');
  add('liquidity', 'liquidity', 'Spread stable vs pre-market', w.spreadChange == null ? null : 1 - clamp((w.spreadChange - 1) / 2, 0, 1), `opening spread ${r2(w.spreadChange)}× the pre-market median`);
  const groupsW = { price: 30, volume: 30, vwap: 15, market: 15, liquidity: 10 };
  const groups = {};
  for (const [gk, gw] of Object.entries(groupsW)) {
    const vals = factors.filter((x) => x.group === gk && x.value != null).map((x) => x.value);
    groups[gk] = { weight: gw, score: vals.length ? mean(vals) : null };
  }
  const usable = Object.values(groups).filter((x) => x.score != null);
  const totalW = sum(Object.values(groupsW));
  const usableW = sum(usable.map((x) => x.weight));
  const raw = usableW ? (100 * sum(usable.map((x) => x.weight * x.score))) / usableW : null;
  const coverage = usableW / totalW;
  const score = raw == null ? null : Math.round(50 + (raw - 50) * coverage);
  const reasons = [];
  let verdict;
  const contradiction = move <= -0.3 || (dir * (w.vwapDistPct ?? 0) < -0.1 && (w.rvol?.ok ? w.rvol.rvol >= 1 : true));
  if (contradiction) { verdict = 'rejected'; reasons.push(move <= -0.3 ? `moved ${r2(w.ret5Pct)}% against the setup` : 'trading on the wrong side of VWAP with normal-or-heavy volume'); }
  else if (Math.abs(w.ret5Pct) < 0.3 && Math.abs(w.vwapDistPct ?? 0) < 0.1) { verdict = 'unconfirmed'; reasons.push('flat open: no material move either way'); }
  else if (score >= 65) verdict = 'confirmed';
  else if (score >= 50) verdict = 'weak';
  else { verdict = 'rejected'; reasons.push(`confirmation score ${score}`); }
  if (!w.complete) reasons.push(`${w.missingMinutes} window minute(s) not observed: window incomplete`);
  if (pre && pre.adjustedScore >= 65 && verdict === 'rejected') reasons.push(`pre-market score ${pre.adjustedScore} downgraded: the open contradicts it`);
  return { score, rawScore: raw == null ? null : Math.round(raw), coverage, verdict, reasons, factors, groups };
}
