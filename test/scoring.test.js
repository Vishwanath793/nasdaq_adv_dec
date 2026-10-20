import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../src/utils/features.js';
import { scoreDirection, scoreStock, convictionLabel, effectiveWeights, priceAlignment, RESEARCH_CAP } from '../src/utils/conviction.js';
import { evaluateGates } from '../src/utils/tradeability.js';
import { sessionTimes } from '../src/utils/clock.js';
import { DATE, T, bars, inst, quotes } from './helpers.js';

const ctx = () => ({ date: DATE, times: sessionTimes(DATE), market: { QQQ: { gapPct: 0.4 } }, breadth: null, dataMode: 'LIVE' });

function gapper({ p1 = 103, v = 3000, newsChecked = true } = {}) {
  return inst({
    today: { bars: [...bars('04:00', '07:00', { v: 1000, p0: 100, p1: 100 }), ...bars('07:00', '09:30', { v, p0: 100.5, p1 })], coverage: [{ from: T('04:00'), to: T('16:00') }], quotes: quotes('04:00', '16:00', { bid: p1 - 0.02, ask: p1 + 0.02 }) },
    newsChecked,
  });
}

test('coverage keeps a fixed denominator: a missing source lowers coverage instead of shrinking the profile', () => {
  const f = computeFeatures(gapper({ newsChecked: false }), T('09:28'), ctx());
  const s = scoreDirection(f, 1, ctx(), { preset: 'volumeFirst' });
  const cat = s.factors.find((x) => x.key === 'catalyst');
  assert.equal(cat.status, 'missing');
  assert.match(cat.missingKind, /unsupported/);
  assert.equal(s.groups.catalyst.usable, false);
  assert.ok(s.coverage.profile <= 0.9 + 1e-9); // catalyst is 10% of the configured profile
  assert.ok(s.adjustedScore <= s.rawScore); // conservative adjustment, raw kept visible
});

test('volume amplifies price evidence but never picks the side', () => {
  const up = computeFeatures(gapper({ p1: 103 }), T('09:28'), ctx());
  const down = computeFeatures(gapper({ p1: 97 }), T('09:28'), ctx());
  const rvUp = scoreDirection(up, 1, ctx()).factors.find((x) => x.key === 'rvolCum');
  const rvUpShort = scoreDirection(up, -1, ctx()).factors.find((x) => x.key === 'rvolCum');
  const rvDownShort = scoreDirection(down, -1, ctx()).factors.find((x) => x.key === 'rvolCum');
  assert.ok(rvUp.value > 0.5 && rvUpShort.value < 0.5 && rvDownShort.value > 0.5);
  // Same participation, flat price: no direction from volume.
  const flat = computeFeatures(gapper({ p1: 100.5 }), T('09:28'), ctx());
  assert.ok(Math.abs(priceAlignment({ ...flat, gapPct: 0, gapAtr: 0, distVwapPct: 0 }, 1)) < 1e-9);
});

test('one excellent factor cannot produce a strong label (minimum-evidence policy)', () => {
  // Huge gap, but no history (RVOL refused) and almost nothing else.
  const i = gapper({ p1: 110 });
  i.history = [];
  const f = computeFeatures(i, T('09:28'), ctx());
  const s = scoreStock(f, ctx());
  assert.notEqual(s.long.label.label, 'strong');
  assert.equal(s.long.label.label, 'insufficient evidence');
  // A synthetic score with one perfect group and nothing else.
  const fake = { coverage: { mandatoryOk: true, profile: 0.15 }, supportingGroups: ['priceStructure'], groups: { priceStructure: { score: 1, usable: true } }, adjustedScore: 57, rawScore: 100, volumeEvidenceScore: null };
  assert.equal(convictionLabel(fake).label, 'insufficient evidence');
});

test('price without participation is labelled weak, not moderate/strong', () => {
  const f = computeFeatures(gapper({ p1: 105, v: 150 }), T('09:28'), ctx());
  const s = scoreStock(f, ctx());
  assert.ok(['weak', 'none', 'insufficient evidence'].includes(s.long.label.label), s.long.label.label);
});

test('the research family is capped at 5% of total weight', () => {
  const { groups } = effectiveWeights({ preset: 'fullFree', groupWeights: { research: 50 } });
  const total = Object.values(groups).reduce((a, b) => a + b, 0);
  assert.ok(groups.research / total <= RESEARCH_CAP / 100 + 1e-9);
});

test('every factor row explains itself: value, weight, contribution, lineage, or a missing reason', () => {
  const f = computeFeatures(gapper(), T('09:28'), ctx());
  const s = scoreDirection(f, 1, ctx());
  for (const x of s.factors) {
    assert.ok(x.label && x.group && x.family && x.source && x.describe);
    if (x.status === 'used') assert.ok(x.detail && x.transform && Number.isFinite(x.contribution));
    else assert.ok(x.reason);
  }
  const sum = s.factors.filter((x) => x.status === 'used').reduce((a, x) => a + x.weightInScore, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9); // contributions add up to the raw score
  const recon = 50 + s.factors.filter((x) => x.status === 'used').reduce((a, x) => a + x.contribution, 0);
  assert.ok(Math.abs(recon - s.rawScore) <= 0.5 + 1e-9);
});

test('gates: halt blocks, unknown halt status is not "safe", delayed data blocks, unknown borrow keeps shorts hypothetical', () => {
  const base = computeFeatures(gapper(), T('09:28'), ctx());
  assert.equal(evaluateGates({ ...base, halt: { halted: true, statusKnown: true, current: { haltAt: T('09:05'), reason: 'T1' }, today: 1 } }).status, 'blocked');
  assert.equal(evaluateGates({ ...base, halt: { halted: false, statusKnown: false } }).status, 'unverified');
  assert.equal(evaluateGates(base, { dataMode: 'DELAYED' }).status, 'blocked');
  const short = evaluateGates(base, { direction: -1 });
  assert.equal(short.gates.find((g) => g.key === 'borrow').state, 'unknown');
  const luld = evaluateGates(base).gates.find((g) => g.key === 'luld');
  assert.equal(luld.state, 'unknown'); // extended-hours LULD unknown ≠ unrestricted
});
