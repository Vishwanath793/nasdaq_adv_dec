/**
 * Pre-market feature engine (pure). computeFeatures(inst, asOf, ctx) uses only
 * records available at `asOf` and returns raw features with units, lineage and
 * explicit missing reasons. Scoring (conviction.js) decides what counts.
 *
 * Indicators are computed locally from bars/trades/quotes, never fetched.
 */

import { etToUtc, etParts } from './clock.js';
import { buildSeries, barsBetween, totals, minuteGrid, observedFraction, coverageGaps, lastPrice } from './series.js';
import { sameTimeRvol, expectedPerMinute } from './baseline.js';
import { classifyTrades } from './orderflow.js';
import { auctionFeatures, normalizeNoii } from './auction.js';
import { median, mean, stdev, sum, isNum } from './stats.js';

export const FEATURE_VERSION = 'feat-1.0.0';

const MIN = 60_000;
const pct = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? ((a - b) / b) * 100 : null);

/** Wilder ATR(14) from completed daily bars (oldest first). */
export function atr(daily, n = 14) {
  if (!daily || daily.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < daily.length; i++) {
    const d = daily[i];
    const pc = daily[i - 1].c;
    trs.push(Math.max(d.h - d.l, Math.abs(d.h - pc), Math.abs(d.l - pc)));
  }
  let a = mean(trs.slice(0, n));
  for (let i = n; i < trs.length; i++) a = (a * (n - 1) + trs[i]) / n;
  return a;
}

const sma = (daily, n) => (daily.length >= n ? mean(daily.slice(-n).map((d) => d.c)) : null);

/** Daily-history context (no intraday data needed). */
export function historicalContext(daily, prevClose) {
  const out = { missing: {} };
  if (!daily?.length) { out.missing.history = 'no daily history'; return out; }
  const last = daily.at(-1);
  out.atr14 = atr(daily);
  if (out.atr14 == null) out.missing.atr14 = `insufficient history (${daily.length} sessions, need 15)`;
  out.realizedVol20 = daily.length >= 21 ? stdev(daily.slice(-21).map((d, i, a) => (i ? Math.log(d.c / a[i - 1].c) : null)).slice(1)) * Math.sqrt(252) * 100 : null;
  out.prevHigh = last.h;
  out.prevLow = last.l;
  out.closeLocation = last.h > last.l ? (last.c - last.l) / (last.h - last.l) : null;
  out.ret5 = daily.length > 5 ? pct(last.c, daily.at(-6).c) : null;
  out.ret20 = daily.length > 20 ? pct(last.c, daily.at(-21).c) : null;
  const vols = daily.slice(-21, -1).map((d) => d.v);
  out.prevDayRvol = vols.length >= 10 && median(vols) > 0 ? last.v / median(vols) : null;
  out.avgDailyVolume20 = daily.length >= 20 ? median(daily.slice(-20).map((d) => d.v)) : null;
  out.avgDailyDollar20 = daily.length >= 20 ? median(daily.slice(-20).map((d) => d.v * d.c)) : null;
  out.volumeTrend5 = daily.length >= 10 ? mean(daily.slice(-5).map((d) => d.v)) / Math.max(1, mean(daily.slice(-10, -5).map((d) => d.v))) : null;
  for (const n of [20, 50, 200]) {
    const m = sma(daily, n);
    out[`distSma${n}`] = m && prevClose ? pct(prevClose, m) : null;
    if (m == null) out.missing[`distSma${n}`] = `fewer than ${n} sessions`;
  }
  // Historical gap behaviour: sessions that opened ≥2% away from the prior close; did the open-to-close move continue the gap?
  const gaps = [];
  for (let i = 1; i < daily.length; i++) {
    const g = pct(daily[i].o, daily[i - 1].c);
    if (g != null && Math.abs(g) >= 2) gaps.push(Math.sign(g) === Math.sign(daily[i].c - daily[i].o) ? 1 : 0);
  }
  out.gapSample = gaps.length;
  out.gapContinuationRate = gaps.length >= 5 ? mean(gaps) : null;
  if (out.gapContinuationRate == null) out.missing.gapContinuationRate = `only ${gaps.length} prior ≥2% gaps`;
  return out;
}

/** Latest quote at asOf and liquidity measures over the last `lookbackMs`. */
export function quoteFeatures(quotes, asOf, { roundLot = 100, sizeUnit = 'shares', lookbackMs = 15 * MIN } = {}) {
  const known = (quotes ?? []).filter((q) => (q.availableAt ?? q.t) <= asOf && q.t < asOf).sort((a, b) => a.t - b.t);
  if (!known.length) return { available: false, reason: 'no quotes received' };
  const mult = sizeUnit === 'round_lots' ? roundLot : 1;
  const q = known.at(-1);
  const mid = q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null;
  const recent = known.filter((x) => x.t >= asOf - lookbackMs);
  const spreads = recent.filter((x) => x.bid > 0 && x.ask > x.bid).map((x) => ((x.ask - x.bid) / ((x.ask + x.bid) / 2)) * 10_000);
  const crossed = recent.filter((x) => x.bid > 0 && x.ask > 0 && x.bid > x.ask).length;
  const locked = recent.filter((x) => x.bid > 0 && x.bid === x.ask).length;
  const sizes = recent.map((x) => (x.bidSize + x.askSize) * mult);
  return {
    available: true,
    bid: q.bid, ask: q.ask, mid,
    bidSizeShares: q.bidSize * mult, askSizeShares: q.askSize * mult,
    sizeUnit, roundLot,
    quoteAgeMs: asOf - q.t,
    spread: q.ask - q.bid,
    spreadBps: mid && q.ask >= q.bid ? ((q.ask - q.bid) / mid) * 10_000 : null,
    medianSpreadBps: spreads.length ? median(spreads) : null,
    // Spread stability: 1 = constant spread, falls toward 0 as the spread varies more relative to its median.
    spreadStability: spreads.length >= 5 ? 1 / (1 + (stdev(spreads) ?? 0) / Math.max(1, median(spreads))) : null,
    topOfBookImbalance: q.bidSize + q.askSize > 0 ? (q.bidSize - q.askSize) / (q.bidSize + q.askSize) : null,
    crossedShare: recent.length ? crossed / recent.length : 0,
    lockedShare: recent.length ? locked / recent.length : 0,
    crossedNow: q.bid > 0 && q.ask > 0 && q.bid > q.ask,
    medianTopSizeShares: sizes.length ? median(sizes) : null,
    quoteCount: recent.length,
  };
}

/** Running VWAP over bars, plus the VWAP-acceptance family. */
function vwapFamily(bars, dir) {
  let pv = 0; let v = 0;
  let above = 0; let below = 0; let volAbove = 0; let volBelow = 0; let crossings = 0; let lastSide = 0;
  const crossTimes = [];
  const path = [];
  for (const b of bars) {
    if (b.c == null) continue;
    pv += (b.vw ?? b.c) * b.v; v += b.v;
    const vwap = v ? pv / v : null;
    path.push({ t: b.t, vwap });
    const side = b.c > vwap ? 1 : b.c < vwap ? -1 : 0;
    if (side > 0) { above++; volAbove += b.v; } else if (side < 0) { below++; volBelow += b.v; }
    if (side && lastSide && side !== lastSide) { crossings++; crossTimes.push(b.t); }
    if (side) lastSide = side;
  }
  const vwap = v ? pv / v : null;
  const n = above + below;
  const p15 = path.filter((p) => p.t <= (path.at(-1)?.t ?? 0) - 15 * MIN).at(-1);
  return {
    vwap,
    vwapSlopeBps15: p15?.vwap && vwap ? ((vwap - p15.vwap) / p15.vwap) * 10_000 : null,
    timeAboveVwap: n ? above / n : null,
    volumeAboveVwapShare: volAbove + volBelow ? volAbove / (volAbove + volBelow) : null,
    vwapCrossings: crossings,
    // Crossings in the last 60 minutes: the choppiness measure (a long session naturally accumulates crossings).
    vwapCrossings60: crossTimes.filter((t) => t >= (bars.at(-1)?.t ?? 0) - 59 * MIN).length,
    lastSide,
    dirAcceptance: n ? (dir > 0 ? above / n : below / n) : null,
  };
}

/** Volume-at-price; exact from trades, estimated (volume spread evenly over each bar's range) from bars. */
export function volumeProfile({ trades = null, bars = [] }, bins = 24) {
  const pts = [];
  let estimated = false;
  if (trades?.length) for (const t of trades) pts.push([t.price, t.size]);
  else {
    estimated = true;
    for (const b of bars) {
      if (b.l == null || b.h == null || !b.v) continue;
      const k = Math.max(1, Math.min(8, Math.round((b.h - b.l) / Math.max(1e-9, b.c * 0.0005))));
      for (let i = 0; i < k; i++) pts.push([b.l + ((b.h - b.l) * (i + 0.5)) / k, b.v / k]);
    }
  }
  if (!pts.length) return null;
  const lo = Math.min(...pts.map((p) => p[0]));
  const hi = Math.max(...pts.map((p) => p[0]));
  if (hi <= lo) return { estimated, poc: lo, valueLow: lo, valueHigh: hi, bins: [{ price: lo, volume: sum(pts.map((p) => p[1])) }] };
  const w = (hi - lo) / bins;
  const hist = Array.from({ length: bins }, (_, i) => ({ price: lo + w * (i + 0.5), volume: 0 }));
  for (const [p, v] of pts) hist[Math.min(bins - 1, Math.floor((p - lo) / w))].volume += v;
  const total = sum(hist.map((h) => h.volume));
  let pocI = 0;
  hist.forEach((h, i) => { if (h.volume > hist[pocI].volume) pocI = i; });
  // Value area: expand from the POC until 70% of volume is inside.
  let a = pocI; let b = pocI; let inside = hist[pocI].volume;
  while (inside < total * 0.7 && (a > 0 || b < bins - 1)) {
    const left = a > 0 ? hist[a - 1].volume : -1;
    const right = b < bins - 1 ? hist[b + 1].volume : -1;
    if (right >= left) inside += hist[++b].volume; else inside += hist[--a].volume;
  }
  return { estimated, poc: hist[pocI].price, valueLow: hist[a].price - w / 2, valueHigh: hist[b].price + w / 2, bins: hist };
}

/** Secondary research indicators from minute bars. Derived transformations, not independent confirmations. */
function researchIndicators(bars) {
  const b = bars.filter((x) => x.c != null && x.h != null);
  if (b.length < 15) return { missing: 'fewer than 15 active minute bars' };
  let obv = 0; const obvPath = [0];
  for (let i = 1; i < b.length; i++) { obv += Math.sign(b[i].c - b[i - 1].c) * b[i].v; obvPath.push(obv); }
  const totalV = sum(b.map((x) => x.v)) || 1;
  const mfm = (x) => (x.h > x.l ? ((x.c - x.l) - (x.h - x.c)) / (x.h - x.l) : 0);
  const last20 = b.slice(-20);
  const cmf = sum(last20.map((x) => mfm(x) * x.v)) / Math.max(1, sum(last20.map((x) => x.v)));
  let pos = 0; let neg = 0;
  const last15 = b.slice(-15);
  for (let i = 1; i < last15.length; i++) {
    const tp = (last15[i].h + last15[i].l + last15[i].c) / 3;
    const ptp = (last15[i - 1].h + last15[i - 1].l + last15[i - 1].c) / 3;
    if (tp > ptp) pos += tp * last15[i].v; else if (tp < ptp) neg += tp * last15[i].v;
  }
  let vpt = 0;
  for (let i = 1; i < b.length; i++) vpt += b[i].v * ((b[i].c - b[i - 1].c) / b[i - 1].c);
  return {
    obvNorm: obv / totalV, // −1..1: share of volume on up-closes minus down-closes
    cmf20: cmf,
    mfi14: pos + neg > 0 ? (100 * pos) / (pos + neg) : 50,
    adNorm: sum(b.map((x) => mfm(x) * x.v)) / totalV,
    vptPct: vpt / totalV * 100,
  };
}

/**
 * Main entry. inst: { symbol, meta, scope, prevClose:{price,date,issue?}, daily:[…oldest→newest completed],
 *   today:{ trades?, bars?, coverage, quotes, feedSwitches }, history:[{date,bars,trades?,coverage,scope}] (most recent first),
 *   news:[…], halts:[…], noii:[…], corporateActions:[…], float:{value, asOf, kind}, borrow:{…}, prevAfterHours:{last}, newsChecked }
 * ctx: { date, times, market (benchmarks), orderShares }
 */
export function computeFeatures(inst, asOf, ctx) {
  const { date, times } = ctx;
  const scope = inst.scope;
  const venueStart = scope?.venueStart ?? '04:00:00';
  const start = Math.max(times.preMarketStart, etToUtc(date, venueStart));
  const end = Math.min(asOf, times.open);
  const missing = {};
  const f = { symbol: inst.symbol, asOf, featureVersion: FEATURE_VERSION, scope, missing, lineage: {} };

  const series = buildSeries({ scope, trades: inst.today?.trades, bars: inst.today?.bars, coverage: inst.today?.coverage, feedSwitches: inst.today?.feedSwitches }, asOf);
  f.series = series;
  const history = (inst.history ?? []).map((h) => ({ date: h.date, series: buildSeries({ scope: h.scope ?? scope, trades: h.trades, bars: h.bars, coverage: h.coverage }) }));
  f.lineage.volume = { provider: scope?.provider, feed: scope?.feed, source: series.source, conditionPolicy: scope?.conditionPolicy };

  // ---- data quality / freshness
  const covEnd = series.coverage.length ? Math.max(...series.coverage.map((c) => c.to)) : null;
  f.dataCutoff = scope?.delayMs ? asOf - scope.delayMs : covEnd;
  f.cutoffLagMs = f.dataCutoff != null ? asOf - f.dataCutoff : null;
  f.preMarketObserved = end > start ? observedFraction(series, start, end) : 0;
  f.coverageGaps = coverageGaps(series, start, end).filter((g) => g.to - g.from >= MIN);
  f.feedSwitches = series.feedSwitches;
  f.seriesStats = series.stats;

  // ---- price structure
  const prev = inst.prevClose?.price ?? null;
  f.prevClose = prev;
  f.prevCloseIssue = inst.prevClose?.issue ?? null;
  if (!prev) missing.prevClose = 'previous official close unavailable';
  const lp = lastPrice(series, asOf);
  const quotes = quoteFeatures(inst.today?.quotes, asOf, { roundLot: inst.meta?.roundLot ?? 100, sizeUnit: scope?.quoteSizeUnit ?? 'shares' });
  f.quote = quotes;
  f.last = lp?.price ?? null;
  f.lastTradeAgeMs = lp ? asOf - lp.t : null;
  // The reference price for the gap: last eligible trade, else the quote midpoint (labelled).
  f.refPrice = f.last ?? quotes.mid ?? null;
  f.refPriceSource = f.last != null ? 'last eligible trade' : quotes.mid != null ? 'quote midpoint (no trades yet)' : null;
  f.gapPct = prev && f.refPrice ? pct(f.refPrice, prev) : null;
  if (f.gapPct == null) missing.gapPct = prev ? 'no pre-market trade or quote' : 'no previous close';
  const hist = historicalContext(inst.daily ?? [], prev);
  Object.assign(f, { hist });
  Object.assign(missing, Object.fromEntries(Object.entries(hist.missing).map(([k, v]) => [`hist.${k}`, v])));
  f.gapAtr = f.gapPct != null && hist.atr14 ? ((f.refPrice - prev) / hist.atr14) : null;
  f.afterHoursMovePct = inst.prevAfterHours?.last && prev ? pct(inst.prevAfterHours.last, prev) : null;
  f.overnightMovePct = inst.overnight?.last && inst.prevAfterHours?.last ? pct(inst.overnight.last, inst.prevAfterHours.last) : null;

  const pmBars = barsBetween(series, start, end).filter((b) => b.c != null);
  f.pm = pmBars.length ? {
    open: pmBars[0].o, high: Math.max(...pmBars.map((b) => b.h)), low: Math.min(...pmBars.map((b) => b.l)), close: pmBars.at(-1).c,
  } : null;
  const dir0 = Math.sign(f.gapPct ?? 0) || 1;
  const vw = vwapFamily(pmBars, dir0);
  f.pmVwap = vw.vwap;
  f.vwap = vw;
  f.distVwapPct = f.refPrice && vw.vwap ? pct(f.refPrice, vw.vwap) : null;
  if (f.pm) {
    f.distPmHighPct = pct(f.refPrice, f.pm.high);
    f.distPmLowPct = pct(f.refPrice, f.pm.low);
    // Pullback depth from the extreme in the gap direction, as a share of the move from the previous close.
    const ext = dir0 > 0 ? f.pm.high : f.pm.low;
    f.pullbackDepth = prev && ext !== prev ? (ext - f.refPrice) / (ext - prev) : null;
  }
  const priceAt = (t) => { const b = barsBetween(series, start, t).filter((x) => x.c != null).at(-1); return b?.c ?? null; };
  f.returns = {};
  for (const m of [1, 5, 15, 30, 60]) f.returns[`r${m}`] = f.refPrice && priceAt(end - m * MIN) ? pct(f.refPrice, priceAt(end - m * MIN)) : null;
  // Trend consistency: share of 5-minute steps over the last 30 minutes moving in the gap direction.
  const steps = [];
  for (let k = 6; k >= 1; k--) {
    const a = priceAt(end - k * 5 * MIN); const b = priceAt(end - (k - 1) * 5 * MIN);
    if (a && b && a !== b) steps.push(Math.sign(b - a) === dir0 ? 1 : 0);
  }
  f.trendConsistency = steps.length >= 3 ? mean(steps) : null;
  f.prevRangePosition = f.refPrice && hist.prevHigh > hist.prevLow ? (f.refPrice - hist.prevLow) / (hist.prevHigh - hist.prevLow) : null;
  f.beyondPrevRange = f.refPrice && hist.prevHigh ? (f.refPrice > hist.prevHigh ? 1 : f.refPrice < hist.prevLow ? -1 : 0) : null;

  // ---- A. absolute participation
  const tot = totals(series, start, end);
  f.cumVolume = tot.volume;
  f.cumDollar = tot.dollar;
  f.cumDollarExact = tot.dollarExact;
  f.tradeCount = tot.trades;
  f.avgTradeSize = tot.trades ? tot.volume / tot.trades : null;
  for (const m of [1, 5, 15, 30]) {
    const t = totals(series, end - m * MIN, end);
    f[`vol${m}`] = t.volume;
    f[`dollar${m}`] = t.dollar;
  }
  const grid = minuteGrid(series, start, end);
  const observedMinutes = grid.filter((g) => g.state !== 'missing');
  const activeMinutes = grid.filter((g) => g.state === 'traded');
  f.activeMinutes = activeMinutes.length;
  f.observedMinutes = observedMinutes.length;
  f.activeShare = observedMinutes.length ? activeMinutes.length / observedMinutes.length : null;
  f.genuineZeroMinutes = grid.filter((g) => g.state === 'zero').length;
  f.missingMinutes = grid.filter((g) => g.state === 'missing').length;
  if (!series.coverage.length) missing.participation = 'no observed pre-market data (feed not connected or not queried)';

  // ---- B. same-time relative participation
  const rvArgs = { today: series, history, date, t: end, corporateActions: inst.corporateActions };
  f.rvol = sameTimeRvol({ ...rvArgs, startTime: etParts(start).time });
  f.rvolDollar = sameTimeRvol({ ...rvArgs, startTime: etParts(start).time, measure: 'dollar' });
  f.rvol15 = sameTimeRvol({ ...rvArgs, lookbackMs: 15 * MIN });
  if (!f.rvol.ok) missing.rvol = f.rvol.reason;

  // ---- C. acceleration (clock-normalised: each window vs its own same-clock expectation)
  const exp = history.length ? expectedPerMinute({ today: series, history, date, from: Math.floor(start / MIN) * MIN, to: end }) : [];
  const expSum = (a, b) => { const xs = exp.filter((e) => e.t >= a && e.t < b); return xs.length && xs.every((e) => e.expected != null) ? sum(xs.map((e) => e.expected)) : null; };
  const e15 = expSum(end - 15 * MIN, end); const p15 = expSum(end - 30 * MIN, end - 15 * MIN);
  const a15 = totals(series, end - 15 * MIN, end).volume; const pa15 = totals(series, end - 30 * MIN, end - 15 * MIN).volume;
  const floorV = 200;
  f.accel = (e15 != null && p15 != null) ? {
    recentVsExpected: a15 / Math.max(floorV, e15),
    priorVsExpected: pa15 / Math.max(floorV, p15),
    ratio: (a15 / Math.max(floorV, e15)) / Math.max(0.05, pa15 / Math.max(floorV, p15)),
  } : null;
  if (f.accel) f.accel.state = f.accel.ratio >= 1.3 ? 'expanding' : f.accel.ratio <= 0.7 ? 'fading' : 'steady';
  else missing.accel = 'no same-clock per-minute baseline';
  f.rawRateRatio = pa15 > 0 ? a15 / pa15 : null; // display only: not clock-normalised

  // ---- D. persistence and concentration
  const expMap = new Map(exp.map((e) => [e.t, e.expected]));
  const firstActive = activeMinutes[0]?.t ?? null;
  const since = firstActive != null ? grid.filter((g) => g.t >= firstActive && g.state !== 'missing') : [];
  const meaningful = (g) => g.state === 'traded' && (g.bar.n == null ? g.bar.v > 0 : g.bar.n >= 1) && g.bar.v >= Math.max(1, (expMap.get(g.t) ?? 0) * 0.25);
  f.persistence = since.length ? since.filter(meaningful).length / since.length : null;
  let run = 0; let best = 0;
  for (const g of grid) { if (g.state === 'traded') { run++; best = Math.max(best, run); } else run = 0; }
  f.longestActiveRun = best;
  const minuteVols = activeMinutes.map((g) => g.bar.v);
  f.largestMinuteShare = tot.volume ? Math.max(0, ...minuteVols) / tot.volume : null;
  // Trade-level detail: the canonical trades (when the series is built from trades) or a live trade stream kept
  // alongside canonical minute bars (tradeDetail) — used for concentration and the aggressor estimate only.
  const tradeSrc = inst.today?.trades ?? inst.today?.tradeDetail ?? null;
  const pmTrades = tradeSrc ? tradeSrc.filter((t) => t.t >= start && t.t < end && (t.availableAt ?? t.t) <= asOf && !t.correction) : null;
  if (pmTrades?.length) {
    const sizes = pmTrades.map((t) => t.size).sort((a, b) => b - a);
    f.top3PrintShare = sum(sizes.slice(0, 3)) / Math.max(1, sum(sizes));
    f.tradeSizeP50 = median(sizes);
    f.tradeSizeMax = sizes[0];
  } else { f.top3PrintShare = null; missing.top3PrintShare = 'no trade-level data (bars only)'; }
  // After the biggest-volume minute: did activity persist (vs a one-print spike followed by silence)?
  if (activeMinutes.length) {
    const spike = activeMinutes.reduce((a, g) => (g.bar.v > a.bar.v ? g : a));
    const after = grid.filter((g) => g.t > spike.t && g.state !== 'missing');
    f.postSpikePersistence = after.length >= 5 ? after.filter((g) => g.state === 'traded').length / after.length : null;
    f.spikeMinute = spike.t;
  }
  f.lastTradeGapMin = f.lastTradeAgeMs != null ? f.lastTradeAgeMs / MIN : null;

  // ---- E. price–volume agreement, for both directions
  const pv = (dir) => {
    let pushV = 0; let pushN = 0; let pullV = 0; let pullN = 0;
    for (const g of activeMinutes) {
      const b = g.bar;
      if (b.o == null || b.c == null || b.c === b.o) continue;
      const e = Math.max(floorV, expMap.get(g.t) ?? median(minuteVols) ?? 1);
      if (Math.sign(b.c - b.o) === dir) { pushV += b.v / e; pushN++; } else { pullV += b.v / e; pullN++; }
    }
    const pushRate = pushN ? pushV / pushN : null;
    const pullRate = pullN ? pullV / pullN : null;
    const progress = f.gapPct != null ? dir * f.gapPct : null;
    const atrProgress = f.gapAtr != null ? dir * f.gapAtr : null;
    return { pushRate, pullRate, pushMinutes: pushN, pullMinutes: pullN, pushPullRatio: pushRate != null && pullRate ? pushRate / pullRate : pushRate != null && !pullN ? 3 : null, progressPct: progress, progressAtr: atrProgress };
  };
  f.pvLong = pv(1);
  f.pvShort = pv(-1);
  // High-volume rejection: a heavy bar (≥3× its same-clock expectation) whose wick against the move is ≥60% of its range.
  // Heavy = ≥3× its same-clock expectation AND ≥2× the median of the last 60 active minutes; only bars with a
  // material range (≥0.2% of price) count, so tiny noise bars with long relative wicks are ignored.
  const recentVols = activeMinutes.filter((g) => g.t >= end - 60 * MIN).map((g) => g.bar.v);
  const recentMedian = median(recentVols) ?? 0;
  const heavy = activeMinutes.filter((g) => g.t >= end - 60 * MIN && g.bar.h > g.bar.l && (g.bar.h - g.bar.l) / g.bar.c >= 0.002
    && g.bar.v >= 3 * Math.max(floorV, expMap.get(g.t) ?? Infinity) && g.bar.v >= 2 * recentMedian);
  f.heavyRejections = { up: 0, down: 0 };
  for (const g of heavy) {
    const b = g.bar; const r = b.h - b.l;
    if ((b.h - Math.max(b.o, b.c)) / r >= 0.6) f.heavyRejections.up++; // rejected from above (bearish for longs)
    if ((Math.min(b.o, b.c) - b.l) / r >= 0.6) f.heavyRejections.down++;
  }
  // Breakout / failed break of the pre-market high (low) set before the last 15 minutes.
  const early = pmBars.filter((b) => b.t < end - 15 * MIN);
  const late = pmBars.filter((b) => b.t >= end - 15 * MIN);
  if (early.length >= 5 && late.length) {
    const eh = Math.max(...early.map((b) => b.h)); const el = Math.min(...early.map((b) => b.l));
    // A break must be material (beyond the earlier extreme by ≥0.15% or 0.1 ATR), and a failure means closing back inside by the same margin.
    const margin = Math.max(eh * 0.0015, (hist.atr14 ?? 0) * 0.1);
    const brokeUp = late.some((b) => b.h > eh + margin); const brokeDown = late.some((b) => b.l < el - margin);
    const lateV = sum(late.map((b) => b.v)) / late.length; const earlyV = sum(early.map((b) => b.v)) / early.length;
    f.breaks = {
      up: brokeUp ? { failed: f.refPrice < eh - margin, level: eh, volumeRatio: earlyV ? lateV / earlyV : null } : null,
      down: brokeDown ? { failed: f.refPrice > el + margin, level: el, volumeRatio: earlyV ? lateV / earlyV : null } : null,
    };
  } else f.breaks = null;

  // ---- G. volume profile
  f.profile = volumeProfile({ trades: pmTrades, bars: pmBars });

  // ---- H. float / capacity
  const fl = inst.float;
  if (fl?.value > 0) f.turnover = { value: tot.volume / fl.value, kind: fl.kind, asOf: fl.asOf };
  else { f.turnover = null; missing.turnover = 'no dated float or shares-outstanding figure'; }
  f.orderShareOfVol30 = ctx.orderShares && f.vol30 ? ctx.orderShares / f.vol30 : null;

  // ---- order flow estimate (trades + quotes only)
  if (pmTrades?.length && inst.today?.quotes?.length) {
    const of = classifyTrades(pmTrades, inst.today.quotes.filter((q) => (q.availableAt ?? q.t) <= asOf));
    f.orderflow = { ...of, trades: undefined };
  } else { f.orderflow = null; missing.orderflow = 'needs trade-level data with contemporaneous quotes'; }

  // ---- J. research family
  f.research = researchIndicators(pmBars);

  // ---- auction
  // Vendor messages are normalised here (side codes, placeholder near/far prices → unavailable).
  const noii = inst.noii ? inst.noii.map((m) => ('side' in m && 'insufficient' in m ? m : normalizeNoii(m, { convention: inst.noiiConvention ?? 'itch' }))) : null;
  f.auction = noii ? auctionFeatures(noii, asOf, {
    preMarketVwap: vw.vwap, preMarketMid: quotes.mid, preMarketReturnPct: f.gapPct, typicalCrossVolume: inst.typicalCrossVolume,
    stageTimes: { early: times.earlyAuction, main: times.main },
  }) : { available: false, reason: inst.noiiReason ?? 'NOII not available in this data profile (licensed feed)' };

  // ---- status
  const halts = (inst.halts ?? []).filter((h) => (h.firstSeenAt ?? h.haltAt) <= asOf && h.haltAt <= asOf);
  const active = halts.filter((h) => !h.resumeAt || h.resumeAt > asOf);
  f.halt = { halted: active.length > 0, current: active.at(-1) ?? null, today: halts.length, statusKnown: inst.haltsChecked !== false };
  f.borrow = inst.borrow ?? null;
  f.meta = inst.meta ?? {};
  f.newsChecked = inst.newsChecked !== false;
  f.news = inst.news ?? [];
  return f;
}
