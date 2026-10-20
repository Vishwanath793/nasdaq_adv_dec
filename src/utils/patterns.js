/**
 * Continuation vs exhaustion research checklists (pure). These are hypotheses to
 * validate on recorded sessions, not known edges. Each check reports whether it
 * could be evaluated; an unevaluable check is neither met nor failed.
 *
 * "Absorption" is an INFERENCE from price behaviour under heavy activity; nothing
 * here observes hidden orders or institutional intent.
 */

const r = (n, d = 2) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(d));

export function setupChecklists(f, dir) {
  const pv = dir > 0 ? f.pvLong : f.pvShort;
  const rv = f.rvol?.ok ? f.rvol.rvol : null;
  const prog = pv?.progressAtr ?? (f.gapPct != null ? (dir * f.gapPct) / 2 : null);
  const c = (key, label, met, detail) => ({ key, label, met, evaluable: met !== null, detail });
  const continuation = [
    c('rvol', 'Elevated same-time RVOL', rv == null ? null : rv >= 1.5, `RVOL ${r(rv)} (≥1.5)`),
    c('sustained', 'Sustained activity across intervals', f.persistence == null ? null : f.persistence >= 0.5, `${r((f.persistence ?? 0) * 100, 0)}% of minutes since first trade active`),
    c('progress', 'Price progress in the setup direction', prog == null ? null : prog >= 0.3, `${r(prog)} ATR (or 2%-units) in direction`),
    c('pullbackVol', 'Pullbacks on reduced volume', pv?.pushPullRatio == null ? null : pv.pushPullRatio >= 1.2, `push/pullback volume ratio ${r(pv?.pushPullRatio)}`),
    c('breakVol', 'Breakout on renewed volume', f.breaks == null ? null : (() => { const b = dir > 0 ? f.breaks.up : f.breaks.down; return b ? !b.failed && (b.volumeRatio ?? 0) >= 1.2 : false; })(), 'break of the earlier pre-market extreme with volume'),
    c('liquidity', 'Stable executable liquidity', f.quote?.spreadStability == null ? null : f.quote.spreadStability >= 0.6 && (f.quote.spreadBps ?? 999) <= 50, `spread ${r(f.quote?.spreadBps, 1)} bps, stability ${r(f.quote?.spreadStability)}`),
  ];
  const rej = dir > 0 ? f.heavyRejections?.up : f.heavyRejections?.down;
  const brk = f.breaks ? (dir > 0 ? f.breaks.up : f.breaks.down) : undefined;
  const exhaustion = [
    c('noProgress', 'Extreme volume with little price progress', rv == null || prog == null ? null : rv >= 3 && prog < 0.2, `RVOL ${r(rv)} with ${r(prog)} ATR progress`),
    c('rejection', 'Large rejection wick on heavy volume', f.heavyRejections == null ? null : rej > 0, `${rej ?? 0} heavy rejection bar(s)`),
    c('failedBreak', 'Failed breakout on heavy activity', brk === undefined ? null : Boolean(brk?.failed && (brk.volumeRatio ?? 0) >= 1), brk ? `failed=${brk.failed}, volume ×${r(brk.volumeRatio)}` : 'no break attempt'),
    c('spikeSilence', 'Volume spike followed by inactivity', f.postSpikePersistence == null ? null : f.postSpikePersistence < 0.3 && (f.largestMinuteShare ?? 0) >= 0.3, `largest minute ${r((f.largestMinuteShare ?? 0) * 100, 0)}% of volume, ${r((f.postSpikePersistence ?? 0) * 100, 0)}% of later minutes active`),
    c('extended', 'Excessive distance from VWAP', f.distVwapPct == null ? null : dir * f.distVwapPct >= 4, `${r(f.distVwapPct)}% from pre-market VWAP`),
    c('spreadWiden', 'Widening spreads', f.quote?.medianSpreadBps == null || f.quote?.spreadBps == null ? null : f.quote.spreadBps >= 2 * f.quote.medianSpreadBps && f.quote.spreadBps > 20, `spread ${r(f.quote?.spreadBps, 1)} vs median ${r(f.quote?.medianSpreadBps, 1)} bps`),
    c('counterVolume', 'Countertrend volume overwhelming the recovery', pv?.pushPullRatio == null ? null : pv.pushPullRatio < 0.7, `push/pullback volume ratio ${r(pv?.pushPullRatio)}`),
  ];
  const met = (list) => list.filter((x) => x.met === true).length;
  const evaluable = (list) => list.filter((x) => x.evaluable).length;
  const cm = met(continuation);
  const em = met(exhaustion);
  // Absorption-like (inference): heavy volume on minutes moving in the gap direction, yet no further
  // progress over the last 30 minutes (someone may be taking the other side). An inference, not an observation.
  const r30 = f.returns?.r30;
  const against = pv?.pullRate != null && pv?.pushRate != null && pv.pushRate > 1.5 * pv.pullRate && rv != null && rv >= 2 && r30 != null && dir * r30 <= 0.05;
  const classification = evaluable(continuation) < 3 ? 'insufficient evidence'
    : em >= 2 && em >= cm ? 'possible exhaustion / fade'
      : cm >= 3 && em <= 1 ? 'continuation'
        : 'unclear';
  return {
    direction: dir,
    continuation, exhaustion,
    continuationMet: cm, exhaustionMet: em,
    continuationEvaluable: evaluable(continuation), exhaustionEvaluable: evaluable(exhaustion),
    classification,
    absorptionInference: against ? `heavy ${dir > 0 ? 'buying-side' : 'selling-side'} volume without further progress over 30 min: absorption-like behaviour (inference only, not observed orders)` : null,
    // Separate fade score: never mixed into the continuation score.
    fadeScore: evaluable(exhaustion) >= 3 ? Math.round((em / evaluable(exhaustion)) * 100) : null,
  };
}
