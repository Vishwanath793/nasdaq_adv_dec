/**
 * Hard eligibility gates (pure). Gates are tri-state: 'pass' | 'fail' | 'unknown'.
 * A failed gate blocks regardless of score; an unknown gate on a critical input
 * prevents an executable decision ("insufficient evidence"), it never reads as safe.
 */

export const DEFAULT_GATES = {
  maxQuoteAgeMs: 120_000, // pre-market quotes on a single venue can be sparse
  maxCutoffLagMs: 90_000, // data must reach within this of the decision time
  minObservedShare: 0.8, // of the pre-market window that should have been observed
  minActiveMinutes: 10,
  maxSpreadBps: 60, // pre-market; opening entries use the risk setting
  maxCrossedShare: 0.2,
  minPreMarketDollar: 250_000,
  minAvgDailyDollar: 5_000_000,
  maxOrderShareOfTop: 1.0, // proposed order ÷ displayed top-of-book size on the entry side
};

const g = (key, label, state, detail, critical = true) => ({ key, label, state, detail, critical });
const money = (n) => (n == null ? 'n/a' : `$${Math.round(n).toLocaleString('en-US')}`);

/**
 * f: features; opts: { dataMode, gates, direction, orderShares, sessionPhase, riskBlockers:[...] }
 */
export function evaluateGates(f, opts = {}) {
  const c = { ...DEFAULT_GATES, ...(opts.gates ?? {}) };
  const out = [];
  // Halt / suspension (Nasdaq Trader RSS is not a low-latency status stream: unknown when not checked).
  if (!f.halt?.statusKnown) out.push(g('halt', 'Not halted', 'unknown', 'halt status not checked'));
  else out.push(g('halt', 'Not halted', f.halt.halted ? 'fail' : 'pass', f.halt.halted ? `halted (${f.halt.current?.reason ?? 'reason n/a'}) since ${new Date(f.halt.current.haltAt).toISOString()}` : `${f.halt.today} halt record(s) today, none active`));
  // Freshness of critical data.
  if (opts.dataMode === 'DELAYED') out.push(g('fresh', 'Current data', 'fail', `delayed feed: data cutoff ${Math.round((f.cutoffLagMs ?? 0) / 60_000)} min before the decision`));
  else if (opts.dataMode === 'DEMO' || opts.dataMode === 'REPLAY') out.push(g('fresh', 'Current data', f.cutoffLagMs != null && f.cutoffLagMs <= c.maxCutoffLagMs ? 'pass' : 'fail', `${opts.dataMode}: cutoff lag ${f.cutoffLagMs == null ? 'n/a' : Math.round(f.cutoffLagMs / 1000) + ' s'}`));
  else out.push(g('fresh', 'Current data', f.cutoffLagMs == null ? 'unknown' : f.cutoffLagMs <= c.maxCutoffLagMs ? 'pass' : 'fail', f.cutoffLagMs == null ? 'feed observation end unknown' : `observation reaches ${Math.round(f.cutoffLagMs / 1000)} s before the decision`));
  // Observation window.
  out.push(g('window', 'Enough observation', f.preMarketObserved >= c.minObservedShare && f.activeMinutes >= c.minActiveMinutes ? 'pass' : f.preMarketObserved === 0 ? 'unknown' : 'fail',
    `${Math.round((f.preMarketObserved ?? 0) * 100)}% of the window observed, ${f.activeMinutes ?? 0} active minutes (min ${c.minActiveMinutes})${f.coverageGaps?.length ? `; ${f.coverageGaps.length} gap(s)` : ''}`));
  // Reference price / corporate action.
  if (f.prevCloseIssue) out.push(g('reference', 'Reference price valid', 'fail', f.prevCloseIssue));
  else out.push(g('reference', 'Reference price valid', f.prevClose ? 'pass' : 'unknown', f.prevClose ? `previous official close ${f.prevClose}` : 'no previous close'));
  // Market quality.
  const q = f.quote;
  if (!q?.available) out.push(g('quote', 'Two-sided, current quote', 'unknown', q?.reason ?? 'no quote'));
  else {
    const crossed = q.crossedNow || q.crossedShare > c.maxCrossedShare;
    const stale = q.quoteAgeMs > c.maxQuoteAgeMs;
    out.push(g('quote', 'Two-sided, current quote', crossed || stale || !(q.bid > 0 && q.ask > 0) ? 'fail' : 'pass',
      `${q.bid}×${q.ask}, age ${Math.round(q.quoteAgeMs / 1000)} s${crossed ? `; crossed ${Math.round(q.crossedShare * 100)}% of the time` : ''}${q.lockedShare > 0.2 ? '; often locked' : ''}`));
    out.push(g('spread', 'Spread acceptable', q.spreadBps == null ? 'unknown' : q.spreadBps <= c.maxSpreadBps ? 'pass' : 'fail', `${q.spreadBps == null ? 'n/a' : q.spreadBps.toFixed(1)} bps (max ${c.maxSpreadBps}; single-venue quote when the feed is IEX)`));
    if (opts.orderShares) {
      const side = opts.direction > 0 ? q.askSizeShares : q.bidSizeShares;
      const share = side > 0 ? opts.orderShares / side : Infinity;
      out.push(g('slippage', 'Order fits displayed size', share <= c.maxOrderShareOfTop ? 'pass' : 'fail', `${opts.orderShares} shares vs ${side ?? 0} displayed (${share === Infinity ? '∞' : share.toFixed(2)}×); deeper liquidity is unknown`, false));
    }
  }
  // Liquidity.
  const adv = f.hist?.avgDailyDollar20;
  const liqState = adv == null && f.cumDollar == null ? 'unknown' : (adv == null || adv >= c.minAvgDailyDollar) && (f.cumDollar ?? 0) >= c.minPreMarketDollar ? 'pass' : 'fail';
  out.push(g('liquidity', 'Enough liquidity', liqState, `pre-market ${money(f.cumDollar)} (min ${money(c.minPreMarketDollar)})${f.cumDollarExact ? '' : ' approx'}; 20-day median ${money(adv)} (min ${money(c.minAvgDailyDollar)}) — ${f.scope?.feed === 'iex' ? 'IEX-only volume understates the market' : 'feed volume'}`));
  // LULD: bands apply in the regular session only; in extended hours they are not in force, which is not "safe".
  out.push(g('luld', 'LULD context', 'unknown', 'LULD bands are not published for extended hours; treated as unknown, not as unrestricted', false));
  // Short borrow.
  if (opts.direction < 0) {
    const b = f.borrow;
    out.push(g('borrow', 'Shortable (paper short)', b == null ? 'unknown' : b.shortable && b.easyToBorrow ? 'pass' : 'fail',
      b == null ? 'borrow/shortability not checked: short stays hypothetical' : `shortable ${b.shortable}, easy to borrow ${b.easyToBorrow} (as of ${b.asOf ?? 'n/a'}, ${b.source ?? 'broker'})`));
  }
  for (const r of opts.riskBlockers ?? []) out.push(g('risk', 'Risk limits', 'fail', r));
  const failed = out.filter((x) => x.state === 'fail');
  const unknownCritical = out.filter((x) => x.state === 'unknown' && x.critical);
  return {
    gates: out,
    eligible: failed.length === 0 && unknownCritical.length === 0,
    status: failed.length ? 'blocked' : unknownCritical.length ? 'unverified' : 'eligible',
    primaryReason: failed[0] ? `${failed[0].label}: ${failed[0].detail}` : unknownCritical[0] ? `${unknownCritical[0].label} unknown: ${unknownCritical[0].detail}` : null,
  };
}
