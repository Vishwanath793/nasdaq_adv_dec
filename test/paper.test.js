import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, applyEvent, stepMarket, rebuildLedger } from '../src/utils/paperLedger.js';
import { tradeCosts, buildTradePlan, positionSize } from '../src/utils/risk.js';

const risk = { slippageBps: 0, participationCap: 0.1, latencyMs: 1000, capital: 100_000, dailyLossPct: 5, maxConsecutiveLosses: 5 };
const t0 = 1_000_000;

function ledgerWith(order) {
  const s = emptyLedger('2026-10-19');
  applyEvent(s, { type: 'order', at: t0, order: { id: 'o1', symbol: 'X', side: order.direction > 0 ? 'BUY' : 'SELL', qty: 1000, firstExitQty: 500, trigger: 10, maxEntry: order.direction > 0 ? 10.05 : 9.95, stop: order.direction > 0 ? 9.8 : 10.2, target1: order.direction > 0 ? 10.3 : 9.7, target2: order.direction > 0 ? 10.6 : 9.4, immediate: false, activeAt: t0 + 1000, expiresAt: t0 + 600_000, ...order } });
  return s;
}
const q = (t, bid, ask, size = 300) => ({ kind: 'quote', symbol: 'X', t, bid, ask, bidSize: size, askSize: size });
const tr = (t, price, size = 1000) => ({ kind: 'trade', symbol: 'X', t, price, size });

test('no fill on data stamped before the order existed (decision + latency)', () => {
  const s = ledgerWith({ direction: 1, immediate: true });
  assert.equal(stepMarket(s, q(t0 + 500, 10, 10.01), risk).length, 0);
  const ev = stepMarket(s, q(t0 + 1500, 10, 10.01), risk);
  assert.ok(ev.some((e) => e.type === 'fill'));
});

test('fills are limited to displayed size, never reuse the same displayed liquidity, and respect the participation cap', () => {
  const s = ledgerWith({ direction: 1 });
  stepMarket(s, tr(t0 + 2000, 10.0, 2000), risk); // triggers; 2,000 traded this minute → cap 200
  const quote = q(t0 + 3000, 10.0, 10.02, 300);
  stepMarket(s, quote, risk);
  assert.equal(s.orders[0].filledQty, 200); // participation cap binds before displayed size
  stepMarket(s, quote, risk); // the same quote again: nothing more from the cap or that displayed size
  assert.equal(s.orders[0].filledQty, 200);
  stepMarket(s, tr(t0 + 4000, 10.01, 5000), risk); // more volume this minute → cap 700 total
  stepMarket(s, q(t0 + 5000, 10.0, 10.02, 300), risk);
  assert.equal(s.orders[0].filledQty, 500);
  assert.equal(s.orders[0].status, 'PARTIAL');
});

test('entry beyond maxEntry waits; stops fill at the touch and can be worse than the stop', () => {
  const s = ledgerWith({ direction: 1, immediate: true });
  stepMarket(s, q(t0 + 2000, 10.05, 10.2, 5000), { ...risk, participationCap: 1 });
  assert.equal(s.orders[0].filledQty, 0); // ask 10.20 > maxEntry 10.05
  stepMarket(s, tr(t0 + 2500, 10.02, 100_000), { ...risk, participationCap: 1 });
  stepMarket(s, q(t0 + 3000, 10.0, 10.02, 5000), { ...risk, participationCap: 1 });
  assert.equal(s.orders[0].filledQty, 1000);
  stepMarket(s, q(t0 + 60_000, 9.6, 9.62, 5000), risk); // gap through the 9.80 stop
  const p = s.positions[0];
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exits[0].kind, 'stop');
  assert.ok(p.exits[0].price < 9.8);
  assert.ok(p.net < 0);
});

test('a touched target is not a fill; a trade-through is', () => {
  const s = ledgerWith({ direction: 1, immediate: true });
  stepMarket(s, tr(t0 + 1500, 10.01, 100_000), { ...risk, participationCap: 1 });
  stepMarket(s, q(t0 + 2000, 10.0, 10.02, 5000), { ...risk, participationCap: 1 });
  stepMarket(s, q(t0 + 70_000, 10.3, 10.32, 5000), risk); // bid touches T1 exactly
  assert.equal(s.positions[0].t1Done, false);
  stepMarket(s, q(t0 + 80_000, 10.31, 10.33, 5000), risk); // bid through T1
  assert.equal(s.positions[0].t1Done, true);
  assert.equal(s.positions[0].stop, s.positions[0].avgEntry); // stop moved to entry
});

test('hypothetical shorts are totalled separately from paper P&L and risk counts', () => {
  const s = ledgerWith({ direction: -1, immediate: true, hypothetical: true });
  stepMarket(s, tr(t0 + 1500, 10, 100_000), { ...risk, participationCap: 1 });
  stepMarket(s, q(t0 + 2000, 9.99, 10.01, 5000), { ...risk, participationCap: 1 });
  stepMarket(s, q(t0 + 90_000, 10.4, 10.42, 5000), risk); // stopped out
  assert.equal(s.realised, 0);
  assert.ok(s.hypotheticalRealised < 0);
  assert.equal(s.trades, 0);
});

test('event log rebuilds the same state (restart determinism)', () => {
  const s = ledgerWith({ direction: 1, immediate: true });
  const log = [{ type: 'order', at: t0, order: s.orders[0] && { ...s.orders[0] } }];
  const evs = [...stepMarket(s, tr(t0 + 1500, 10.01, 100_000), { ...risk, participationCap: 1 }), ...stepMarket(s, q(t0 + 2000, 10.0, 10.02, 5000), { ...risk, participationCap: 1 })];
  const rebuilt = rebuildLedger('2026-10-19', [...log, ...evs]);
  assert.equal(rebuilt.orders[0].filledQty, s.orders[0].filledQty);
  assert.equal(rebuilt.positions[0].avgEntry, s.positions[0].avgEntry);
});

test('US costs: SEC fee and FINRA TAF apply to sells only; TAF is capped', () => {
  const c = tradeCosts([{ side: 'BUY', qty: 100, price: 50 }, { side: 'SELL', qty: 100, price: 50 }]);
  assert.equal(c.sec, Math.round(5000 * 20.6 / 1e6 * 100) / 100);
  assert.equal(c.taf, 0.02);
  assert.equal(tradeCosts([{ side: 'SELL', qty: 1_000_000, price: 1 }]).taf, 8.3);
});

test('trade plan: sizing from risk, reward/risk after costs, spread rejection', () => {
  const size = positionSize({ entry: 50, stop: 49, settings: { capital: 25_000, riskPerTradePct: 0.5, maxPositionPct: 25 } });
  assert.equal(size.qty, 125);
  const w = { quote: { bid: 49.99, ask: 50.01, spreadBps: 4 } };
  const plan = buildTradePlan({ direction: 1, trigger: 50, stop: 49, target1: 51.5, target2: 53 }, w, { capital: 25_000 });
  assert.ok(plan.ok);
  assert.ok(plan.rewardRisk > 1.5 && plan.rewardRisk < 2.5);
  const wide = buildTradePlan({ direction: 1, trigger: 50, stop: 49, target1: 51.5, target2: 53 }, { quote: { spreadBps: 80 } }, { capital: 25_000 });
  assert.equal(wide.ok, false);
});
