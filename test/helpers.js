// Small synthetic builders for tests (not a test file itself).
import { etToUtc, previousTradingDays } from '../src/utils/clock.js';

export const DATE = '2026-10-19';
export const SCOPE = { provider: 'test', feed: 'sip', conditionPolicy: 'cond-v1', adjustment: 'raw', venueStart: '04:00:00', quoteSizeUnit: 'shares' };
export const T = (hhmm, date = DATE) => etToUtc(date, hhmm.length === 5 ? `${hhmm}:00` : hhmm);

/** Minute bars from `from` to `to` (HH:MM) with constant volume v and a linear price path p0 → p1. */
export function bars(from, to, { v = 1000, p0 = 100, p1 = 100, date = DATE, avail = 60_400, every = 1 } = {}) {
  const out = [];
  const a = T(from, date); const b = T(to, date);
  const n = Math.max(1, (b - a) / 60_000);
  let i = 0;
  for (let t = a; t < b; t += 60_000, i++) {
    if (i % every) continue;
    const c = p0 + ((p1 - p0) * (i + 1)) / n;
    const o = p0 + ((p1 - p0) * i) / n;
    out.push({ t, o, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, c, v, n: 5, vw: (o + c) / 2, availableAt: t + avail });
  }
  return out;
}

export function history(days = 20, { v = 1000, date = DATE, scope = SCOPE, from = '04:00', to = '09:35' } = {}) {
  return previousTradingDays(date, days).map((d) => ({ date: d, scope, bars: bars(from, to, { v, date: d }), coverage: [{ from: T(from, d), to: T(to, d) }] }));
}

export function daily(n = 30, { c = 100, v = 1_000_000, date = DATE } = {}) {
  return previousTradingDays(date, n).reverse().map((d) => ({ date: d, o: c, h: c * 1.01, l: c * 0.99, c, v }));
}

export function quotes(from, to, { bid = 99.98, ask = 100.02, size = 500, date = DATE, step = 30_000 } = {}) {
  const out = [];
  for (let t = T(from, date); t < T(to, date); t += step) out.push({ t, bid, ask, bidSize: size, askSize: size, availableAt: t + 100 });
  return out;
}

export function inst(overrides = {}) {
  return {
    symbol: 'TEST', meta: { name: 'Test Co', securityType: 'Common Stock', roundLot: 100 }, scope: SCOPE,
    prevClose: { price: 100, date: '2026-10-16' }, daily: daily(), history: history(),
    today: { bars: bars('04:00', '09:30'), coverage: [{ from: T('04:00'), to: T('16:00') }], quotes: quotes('04:00', '16:00') },
    news: [], newsChecked: true, halts: [], haltsChecked: true, corporateActions: [], borrow: null,
    ...overrides,
  };
}
