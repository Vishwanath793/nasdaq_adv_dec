/**
 * Nasdaq opening-cross NOII (Net Order Imbalance Indicator) model (pure).
 *
 * NOII is a paid/licensed feed (TotalView-ITCH, or a vendor such as Databento
 * XNAS.ITCH). In the free profiles it is UNAVAILABLE and every auction factor
 * says so; nothing here is ever synthesised from quote sizes.
 *
 * Semantics (verify against the current Nasdaq rulebook / ITCH spec before live use):
 *  - Dissemination: early NOII from about 09:25 ET; near/far indicative prices only
 *    from about 09:28 ET. Before that, near/far fields carry placeholders (0, or a
 *    vendor "undefined price" sentinel) which are UNAVAILABLE values, not $0 prices.
 *  - ITCH imbalance direction: B = buy, S = sell, N = no imbalance, O = insufficient orders.
 *    Databento's normalised imbalance schema uses side B (bid/buy), A (ask/sell), N (none).
 *  - Paired shares + imbalance shares are NOT the auction's full supply/demand curve.
 */

export const UNDEF_PRICE_SENTINELS = new Set([0, 9_223_372_036_854_775_807, 2_147_483_647]);

/** Map a vendor side code to +1 (buy imbalance), −1 (sell), 0 (none), or null (insufficient/unknown). */
export function imbalanceSign(side, convention = 'itch') {
  const s = String(side ?? '').toUpperCase();
  if (convention === 'databento') return s === 'B' ? 1 : s === 'A' ? -1 : s === 'N' ? 0 : null;
  return s === 'B' ? 1 : s === 'S' ? -1 : s === 'N' ? 0 : null; // 'O' = insufficient orders → null
}

const priceOrNull = (p) => (p == null || UNDEF_PRICE_SENTINELS.has(p) || !(p > 0) ? null : p);

/** One raw message → normalised NOII record. `priceScale` divides integer vendor prices (ITCH 1e4, Databento 1e9). */
export function normalizeNoii(raw, { convention = 'itch', priceScale = 1 } = {}) {
  // Sentinels are checked on the raw vendor value, before scaling.
  const px = (p) => (p == null || UNDEF_PRICE_SENTINELS.has(p) ? null : priceOrNull(p / priceScale));
  const sign = imbalanceSign(raw.imbalanceSide ?? raw.side, convention);
  return {
    t: raw.t,
    availableAt: raw.availableAt ?? raw.t,
    pairedShares: raw.pairedShares ?? null,
    imbalanceShares: raw.imbalanceShares ?? null,
    side: sign,
    insufficient: sign == null,
    referencePrice: px(raw.referencePrice),
    nearPrice: px(raw.nearPrice),
    farPrice: px(raw.farPrice),
    crossType: raw.crossType ?? 'O',
    priceVariation: raw.priceVariation ?? null,
  };
}

const bps = (a, b) => (a != null && b != null && b > 0 ? ((a - b) / b) * 10_000 : null);

/**
 * Auction features known at asOf.
 * ctx: { preMarketVwap, preMarketMid, preMarketReturnPct, typicalCrossVolume, stageTimes:{early, main} }
 */
export function auctionFeatures(messages, asOf, ctx = {}) {
  const msgs = (messages ?? []).filter((m) => m.availableAt <= asOf && m.crossType === 'O').sort((a, b) => a.t - b.t);
  if (!msgs.length) return { available: false, reason: 'no NOII messages received by this time' };
  const last = msgs.at(-1);
  const first = msgs[0];
  const signed = last.side == null || last.imbalanceShares == null ? null : last.side * last.imbalanceShares;
  const valid = msgs.filter((m) => m.side != null);
  const sameSide = valid.filter((m) => m.side === last.side && m.side !== 0).length;
  let changes = 0;
  for (let i = 1; i < valid.length; i++) if (valid[i].side !== valid[i - 1].side) changes++;
  const at = (t) => [...msgs].reverse().find((m) => m.t <= t) ?? null;
  const stage = (m) => (m ? { t: m.t, pairedShares: m.pairedShares, signedImbalance: m.side == null ? null : m.side * (m.imbalanceShares ?? 0), referencePrice: m.referencePrice, nearPrice: m.nearPrice, farPrice: m.farPrice } : null);
  const indicative = last.nearPrice ?? null;
  const recent = msgs.filter((m) => m.t >= last.t - 60_000 && m.referencePrice != null);
  const refChangeBps = recent.length >= 2 ? bps(recent.at(-1).referencePrice, recent[0].referencePrice) : null;
  return {
    available: true,
    messages: msgs.length,
    ageMs: asOf - last.t,
    side: last.side,
    insufficient: last.insufficient,
    pairedShares: last.pairedShares,
    imbalanceShares: last.imbalanceShares,
    signedImbalance: signed,
    // Normalised imbalance: signed imbalance / paired shares (null when nothing is paired).
    imbalanceToPaired: signed != null && last.pairedShares > 0 ? signed / last.pairedShares : null,
    imbalanceToTypicalCross: signed != null && ctx.typicalCrossVolume > 0 ? signed / ctx.typicalCrossVolume : null,
    pairedGrowth: first.pairedShares > 0 && last.pairedShares != null ? last.pairedShares / first.pairedShares - 1 : null,
    persistence: valid.length ? sameSide / valid.length : null,
    sideChanges: changes,
    referencePrice: last.referencePrice,
    nearPrice: last.nearPrice,
    farPrice: last.farPrice,
    nearFarAvailable: last.nearPrice != null && last.farPrice != null,
    nearFarDivergenceBps: bps(last.farPrice, last.nearPrice),
    refChangeBps1m: refChangeBps,
    indicativeVsVwapBps: bps(indicative ?? last.referencePrice, ctx.preMarketVwap),
    indicativeVsMidBps: bps(indicative ?? last.referencePrice, ctx.preMarketMid),
    agreesWithPreMarket: last.side && ctx.preMarketReturnPct ? Math.sign(ctx.preMarketReturnPct) === last.side : null,
    stages: {
      early: ctx.stageTimes?.early ? stage(at(ctx.stageTimes.main - 1)) : null,
      main: ctx.stageTimes?.main ? stage(at(ctx.stageTimes.main)) : null,
      latest: stage(last),
    },
  };
}
