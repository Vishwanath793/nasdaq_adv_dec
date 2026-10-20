/**
 * Same-clock-time relative volume (pure).
 *
 *   RVOL(t) = today's eligible volume over [start, t)
 *             / median of the same ET clock interval over comparable completed sessions.
 *
 * Requirements enforced here (refused, not approximated, when they fail):
 *  - Same provider, feed and trade-condition policy for today and the history
 *    (IEX today over SIP history is not RVOL).
 *  - Adjustment basis: history in raw shares is multiplied by known split
 *    factors; a split with an unknown ratio in the window refuses the baseline.
 *  - A history session counts only if its interval was observed (≥ minObserved);
 *    an observed session with no trades is a genuine zero, a missing one is excluded.
 *  - Minimum sample; tiny denominators are floored and flagged so they cannot
 *    produce meaningless extreme ratios.
 */

import { etParts, etToUtc } from './clock.js';
import { median, mad, percentileRank } from './stats.js';
import { observedFraction, totals } from './series.js';
import { CONDITION_POLICY } from './series.js';

export const DEFAULT_BASELINE = {
  targetSessions: 20,
  minSessions: 8,
  minObserved: 0.9,
  floorShares: 2_000, // a baseline below this many shares is floored and flagged
  floorDollars: 20_000,
};

const coreScope = (s) => (s ? `${s.provider}/${s.feed}/${s.conditionPolicy ?? CONDITION_POLICY.version}` : 'unknown');

/** Split factor to bring a history date's raw volume onto today's share basis (null when unknown). */
export function splitFactorSince(histDate, today, actions = []) {
  let factor = 1;
  for (const a of actions) {
    if (a.type !== 'split') continue;
    if (a.exDate > histDate && a.exDate <= today) {
      if (!(a.ratio > 0)) return null;
      factor *= a.ratio; // ratio = new shares per old share (2-for-1 → 2)
    }
  }
  return factor;
}

/**
 * history: [{ date, series }] most recent first (completed sessions only).
 * window: { startTime: 'HH:MM:SS' } or { lookbackMs } for a rolling window ending at t.
 * measure: 'volume' | 'dollar'.
 */
export function sameTimeRvol({ today, history, date, t, startTime = null, lookbackMs = null, measure = 'volume', corporateActions = [], config = {} }) {
  const cfg = { ...DEFAULT_BASELINE, ...config };
  const flags = [];
  const clock = etParts(t).time;
  const todayFrom = lookbackMs ? t - lookbackMs : etToUtc(date, startTime);
  const fromClock = lookbackMs ? etParts(t - lookbackMs).time : startTime;
  const method = `median of same-clock ${fromClock}–${clock} ET ${measure} over completed sessions`;
  if (!today) return { ok: false, reason: 'no data for today', method };
  const todayObserved = observedFraction(today, todayFrom, t);
  const todayTotals = totals(today, todayFrom, t);
  const todayValue = measure === 'dollar' ? todayTotals.dollar : todayTotals.volume;
  if (todayObserved < cfg.minObserved) {
    return { ok: false, reason: `today's window only ${Math.round(todayObserved * 100)}% observed`, today: todayValue, todayObserved, method };
  }
  const values = [];
  const excluded = { missing: 0, scopeMismatch: 0, unknownSplit: 0, notCompleted: 0 };
  for (const h of history ?? []) {
    if (values.length >= cfg.targetSessions) break;
    if (!h.series) { excluded.missing++; continue; }
    if (coreScope(h.series.scope) !== coreScope(today.scope)) { excluded.scopeMismatch++; continue; }
    if (h.date >= date) { excluded.notCompleted++; continue; }
    const from = etToUtc(h.date, fromClock);
    const to = etToUtc(h.date, clock);
    if (observedFraction(h.series, from, to) < cfg.minObserved) { excluded.missing++; continue; }
    let factor = 1;
    if ((h.series.scope?.adjustment ?? 'raw') === 'raw') {
      factor = splitFactorSince(h.date, date, corporateActions);
      if (factor == null) { excluded.unknownSplit++; continue; }
    }
    const tot = totals(h.series, from, to);
    // Split-adjusting volume multiplies shares; dollar turnover is unchanged by a split.
    values.push(measure === 'dollar' ? tot.dollar : tot.volume * factor);
  }
  if (excluded.scopeMismatch) flags.push(`${excluded.scopeMismatch} history session(s) refused: different feed/scope (${coreScope(today.scope)} today)`);
  if (excluded.unknownSplit) flags.push(`${excluded.unknownSplit} session(s) refused: split with unknown ratio`);
  if (values.length < cfg.minSessions) {
    return { ok: false, reason: `only ${values.length} comparable session(s); need ${cfg.minSessions}`, today: todayValue, sample: values.length, excluded, flags, method };
  }
  if (values.length < cfg.targetSessions) flags.push(`small sample: ${values.length} of ${cfg.targetSessions} target sessions`);
  const base = median(values);
  const floor = measure === 'dollar' ? cfg.floorDollars : cfg.floorShares;
  const floored = base < floor;
  if (floored) flags.push(`baseline ${Math.round(base)} below floor ${floor}: ratio uses the floor`);
  const denom = Math.max(base, floor);
  const spread = mad(values);
  const zeroSessions = values.filter((v) => v === 0).length;
  return {
    ok: true,
    rvol: todayValue / denom,
    today: todayValue,
    baseline: base,
    denominator: denom,
    floored,
    sample: values.length,
    zeroSessions,
    percentile: percentileRank(values, todayValue),
    robustZ: spread > 0 ? (todayValue - base) / (1.4826 * spread) : null,
    excluded,
    flags,
    method,
    todayObserved,
  };
}

/** Per-minute same-clock expected volume (median across history) for each minute in [from, to) of today. */
export function expectedPerMinute({ today, history, date, from, to, config = {} }) {
  const cfg = { ...DEFAULT_BASELINE, ...config };
  const out = [];
  const usable = (history ?? []).filter((h) => h.series && coreScope(h.series.scope) === coreScope(today?.scope) && h.date < date).slice(0, cfg.targetSessions);
  for (let m = from; m < to; m += 60_000) {
    const clock = etParts(m).time;
    const vals = [];
    for (const h of usable) {
      const hf = etToUtc(h.date, clock);
      if (observedFraction(h.series, hf, hf + 60_000) < 0.5) continue;
      vals.push(totals(h.series, hf, hf + 60_000).volume);
    }
    out.push({ t: m, expected: vals.length >= cfg.minSessions ? median(vals) : null, sample: vals.length });
  }
  return out;
}
