/**
 * Paper research strategies, evaluated at the 09:35 seal (pure). Each returns every
 * check with a reason and a signal (direction, trigger, stop, targets, invalidation)
 * only when all checks pass. Continuation and reversal are separate strategies and
 * never share one score. Every threshold is an untested hypothesis.
 *
 * Input s = { w (opening window), pre (pre-market features), conf: {long, short} confirmation, market }.
 */

export const DEFAULT_STRATEGY_SETTINGS = {
  orb: { enabled: true, allowShorts: true, minClosePos: 0.7, minRvol: 1.2, minRangeAtr: 0.1, maxRangeAtr: 1.2, wideRangeAtr: 0.8, maxSpreadBps: 25, target1R: 1.5, target2R: 3 },
  gapPullback: { enabled: true, allowShorts: true, minGapPct: 2, minPullbackPct: 0.4, maxGapRetracePct: 60, minRecovery: 0.5, minRecoveryVolumeRatio: 1.2, maxStopPct: 3, maxSpreadBps: 30 },
  momentum: { enabled: true, allowShorts: true, minConsistentMinutes: 4, minRvol: 1.5, minClosePos: 0.8, maxOppositeWickPct: 25, maxVwapDistPct: 1.5, maxRet5Pct: 3, maxRangeAtr: 1.2, maxSpreadBps: 20, minStopAtr: 0.15, target1R: 1.5, target2R: 3 },
  gapFailure: { enabled: true, allowShorts: true, minGapPct: 2, minGiveBackPct: 50, minRvol: 1.0, maxSpreadBps: 30, target1R: 1.5, target2R: 2.5 },
};

export const STRATEGY_LABEL = {
  orb: 'Opening-range breakout / breakdown', gapPullback: 'Gap pullback & recovery', momentum: 'Opening momentum', gapFailure: 'Gap failure / reversal',
};
export const STRATEGY_KIND = { orb: 'continuation', gapPullback: 'continuation', momentum: 'continuation', gapFailure: 'reversal' };

const f2 = (n) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(2));
export const tickSize = (price) => (price >= 1 ? 0.01 : 0.0001);

export function strategySettings(input = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_STRATEGY_SETTINGS).map(([k, d]) => [k, { ...d, ...(input?.[k] ?? {}) }]));
}

function make(strategy) {
  const checks = [];
  const check = (key, label, ok, detail) => { checks.push({ key, label, ok: Boolean(ok), detail }); return ok; };
  const result = (fields) => ({ strategy, kind: STRATEGY_KIND[strategy], label: STRATEGY_LABEL[strategy], checks, ...fields, pass: Boolean(fields.applies && checks.every((c) => c.ok) && fields.signal) });
  return { check, result };
}

const spreadCheck = (check, w, max) => check('spread', 'Spread at the seal', w.quote?.spreadBps != null && w.quote.spreadBps <= max, w.quote?.spreadBps != null ? `${f2(w.quote.spreadBps)} bps (max ${max})` : 'no two-sided quote at the seal');
const rvolOf = (w) => (w.rvol?.ok ? w.rvol.rvol : null);

/** A. Opening-range breakout (long) / breakdown (short). */
export function openingRangeBreakout({ w }, cfg) {
  const { check, result } = make('orb');
  if (!cfg.enabled) return result({ applies: false, reason: 'turned off' });
  if (!w?.available) return result({ applies: false, reason: 'no opening window' });
  const dir = w.closePos >= cfg.minClosePos && w.ret5Pct > 0 ? 1 : w.closePos <= 1 - cfg.minClosePos && w.ret5Pct < 0 ? -1 : 0;
  if (!dir) return result({ applies: false, reason: `close at ${Math.round(w.closePos * 100)}% of the range: not at an extreme` });
  if (dir < 0) check('shorts', 'Shorts allowed', cfg.allowShorts, cfg.allowShorts ? 'paper short (needs borrow for an executable entry)' : 'shorts turned off');
  const rv = rvolOf(w);
  check('rvol', 'Opening volume above its norm', rv != null && rv >= cfg.minRvol, rv == null ? `no opening baseline (${w.rvol?.reason})` : `RVOL ${f2(rv)} (min ${cfg.minRvol})`);
  check('vwap', `${dir > 0 ? 'Above' : 'Below'} session VWAP`, dir * (w.close - w.vwap) > 0, `close ${f2(w.close)} vs VWAP ${f2(w.vwap)}`);
  check('range', 'Range width vs ATR', w.orRangeAtr == null || (w.orRangeAtr >= cfg.minRangeAtr && w.orRangeAtr <= cfg.maxRangeAtr), w.orRangeAtr == null ? 'no ATR (not required)' : `${f2(w.orRangeAtr)}× ATR (${cfg.minRangeAtr}–${cfg.maxRangeAtr})`);
  check('complete', 'Window fully observed', w.complete, w.complete ? 'all 5 minutes observed' : `${w.missingMinutes} minute(s) missing`);
  spreadCheck(check, w, cfg.maxSpreadBps);
  const tick = tickSize(w.close);
  const wide = w.orRangeAtr != null && w.orRangeAtr > cfg.wideRangeAtr;
  const trigger = dir > 0 ? w.orHigh + tick : w.orLow - tick;
  const stop = wide ? (w.orHigh + w.orLow) / 2 : dir > 0 ? w.orLow - tick : w.orHigh + tick;
  const R = Math.abs(trigger - stop);
  const signal = w.orHigh > w.orLow ? {
    direction: dir, trigger, stop, target1: trigger + dir * cfg.target1R * R, target2: trigger + dir * cfg.target2R * R,
    invalidation: `a 1-minute close back ${dir > 0 ? 'below' : 'above'} session VWAP ${f2(w.vwap)} before the trigger, or no trigger by the entry expiry`,
    note: `stop-entry one tick beyond the 09:30–09:35 ${dir > 0 ? 'high' : 'low'}; stop at the ${wide ? 'range midpoint (wide range)' : `range ${dir > 0 ? 'low' : 'high'}`}`,
  } : null;
  return result({ applies: true, direction: dir, signal, summary: `${dir > 0 ? 'long breakout' : 'short breakdown'} setup` });
}

/** B. Gap pullback & recovery: gap holds, pulls back on lighter volume, recovers on heavier volume. Mirrored for gap-downs. */
export function gapPullbackRecovery({ w, pre }, cfg) {
  const { check, result } = make('gapPullback');
  if (!cfg.enabled) return result({ applies: false, reason: 'turned off' });
  const gap = w?.officialOpenGapPct ?? pre?.gapPct;
  if (!w?.available || gap == null || Math.abs(gap) < cfg.minGapPct) return result({ applies: false, reason: `gap ${f2(gap)}% is smaller than ±${cfg.minGapPct}%` });
  const dir = Math.sign(gap);
  if (dir < 0) check('shorts', 'Shorts allowed', cfg.allowShorts, cfg.allowShorts ? 'paper short' : 'shorts turned off');
  const c = w.candles.map((x, i) => (x ? { ...x, i } : null)).filter(Boolean);
  if (c.length < 3) return result({ applies: true, direction: dir, signal: null, reason: 'fewer than 3 minute candles' });
  const ext = (a, b) => (dir > 0 ? (a.h > b.h ? a : b) : (a.l < b.l ? a : b));
  const worst = (a, b) => (dir > 0 ? (a.l < b.l ? a : b) : (a.h > b.h ? a : b));
  const trough = c.reduce(worst);
  const before = c.filter((x) => x.i < trough.i);
  const peak = before.length ? before.reduce(ext) : trough;
  const after = c.filter((x) => x.i > trough.i);
  check('order', 'Extreme, then pullback, then recovery', before.length > 0 && after.length > 0, before.length ? `extreme in minute ${peak.i + 1}, pullback in minute ${trough.i + 1}` : 'pullback extreme in the first minute');
  const pk = dir > 0 ? peak.h : peak.l; const tr = dir > 0 ? trough.l : trough.h;
  const pullbackPct = Math.abs((pk - tr) / pk) * 100;
  check('pullback', 'A real pullback', pullbackPct >= cfg.minPullbackPct, `${f2(pullbackPct)}% (min ${cfg.minPullbackPct}%)`);
  const prev = pre?.prevClose;
  const retrace = prev && w.open !== prev ? ((w.open - tr) / (w.open - prev)) * 100 : null;
  check('gapHeld', 'Gap not filled', prev != null && dir * (tr - prev) > 0 && (retrace == null || retrace <= cfg.maxGapRetracePct), `${f2(retrace)}% of the gap given back (max ${cfg.maxGapRetracePct}%)`);
  const recovery = pk !== tr ? (w.close - tr) / (pk - tr) : 0;
  check('recovery', 'Recovered from the pullback', recovery >= cfg.minRecovery, `${Math.round(recovery * 100)}% recovered (min ${Math.round(cfg.minRecovery * 100)}%)`);
  check('vwap', 'Back on the gap side of VWAP', dir * (w.close - w.vwap) > 0, `close ${f2(w.close)} vs VWAP ${f2(w.vwap)}`);
  const sell = c.filter((x) => x.i >= peak.i && x.i <= trough.i);
  const rate = (xs) => xs.reduce((s, x) => s + x.v, 0) / Math.max(1, xs.length);
  const volRatio = rate(sell) > 0 ? rate(after) / rate(sell) : null;
  check('volume', 'Recovery volume heavier than the pullback', volRatio != null && volRatio >= cfg.minRecoveryVolumeRatio, volRatio == null ? 'no pullback volume' : `${f2(volRatio)}× (min ${cfg.minRecoveryVolumeRatio}); lighter reads as a dead-cat bounce`);
  spreadCheck(check, w, cfg.maxSpreadBps);
  const tick = tickSize(w.close);
  const lastExt = after.length ? (dir > 0 ? after.at(-1).h : after.at(-1).l) : w.close;
  const trigger = dir > 0 ? Math.max(lastExt, w.close) + tick : Math.min(lastExt, w.close) - tick;
  const stop = tr - dir * tick;
  const stopPct = Math.abs((trigger - stop) / trigger) * 100;
  check('stopWidth', 'Stop distance acceptable', stopPct <= cfg.maxStopPct, `${f2(stopPct)}% (max ${cfg.maxStopPct}%)`);
  const R = Math.abs(trigger - stop);
  const signal = { direction: dir, trigger, stop, target1: dir > 0 ? Math.max(pk, trigger + R) : Math.min(pk, trigger - R), target2: trigger + dir * 2 * R,
    invalidation: `price through the pullback ${dir > 0 ? 'low' : 'high'} ${f2(tr)}`, note: 'stop-entry beyond the recovery candle; stop beyond the pullback extreme' };
  return result({ applies: true, direction: dir, signal, summary: `gap-${dir > 0 ? 'up' : 'down'} recovery setup`, metrics: { pullbackPct, recovery, volRatio, retrace } });
}

/** C. Opening momentum: consistent direction, strong volume, close at the extreme, not over-extended. */
export function openingMomentum({ w, market, pre }, cfg) {
  const { check, result } = make('momentum');
  if (!cfg.enabled) return result({ applies: false, reason: 'turned off' });
  if (!w?.available || !w.ret5Pct) return result({ applies: false, reason: 'no move since the open' });
  const dir = Math.sign(w.ret5Pct);
  const consistent = w.minuteReturns.filter((r) => r != null && Math.sign(r) === dir).length;
  if (consistent < cfg.minConsistentMinutes - 1) return result({ applies: false, reason: `only ${consistent} of 5 minutes moved ${dir > 0 ? 'up' : 'down'}` });
  if (dir < 0) check('shorts', 'Shorts allowed', cfg.allowShorts, cfg.allowShorts ? 'paper short' : 'shorts turned off');
  check('consistent', 'Consistent direction', consistent >= cfg.minConsistentMinutes, `${consistent} of 5 minutes (min ${cfg.minConsistentMinutes})`);
  const rv = rvolOf(w);
  check('rvol', 'Strong opening RVOL', rv != null && rv >= cfg.minRvol, rv == null ? `no baseline (${w.rvol?.reason})` : `RVOL ${f2(rv)} (min ${cfg.minRvol})`);
  const pos = dir > 0 ? w.closePos : 1 - w.closePos;
  check('extreme', 'Close near the extreme', pos >= cfg.minClosePos, `close at ${Math.round(w.closePos * 100)}% of the range`);
  const wick = dir > 0 ? w.upperWickPct : w.lowerWickPct;
  check('wick', 'Small rejection wick', wick <= cfg.maxOppositeWickPct, `${f2(wick)}% (max ${cfg.maxOppositeWickPct})`);
  const q = market?.QQQ?.ret5Pct;
  check('market', 'QQQ not against', q == null || dir * q > -0.05, q == null ? 'QQQ window not observed (not required)' : `QQQ ${f2(q)}%`);
  check('notExtended', 'Not over-extended', dir * (w.vwapDistPct ?? 0) <= cfg.maxVwapDistPct && dir * w.ret5Pct <= cfg.maxRet5Pct && (w.orRangeAtr == null || w.orRangeAtr <= cfg.maxRangeAtr), `${f2(w.vwapDistPct)}% from VWAP, ${f2(w.ret5Pct)}% since the open, ${f2(w.orRangeAtr)}× ATR`);
  spreadCheck(check, w, cfg.maxSpreadBps);
  const entry = dir > 0 ? w.quote?.ask ?? w.close : w.quote?.bid ?? w.close;
  const last = w.candles.filter(Boolean).at(-1);
  let stop = dir > 0 ? Math.min(w.vwap, last.l) : Math.max(w.vwap, last.h);
  const atr = pre?.hist?.atr14;
  if (atr && dir * (entry - stop) < cfg.minStopAtr * atr) stop = entry - dir * cfg.minStopAtr * atr;
  const R = Math.abs(entry - stop);
  const signal = R > 0 ? { direction: dir, immediate: true, trigger: entry, stop, target1: entry + dir * cfg.target1R * R, target2: entry + dir * cfg.target2R * R,
    invalidation: `a close back through session VWAP ${f2(w.vwap)}`, note: 'marketable entry after the seal at the ask (bid for shorts); stop beyond VWAP / the last minute' } : null;
  return result({ applies: true, direction: dir, signal, summary: `${dir > 0 ? 'long' : 'short'} momentum setup` });
}

/** D. Gap failure / reversal (separate strategy): a gap that gives back most of itself and loses VWAP on volume. */
export function gapFailure({ w, pre }, cfg) {
  const { check, result } = make('gapFailure');
  if (!cfg.enabled) return result({ applies: false, reason: 'turned off' });
  const gap = pre?.gapPct;
  if (!w?.available || gap == null || Math.abs(gap) < cfg.minGapPct) return result({ applies: false, reason: `pre-market gap ${f2(gap)}% is smaller than ±${cfg.minGapPct}%` });
  const gapDir = Math.sign(gap);
  const dir = -gapDir; // trade against the gap
  if (dir < 0) check('shorts', 'Shorts allowed', cfg.allowShorts, cfg.allowShorts ? 'paper short' : 'shorts turned off');
  const prev = pre.prevClose;
  const extreme = gapDir > 0 ? Math.max(w.orHigh, pre.pm?.high ?? -Infinity) : Math.min(w.orLow, pre.pm?.low ?? Infinity);
  const giveBack = extreme !== prev ? ((extreme - w.close) / (extreme - prev)) * 100 : 0;
  check('giveBack', 'Gap substantially given back', giveBack >= cfg.minGiveBackPct, `${f2(giveBack)}% of the gap given back (min ${cfg.minGiveBackPct}%)`);
  check('vwap', 'Lost session VWAP', dir * (w.close - w.vwap) > 0, `close ${f2(w.close)} vs VWAP ${f2(w.vwap)}`);
  const rv = rvolOf(w);
  check('rvol', 'Reversal on real volume', rv != null && rv >= cfg.minRvol, rv == null ? `no baseline (${w.rvol?.reason})` : `RVOL ${f2(rv)} (min ${cfg.minRvol})`);
  check('direction', 'Window moving against the gap', dir * w.ret5Pct > 0, `${f2(w.ret5Pct)}% open→09:35`);
  spreadCheck(check, w, cfg.maxSpreadBps);
  const tick = tickSize(w.close);
  const trigger = w.close + dir * tick;
  const stop = dir > 0 ? w.orLow - tick : w.orHigh + tick;
  const R = Math.abs(trigger - stop);
  const fill = prev != null && dir * (prev - trigger) > cfg.target1R * R ? prev : trigger + dir * cfg.target2R * R;
  const signal = dir * (trigger - stop) > 0 ? { direction: dir, trigger, stop, target1: trigger + dir * cfg.target1R * R, target2: fill,
    invalidation: `price back beyond the opening ${gapDir > 0 ? 'high' : 'low'} ${f2(gapDir > 0 ? w.orHigh : w.orLow)}`, note: 'stop-entry one tick through the seal price, against the gap; target 2 the previous close (gap fill)' } : null;
  return result({ applies: true, direction: dir, signal, summary: `gap-${gapDir > 0 ? 'up' : 'down'} failure (${dir > 0 ? 'long' : 'short'} reversal)` });
}

export const STRATEGIES = { orb: openingRangeBreakout, gapPullback: gapPullbackRecovery, momentum: openingMomentum, gapFailure };

export function runStrategies(input, settings) {
  const cfg = strategySettings(settings);
  return Object.entries(STRATEGIES).map(([k, fn]) => fn(input, cfg[k]));
}
