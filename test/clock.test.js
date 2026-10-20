import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etToUtc, zoneParts, formatIst, dayStatus, previousTradingDay, sessionTimes, phaseAt, noiiStage } from '../src/utils/clock.js';

test('ET ↔ UTC across both DST transitions (no fixed offset)', () => {
  // Before the November change: EDT (UTC−4); after: EST (UTC−5).
  assert.equal(new Date(etToUtc('2026-10-30', '09:30:00')).toISOString(), '2026-10-30T13:30:00.000Z');
  assert.equal(new Date(etToUtc('2026-11-02', '09:30:00')).toISOString(), '2026-11-02T14:30:00.000Z');
  // March change: 2026-03-06 EST, 2026-03-09 EDT.
  assert.equal(new Date(etToUtc('2026-03-06', '09:30:00')).toISOString(), '2026-03-06T14:30:00.000Z');
  assert.equal(new Date(etToUtc('2026-03-09', '09:30:00')).toISOString(), '2026-03-09T13:30:00.000Z');
  assert.equal(zoneParts(etToUtc('2026-11-02', '04:00:00')).time, '04:00:00');
});

test('IST display shifts by 9:30 in winter and 10:30 in summer relative to ET', () => {
  assert.equal(formatIst(etToUtc('2026-10-30', '09:28:00')), '18:58:00 IST'); // EDT
  assert.equal(formatIst(etToUtc('2026-11-02', '09:28:00')), '19:58:00 IST'); // EST
});

test('holidays, weekends, early closes and unknown years', () => {
  assert.equal(dayStatus('2026-11-26'), 'holiday'); // Thanksgiving
  assert.equal(dayStatus('2026-11-27'), 'early');
  assert.equal(dayStatus('2026-07-03'), 'holiday'); // Independence Day observed
  assert.equal(dayStatus('2026-10-17'), 'weekend');
  assert.equal(dayStatus('2026-10-19'), 'open');
  assert.equal(dayStatus('2031-03-04'), 'unknown'); // fails closed
  assert.equal(previousTradingDay('2026-11-27'), '2026-11-25');
  const t = sessionTimes('2026-11-27');
  assert.equal(new Date(t.regularClose).toISOString(), '2026-11-27T18:00:00.000Z'); // 13:00 EST
});

test('a provider calendar overrides the fallback table', () => {
  const cal = { from: '2026-01-01', to: '2026-12-31', days: { '2026-10-19': { open: '09:30', close: '16:00' } } };
  assert.equal(dayStatus('2026-10-19', cal), 'open');
  assert.equal(dayStatus('2026-10-20', cal), 'holiday'); // not in the verified list
});

test('snapshot boundaries, phases and NOII stages', () => {
  const t = sessionTimes('2026-10-19');
  assert.equal(phaseAt(t.open - 1, t), 'openingAuction');
  assert.equal(phaseAt(t.open, t), 'openingWindow');
  assert.equal(phaseAt(t.windowEnd - 1, t), 'openingWindow');
  assert.equal(phaseAt(t.windowEnd, t), 'regular');
  assert.equal(noiiStage(t.earlyAuction - 1, t), 'none');
  assert.equal(noiiStage(t.earlyAuction, t), 'early');
  assert.equal(noiiStage(t.main, t), 'full');
  assert.equal(t.confirmPublish - t.windowEnd, 5000);
  assert.ok(t.preliminary < t.earlyAuction && t.earlyAuction < t.main && t.main < t.final && t.final < t.open);
});
