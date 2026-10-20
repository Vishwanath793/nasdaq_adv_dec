/**
 * Canonical minute series for one instrument and one data scope (pure).
 *
 * A scope is { provider, feed, conditionPolicy, adjustment }. Everything that is
 * compared (today vs history, RVOL numerator vs denominator) must share it;
 * series from different scopes are never summed into a "total market" volume.
 *
 * Look-ahead protection: every record carries `availableAt` (when we could have
 * known it: local receive time for live data, publication time for REST/backfill).
 * buildSeries(…, asOf) ignores anything not yet available, including later
 * corrections, so a snapshot only ever sees what was known at the time.
 *
 * Missing vs zero: a minute with no bar is a genuine zero-volume minute only if
 * it lies inside an observed interval (stream connected, or the REST range
 * actually queried). Outside the observed intervals it is "not observed".
 */

import { minuteOf } from './clock.js';

/** Trade-condition policy (SIP/UTDF/CTA letter codes as used by Alpaca). Version it when it changes. */
export const CONDITION_POLICY = {
  version: 'cond-v1',
  // Reports, not executions: excluded from volume and price.
  notVolume: new Set(['M', 'Q', '9']),
  // Count toward volume but do not set the last-sale price, highs or lows.
  notPrice: new Set(['I', 'W', 'Z', 'U', '4', 'B', 'C', 'N', 'R', 'H', 'P', 'V', '7']),
  // Auction prints, kept separately when identifiable.
  auction: new Set(['O', '6', '5']),
};

export const scopeKey = (s) => (s ? `${s.provider}/${s.feed}/${s.conditionPolicy ?? CONDITION_POLICY.version}/${s.adjustment ?? 'raw'}` : 'unknown');
export const sameScope = (a, b) => scopeKey(a) === scopeKey(b);

const avail = (r) => r.availableAt ?? r.receivedAt ?? r.t;

/** Merge [from,to) intervals and clip them to an upper bound. */
export function mergeIntervals(list, upTo = Infinity) {
  const iv = list.map((x) => [x.from, Math.min(x.to, upTo)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out.at(-1);
    if (last && a <= last.to) last.to = Math.max(last.to, b);
    else out.push({ from: a, to: b });
  }
  return out;
}

/** Classify one trade under the condition policy. */
export function tradeEligibility(trade, policy = CONDITION_POLICY) {
  const c = trade.conditions ?? [];
  const volume = !c.some((x) => policy.notVolume.has(x));
  const price = volume && !c.some((x) => policy.notPrice.has(x));
  const auction = c.some((x) => policy.auction.has(x));
  return { volume, price, auction };
}

/**
 * Apply cancels/corrections known by asOf and drop duplicates.
 * Returns { trades, stats } with trades sorted by time.
 */
export function cleanTrades(trades, asOf = Infinity) {
  const stats = { duplicates: 0, cancelled: 0, corrected: 0 };
  const byId = new Map();
  const corrections = [];
  for (const t of trades) {
    if (avail(t) > asOf || t.t >= asOf) continue;
    if (t.correction) { corrections.push(t); continue; }
    const key = t.id ?? `${t.t}:${t.price}:${t.size}:${t.exchange ?? ''}`;
    if (byId.has(key)) { stats.duplicates++; continue; }
    byId.set(key, { ...t });
  }
  for (const c of corrections.sort((a, b) => avail(a) - avail(b))) {
    const orig = byId.get(c.correction.of);
    if (!orig) continue;
    if (c.correction.type === 'cancel') { byId.delete(c.correction.of); stats.cancelled++; }
    else { Object.assign(orig, { price: c.price ?? orig.price, size: c.size ?? orig.size, conditions: c.conditions ?? orig.conditions, corrected: true }); stats.corrected++; }
  }
  return { trades: [...byId.values()].sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id))), stats };
}

/** Aggregate clean trades into minute bars (volume-eligible trades only; price fields from price-eligible trades). */
export function tradesToBars(trades, policy = CONDITION_POLICY) {
  const bars = new Map();
  let auctionVolume = 0;
  const auctionPrints = [];
  for (const t of trades) {
    const e = tradeEligibility(t, policy);
    if (!e.volume) continue;
    if (e.auction) { auctionVolume += t.size; auctionPrints.push(t); }
    const m = minuteOf(t.t);
    let b = bars.get(m);
    if (!b) { b = { t: m, o: null, h: -Infinity, l: Infinity, c: null, v: 0, n: 0, pv: 0, auctionV: 0, largest: 0 }; bars.set(m, b); }
    b.v += t.size;
    b.n += 1;
    b.pv += t.price * t.size;
    b.largest = Math.max(b.largest, t.size);
    if (e.auction) b.auctionV += t.size;
    if (e.price) {
      if (b.o == null) b.o = t.price;
      b.h = Math.max(b.h, t.price);
      b.l = Math.min(b.l, t.price);
      b.c = t.price;
    }
  }
  const out = [...bars.values()].sort((a, b) => a.t - b.t).map((b) => ({
    t: b.t, o: b.o, h: b.o == null ? null : b.h, l: b.o == null ? null : b.l, c: b.c, v: b.v, n: b.n,
    vw: b.v ? b.pv / b.v : null, dollar: b.pv, dollarExact: true, auctionV: b.auctionV, largest: b.largest,
  }));
  return { bars: out, auctionVolume, auctionPrints };
}

/** Bars from a provider: drop exact duplicates, later revisions of a minute replace earlier ones. */
export function cleanBars(bars, asOf = Infinity) {
  const stats = { duplicates: 0, revisions: 0 };
  const byMinute = new Map();
  for (const b of [...bars].sort((x, y) => avail(x) - avail(y))) {
    if (avail(b) > asOf || b.t >= asOf) continue;
    // A bar for minute m is complete at m + 60 s; a partial current-minute bar is allowed but flagged.
    const prev = byMinute.get(b.t);
    if (prev) {
      if (prev.v === b.v && prev.c === b.c && prev.h === b.h && prev.l === b.l) { stats.duplicates++; continue; }
      stats.revisions++;
    }
    const dollarExact = b.vw != null;
    byMinute.set(b.t, { ...b, dollar: b.vw != null ? b.vw * b.v : (b.c ?? 0) * b.v, dollarExact, partial: b.t + 60_000 > asOf });
  }
  return { bars: [...byMinute.values()].sort((a, b) => a.t - b.t), stats };
}

/**
 * Cumulative-volume snapshots (e.g. a "volume so far today" field polled every
 * few seconds) become per-minute increments: only positive deltas count, so a
 * repeated snapshot adds nothing; a decrease is a reset/feed change and is flagged.
 */
export function cumulativeToIncrements(snapshots, asOf = Infinity) {
  const out = new Map();
  let last = null;
  const flags = [];
  for (const s of [...snapshots].filter((x) => avail(x) <= asOf && x.t < asOf).sort((a, b) => a.t - b.t)) {
    if (last == null) { last = s.cumVolume; continue; } // the first snapshot only sets the reference
    const d = s.cumVolume - last;
    if (d < 0) { flags.push({ t: s.t, issue: 'cumulative volume decreased (reset or feed switch)' }); last = s.cumVolume; continue; }
    if (d > 0) {
      const m = minuteOf(s.t);
      out.set(m, (out.get(m) ?? 0) + d);
    }
    last = s.cumVolume;
  }
  return { increments: [...out.entries()].map(([t, v]) => ({ t, v })), flags };
}

/**
 * Build the series known at `asOf` from raw records.
 * input: { scope, trades?, bars?, coverage?: [{from,to}], feedSwitches?: [{t, from, to}] }
 * Trades take precedence over bars when both exist (one canonical source per calculation).
 */
export function buildSeries(input, asOf = Infinity) {
  const { scope } = input;
  let bars;
  let stats;
  let auctionVolume = null;
  let source;
  if (input.trades?.length) {
    const clean = cleanTrades(input.trades, asOf);
    const agg = tradesToBars(clean.trades);
    bars = agg.bars;
    auctionVolume = agg.auctionVolume;
    stats = { ...clean.stats, trades: clean.trades.length };
    source = 'trades';
  } else {
    const clean = cleanBars(input.bars ?? [], asOf);
    bars = clean.bars;
    stats = clean.stats;
    source = 'bars';
  }
  const coverage = mergeIntervals((input.coverage ?? []).filter((c) => avail(c) <= asOf || c.availableAt == null), asOf);
  const feedSwitches = (input.feedSwitches ?? []).filter((f) => f.t < asOf);
  return { scope, source, bars, coverage, stats, auctionVolume, feedSwitches, asOf };
}

const lowerBound = (bars, t) => {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Bars with from <= t < to. */
export function barsBetween(series, from, to) {
  const i = lowerBound(series.bars, from);
  const j = lowerBound(series.bars, to);
  return series.bars.slice(i, j);
}

/** Observed milliseconds of [from, to). */
export function observedMs(series, from, to) {
  let ms = 0;
  for (const c of series.coverage) ms += Math.max(0, Math.min(to, c.to) - Math.max(from, c.from));
  return ms;
}
export const observedFraction = (series, from, to) => (to > from ? observedMs(series, from, to) / (to - from) : 0);

/** Gaps (unobserved sub-intervals) inside [from, to). */
export function coverageGaps(series, from, to) {
  const gaps = [];
  let cursor = from;
  for (const c of series.coverage) {
    if (c.to <= cursor || c.from >= to) continue;
    if (c.from > cursor) gaps.push({ from: cursor, to: Math.min(c.from, to) });
    cursor = Math.max(cursor, c.to);
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

/**
 * Minute grid over [from, to): each minute is { t, bar, state } with state
 * 'traded' | 'zero' (observed, no trades) | 'missing' (not observed).
 */
export function minuteGrid(series, from, to) {
  const bars = new Map(barsBetween(series, from, to).map((b) => [b.t, b]));
  const out = [];
  for (let t = minuteOf(from); t < to; t += 60_000) {
    const bar = bars.get(t) ?? null;
    const obs = observedMs(series, t, t + 60_000) >= 30_000;
    out.push({ t, bar, state: bar ? 'traded' : obs ? 'zero' : 'missing' });
  }
  return out;
}

/** Volume, dollar turnover, trade count over [from, to), plus whether dollar turnover is exact. */
export function totals(series, from, to) {
  const bars = barsBetween(series, from, to);
  let v = 0; let dollar = 0; let n = 0; let exact = true; let nKnown = true;
  for (const b of bars) {
    v += b.v;
    dollar += b.dollar ?? (b.c ?? 0) * b.v;
    if (b.n == null) nKnown = false; else n += b.n;
    if (!b.dollarExact) exact = false;
  }
  return { volume: v, dollar, trades: nKnown ? n : null, dollarExact: exact, bars: bars.length };
}

/** Last price-eligible bar close at or before asOf, with its age. */
export function lastPrice(series, asOf) {
  for (let i = series.bars.length - 1; i >= 0; i--) {
    const b = series.bars[i];
    if (b.t < asOf && b.c != null) return { price: b.c, t: b.t + 59_999 > asOf ? asOf : b.t + 59_999, barT: b.t };
  }
  return null;
}
