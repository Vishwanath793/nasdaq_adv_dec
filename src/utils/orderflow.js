/**
 * Aggressor-side ESTIMATE (pure). Lee–Ready (1991) style:
 *  1. Quote rule: a trade above the prevailing midpoint is classified buyer-initiated,
 *     below it seller-initiated. The prevailing quote is the latest quote strictly
 *     before the trade (no 5-second lag: modern feeds are timestamped together).
 *  2. At the midpoint, the tick rule: an uptick (or zero-uptick) is a buy, a downtick
 *     (or zero-downtick) a sell.
 *  3. With no usable quote (missing, stale beyond maxQuoteAgeMs, crossed or locked),
 *     the trade stays unclassified rather than being guessed.
 *
 * Known uncertainty: published accuracy of Lee–Ready is roughly 70–90% depending on
 * venue and period, worse for trades inside the spread and in fast markets. With a
 * single-venue feed (IEX) the quote is IEX's own book, not the NBBO. This is never
 * "institutional buying"; it is an estimate of which side crossed the spread.
 */

export const ORDERFLOW_METHOD = 'Lee–Ready quote rule + tick rule at the midpoint; unclassified without a valid prevailing quote';

export function classifyTrades(trades, quotes, { maxQuoteAgeMs = 5_000 } = {}) {
  const qs = [...quotes].sort((a, b) => a.t - b.t);
  let qi = -1;
  let lastPrice = null;
  let lastDir = 0;
  let buy = 0; let sell = 0; let unclassified = 0; let byQuote = 0; let byTick = 0;
  const out = [];
  for (const tr of [...trades].sort((a, b) => a.t - b.t)) {
    while (qi + 1 < qs.length && qs[qi + 1].t < tr.t) qi++;
    const q = qi >= 0 ? qs[qi] : null;
    let side = 0;
    let how = 'none';
    const quoteOk = q && tr.t - q.t <= maxQuoteAgeMs && q.bid > 0 && q.ask > q.bid;
    if (quoteOk) {
      const mid = (q.bid + q.ask) / 2;
      if (tr.price > mid) { side = 1; how = 'quote'; }
      else if (tr.price < mid) { side = -1; how = 'quote'; }
      else if (lastPrice != null) {
        side = tr.price > lastPrice ? 1 : tr.price < lastPrice ? -1 : lastDir;
        how = side ? 'tick' : 'none';
      }
    }
    if (lastPrice != null && tr.price !== lastPrice) lastDir = tr.price > lastPrice ? 1 : -1;
    lastPrice = tr.price;
    if (side > 0) buy += tr.size; else if (side < 0) sell += tr.size; else unclassified += tr.size;
    if (how === 'quote') byQuote += tr.size; else if (how === 'tick') byTick += tr.size;
    out.push({ ...tr, side, how });
  }
  const total = buy + sell + unclassified;
  return {
    method: ORDERFLOW_METHOD,
    estBuyVolume: buy,
    estSellVolume: sell,
    unclassifiedVolume: unclassified,
    coverage: total ? (buy + sell) / total : 0,
    byQuoteShare: total ? byQuote / total : 0,
    byTickShare: total ? byTick / total : 0,
    // Signed share of classified volume, −1..1. Null when too little is classified to say anything.
    imbalance: buy + sell > 0 && (buy + sell) / Math.max(1, total) >= 0.5 ? (buy - sell) / (buy + sell) : null,
    trades: out,
  };
}
