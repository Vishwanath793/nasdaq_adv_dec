import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSession } from '../src/utils/demoSession.js';
import { runSnapshot, runConfirmation, simulatePaper, dayContext } from '../src/utils/pipeline.js';
import { hashOf } from '../src/utils/stats.js';

const day = demoSession();
const main = runSnapshot(day, 'main');
const row = (sym, snap = main) => snap.rows.find((r) => r.symbol === sym);
const fingerprint = (snap) => hashOf(snap.rows.map((r) => [r.symbol, r.longScore, r.shortScore, r.longLabel, r.shortLabel, r.outcome, r.eligibility]));

/** Remove every record not yet available at `asOf` — what a live run would have had. */
function truncate(d, asOf) {
  const cut = (xs) => (xs ?? []).filter((x) => (x.availableAt ?? x.receivedAt ?? x.t) <= asOf && (x.t == null || x.t < asOf));
  const instruments = {};
  for (const [s, i] of Object.entries(d.instruments)) {
    instruments[s] = {
      ...i,
      today: { ...i.today, bars: cut(i.today.bars), quotes: cut(i.today.quotes), coverage: i.today.coverage.filter((c) => c.availableAt == null || c.availableAt <= asOf).map((c) => ({ ...c, to: Math.min(c.to, asOf) })).filter((c) => c.to > c.from) },
      news: (i.news ?? []).filter((n) => n.firstSeenAt <= asOf),
      halts: (i.halts ?? []).filter((h) => h.firstSeenAt <= asOf),
      noii: i.noii ? i.noii.filter((m) => m.availableAt <= asOf) : null,
    };
  }
  return { ...d, instruments };
}

test('no future-information leakage: a snapshot is identical with or without later data present', () => {
  const asOf = dayContext(day).times.main;
  const cut = runSnapshot(truncate(day, asOf), 'main');
  assert.equal(fingerprint(cut), fingerprint(main));
});

test('replay determinism: the same records and settings give identical decisions', () => {
  const again = runSnapshot(demoSession(), 'main');
  assert.equal(fingerprint(again), fingerprint(main));
  assert.equal(again.id, main.id);
});

test('pre-open snapshots never produce an executable decision', () => {
  for (const k of ['preliminary', 'earlyAuction', 'main', 'final']) {
    const s = k === 'main' ? main : runSnapshot(day, k);
    assert.ok(s.rows.every((r) => r.outcome !== 'PAPER ENTRY ELIGIBLE'));
  }
});

test('DEMO validation cases behave as specified', () => {
  // Large gap with almost no volume: never strong.
  assert.notEqual(row('ZBIG').longLabel, 'strong');
  // IEX/SIP baseline mismatch: RVOL refused → insufficient evidence.
  assert.equal(row('ZMIX').rvol, null);
  assert.match(row('ZMIX').rvolReason, /comparable session/);
  assert.equal(row('ZMIX').longLabel, 'insufficient evidence');
  // Unknown split ratio refuses the affected sessions.
  assert.equal(row('ZSPX').rvol, null);
  assert.ok(row('ZSPX').features.rvol.excluded.unknownSplit > 0);
  // Known split: adjusted RVOL stays near the simulated ~2.5×, not doubled.
  assert.ok(row('ZSPL').rvol > 1.2 && row('ZSPL').rvol < 3.5, String(row('ZSPL').rvol));
  // Missing pre-market volume (feed connected late): insufficient evidence, blocked on observation.
  assert.equal(row('ZMIS').longLabel, 'insufficient evidence');
  assert.equal(row('ZMIS').eligibility, 'blocked');
  // Delayed consolidated data cannot masquerade as current.
  assert.ok(row('ZDLY').quality.delayed);
  assert.equal(row('ZDLY').eligibility, 'blocked');
  // Halted name is blocked.
  assert.equal(row('ZHLT').gates.gates.find((g) => g.key === 'halt').state, 'fail');
  // Late backfill: unknown at 09:28.
  assert.ok(row('ZLAT').features.coverageGaps.length > 0);
  // Duplicate observations are dropped, not double counted.
  assert.ok(row('ZDUP').features.seriesStats.duplicates > 0);
  // Cumulative snapshots: counted once.
  const cum = day.instruments.ZCUM.cumulativeCheck;
  assert.equal(cum.counted, cum.original);
  // Strong, volume-supported continuation cases.
  assert.equal(row('ZPPR').longLabel, 'strong');
  assert.equal(row('ZDWN').shortLabel, 'strong');
  // Absorption-like behaviour is reported as an inference.
  assert.match(row('ZABS').setup.absorptionInference ?? '', /inference/);
  // Priced offering is a negative catalyst.
  assert.match(row('ZOFF').catalystDetail ?? '', /offering-priced/);
  // Earnings without consensus is neutral.
  assert.match(row('ZERN').catalystDetail ?? '', /no measurable direction/);
});

test('09:35 seal: late window records ignored, halts give no data, paper orders never fill before publication + latency', () => {
  const final = runSnapshot(day, 'final');
  const c = runConfirmation(day, final);
  const dly = c.rows.find((r) => r.symbol === 'ZDLY');
  assert.equal(dly.window.available, false);
  assert.match(dly.window.reason, /after the seal/);
  const hlt = c.rows.find((r) => r.symbol === 'ZHLT');
  assert.equal(hlt.decision, 'NO TRADE');
  // Continuation entries against opposing pre-market evidence are refused.
  const abs = c.rows.find((r) => r.symbol === 'ZABS');
  assert.notEqual(abs.decision, 'PAPER ENTRY ELIGIBLE');
  // Shorts without verified borrow stay hypothetical.
  for (const r of c.rows.filter((x) => x.decision === 'PAPER ENTRY ELIGIBLE' && x.direction < 0)) assert.ok(day.instruments[r.symbol].borrow?.shortable);
  const paper = simulatePaper(day, c, {});
  for (const o of paper.state.orders) assert.ok(o.activeAt >= c.publishedAt + 750);
  for (const p of paper.state.positions) for (const e of p.entries) assert.ok(e.at >= p.entries[0].at && e.at >= c.publishedAt + 750);
  assert.ok(paper.state.orders.length > 0);
});
