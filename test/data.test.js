import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, cleanTrades, cumulativeToIncrements, minuteGrid, totals, tradeEligibility, coverageGaps } from '../src/utils/series.js';
import { sameTimeRvol, splitFactorSince } from '../src/utils/baseline.js';
import { classifyTrades } from '../src/utils/orderflow.js';
import { normalizeNoii, imbalanceSign, auctionFeatures } from '../src/utils/auction.js';
import { catalystEvidence, classifyItem, dedupeNews } from '../src/utils/catalyst.js';
import { quoteFeatures } from '../src/utils/features.js';
import { DATE, SCOPE, T, bars, history } from './helpers.js';

test('duplicate and corrected trades: duplicates dropped, cancels removed, corrections applied only once known', () => {
  const t0 = T('08:00');
  const trades = [
    { id: 'a', t: t0, price: 10, size: 100, availableAt: t0 },
    { id: 'a', t: t0, price: 10, size: 100, availableAt: t0 + 5 }, // duplicate delivery
    { id: 'b', t: t0 + 1000, price: 10.1, size: 200, availableAt: t0 + 1000 },
    { id: 'c', t: t0 + 2000, price: 10.2, size: 300, availableAt: t0 + 2000 },
    { id: 'x1', t: t0 + 1000, correction: { type: 'cancel', of: 'b' }, availableAt: t0 + 90_000 },
    { id: 'x2', t: t0 + 2000, price: 10.2, size: 30, correction: { type: 'correct', of: 'c' }, availableAt: t0 + 95_000 },
  ];
  const early = cleanTrades(trades, t0 + 60_000);
  assert.equal(early.trades.length, 3);
  assert.equal(early.stats.duplicates, 1);
  const late = cleanTrades(trades, t0 + 120_000);
  assert.deepEqual(late.trades.map((x) => [x.id, x.size]), [['a', 100], ['c', 30]]);
  assert.equal(late.stats.cancelled, 1);
  assert.equal(late.stats.corrected, 1);
});

test('trade-condition policy: official open/close reports are not volume; auction prints are tagged', () => {
  assert.equal(tradeEligibility({ conditions: ['Q'] }).volume, false);
  assert.equal(tradeEligibility({ conditions: ['I'] }).price, false);
  assert.equal(tradeEligibility({ conditions: ['I'] }).volume, true);
  assert.equal(tradeEligibility({ conditions: ['O'] }).auction, true);
});

test('repeated cumulative-volume snapshots are not added again; a decrease is flagged', () => {
  const t0 = T('08:00');
  const snaps = [0, 100, 100, 100, 250, 250, 240, 300].map((c, i) => ({ t: t0 + i * 15_000, cumVolume: c, availableAt: t0 + i * 15_000 }));
  const r = cumulativeToIncrements(snaps);
  assert.equal(r.increments.reduce((s, x) => s + x.v, 0), 100 + 150 + 60);
  assert.equal(r.flags.length, 1);
});

test('missing vs genuine zero-volume minutes and reconnect gaps', () => {
  const s = buildSeries({ scope: SCOPE, bars: bars('08:00', '08:10', { every: 2 }), coverage: [{ from: T('08:00'), to: T('08:05') }, { from: T('08:07'), to: T('08:10') }] });
  const g = minuteGrid(s, T('08:00'), T('08:10'));
  const states = g.map((x) => x.state).join(',');
  assert.equal(states, 'traded,zero,traded,zero,traded,missing,traded,zero,traded,zero');
  assert.deepEqual(coverageGaps(s, T('08:00'), T('08:10')), [{ from: T('08:05'), to: T('08:07') }]);
});

test('late records are invisible to an earlier decision (no look-ahead)', () => {
  const b = bars('09:00', '09:20');
  b[5] = { ...b[5], availableAt: T('09:40') }; // backfilled later
  const at928 = buildSeries({ scope: SCOPE, bars: b, coverage: [] }, T('09:28'));
  const at945 = buildSeries({ scope: SCOPE, bars: b, coverage: [] }, T('09:45'));
  assert.equal(at928.bars.length, 19);
  assert.equal(at945.bars.length, 20);
});

test('same-time RVOL: same-clock window, sample size, missing history excluded', () => {
  const today = buildSeries({ scope: SCOPE, bars: bars('04:00', '09:28', { v: 3000, avail: 60_000 }), coverage: [{ from: T('04:00'), to: T('09:28') }] }, T('09:28'));
  const hist = history(20, { v: 1000 }).map((h) => ({ date: h.date, series: buildSeries(h) }));
  hist[3].series = { ...hist[3].series, coverage: [] }; // a missing session is excluded, not counted as zero
  const r = sameTimeRvol({ today, history: hist, date: DATE, t: T('09:28'), startTime: '04:00:00' });
  assert.ok(r.ok);
  assert.ok(Math.abs(r.rvol - 3) < 1e-9);
  assert.equal(r.sample, 19);
  assert.equal(r.excluded.missing, 1);
  assert.match(r.method, /04:00:00–09:28:00 ET/);
});

test('RVOL refuses IEX-vs-SIP scope mixing and too-small samples', () => {
  const today = buildSeries({ scope: { ...SCOPE, feed: 'iex' }, bars: bars('04:00', '09:28'), coverage: [{ from: T('04:00'), to: T('09:28') }] }, T('09:28'));
  const hist = history(20).map((h) => ({ date: h.date, series: buildSeries(h) }));
  const r = sameTimeRvol({ today, history: hist, date: DATE, t: T('09:28'), startTime: '04:00:00' });
  assert.equal(r.ok, false);
  assert.equal(r.excluded.scopeMismatch, 20);
  const r2 = sameTimeRvol({ today: { ...today, scope: SCOPE }, history: hist.slice(0, 3), date: DATE, t: T('09:28'), startTime: '04:00:00' });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /only 3 comparable/);
});

test('tiny denominators are floored and flagged; genuine zero sessions count as zero', () => {
  const today = buildSeries({ scope: SCOPE, bars: bars('09:00', '09:28', { v: 50 }), coverage: [{ from: T('04:00'), to: T('09:28') }] }, T('09:28'));
  const hist = history(20, { v: 0 }).map((h) => ({ date: h.date, series: buildSeries({ ...h, bars: [] }) }));
  const r = sameTimeRvol({ today, history: hist, date: DATE, t: T('09:28'), startTime: '04:00:00' });
  assert.ok(r.ok);
  assert.equal(r.zeroSessions, 20);
  assert.ok(r.floored);
  // The 09:27 bar completes at 09:28:00.4, after the decision, so only 27 of 28 bars count.
  assert.equal(r.rvol, 1350 / 2000);
});

test('split-adjusted baselines: known ratio adjusts raw history; unknown ratio refuses those sessions', () => {
  assert.equal(splitFactorSince('2026-10-01', DATE, [{ type: 'split', exDate: '2026-10-10', ratio: 2 }]), 2);
  assert.equal(splitFactorSince('2026-10-12', DATE, [{ type: 'split', exDate: '2026-10-10', ratio: 2 }]), 1);
  assert.equal(splitFactorSince('2026-10-01', DATE, [{ type: 'split', exDate: '2026-10-10', ratio: null }]), null);
  const today = buildSeries({ scope: SCOPE, bars: bars('04:00', '09:28', { v: 2000, avail: 60_000 }), coverage: [{ from: T('04:00'), to: T('09:28') }] }, T('09:28'));
  // Pre-split raw history is in old shares (half as many): adjusted, RVOL = 1, not 2.
  const hist = history(20, { v: 1000 }).map((h) => ({ date: h.date, series: buildSeries(h) }));
  const r = sameTimeRvol({ today, history: hist, date: DATE, t: T('09:28'), startTime: '04:00:00', corporateActions: [{ type: 'split', exDate: DATE, ratio: 2 }] });
  assert.ok(Math.abs(r.rvol - 1) < 1e-9);
});

test('quote-size units: round lots are converted with the instrument round lot', () => {
  const q = [{ t: T('09:00'), bid: 10, ask: 10.02, bidSize: 3, askSize: 5, availableAt: T('09:00') }];
  const lots = quoteFeatures(q, T('09:01'), { roundLot: 100, sizeUnit: 'round_lots' });
  assert.equal(lots.bidSizeShares, 300);
  assert.equal(lots.askSizeShares, 500);
  const shares = quoteFeatures(q, T('09:01'), { roundLot: 100, sizeUnit: 'shares' });
  assert.equal(shares.askSizeShares, 5);
  const odd = quoteFeatures(q, T('09:01'), { roundLot: 10, sizeUnit: 'round_lots' });
  assert.equal(odd.askSizeShares, 50); // not every round lot is 100 shares
});

test('aggressor estimate: quote rule, tick rule at the midpoint, unclassified without a valid quote', () => {
  const t0 = T('08:00');
  const quotes = [{ t: t0, bid: 10, ask: 10.1 }];
  const trades = [
    { t: t0 + 10, price: 10.09, size: 100 }, { t: t0 + 20, price: 10.05, size: 30 }, { t: t0 + 30, price: 10.01, size: 50 }, { t: t0 + 60_000, price: 10.05, size: 10 },
  ];
  const r = classifyTrades(trades, quotes, { maxQuoteAgeMs: 5000 });
  assert.equal(r.estBuyVolume, 100);
  assert.equal(r.estSellVolume, 30 + 50); // the midpoint trade after a downtick is a sell by the tick rule
  assert.equal(r.unclassifiedVolume, 10); // quote too old
});

test('NOII: buy/sell mapping for both conventions and early placeholders are unavailable, not $0', () => {
  assert.equal(imbalanceSign('B'), 1);
  assert.equal(imbalanceSign('S'), -1);
  assert.equal(imbalanceSign('N'), 0);
  assert.equal(imbalanceSign('O'), null);
  assert.equal(imbalanceSign('A', 'databento'), -1);
  assert.equal(imbalanceSign('B', 'databento'), 1);
  const early = normalizeNoii({ t: T('09:25:10'), pairedShares: 1000, imbalanceShares: 300, imbalanceSide: 'S', referencePrice: 100, nearPrice: 0, farPrice: 0, crossType: 'O' });
  assert.equal(early.nearPrice, null);
  assert.equal(early.farPrice, null);
  assert.equal(early.side, -1);
  const scaled = normalizeNoii({ t: 1, referencePrice: 1_000_000, nearPrice: 9_223_372_036_854_775_807, imbalanceSide: 'B' }, { priceScale: 1e4 });
  assert.equal(scaled.referencePrice, 100);
  assert.equal(scaled.nearPrice, null);
  const f = auctionFeatures([early, { ...early, t: T('09:26'), availableAt: T('09:26'), imbalanceShares: 500 }], T('09:27'), { preMarketReturnPct: -2 });
  assert.equal(f.signedImbalance, -500);
  assert.equal(f.nearFarAvailable, false);
  assert.equal(f.agreesWithPreMarket, true);
  assert.equal(auctionFeatures([early], T('09:25:00')).available, false); // not yet received
});

test('catalysts: shelf ≠ executed offering, earnings without consensus is neutral, syndication deduplicated', () => {
  assert.equal(classifyItem({ headline: 'Acme files shelf registration on Form S-3' }).category, 'shelf');
  assert.equal(classifyItem({ formType: 'S-3' }).direction, 0);
  assert.equal(classifyItem({ headline: 'Acme prices $20 million registered direct offering' }).direction, -1);
  const t = T('07:00');
  const e = catalystEvidence([{ headline: 'Acme reports third-quarter results', publishedAt: t, firstSeenAt: t, sourceKind: 'newswire' }], { asOf: T('09:28'), since: T('16:00', '2026-10-16'), direction: 1 });
  assert.equal(e.score, 0.5);
  const e2 = catalystEvidence([{ headline: 'Acme reports third-quarter results', publishedAt: t, firstSeenAt: t, sourceKind: 'newswire', surprise: { epsActual: 1.2, epsEstimate: 1 } }], { asOf: T('09:28'), since: 0, direction: 1 });
  assert.ok(e2.score > 0.5);
  const d = dedupeNews([{ headline: 'Acme prices $20 million offering', url: 'a', publishedAt: 1, firstSeenAt: 1, source: 'X' }, { headline: 'ACME Prices $20 Million Offering', url: 'b', publishedAt: 2, firstSeenAt: 2, source: 'Y' }]);
  assert.equal(d.length, 1);
  assert.equal(d[0].syndicated, 1);
  // A story first seen after the decision is not used.
  const late = catalystEvidence([{ headline: 'Acme raises full-year guidance', publishedAt: t, firstSeenAt: T('09:40'), sourceKind: 'newswire' }], { asOf: T('09:28'), since: 0, direction: 1 });
  assert.equal(late.items.length, 0);
  assert.equal(catalystEvidence([], { checked: false }).score, null);
});
