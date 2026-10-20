/**
 * Risk settings, position sizing and US cost assumptions (pure). USD. PAPER only.
 * Nothing here promises that a stop fills or that a strategy makes money.
 */

export const DEFAULT_RISK_SETTINGS = {
  capital: 25_000, // USD paper capital
  riskPerTradePct: 0.5,
  dailyLossPct: 1.5,
  maxOpenPositions: 3,
  maxTradesPerDay: 4,
  maxPerSector: 2, // concentration limit
  maxPositionPct: 25, // max notional per position, % of capital
  minRewardRisk: 1.5, // after costs
  maxConsecutiveLosses: 2,
  slippageBps: 3, // added beyond the bid/ask for paper fills
  maxSlippageBps: 25, // a fill beyond trigger + this is not taken
  maxSpreadBps: 30,
  latencyMs: 750, // order becomes active this long after the decision is published
  participationCap: 0.1, // at most 10% of the volume traded in a minute
  entryUntil: '09:50', // ET: unfilled entries expire
  squareOffAt: '15:55', // ET: open paper positions are closed
  allowHypotheticalShorts: true, // shorts without verified borrow are tracked separately as hypothetical
};

/**
 * Cost assumptions (verify before relying on them):
 *  - Commission: $0 (commission-free broker such as Alpaca); configurable.
 *  - SEC Section 31 fee on sales: $20.60 per $1M (fiscal 2026 rate effective 2026-04-04; SEC fee rate advisory).
 *  - FINRA Trading Activity Fee on sales: $0.000166/share, max $8.30 per trade (rate last checked for 2024; check FINRA Schedule A).
 */
export const DEFAULT_COSTS = { commissionPerShare: 0, commissionMin: 0, secFeePerMillion: 20.6, tafPerShare: 0.000166, tafMax: 8.3, verifiedOn: '2026-10-20', note: 'SEC rate from the FY2026 fee advisory; FINRA TAF from 2024 schedule — verify' };

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function cleanRiskSettings(input = {}) {
  const d = DEFAULT_RISK_SETTINGS;
  const c = (k, lo, hi) => Math.min(hi, Math.max(lo, num(input?.[k], d[k])));
  return {
    capital: c('capital', 500, 1e9),
    riskPerTradePct: c('riskPerTradePct', 0.01, 5),
    dailyLossPct: c('dailyLossPct', 0.05, 20),
    maxOpenPositions: Math.round(c('maxOpenPositions', 1, 20)),
    maxTradesPerDay: Math.round(c('maxTradesPerDay', 1, 50)),
    maxPerSector: Math.round(c('maxPerSector', 1, 20)),
    maxPositionPct: c('maxPositionPct', 1, 100),
    minRewardRisk: c('minRewardRisk', 0.5, 10),
    maxConsecutiveLosses: Math.round(c('maxConsecutiveLosses', 1, 20)),
    slippageBps: c('slippageBps', 0, 200),
    maxSlippageBps: c('maxSlippageBps', 1, 500),
    maxSpreadBps: c('maxSpreadBps', 1, 500),
    latencyMs: Math.round(c('latencyMs', 0, 60_000)),
    participationCap: c('participationCap', 0.001, 1),
    entryUntil: HHMM.test(input?.entryUntil ?? '') && input.entryUntil > '09:35' && input.entryUntil < '16:00' ? input.entryUntil : d.entryUntil,
    squareOffAt: HHMM.test(input?.squareOffAt ?? '') && input.squareOffAt > '09:35' && input.squareOffAt <= '16:00' ? input.squareOffAt : d.squareOffAt,
    allowHypotheticalShorts: input?.allowHypotheticalShorts ?? d.allowHypotheticalShorts,
  };
}

/** Fees for a list of fills [{ side:'BUY'|'SELL', qty, price }]. */
export function tradeCosts(fills, costs = DEFAULT_COSTS) {
  let commission = 0; let sec = 0; let taf = 0;
  for (const f of fills) {
    commission += Math.max(costs.commissionMin, costs.commissionPerShare * f.qty);
    if (f.side === 'SELL') {
      sec += (f.qty * f.price * costs.secFeePerMillion) / 1_000_000;
      taf += Math.min(costs.tafMax, costs.tafPerShare * f.qty);
    }
  }
  const r = (n) => Math.round(n * 100) / 100;
  return { commission: r(commission), sec: r(sec), taf: r(taf), total: r(commission + sec + taf) };
}

/** Shares for a trade: risk ÷ stop distance, capped by max notional. */
export function positionSize({ entry, stop, settings }) {
  const s = cleanRiskSettings(settings);
  const per = Math.abs(entry - stop);
  if (!(per > 0) || !(entry > 0)) return { qty: 0, reason: 'no stop distance' };
  const budget = (s.capital * s.riskPerTradePct) / 100;
  let qty = Math.floor(budget / per);
  qty = Math.min(qty, Math.floor((s.capital * s.maxPositionPct) / 100 / entry));
  if (qty < 1) return { qty: 0, reason: 'risk budget smaller than one share at this stop' };
  return { qty, riskAmount: qty * per, notional: qty * entry };
}

/** Reasons a new trade may not open. day: { killSwitch, realised, trades, open, consecutiveLosses, sectors:{} } */
export function tradeBlockers(day, settings, sector = null) {
  const s = cleanRiskSettings(settings);
  const out = [];
  if (day.killSwitch) out.push('kill switch is on');
  if (day.realised <= -(s.capital * s.dailyLossPct) / 100) out.push(`daily loss limit reached (${s.dailyLossPct}% of capital)`);
  if (day.trades >= s.maxTradesPerDay) out.push(`maximum ${s.maxTradesPerDay} trades a day reached`);
  if (day.open >= s.maxOpenPositions) out.push(`maximum ${s.maxOpenPositions} open positions reached`);
  if (day.consecutiveLosses >= s.maxConsecutiveLosses) out.push(`${day.consecutiveLosses} losses in a row: stopped for the day`);
  if (sector && (day.sectors?.[sector] ?? 0) >= s.maxPerSector) out.push(`sector limit: ${s.maxPerSector} position(s) in ${sector}`);
  return out;
}

/** Trade plan from a strategy signal: size, expected entry incl. spread/slippage, reward/risk after costs. */
export function buildTradePlan(signal, w, settings, costs = DEFAULT_COSTS) {
  const s = cleanRiskSettings(settings);
  const reasons = [];
  if (!signal) return { ok: false, reasons: ['no signal'] };
  const dir = signal.direction;
  const slip = s.slippageBps / 10_000;
  const expectedEntry = signal.immediate ? (dir > 0 ? (w.quote?.ask ?? signal.trigger) * (1 + slip) : (w.quote?.bid ?? signal.trigger) * (1 - slip)) : signal.trigger * (1 + dir * slip);
  const maxEntry = signal.trigger * (1 + (dir * s.maxSlippageBps) / 10_000);
  const size = positionSize({ entry: expectedEntry, stop: signal.stop, settings: s });
  if (!size.qty) reasons.push(size.reason);
  const qty = size.qty;
  const half = qty > 1 ? Math.floor(qty / 2) : qty;
  const side = dir > 0 ? 'BUY' : 'SELL';
  const exit = dir > 0 ? 'SELL' : 'BUY';
  const stopFill = signal.stop * (1 - dir * slip);
  const c = (exits) => tradeCosts([{ side, qty, price: expectedEntry }, ...exits.map(([q, p]) => ({ side: exit, qty: q, price: p }))], costs).total;
  const riskAmt = qty ? qty * Math.abs(expectedEntry - stopFill) + c([[qty, stopFill]]) : null;
  const rewardAmt = qty ? dir * (half * (signal.target1 - expectedEntry) + (qty - half) * (signal.target2 - expectedEntry)) - c([[half, signal.target1], [qty - half, signal.target2]]) : null;
  const rewardRisk = riskAmt ? rewardAmt / riskAmt : null;
  if (rewardRisk != null && rewardRisk < s.minRewardRisk) reasons.push(`reward/risk ${rewardRisk.toFixed(2)} after costs is below ${s.minRewardRisk}`);
  if (w.quote?.spreadBps == null) reasons.push('no two-sided quote');
  else if (w.quote.spreadBps > s.maxSpreadBps) reasons.push(`spread ${w.quote.spreadBps.toFixed(1)} bps above ${s.maxSpreadBps}`);
  const r = (n) => (n == null ? null : Math.round(n * 10_000) / 10_000);
  return {
    ok: reasons.length === 0, reasons, side, direction: dir, qty, firstExitQty: half, immediate: Boolean(signal.immediate),
    trigger: r(signal.trigger), maxEntry: r(maxEntry), expectedEntry: r(expectedEntry), stop: r(signal.stop), target1: r(signal.target1), target2: r(signal.target2),
    riskAmount: riskAmt == null ? null : Math.round(riskAmt * 100) / 100, rewardAmount: rewardAmt == null ? null : Math.round(rewardAmt * 100) / 100,
    rewardRisk: rewardRisk == null ? null : Math.round(rewardRisk * 100) / 100, invalidation: signal.invalidation, note: signal.note,
  };
}
