/**
 * Pre-market conviction engine (pure, explainable).
 *
 * Structure (see docs/SCORING.md):
 *   factor value      0..1, 0.5 = neutral, in the direction being scored (long +1 / short −1)
 *   family score      mean of the usable factors in one correlation family (redundant
 *                     fields such as shares / dollars / percentile of the same activity share one slot)
 *   group score       mean of its usable families
 *   rawScore          100 × weighted mean of usable group scores (configured group weights)
 *   coverage          usable configured weight ÷ ALL configured weight (the denominator never
 *                     shrinks because an API failed)
 *   adjustedScore     50 + (raw − 50) × coverage   (conservative; raw stays visible)
 *
 * A score of 80 is a ranking, not an 80% probability. Volume never picks the side on its
 * own: participation factors amplify the price evidence in the direction being scored.
 */

import { clamp, isNum, hashOf, mean } from './stats.js';
import { catalystEvidence } from './catalyst.js';
import { setupChecklists } from './patterns.js';

export const SCORE_VERSION = 'score-1.0.0';

export const GROUPS = {
  relParticipation: { label: 'Relative participation', volume: true, mandatory: true },
  accelPersistence: { label: 'Acceleration & persistence', volume: true },
  priceVolume: { label: 'Price–volume agreement', volume: true },
  vwapAcceptance: { label: 'VWAP & acceptance', volume: true },
  priceStructure: { label: 'Price structure & gap', mandatory: true },
  marketSector: { label: 'Market & sector alignment' },
  catalyst: { label: 'Verified catalyst' },
  history: { label: 'Historical setup context' },
  auction: { label: 'Opening auction (NOII)' },
  research: { label: 'Research indicators (capped)' },
};

/** Presets. Weights are hypotheses, not fitted optima. */
export const PRESETS = {
  volumeFirst: {
    label: 'Volume-first research preset (60% volume)',
    groups: { relParticipation: 20, accelPersistence: 15, priceVolume: 15, vwapAcceptance: 10, priceStructure: 15, marketSector: 10, catalyst: 10, history: 5 },
  },
  equalGroups: {
    label: 'Equal groups (baseline)',
    groups: { relParticipation: 1, accelPersistence: 1, priceVolume: 1, vwapAcceptance: 1, priceStructure: 1, marketSector: 1, catalyst: 1, history: 1 },
  },
  gapOnly: { label: 'Gap only (baseline)', groups: { priceStructure: 1 }, factors: ['gap'] },
  gapRvol: { label: 'Gap + same-time RVOL', groups: { priceStructure: 1, relParticipation: 1 }, factors: ['gap', 'rvolCum'] },
  priceVolumeNoNews: {
    label: 'Price + volume, no news',
    groups: { relParticipation: 20, accelPersistence: 15, priceVolume: 15, vwapAcceptance: 10, priceStructure: 15, marketSector: 10, history: 5 },
  },
  fullFree: {
    label: 'Full free-data model (+ capped research family)',
    groups: { relParticipation: 20, accelPersistence: 15, priceVolume: 15, vwapAcceptance: 10, priceStructure: 15, marketSector: 10, catalyst: 10, history: 5, research: 5 },
  },
  enhanced: {
    label: 'Enhanced (adds NOII; needs a licensed feed)',
    groups: { relParticipation: 20, accelPersistence: 15, priceVolume: 15, vwapAcceptance: 10, priceStructure: 15, marketSector: 10, catalyst: 10, history: 5, auction: 15 },
  },
};
export const DEFAULT_PRESET = 'volumeFirst';
export const RESEARCH_CAP = 5; // % of total weight at most, until validated

export const LABEL_POLICY = {
  strong: { minAdjusted: 68, minRaw: 70, minVolumeScore: 62, minSupportingGroups: 3, minSupportingVolumeGroups: 2, minCoverage: 0.75, maxOpposingVolume: 0.35 },
  moderate: { minAdjusted: 58, minSupportingGroups: 2, minVolumeScore: 55, minRelParticipation: 0.5 },
  insufficientCoverage: 0.5,
};

const r2 = (n) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(2));
const sgn = (n) => (n > 0 ? '+' : '');
const logScale = (x, full) => (x > 0 ? clamp(Math.log(x) / Math.log(full), -1, 1) : -1);

/** How strongly price agrees with direction `dir` (−1..1): the evidence that participation amplifies. */
export function priceAlignment(f, dir) {
  const g = f.gapAtr != null ? f.gapAtr / 0.75 : f.gapPct != null ? f.gapPct / 1.5 : null;
  const v = f.distVwapPct != null ? f.distVwapPct / 0.75 : null;
  const parts = [g, v].filter(isNum);
  if (!parts.length) return null;
  return clamp(dir * mean(parts.map((p) => clamp(p, -1, 1))), -1, 1);
}

/** Participation strength s (−1..1) → value for a direction, given price alignment. */
function amplified(s, align) {
  if (align == null) return null;
  return s >= 0 ? 0.5 + 0.5 * s * align : 0.5 - 0.3 * Math.abs(s);
}

const NA = (reason) => ({ na: true, reason });
const MISSING = (reason, kind = 'unsupported') => ({ missing: true, reason, kind });

/**
 * The factor registry. Each: key, group, family (correlation family), role, label, units, source, describe, fn(f, dir, ctx).
 * fn returns { value, raw, detail, transform } | NA(reason) (not applicable: excluded, but counts as covered) | MISSING(reason, kind).
 */
export const FACTORS = [
  // --- relative participation
  { key: 'rvolCum', group: 'relParticipation', family: 'activity', role: 'directional', label: 'Same-time RVOL', units: '×', source: 'minute volume vs same-clock median',
    describe: 'Cumulative pre-market volume through now divided by the median of the same ET clock interval over comparable sessions (same feed). Amplifies price evidence; never picks the side.',
    fn: (f, dir) => {
      if (!f.rvol?.ok) return MISSING(f.rvol?.reason ?? 'no baseline', f.rvol?.reason?.includes('observed') ? 'stale' : 'insufficient history');
      let s = logScale(f.rvol.rvol, 4);
      if (f.rvol.floored) s = Math.min(s, 0.5);
      const align = priceAlignment(f, dir);
      const v = amplified(s, align);
      if (v == null) return MISSING('no price reference to align with', 'failed');
      return { value: v, raw: f.rvol.rvol, transform: 'log4(RVOL) × price alignment', detail: `RVOL ${r2(f.rvol.rvol)} over ${f.rvol.sample} sessions${f.rvol.floored ? ' (floored baseline)' : ''}; price alignment ${r2(align)}` };
    } },
  { key: 'rvolDollar', group: 'relParticipation', family: 'activity', role: 'directional', label: 'Same-time relative dollar turnover', units: '×', source: 'Σ price×size vs same-clock median',
    describe: 'Same as RVOL but in dollars; shares the "activity" slot with RVOL so the same activity is not counted twice.',
    fn: (f, dir) => {
      if (!f.rvolDollar?.ok) return MISSING(f.rvolDollar?.reason ?? 'no baseline', 'insufficient history');
      const align = priceAlignment(f, dir);
      const v = amplified(logScale(f.rvolDollar.rvol, 4), align);
      return v == null ? MISSING('no price reference', 'failed') : { value: v, raw: f.rvolDollar.rvol, transform: 'log4(rel $) × alignment', detail: `relative dollar turnover ${r2(f.rvolDollar.rvol)}${f.cumDollarExact ? '' : ' (approximate: close×volume)'}` };
    } },
  { key: 'rvol15', group: 'relParticipation', family: 'rolling', role: 'directional', label: 'Last-15-minute RVOL', units: '×', source: 'rolling same-clock window',
    describe: 'Volume over the last 15 minutes vs the same clock window historically (catches activity arriving now, not hours ago).',
    fn: (f, dir) => {
      if (!f.rvol15?.ok) return MISSING(f.rvol15?.reason ?? 'no baseline', 'insufficient history');
      const align = priceAlignment(f, dir);
      const v = amplified(logScale(f.rvol15.rvol, 4), align);
      return v == null ? MISSING('no price reference', 'failed') : { value: v, raw: f.rvol15.rvol, transform: 'log4(RVOL15) × alignment', detail: `last-15-min RVOL ${r2(f.rvol15.rvol)}` };
    } },
  // --- acceleration & persistence
  { key: 'accel', group: 'accelPersistence', family: 'accel', role: 'directional', label: 'Clock-normalised acceleration', units: 'ratio', source: 'last 15 min vs prior 15 min, each vs its own same-clock expectation',
    describe: 'Whether participation is expanding beyond the normal rise toward the open. 1.0 = following the usual intraday curve.',
    fn: (f, dir) => {
      if (!f.accel) return MISSING('no same-clock per-minute baseline', 'insufficient history');
      const v = amplified(logScale(f.accel.ratio, 2.5), priceAlignment(f, dir));
      return v == null ? MISSING('no price reference', 'failed') : { value: v, raw: f.accel.ratio, transform: 'log2.5(ratio) × alignment', detail: `${f.accel.state}: recent ${r2(f.accel.recentVsExpected)}× expected vs prior ${r2(f.accel.priorVsExpected)}×` };
    } },
  { key: 'persistence', group: 'accelPersistence', family: 'persist', role: 'directional', label: 'Participation persistence', units: 'share', source: 'minute grid since first trade',
    describe: 'Share of observed minutes since the first trade with meaningful activity. Sustained participation outranks a single burst.',
    fn: (f, dir) => {
      if (f.persistence == null) return MISSING('no active minutes', 'not applicable');
      const align = priceAlignment(f, dir);
      if (align == null) return MISSING('no price reference', 'failed');
      return { value: 0.5 + 0.5 * align * clamp((f.persistence - 0.3) / 0.5, -1, 1), raw: f.persistence, transform: '(p−0.3)/0.5 × alignment', detail: `${Math.round(f.persistence * 100)}% of minutes active; longest run ${f.longestActiveRun} min` };
    } },
  { key: 'concentration', group: 'accelPersistence', family: 'concentration', role: 'risk', label: 'Concentration in one burst', units: 'share', source: 'largest minute / prints',
    describe: 'Penalty when a large share of volume came in one minute (or three prints) and activity then died away.',
    fn: (f) => {
      if (f.largestMinuteShare == null) return MISSING('no volume', 'not applicable');
      const share = Math.max(f.largestMinuteShare, f.top3PrintShare ?? 0);
      if (share < 0.25 && (f.postSpikePersistence ?? 1) >= 0.3) return NA('volume not concentrated');
      const silence = f.postSpikePersistence != null && f.postSpikePersistence < 0.3 ? 0.2 : 0;
      return { value: clamp(0.5 - 0.5 * clamp((share - 0.25) / 0.35, 0, 1) - silence, 0, 0.5), raw: share, transform: 'penalty only', detail: `largest minute ${Math.round(f.largestMinuteShare * 100)}%${f.top3PrintShare != null ? `, top-3 prints ${Math.round(f.top3PrintShare * 100)}%` : ''}${silence ? '; little activity afterwards' : ''}` };
    } },
  // --- price–volume agreement
  { key: 'pushPull', group: 'priceVolume', family: 'pushpull', role: 'directional', label: 'Push vs pullback volume', units: 'ratio', source: 'minute bars, clock-normalised',
    describe: 'Volume rate on minutes moving in the setup direction vs minutes against it. Light pullbacks and heavy pushes support the setup.',
    fn: (f, dir) => {
      const pv = dir > 0 ? f.pvLong : f.pvShort;
      if (pv?.pushPullRatio == null) return MISSING('too few directional minutes', 'insufficient history');
      return { value: 0.5 + 0.5 * logScale(pv.pushPullRatio, 2), raw: pv.pushPullRatio, transform: 'log2(ratio)', detail: `${pv.pushMinutes} push / ${pv.pullMinutes} pullback minutes, volume-rate ratio ${r2(pv.pushPullRatio)}` };
    } },
  { key: 'progress', group: 'priceVolume', family: 'progress', role: 'directional', label: 'Progress per unit of activity', units: 'ATR', source: 'gap in ATR vs RVOL',
    describe: 'Price progress in the direction relative to how much activity it took. Heavy volume with no progress reads as possible exhaustion.',
    fn: (f, dir) => {
      const prog = f.gapAtr != null ? dir * f.gapAtr : f.gapPct != null ? (dir * f.gapPct) / 2 : null;
      if (prog == null) return MISSING('no gap measure', 'failed');
      const rv = f.rvol?.ok ? f.rvol.rvol : null;
      if (rv != null && rv >= 2 && prog >= 0 && prog < 0.2) return { value: 0.3, raw: prog, transform: 'exhaustion rule', detail: `RVOL ${r2(rv)} but only ${r2(prog)} ATR progress` };
      return { value: 0.5 + 0.5 * clamp(prog / 1, -1, 1), raw: prog, transform: 'clamp(progress/1 ATR)', detail: `${sgn(prog)}${r2(prog)} ${f.gapAtr != null ? 'ATR' : '(gap%/2)'} in direction${rv != null ? ` on RVOL ${r2(rv)}` : ''}` };
    } },
  { key: 'rejection', group: 'priceVolume', family: 'rejection', role: 'risk', label: 'High-volume rejection', units: 'bars', source: 'heavy bars with ≥60% wick',
    describe: 'Penalty for heavy-volume bars rejected against the setup direction.',
    fn: (f, dir) => {
      const n = dir > 0 ? f.heavyRejections?.up : f.heavyRejections?.down;
      if (n == null) return MISSING('no bars', 'not applicable');
      return n ? { value: Math.max(0.1, 0.4 - 0.1 * (n - 1)), raw: n, transform: 'penalty only', detail: `${n} heavy rejection bar(s) against the direction` } : NA('no heavy rejection');
    } },
  { key: 'breakout', group: 'priceVolume', family: 'breakout', role: 'directional', label: 'Pre-market break & follow-through', units: '', source: 'last 15 min vs earlier extreme',
    describe: 'A break of the earlier pre-market high (low for shorts) on renewed volume that holds, vs a failed break back into the range.',
    fn: (f, dir) => {
      if (f.breaks == null) return MISSING('not enough pre-market bars', 'insufficient history');
      const b = dir > 0 ? f.breaks.up : f.breaks.down;
      if (!b) return NA('no break attempt');
      if (b.failed) return { value: 0.15, raw: b.volumeRatio, transform: 'failed break', detail: `broke the earlier ${dir > 0 ? 'high' : 'low'} and fell back (volume ×${r2(b.volumeRatio)})` };
      return { value: (b.volumeRatio ?? 0) >= 1.2 ? 0.85 : 0.65, raw: b.volumeRatio, transform: 'held break', detail: `held a break of the earlier ${dir > 0 ? 'high' : 'low'} (volume ×${r2(b.volumeRatio)})` };
    } },
  { key: 'flowEstimate', group: 'priceVolume', family: 'flowEstimate', role: 'directional', label: 'Estimated aggressor imbalance', units: '−1..1', source: 'Lee–Ready estimate (trades + quotes)',
    describe: 'Estimated buyer- minus seller-initiated volume share. An estimate with documented uncertainty, not institutional buying.',
    fn: (f, dir) => {
      if (!f.orderflow) return MISSING('needs trade-level data with quotes', 'unsupported');
      if (f.orderflow.imbalance == null) return MISSING(`only ${Math.round(f.orderflow.coverage * 100)}% of volume classifiable`, 'insufficient history');
      return { value: 0.5 + 0.5 * clamp((dir * f.orderflow.imbalance) / 0.4, -1, 1), raw: f.orderflow.imbalance, transform: 'imbalance/0.4', detail: `estimated imbalance ${r2(f.orderflow.imbalance)} (${Math.round(f.orderflow.coverage * 100)}% classified)` };
    } },
  // --- VWAP & acceptance
  { key: 'vwapSide', group: 'vwapAcceptance', family: 'vwapSide', role: 'directional', label: 'Price vs pre-market VWAP', units: '%', source: 'pre-market VWAP (separate from regular-session VWAP)',
    describe: 'Distance of the price from the pre-market VWAP in the setup direction.',
    fn: (f, dir) => (f.distVwapPct == null ? MISSING('no pre-market VWAP', 'insufficient history')
      : { value: 0.5 + 0.5 * clamp((dir * f.distVwapPct) / 1, -1, 1), raw: f.distVwapPct, transform: 'clamp(dist/1%)', detail: `${sgn(f.distVwapPct)}${r2(f.distVwapPct)}% from pre-market VWAP ${r2(f.pmVwap)}` }) },
  { key: 'vwapTime', group: 'vwapAcceptance', family: 'vwapTime', role: 'directional', label: 'Time & volume on the setup side of VWAP', units: 'share', source: 'running VWAP over minute bars',
    describe: 'Share of minutes (and of volume) that closed on the setup side of the running VWAP: acceptance, not a single print.',
    fn: (f, dir) => {
      const t = f.vwap?.timeAboveVwap; const vs = f.vwap?.volumeAboveVwapShare;
      if (t == null) return MISSING('too few bars', 'insufficient history');
      const v = dir > 0 ? mean([t, vs ?? t]) : mean([1 - t, 1 - (vs ?? t)]);
      return { value: v, raw: v, transform: 'share', detail: `${Math.round((dir > 0 ? t : 1 - t) * 100)}% of minutes ${dir > 0 ? 'above' : 'below'} VWAP; ${f.vwap.vwapCrossings} crossings` };
    } },
  { key: 'vwapSlope', group: 'vwapAcceptance', family: 'vwapSlope', role: 'directional', label: 'VWAP slope (15 min)', units: 'bps', source: 'running VWAP',
    describe: 'Whether the pre-market VWAP itself is rising (falling) over the last 15 minutes.',
    fn: (f, dir) => (f.vwap?.vwapSlopeBps15 == null ? MISSING('fewer than 15 minutes of VWAP', 'insufficient history')
      : { value: 0.5 + 0.5 * clamp((dir * f.vwap.vwapSlopeBps15) / 30, -1, 1), raw: f.vwap.vwapSlopeBps15, transform: 'clamp(slope/30 bps)', detail: `VWAP ${sgn(f.vwap.vwapSlopeBps15)}${r2(f.vwap.vwapSlopeBps15)} bps over 15 min` }) },
  { key: 'chop', group: 'vwapAcceptance', family: 'chop', role: 'risk', label: 'VWAP choppiness', units: 'crossings', source: 'running VWAP',
    describe: 'Penalty for repeated VWAP crossings in the last hour (no acceptance either side).',
    fn: (f) => (f.vwap?.vwapCrossings60 == null ? MISSING('no VWAP', 'insufficient history') : f.vwap.vwapCrossings60 < 8 ? NA(`${f.vwap.vwapCrossings60} crossings in the last hour`)
      : { value: Math.max(0.15, 0.45 - 0.02 * (f.vwap.vwapCrossings60 - 8)), raw: f.vwap.vwapCrossings60, transform: 'penalty only (≥8 crossings / hour)', detail: `${f.vwap.vwapCrossings60} VWAP crossings in the last hour` }) },
  // --- price structure
  { key: 'gap', group: 'priceStructure', family: 'gap', role: 'directional', label: 'Gap in the setup direction', units: 'ATR', source: 'reference price vs previous official close',
    describe: 'Gap from the previous official close, in ATR units when available. No NSE "sweet spot" is assumed for Nasdaq; the transform is a plain bounded ramp until validated.',
    fn: (f, dir) => {
      if (f.gapPct == null) return MISSING(f.missing.gapPct ?? 'no gap', 'failed');
      const x = f.gapAtr != null ? f.gapAtr : f.gapPct / 3;
      return { value: 0.5 + 0.5 * clamp((dir * x) / 1, -1, 1), raw: f.gapPct, transform: f.gapAtr != null ? 'clamp(gap/1 ATR)' : 'clamp(gap/3%) (no ATR)', detail: `gap ${sgn(f.gapPct)}${r2(f.gapPct)}%${f.gapAtr != null ? ` (${r2(f.gapAtr)} ATR)` : ''} from ${r2(f.prevClose)} using ${f.refPriceSource}` };
    } },
  { key: 'trend', group: 'priceStructure', family: 'trend', role: 'directional', label: 'Pre-market trend consistency', units: 'share', source: '5-minute steps, last 30 min',
    describe: 'Share of recent 5-minute steps moving in the setup direction.',
    fn: (f, dir) => {
      if (f.trendConsistency == null) return MISSING('fewer than 3 price steps', 'insufficient history');
      const g = Math.sign(f.gapPct ?? 0) || 1;
      const v = g === dir ? f.trendConsistency : 1 - f.trendConsistency;
      return { value: v, raw: v, transform: 'share', detail: `${Math.round(v * 100)}% of 5-min steps in direction` };
    } },
  { key: 'holdExtreme', group: 'priceStructure', family: 'pullback', role: 'directional', label: 'Holding near the pre-market extreme', units: 'share of move', source: 'pre-market high/low',
    describe: 'How much of the move from the previous close has been given back (only for the gap direction).',
    fn: (f, dir) => {
      const g = Math.sign(f.gapPct ?? 0);
      if (!g || g !== dir) return NA('not the gap direction');
      if (f.pullbackDepth == null) return MISSING('no pre-market range', 'insufficient history');
      return { value: clamp(1 - f.pullbackDepth, 0, 1), raw: f.pullbackDepth, transform: '1 − giveback', detail: `${Math.round(clamp(f.pullbackDepth, 0, 9) * 100)}% of the move given back from the pre-market ${dir > 0 ? 'high' : 'low'}` };
    } },
  { key: 'prevRange', group: 'priceStructure', family: 'range', role: 'directional', label: "Beyond yesterday's range", units: '', source: 'previous day high/low',
    describe: "Trading beyond yesterday's high (low for shorts) supports; inside the range is not applicable.",
    fn: (f, dir) => (f.beyondPrevRange == null ? MISSING('no previous-day range', 'insufficient history') : f.beyondPrevRange === 0 ? NA("inside yesterday's range")
      : { value: f.beyondPrevRange === dir ? 0.8 : 0.2, raw: f.beyondPrevRange, transform: 'beyond = 0.8 / against = 0.2', detail: `${f.beyondPrevRange > 0 ? 'above yesterday\'s high' : 'below yesterday\'s low'}` }) },
  // --- market & sector
  { key: 'market', group: 'marketSector', family: 'market', role: 'context', label: 'Market (QQQ) alignment', units: '%', source: 'QQQ same-feed pre-market move',
    describe: 'QQQ move since the previous close in the setup direction. Full marks at ±0.5%.',
    fn: (f, dir, ctx) => {
      const q = ctx.market?.QQQ;
      if (q?.gapPct == null) return MISSING('QQQ not observed', ctx.market ? 'failed' : 'unsupported');
      return { value: 0.5 + 0.5 * clamp((dir * q.gapPct) / 0.5, -1, 1), raw: q.gapPct, transform: 'clamp(move/0.5%)', detail: `QQQ ${sgn(q.gapPct)}${r2(q.gapPct)}%` };
    } },
  { key: 'sector', group: 'marketSector', family: 'sector', role: 'context', label: 'Sector ETF alignment', units: '%', source: 'mapped sector ETF',
    describe: 'Mapped sector ETF move in the setup direction (mapping is configurable and approximate).',
    fn: (f, dir, ctx) => {
      const etf = f.meta?.sectorEtf;
      if (!etf) return MISSING('no sector mapping', 'not applicable');
      const s = ctx.market?.[etf];
      if (s?.gapPct == null) return MISSING(`${etf} not observed`, 'failed');
      return { value: 0.5 + 0.5 * clamp((dir * s.gapPct) / 0.75, -1, 1), raw: s.gapPct, transform: 'clamp(move/0.75%)', detail: `${etf} ${sgn(s.gapPct)}${r2(s.gapPct)}%` };
    } },
  { key: 'relStrength', group: 'marketSector', family: 'rs', role: 'directional', label: 'Relative strength vs QQQ and sector', units: '%', source: 'stock gap − benchmark gap (same window)',
    describe: 'Stock move minus the benchmark moves over the same window.',
    fn: (f, dir, ctx) => {
      const q = ctx.market?.QQQ?.gapPct; const s = f.meta?.sectorEtf ? ctx.market?.[f.meta.sectorEtf]?.gapPct : null;
      if (f.gapPct == null || q == null) return MISSING('stock or QQQ move unavailable', 'failed');
      const rs = mean([f.gapPct - q, ...(s != null ? [f.gapPct - s] : [])]);
      return { value: 0.5 + 0.5 * clamp((dir * rs) / 2, -1, 1), raw: rs, transform: 'clamp(rs/2%)', detail: `${sgn(rs)}${r2(rs)}% vs ${s != null ? 'QQQ and sector' : 'QQQ'}` };
    } },
  { key: 'breadth', group: 'marketSector', family: 'breadth', role: 'context', label: 'Tracked-universe breadth', units: 'share', source: 'tracked universe only (not all of Nasdaq)',
    describe: 'Share of the tracked universe gapping in the setup direction. Shows its denominator; a partial watchlist is not the whole market.',
    fn: (f, dir, ctx) => {
      const b = ctx.breadth;
      if (!b || b.counted < 10) return MISSING(`breadth needs ≥10 tracked symbols (${b?.counted ?? 0})`, 'insufficient history');
      const share = (dir > 0 ? b.up : b.down) / b.counted;
      return { value: share, raw: share, transform: 'share', detail: `${Math.round(share * 100)}% of ${b.counted} tracked symbols ${dir > 0 ? 'up' : 'down'} (${b.excluded} stale excluded)` };
    } },
  // --- catalyst
  { key: 'catalyst', group: 'catalyst', family: 'catalyst', role: 'directional', label: 'Verified catalyst', units: '', source: 'news / SEC filings (deterministic rules)',
    describe: 'Strongest classified catalyst since the previous close, with source and timing. Unknown direction (e.g. earnings without consensus) is neutral, never bullish by default.',
    fn: (f, dir, ctx) => {
      const ev = catalystEvidence(f.news, { asOf: f.asOf, since: ctx.times.previousRegularClose ?? 0, direction: dir, checked: f.newsChecked });
      if (ev.score == null) return MISSING(ev.reason, 'unsupported');
      return { value: ev.score, raw: ev.best?.category ?? 'none', transform: 'rule strength × direction', detail: ev.reason, evidence: ev.best ? { headline: ev.best.headline, url: ev.best.url, source: ev.best.source, publishedAt: ev.best.publishedAt, firstSeenAt: ev.best.firstSeenAt } : null };
    } },
  // --- history
  { key: 'gapHistory', group: 'history', family: 'gaphist', role: 'context', label: 'Historical gap continuation', units: 'rate', source: 'daily bars (≥2% gaps)',
    describe: "This stock's past ≥2% gaps: share where the open-to-close move continued the gap.",
    fn: (f, dir) => {
      const rate = f.hist?.gapContinuationRate;
      if (rate == null) return MISSING(f.hist?.missing?.gapContinuationRate ?? 'no history', 'insufficient history');
      const g = Math.sign(f.gapPct ?? 0) || 1;
      const v = g === dir ? rate : 1 - rate;
      return { value: v, raw: rate, transform: 'rate (continuation) / 1−rate (fade)', detail: `${Math.round(rate * 100)}% of ${f.hist.gapSample} past gaps continued` };
    } },
  { key: 'priorTrend', group: 'history', family: 'prior', role: 'context', label: 'Prior trend & close location', units: '%', source: 'daily bars',
    describe: '5- and 20-session returns and where yesterday closed in its range, in the setup direction.',
    fn: (f, dir) => {
      const h = f.hist ?? {};
      if (h.ret5 == null && h.closeLocation == null) return MISSING('no daily history', 'insufficient history');
      const parts = [];
      if (h.ret5 != null) parts.push(0.5 + 0.5 * clamp((dir * h.ret5) / 5, -1, 1));
      if (h.ret20 != null) parts.push(0.5 + 0.5 * clamp((dir * h.ret20) / 10, -1, 1));
      if (h.closeLocation != null) parts.push(dir > 0 ? h.closeLocation : 1 - h.closeLocation);
      return { value: mean(parts), raw: h.ret5, transform: 'mean of bounded ramps', detail: `5d ${r2(h.ret5)}%, 20d ${r2(h.ret20)}%, close location ${r2(h.closeLocation)}` };
    } },
  // --- auction (ENHANCED only)
  { key: 'noiiImbalance', group: 'auction', family: 'imbalance', role: 'directional', label: 'NOII imbalance side & size', units: 'imbalance/paired', source: 'Nasdaq NOII (licensed)',
    describe: 'Signed imbalance relative to paired shares. Unavailable in the free profiles; never synthesised from quotes.',
    fn: (f, dir) => {
      if (!f.auction?.available) return MISSING(f.auction?.reason ?? 'NOII unavailable', 'not entitled');
      if (f.auction.imbalanceToPaired == null) return MISSING(f.auction.insufficient ? 'insufficient orders to calculate' : 'nothing paired yet', 'not applicable');
      return { value: 0.5 + 0.5 * clamp((dir * f.auction.imbalanceToPaired) / 0.5, -1, 1), raw: f.auction.imbalanceToPaired, transform: 'clamp(x/0.5)', detail: `${f.auction.side > 0 ? 'buy' : f.auction.side < 0 ? 'sell' : 'no'} imbalance ${f.auction.imbalanceShares} vs ${f.auction.pairedShares} paired` };
    } },
  { key: 'noiiPersistence', group: 'auction', family: 'persist', role: 'directional', label: 'NOII side persistence', units: 'share', source: 'NOII series',
    describe: 'How consistently the imbalance stayed on the same side, and on which side.',
    fn: (f, dir) => {
      if (!f.auction?.available) return MISSING(f.auction?.reason ?? 'NOII unavailable', 'not entitled');
      if (f.auction.persistence == null || !f.auction.side) return NA('no directional imbalance');
      return { value: 0.5 + 0.5 * f.auction.side * dir * f.auction.persistence, raw: f.auction.persistence, transform: 'side × persistence', detail: `${Math.round(f.auction.persistence * 100)}% of messages on the current side; ${f.auction.sideChanges} side change(s)` };
    } },
  { key: 'noiiPrice', group: 'auction', family: 'price', role: 'directional', label: 'Indicative price vs pre-market VWAP', units: 'bps', source: 'NOII near indicative (from 09:28) else reference',
    describe: 'Where the auction is indicating relative to the pre-market VWAP.',
    fn: (f, dir) => {
      if (!f.auction?.available) return MISSING(f.auction?.reason ?? 'NOII unavailable', 'not entitled');
      if (f.auction.indicativeVsVwapBps == null) return MISSING('no indicative price yet', 'not applicable');
      return { value: 0.5 + 0.5 * clamp((dir * f.auction.indicativeVsVwapBps) / 50, -1, 1), raw: f.auction.indicativeVsVwapBps, transform: 'clamp(bps/50)', detail: `${r2(f.auction.indicativeVsVwapBps)} bps vs pre-market VWAP (${f.auction.nearFarAvailable ? 'near price' : 'reference price; near/far not yet disseminated'})` };
    } },
  // --- research family (capped)
  { key: 'cmf', group: 'research', family: 'derived', role: 'research', label: 'Chaikin money flow (20 min)', units: '−1..1', source: 'derived from minute bars',
    describe: 'Derived transformation of the same bars; not an independent confirmation.',
    fn: (f, dir) => (f.research?.cmf20 == null ? MISSING(f.research?.missing ?? 'no bars', 'insufficient history') : { value: 0.5 + 0.5 * clamp((dir * f.research.cmf20) / 0.3, -1, 1), raw: f.research.cmf20, transform: 'clamp(x/0.3)', detail: `CMF ${r2(f.research.cmf20)} (candle-based proxy)` }) },
  { key: 'obv', group: 'research', family: 'derived', role: 'research', label: 'On-balance volume', units: 'share', source: 'derived from minute bars',
    describe: 'Up-close minus down-close volume share. Up-bar volume is not buy volume.',
    fn: (f, dir) => (f.research?.obvNorm == null ? MISSING(f.research?.missing ?? 'no bars', 'insufficient history') : { value: 0.5 + 0.5 * clamp((dir * f.research.obvNorm) / 0.4, -1, 1), raw: f.research.obvNorm, transform: 'clamp(x/0.4)', detail: `OBV share ${r2(f.research.obvNorm)} (candle proxy)` }) },
  { key: 'mfi', group: 'research', family: 'derived', role: 'research', label: 'Money flow index (14 min)', units: '0..100', source: 'derived from minute bars',
    describe: 'Derived transformation; capped research family.',
    fn: (f, dir) => (f.research?.mfi14 == null ? MISSING(f.research?.missing ?? 'no bars', 'insufficient history') : { value: dir > 0 ? f.research.mfi14 / 100 : 1 - f.research.mfi14 / 100, raw: f.research.mfi14, transform: 'MFI/100', detail: `MFI ${r2(f.research.mfi14)}` }) },
];

export const FACTOR_BY_KEY = Object.fromEntries(FACTORS.map((x) => [x.key, x]));

/** Effective group weights for a configuration (research capped). */
export function effectiveWeights(config = {}) {
  const preset = PRESETS[config.preset] ?? PRESETS[DEFAULT_PRESET];
  const groups = { ...preset.groups, ...(config.groupWeights ?? {}) };
  for (const k of Object.keys(groups)) if (!(groups[k] > 0)) delete groups[k];
  const total = Object.values(groups).reduce((s, w) => s + w, 0);
  if (groups.research && total > 0) {
    const others = total - groups.research;
    const cap = (RESEARCH_CAP / (100 - RESEARCH_CAP)) * others;
    groups.research = Math.min(groups.research, cap);
  }
  const off = new Set(config.factorsOff ?? []);
  const only = preset.factors ? new Set(preset.factors) : null;
  return { groups, factorOn: (key) => !off.has(key) && (!only || only.has(key)) };
}

export const configHash = (config) => hashOf({ v: SCORE_VERSION, preset: config.preset ?? DEFAULT_PRESET, groupWeights: config.groupWeights ?? null, factorsOff: config.factorsOff ?? [] });

/** Score one direction. Returns the full explanation. */
export function scoreDirection(f, dir, ctx, config = {}) {
  const { groups, factorOn } = effectiveWeights(config);
  const totalW = Object.values(groups).reduce((s, w) => s + w, 0);
  const factors = [];
  const groupOut = {};
  for (const [g, w] of Object.entries(groups)) {
    const defs = FACTORS.filter((x) => x.group === g && factorOn(x.key));
    const fams = {};
    let covered = 0;
    for (const d of defs) {
      let res;
      try { res = d.fn(f, dir, ctx); } catch (e) { res = MISSING(`calculation error: ${e.message}`, 'failed'); }
      const row = { key: d.key, group: g, family: d.family, role: d.role, label: d.label, units: d.units, source: d.source, describe: d.describe, direction: dir };
      if (res.missing) Object.assign(row, { status: 'missing', reason: res.reason, missingKind: res.kind });
      else if (res.na) { Object.assign(row, { status: 'na', reason: res.reason }); covered++; }
      else {
        Object.assign(row, { status: 'used', value: res.value, raw: res.raw, transform: res.transform, detail: res.detail, evidence: res.evidence ?? null });
        (fams[d.family] ??= []).push(row);
        covered++;
      }
      factors.push(row);
    }
    const famScores = Object.entries(fams).map(([k, rows]) => ({ family: k, score: mean(rows.map((x) => x.value)), n: rows.length }));
    const score = famScores.length ? mean(famScores.map((x) => x.score)) : null;
    groupOut[g] = { key: g, label: GROUPS[g].label, weight: w, share: totalW ? w / totalW : 0, score, families: famScores, usable: score != null, factorCoverage: defs.length ? covered / defs.length : 0, volume: Boolean(GROUPS[g].volume), mandatory: Boolean(GROUPS[g].mandatory) };
  }
  // Contributions: each used factor's share of the final raw score.
  const usableW = Object.values(groupOut).filter((x) => x.usable).reduce((s, x) => s + x.weight, 0);
  for (const row of factors) {
    if (row.status !== 'used') continue;
    const g = groupOut[row.group];
    const fam = g.families.find((x) => x.family === row.family);
    const wInRaw = usableW ? (g.weight / usableW) / g.families.length / fam.n : 0;
    row.weightInScore = wInRaw;
    row.contribution = wInRaw * (row.value - 0.5) * 100; // points above/below neutral 50
  }
  const raw = usableW ? (100 * Object.values(groupOut).filter((x) => x.usable).reduce((s, x) => s + x.weight * x.score, 0)) / usableW : null;
  const coverage = totalW ? usableW / totalW : 0;
  const mandatoryGroups = Object.values(groupOut).filter((x) => x.mandatory);
  const rvolNeeded = Boolean(groups.relParticipation) && factorOn('rvolCum');
  const mandatoryOk = mandatoryGroups.every((x) => x.usable) && (!rvolNeeded || factors.some((x) => x.key === 'rvolCum' && x.status === 'used'));
  const volGroups = Object.values(groupOut).filter((x) => x.volume);
  const volUsableW = volGroups.filter((x) => x.usable).reduce((s, x) => s + x.weight, 0);
  const volTotalW = volGroups.reduce((s, x) => s + x.weight, 0);
  const volumeScore = volUsableW ? (100 * volGroups.filter((x) => x.usable).reduce((s, x) => s + x.weight * x.score, 0)) / volUsableW : null;
  const adjusted = raw == null ? null : 50 + (raw - 50) * coverage;
  const supporting = Object.values(groupOut).filter((x) => x.usable && x.score >= 0.6);
  const opposing = Object.values(groupOut).filter((x) => x.usable && x.score <= 0.4);
  const optionalKeys = ['catalyst', 'marketSector', 'history', 'auction', 'research'];
  const optional = Object.values(groupOut).filter((x) => optionalKeys.includes(x.key));
  return {
    direction: dir,
    rawScore: raw == null ? null : Math.round(raw),
    adjustedScore: adjusted == null ? null : Math.round(adjusted),
    volumeEvidenceScore: volumeScore == null ? null : Math.round(volumeScore),
    coverage: {
      profile: coverage,
      mandatory: mandatoryGroups.length ? mandatoryGroups.filter((x) => x.usable).length / mandatoryGroups.length : 1,
      mandatoryOk,
      volume: volTotalW ? volUsableW / volTotalW : 0,
      optional: optional.length ? optional.filter((x) => x.usable).reduce((s, x) => s + x.weight, 0) / Math.max(1e-9, optional.reduce((s, x) => s + x.weight, 0)) : null,
      factors: factors.length ? factors.filter((x) => x.status !== 'missing').length / factors.length : 0,
    },
    groups: groupOut,
    factors,
    supportingGroups: supporting.map((x) => x.key),
    opposingGroups: opposing.map((x) => x.key),
    supporting: factors.filter((x) => x.status === 'used' && x.value >= 0.6).sort((a, b) => b.contribution - a.contribution),
    opposing: factors.filter((x) => x.status === 'used' && x.value <= 0.4).sort((a, b) => a.contribution - b.contribution),
  };
}

/** Label under the minimum-evidence policy. One excellent factor cannot produce "strong". */
export function convictionLabel(s, { dataMode = 'LIVE' } = {}) {
  const P = LABEL_POLICY;
  if (!s.coverage.mandatoryOk) return { label: 'insufficient evidence', why: 'mandatory inputs missing (same-time RVOL and price structure are required)' };
  if (s.coverage.profile < P.insufficientCoverage) return { label: 'insufficient evidence', why: `only ${Math.round(s.coverage.profile * 100)}% of the configured profile is covered` };
  const volSupport = s.supportingGroups.filter((g) => s.groups[g].volume).length;
  const volOpposeStrong = Object.values(s.groups).some((g) => g.volume && g.usable && g.score < P.strong.maxOpposingVolume);
  const st = P.strong;
  const strongOk = s.adjustedScore >= st.minAdjusted && s.rawScore >= st.minRaw && s.supportingGroups.length >= st.minSupportingGroups
    && volSupport >= st.minSupportingVolumeGroups && s.coverage.profile >= st.minCoverage && !volOpposeStrong
    && (s.volumeEvidenceScore == null || s.volumeEvidenceScore >= st.minVolumeScore);
  if (strongOk && dataMode !== 'LIVE') return { label: 'moderate', why: `would be strong, but the data mode is ${dataMode}` };
  if (strongOk) return { label: 'strong', why: `${s.supportingGroups.length} supporting groups (${volSupport} volume), coverage ${Math.round(s.coverage.profile * 100)}%` };
  const volOk = s.volumeEvidenceScore == null || s.volumeEvidenceScore >= P.moderate.minVolumeScore;
  if (!volOk && s.adjustedScore >= 50) return { label: 'weak', why: `volume evidence ${s.volumeEvidenceScore} < ${P.moderate.minVolumeScore}: price without participation` };
  const rp = s.groups.relParticipation;
  if (rp?.usable && rp.score < P.moderate.minRelParticipation && s.adjustedScore >= 50) return { label: 'weak', why: `relative participation ${rp.score.toFixed(2)} is below normal: not a volume-supported setup` };
  if (s.adjustedScore >= P.moderate.minAdjusted && s.supportingGroups.length >= P.moderate.minSupportingGroups) {
    const miss = [];
    if (s.adjustedScore < st.minAdjusted) miss.push(`adjusted ${s.adjustedScore} < ${st.minAdjusted}`);
    if (volSupport < st.minSupportingVolumeGroups) miss.push(`${volSupport} supporting volume group(s) < ${st.minSupportingVolumeGroups}`);
    if (s.supportingGroups.length < st.minSupportingGroups) miss.push(`${s.supportingGroups.length} supporting groups < ${st.minSupportingGroups}`);
    if (s.coverage.profile < st.minCoverage) miss.push(`coverage ${Math.round(s.coverage.profile * 100)}% < ${st.minCoverage * 100}%`);
    if (volOpposeStrong) miss.push('a volume group strongly opposes');
    if (s.volumeEvidenceScore != null && s.volumeEvidenceScore < st.minVolumeScore) miss.push(`volume evidence ${s.volumeEvidenceScore} < ${st.minVolumeScore}`);
    return { label: 'moderate', why: miss.join('; ') || 'below strong thresholds' };
  }
  if (s.adjustedScore >= 50) return { label: 'weak', why: `adjusted ${s.adjustedScore}` };
  return { label: 'none', why: `adjusted ${s.adjustedScore}: evidence leans against this direction` };
}

/** Both directions, setup classification and labels for one stock's features. */
export function scoreStock(f, ctx, config = {}) {
  const long = scoreDirection(f, 1, ctx, config);
  const short = scoreDirection(f, -1, ctx, config);
  long.label = convictionLabel(long, ctx);
  short.label = convictionLabel(short, ctx);
  const gapDir = Math.sign(f.gapPct ?? 0) || null;
  const setup = gapDir ? setupChecklists(f, gapDir) : null;
  // Exhaustion evidence in the gap direction caps that direction's label: continuation and fade are never blended into one score.
  if (setup && setup.exhaustionMet >= 2) {
    const s = gapDir > 0 ? long : short;
    if (s.label.label === 'strong') s.label = { label: 'moderate', why: `capped: ${setup.exhaustionMet} exhaustion signals (${setup.exhaustion.filter((x) => x.met).map((x) => x.label.toLowerCase()).join('; ')})`, cappedFrom: 'strong' };
  }
  const better = (long.adjustedScore ?? -1) >= (short.adjustedScore ?? -1) ? long : short;
  return {
    symbol: f.symbol,
    scoreVersion: SCORE_VERSION,
    configHash: configHash(config),
    preset: config.preset ?? DEFAULT_PRESET,
    long, short,
    leading: better.direction,
    setup,
  };
}
