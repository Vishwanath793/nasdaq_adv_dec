/**
 * Deterministic DEMO session (pure, seeded). Every symbol is fictional (Z-prefixed,
 * plus simulated benchmark ETFs) and every number is simulated. The session is
 * labelled DEMO everywhere it appears. It exists to exercise each validation case
 * in the spec (§10) through the same feature, scoring and paper code used live.
 */

import { etToUtc, previousTradingDays, previousTradingDay, sessionTimes } from './clock.js';
import { rng } from './stats.js';
import { cumulativeToIncrements } from './series.js';

export const DEMO_DATE = '2026-10-19';
export const DEMO_SEED = 20261019;
const MIN = 60_000;
const SCOPE = { provider: 'demo', feed: 'demo-sip', conditionPolicy: 'cond-v1', adjustment: 'raw', venueStart: '04:00:00', quoteSizeUnit: 'shares', label: 'DEMO simulated consolidated feed' };

// Minute index m: 0 = 04:00 ET … 329 = 09:29 ET.
const M = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return (h - 4) * 60 + m; };
const ramp = (m, m0, m1, a, b) => (m <= m0 ? a : m >= m1 ? b : a + ((b - a) * (m - m0)) / (m1 - m0));
const curveW = (m) => 0.12 + Math.exp((m - 330) / 40);
const CURVE_SUM = Array.from({ length: 330 }, (_, m) => curveW(m)).reduce((s, x) => s + x, 0);

/** Scenario definitions. path(m) = fractional move from the previous close; volX(m) = volume multiple vs normal. */
const SCENARIOS = [
  { sym: 'ZSTD', name: 'Steadfast Systems', sector: 'Technology', etf: 'XLK', price: 42, adv: 3_200_000, case: 'Modest gap with sustained elevated RVOL',
    path: (m) => (m < M('07:00') ? 0.001 : ramp(m, M('07:00'), M('07:20'), 0.002, 0.021) + ramp(m, M('07:20'), M('09:29'), 0, 0.004)), volX: (m) => (m < M('07:00') ? 1 : 3.2), pushX: 1.3, pullX: 0.6,
    window: [[1, 25, 2.2], [1, 18, 2], [-1, 6, 1.1], [1, 20, 2], [1, 15, 1.8]], drift: 0.006, spreadBps: 4,
    news: [{ at: '07:00', headline: 'Steadfast Systems raises full-year guidance on cloud demand', sourceKind: 'newswire', source: 'DemoWire' }], borrow: { shortable: true, easyToBorrow: true }, noii: { side: 'B', ratio: 0.35 } },
  { sym: 'ZBIG', name: 'Bigleap Bio', sector: 'Healthcare', etf: 'XLV', price: 8.5, adv: 900_000, case: 'Large gap with almost no volume',
    path: (m) => (m < M('06:30') ? 0 : 0.09), volX: () => 0.25, pushX: 1, pullX: 1, thin: true,
    window: [[-1, 40, 0.8], [1, 30, 0.6], [-1, 35, 0.7], [-1, 20, 0.5], [1, 10, 0.4]], drift: -0.01, spreadBps: 45, borrow: null },
  { sym: 'ZSPK', name: 'Spikeline Retail', sector: 'Consumer Discretionary', etf: 'XLY', price: 15, adv: 1_500_000, case: 'One-print volume spike then silence',
    path: (m) => (m < M('07:30') ? 0 : 0.04 - ramp(m, M('07:30'), M('09:29'), 0, 0.006)), volX: (m) => (m === M('07:30') ? 90 : m < M('07:30') ? 0.8 : 0.15), pushX: 1, pullX: 1,
    window: [[-1, 15, 1], [-1, 12, 0.9], [1, 5, 0.6], [-1, 10, 0.8], [-1, 8, 0.7]], drift: -0.008, spreadBps: 12, borrow: { shortable: true, easyToBorrow: false } },
  { sym: 'ZPPR', name: 'Pullpoint Robotics', sector: 'Industrials', etf: 'XLI', price: 63, adv: 2_500_000, case: 'Strong push, light-volume pullback, strong recovery',
    path: (m) => (m < M('07:00') ? 0 : m < M('08:30') ? ramp(m, M('07:00'), M('08:30'), 0.005, 0.04) : m < M('09:00') ? ramp(m, M('08:30'), M('09:00'), 0.04, 0.022) : ramp(m, M('09:00'), M('09:29'), 0.022, 0.036)),
    volX: (m) => (m < M('07:00') ? 1 : m < M('08:30') ? 4 : m < M('09:00') ? 1.1 : 4.5), pushX: 1.4, pullX: 0.5,
    window: [[1, 30, 2.5], [-1, 45, 1.2], [-1, 20, 1], [1, 55, 2.6], [1, 40, 2.4]], drift: 0.008, spreadBps: 5,
    news: [{ at: '06:55', headline: 'Pullpoint Robotics wins $400 million contract with automotive maker', sourceKind: 'newswire', source: 'DemoWire' }], borrow: { shortable: true, easyToBorrow: true }, noii: { side: 'B', ratio: 0.2 } },
  { sym: 'ZFBO', name: 'Falsebreak Media', sector: 'Communication Services', etf: 'XLC', price: 120, adv: 4_000_000, case: 'High-volume failed breakout',
    path: (m) => (m < M('07:00') ? 0 : m < M('08:30') ? ramp(m, M('07:00'), M('08:30'), 0.01, 0.035) : m < M('09:10') ? ramp(m, M('08:30'), M('09:10'), 0.035, 0.028) : m < M('09:20') ? ramp(m, M('09:10'), M('09:20'), 0.028, 0.043) : ramp(m, M('09:20'), M('09:25'), 0.043, 0.025)),
    volX: (m) => (m < M('07:00') ? 1 : m < M('09:10') ? 2.5 : 6), pushX: 1, pullX: 1.3,
    window: [[-1, 30, 2], [-1, 25, 1.8], [1, 8, 1], [-1, 20, 1.6], [-1, 15, 1.4]], drift: -0.006, spreadBps: 3, borrow: { shortable: true, easyToBorrow: true }, noii: { side: 'B', ratio: 0.15, flipAt: '09:27:30' } },
  { sym: 'ZDWN', name: 'Downshift Devices', sector: 'Technology', etf: 'XLK', price: 54, adv: 3_000_000, case: 'Heavy selling with continued downside progress',
    path: (m) => -0.03 - ramp(m, M('06:00'), M('09:29'), 0, 0.018), volX: (m) => (m < M('06:00') ? 2 : 4), pushX: 1.4, pullX: 0.5, afterHours: -0.03,
    window: [[-1, 30, 2.4], [-1, 20, 2.2], [1, 6, 1], [-1, 25, 2.1], [-1, 18, 2]], drift: -0.007, spreadBps: 5,
    news: [{ prevDay: '16:05', headline: 'Downshift Devices cuts full-year outlook, shares slide after hours', sourceKind: 'newswire', source: 'DemoWire' }], borrow: { shortable: true, easyToBorrow: true }, noii: { side: 'S', ratio: 0.4 } },
  { sym: 'ZABS', name: 'Absorb Financial', sector: 'Financials', etf: 'XLF', price: 31, adv: 2_000_000, case: 'Heavy selling followed by absorption-like price behaviour (inference)',
    path: (m) => (m < M('07:00') ? -0.005 : m < M('08:00') ? ramp(m, M('07:00'), M('08:00'), -0.01, -0.03) : m < M('08:59') ? -0.03 : ramp(m, M('08:59'), M('09:29'), -0.03, -0.024)),
    volX: (m) => (m < M('07:00') ? 1 : 3.5), pushX: 2.4, pullX: 0.5, noisy: 0.0018,
    window: [[1, 20, 1.6], [1, 15, 1.4], [-1, 6, 1], [1, 18, 1.5], [1, 10, 1.3]], drift: 0.005, spreadBps: 6, borrow: { shortable: true, easyToBorrow: true } },
  { sym: 'ZMIS', name: 'Missing Feed Industries', sector: 'Industrials', etf: 'XLI', price: 22, adv: 1_200_000, case: 'Missing pre-market volume (feed connected late)',
    path: (m) => (m < M('07:00') ? 0 : 0.03), volX: () => 2, pushX: 1, pullX: 1, observeFrom: '09:22',
    window: [[1, 20, 1.5], [1, 10, 1.2], [-1, 8, 1], [1, 12, 1.2], [-1, 5, 1]], drift: 0.002, spreadBps: 10, borrow: null },
  { sym: 'ZDLY', name: 'Delayline Data', sector: 'Technology', etf: 'XLK', price: 75, adv: 2_000_000, case: 'Delayed consolidated data (15-minute delay)',
    path: (m) => (m < M('07:00') ? 0 : 0.025), volX: (m) => (m < M('07:00') ? 1 : 2.5), pushX: 1.2, pullX: 0.7, delayMs: 15 * MIN,
    window: [[1, 15, 1.5], [1, 10, 1.3], [-1, 6, 1], [1, 12, 1.4], [1, 9, 1.2]], drift: 0.003, spreadBps: 5, borrow: { shortable: true, easyToBorrow: true } },
  { sym: 'ZMIX', name: 'Mixfeed Therapeutics', sector: 'Healthcare', etf: 'XLV', price: 18, adv: 1_000_000, case: 'IEX/SIP baseline mismatch (refused)',
    path: (m) => (m < M('07:00') ? 0 : 0.035), volX: (m) => (m < M('07:00') ? 1 : 3), pushX: 1.3, pullX: 0.6, historyFeed: 'demo-iex',
    window: [[1, 20, 1.5], [1, 12, 1.3], [-1, 6, 1], [1, 15, 1.4], [1, 10, 1.2]], drift: 0.004, spreadBps: 8, borrow: null },
  { sym: 'ZSPL', name: 'Splitwise Goods', sector: 'Consumer Discretionary', etf: 'XLY', price: 40, adv: 2_000_000, case: 'Split-adjusted baseline (2-for-1 split 5 sessions ago)',
    path: (m) => (m < M('07:00') ? 0 : ramp(m, M('07:00'), M('07:30'), 0, 0.025)), volX: (m) => (m < M('07:00') ? 1 : 2.5), pushX: 1.2, pullX: 0.7, split: { ago: 5, ratio: 2 },
    window: [[1, 15, 1.4], [1, 12, 1.3], [-1, 5, 1], [1, 10, 1.2], [1, 8, 1.2]], drift: 0.003, spreadBps: 6, borrow: { shortable: true, easyToBorrow: true } },
  { sym: 'ZSPX', name: 'Splitunknown Corp', sector: 'Industrials', etf: 'XLI', price: 28, adv: 1_500_000, case: 'Split with unknown ratio (baseline refused)',
    path: (m) => (m < M('07:00') ? 0 : 0.02), volX: (m) => (m < M('07:00') ? 1 : 2), pushX: 1, pullX: 1, split: { ago: 3, ratio: null },
    window: [[1, 10, 1.2], [-1, 6, 1], [1, 8, 1.1], [1, 6, 1], [-1, 4, 1]], drift: 0, spreadBps: 8, borrow: null },
  { sym: 'ZZER', name: 'Zero Minute Utilities', sector: 'Utilities', etf: 'XLU', price: 12, adv: 300_000, case: 'Genuine zero-volume minutes vs a reconnect gap',
    path: (m) => (m < M('07:30') ? 0 : 0.015), volX: (m) => (m < M('07:30') ? 1 : 2), pushX: 1, pullX: 1, thin: true, gaps: [['08:40', '08:55']],
    window: [[1, 10, 1.1], [-1, 8, 1], [1, 6, 1], [1, 5, 1], [-1, 4, 0.9]], drift: 0, spreadBps: 30, borrow: null },
  { sym: 'ZCUM', name: 'Cumulus Snapshot Co', sector: 'Industrials', etf: 'XLI', price: 36, adv: 1_800_000, case: 'Repeated cumulative-volume snapshots (counted once)',
    path: (m) => (m < M('07:00') ? 0 : 0.018), volX: (m) => (m < M('07:00') ? 1 : 2), pushX: 1.1, pullX: 0.8, cumulative: true,
    window: [[1, 10, 1.3], [1, 8, 1.2], [-1, 5, 1], [1, 8, 1.2], [1, 6, 1.1]], drift: 0.002, spreadBps: 7, borrow: null },
  { sym: 'ZDUP', name: 'Duplicate Data Labs', sector: 'Technology', etf: 'XLK', price: 48, adv: 1_600_000, case: 'Duplicate and revised provider observations',
    path: (m) => (m < M('07:00') ? 0 : 0.016), volX: (m) => (m < M('07:00') ? 1 : 2), pushX: 1.1, pullX: 0.8, duplicates: true,
    window: [[1, 10, 1.3], [1, 8, 1.2], [-1, 5, 1], [1, 8, 1.2], [-1, 4, 1]], drift: 0.001, spreadBps: 6, borrow: null },
  { sym: 'ZLAT', name: 'Latefill Logistics', sector: 'Industrials', etf: 'XLI', price: 52, adv: 2_200_000, case: 'Late historical backfill unavailable at the original decision',
    path: (m) => (m < M('07:00') ? 0 : 0.022), volX: (m) => (m < M('07:00') ? 1 : 2.6), pushX: 1.2, pullX: 0.7, lateFill: ['08:50', '09:27', '09:40'],
    window: [[1, 12, 1.4], [1, 10, 1.3], [-1, 5, 1], [1, 10, 1.3], [1, 6, 1.1]], drift: 0.003, spreadBps: 6, borrow: null },
  { sym: 'ZHLT', name: 'Haltwell Pharma', sector: 'Healthcare', etf: 'XLV', price: 9, adv: 2_500_000, case: 'Halted (news pending) through the open',
    path: (m) => (m < M('08:00') ? 0 : 0.12), volX: (m) => (m < M('08:00') ? 1 : m < M('09:05') ? 6 : 0), pushX: 1, pullX: 1, halt: ['09:05', '10:05', 'T1'],
    window: null, drift: 0, spreadBps: 40, borrow: null },
  { sym: 'ZFAD', name: 'Fadeaway Software', sector: 'Technology', etf: 'XLK', price: 95, adv: 5_000_000, case: 'Gap-up that fails at the open (reversal strategy)',
    path: (m) => (m < M('07:00') ? 0 : ramp(m, M('07:00'), M('08:00'), 0.01, 0.035)), volX: (m) => (m < M('07:00') ? 1 : 2.4), pushX: 1.2, pullX: 0.8,
    window: [[-1, 70, 2.8], [-1, 60, 2.6], [-1, 45, 2.2], [1, 10, 1.4], [-1, 50, 2.4]], drift: -0.008, spreadBps: 3, borrow: null },
  { sym: 'ZERN', name: 'Earnmark Foods', sector: 'Consumer Staples', etf: 'XLP', price: 66, adv: 1_800_000, case: 'Earnings without valid consensus (catalyst neutral)',
    path: (m) => (m < M('07:00') ? 0 : 0.02), volX: (m) => (m < M('07:00') ? 1 : 2.2), pushX: 1.1, pullX: 0.8,
    window: [[1, 12, 1.4], [-1, 10, 1.1], [1, 8, 1.2], [1, 6, 1.1], [-1, 5, 1]], drift: 0.001, spreadBps: 6,
    news: [{ at: '07:00', headline: 'Earnmark Foods reports third-quarter results', sourceKind: 'newswire', source: 'DemoWire' }], borrow: null },
  { sym: 'ZOFF', name: 'Offerpoint Biotech', sector: 'Healthcare', etf: 'XLV', price: 5.2, adv: 6_000_000, case: 'Priced offering (negative catalyst); not shortable',
    path: (m) => (m < M('07:30') ? -0.01 : -0.12), volX: (m) => (m < M('07:30') ? 1 : 3.5), pushX: 1.3, pullX: 0.7,
    window: [[-1, 40, 2], [-1, 30, 1.8], [1, 20, 1.2], [-1, 25, 1.6], [-1, 15, 1.4]], drift: -0.004, spreadBps: 25,
    news: [{ at: '07:25', headline: 'Offerpoint Biotech prices $50 million public offering of common stock', sourceKind: 'newswire', source: 'DemoWire' }, { at: '07:28', headline: 'Offerpoint Biotech Prices $50 Million Public Offering of Common Stock', sourceKind: 'aggregator', source: 'DemoAggregator' }],
    borrow: { shortable: false, easyToBorrow: false } },
];

const BENCH = [
  ['QQQ', 'Simulated Nasdaq-100 ETF', 480, 40_000_000, 0.0045], ['SPY', 'Simulated S&P 500 ETF', 560, 60_000_000, 0.003], ['IWM', 'Simulated Russell 2000 ETF', 215, 25_000_000, 0.001],
  ['XLK', 'Simulated Tech Sector ETF', 230, 6_000_000, 0.006], ['XLV', 'Simulated Healthcare Sector ETF', 145, 7_000_000, -0.002], ['XLY', 'Simulated Consumer Disc. ETF', 200, 4_000_000, 0.002],
  ['XLC', 'Simulated Communication ETF', 95, 5_000_000, 0.003], ['XLF', 'Simulated Financials ETF', 47, 30_000_000, -0.001], ['XLI', 'Simulated Industrials ETF', 135, 8_000_000, 0.002],
  ['XLU', 'Simulated Utilities ETF', 78, 9_000_000, 0], ['XLP', 'Simulated Staples ETF', 80, 8_000_000, 0.001],
];

const SECTOR_ETFS = ['XLK', 'XLV', 'XLY', 'XLC', 'XLF', 'XLI', 'XLU', 'XLP'];
const SECTOR_OF = { XLK: 'Technology', XLV: 'Healthcare', XLY: 'Consumer Discretionary', XLC: 'Communication Services', XLF: 'Financials', XLI: 'Industrials', XLU: 'Utilities', XLP: 'Consumer Staples' };

const round = (p) => (p >= 1 ? Math.round(p * 100) / 100 : Math.round(p * 10_000) / 10_000);

/** Daily bars ending with the previous session close = prevClose (oldest first). */
function genDaily(rand, { date, prevClose, adv, atrPct, n = 220, split }) {
  const days = previousTradingDays(date, n).reverse();
  const out = [];
  let c = prevClose;
  const closes = [];
  for (let i = days.length - 1; i >= 0; i--) { closes[i] = c; c = c / (1 + (rand() - 0.5) * atrPct * 1.2); }
  for (let i = 0; i < days.length; i++) {
    const close = closes[i];
    const open = i ? closes[i - 1] * (1 + (rand() - 0.5) * atrPct * 0.6) : close;
    const h = Math.max(open, close) * (1 + rand() * atrPct * 0.5);
    const l = Math.min(open, close) * (1 - rand() * atrPct * 0.5);
    let v = Math.round(adv * (0.7 + rand() * 0.6));
    // Raw (unadjusted) daily volume before a split is in old shares.
    if (split && i < days.length - split.ago && split.ratio) v = Math.round(v / split.ratio);
    out.push({ date: days[i], o: round(open), h: round(h), l: round(l), c: round(close), v });
  }
  return out;
}

/** One session's pre-market minute bars [04:00, 09:30). */
function genPreMarket(rand, { date, prevClose, pmVolume, path, volX, pushX = 1, pullX = 1, thin = false, noisy = 0.0008, volDiv = 1 }) {
  const bars = [];
  let last = prevClose * (1 + path(0));
  for (let m = 0; m < 330; m++) {
    const target = prevClose * (1 + path(m));
    const c = target * (1 + (rand() - 0.5) * 2 * noisy);
    const dir = Math.sign(c - last) * Math.sign(path(329) || 1);
    let v = (pmVolume * curveW(m)) / CURVE_SUM * volX(m) * (0.6 + 0.8 * rand());
    v *= dir > 0 ? pushX : dir < 0 ? pullX : 1;
    v /= volDiv;
    if (v < 100) v = rand() < v / (thin ? 160 : 100) ? 100 : 0;
    if (v <= 0) continue;
    const t = etToUtc(date, `${String(4 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);
    const o = last;
    const h = Math.max(o, c) * (1 + rand() * 0.0005);
    const l = Math.min(o, c) * (1 - rand() * 0.0005);
    const vv = Math.round(v);
    bars.push({ t, o: round(o), h: round(h), l: round(l), c: round(c), v: vv, n: Math.max(1, Math.round(vv / 150)), vw: round((o + h + l + c * 2) / 5), availableAt: t + MIN + 400 });
    last = c;
  }
  return bars;
}

/** Five opening-window bars from spec [[dir, bps, volX], …] then regular-session bars to 16:00 with a drift. */
function genRegular(rand, { date, startPrice, window, perMinute, drift, early = false, prevClose }) {
  const bars = [];
  let p = startPrice;
  const t0 = etToUtc(date, '09:30:00');
  const winBase = perMinute * 3.2;
  const steps = window ?? [];
  for (let i = 0; i < 5; i++) {
    const w = steps[i] ?? [Math.sign(rand() - 0.5), 4 + rand() * 8, 1];
    const t = t0 + i * MIN;
    const o = p;
    const c = o * (1 + (w[0] * w[1]) / 10_000);
    const wick = Math.abs(c - o) * 0.25 + o * 0.0004;
    const h = Math.max(o, c) + wick * rand();
    const l = Math.min(o, c) - wick * rand();
    const v = Math.round(winBase * w[2] * (0.85 + 0.3 * rand()));
    bars.push({ t, o: round(o), h: round(h), l: round(l), c: round(c), v, n: Math.round(v / 120), vw: round((o + h + l + c) / 4), availableAt: t + MIN + 400 });
    p = c;
  }
  if (early) return bars;
  const end = etToUtc(date, '16:00:00');
  for (let t = t0 + 5 * MIN; t < end; t += MIN) {
    const o = p;
    const c = o * (1 + drift / 60 * (t < t0 + 120 * MIN ? 1 : 0.2) + (rand() - 0.5) * 0.0016);
    const h = Math.max(o, c) * (1 + rand() * 0.0006);
    const l = Math.min(o, c) * (1 - rand() * 0.0006);
    const minutesIn = (t - t0) / MIN;
    const u = 0.6 + 1.4 * Math.exp(-minutesIn / 45) + 0.6 * Math.exp((minutesIn - 390) / 30);
    const v = Math.round(perMinute * u * (0.7 + 0.6 * rand()));
    bars.push({ t, o: round(o), h: round(h), l: round(l), c: round(c), v, n: Math.round(v / 120), vw: round((o + h + l + c) / 4), availableAt: t + MIN + 400 });
    p = c;
  }
  return bars;
}

/** Quotes derived from bars: one per pre-market minute with a trade (plus every 5 min), three per regular minute. */
function genQuotes(rand, bars, { spreadBps, thin, date, prevClose }) {
  const quotes = [];
  const open = etToUtc(date, '09:30:00');
  const byT = new Map(bars.map((b) => [b.t, b]));
  const size = () => (thin ? 100 : 100 * Math.round(2 + rand() * 12));
  let lastPx = prevClose;
  for (let t = etToUtc(date, '04:00:00'); t < etToUtc(date, '16:00:00'); t += MIN) {
    const b = byT.get(t);
    const pre = t < open;
    const pts = b ? [[2_000, b.o], [30_000, (b.h + b.l) / 2], [58_000, b.c]] : (pre && (t / MIN) % 5 !== 0 ? [] : [[30_000, lastPx]]);
    for (const [dt, px] of pts) {
      const half = (px * spreadBps * (pre ? 2 : 1)) / 20_000;
      quotes.push({ t: t + dt, bid: round(px - half), ask: round(px + half), bidSize: size(), askSize: size(), availableAt: t + dt + 150 });
    }
    if (b) lastPx = b.c;
  }
  return quotes;
}

function genNoii(rand, { date, ref, side, ratio, flipAt }) {
  const out = [];
  const from = etToUtc(date, '09:25:00');
  const main = etToUtc(date, '09:28:00');
  const flip = flipAt ? etToUtc(date, flipAt) : Infinity;
  let paired = 20_000;
  for (let t = from; t < etToUtc(date, '09:30:00'); t += 10_000) {
    paired = Math.round(paired * (1.03 + rand() * 0.04));
    const s = t >= flip ? (side === 'B' ? 'S' : 'B') : side;
    const imb = Math.round(paired * ratio * (0.8 + rand() * 0.4));
    const drift = (s === 'B' ? 1 : -1) * 0.0004 * ((t - from) / 60_000);
    const refPx = round(ref * (1 + drift));
    out.push({
      t, availableAt: t + 50, pairedShares: paired, imbalanceShares: imb, imbalanceSide: s, crossType: 'O',
      referencePrice: refPx,
      // Early NOII (before 09:28): near/far are placeholders (0), i.e. unavailable, not $0.
      nearPrice: t < main ? 0 : round(refPx * (1 + (s === 'B' ? 0.001 : -0.001))),
      farPrice: t < main ? 0 : round(refPx * (1 + (s === 'B' ? 0.003 : -0.003))),
    });
  }
  return out;
}

function instrument(rand, specIn, date, times, kind = 'stock', variant = false) {
  // Validation variants (any seed other than the canonical one): gap sizes are scaled and the move AFTER the
  // decision (window direction and later drift) is randomised, so synthetic data cannot pose as an edge.
  const scale = variant ? 0.6 + rand() * 0.8 : 1;
  const flip = variant && rand() < 0.5 ? -1 : 1;
  const spec = variant ? { ...specIn, path: (m) => specIn.path(m) * scale, drift: (specIn.drift ?? 0) * flip * (0.5 + rand()), window: specIn.window ? specIn.window.map(([d, b, v]) => [rand() < 0.35 ? -d : d, b * (0.5 + rand()), v]) : null } : specIn;
  const prevDate = previousTradingDay(date);
  const prevClose = spec.price;
  const atrPct = spec.atrPct ?? 0.03;
  const daily = genDaily(rand, { date, prevClose, adv: spec.adv, atrPct, split: spec.split });
  const pmVolume = spec.adv * 0.035;
  const histDates = previousTradingDays(date, 20);
  const scope = { ...SCOPE, ...(spec.delayMs ? { delayMs: spec.delayMs, label: 'DEMO delayed feed (15 min)' } : {}) };
  const histScope = { ...SCOPE, feed: spec.historyFeed ?? SCOPE.feed };
  const history = histDates.map((d, i) => {
    const dayClose = daily.find((x) => x.date === d)?.c ?? prevClose;
    const prior = daily[daily.findIndex((x) => x.date === d) - 1]?.c ?? dayClose;
    // Raw history before a split is in old shares (volume ÷ ratio, price × ratio).
    const preSplit = spec.split && i >= spec.split.ago;
    const div = preSplit ? (spec.split.ratio ?? 2) : 1;
    const drift = (dayClose / prior - 1) * 0.3;
    const pm = genPreMarket(rand, { date: d, prevClose: prior, pmVolume, path: (m) => drift * (m / 330), volX: () => 1, thin: spec.thin, volDiv: div });
    const win = genRegular(rand, { date: d, startPrice: pm.at(-1)?.c ?? prior, window: null, perMinute: spec.adv / 390, drift: 0, early: true });
    const bars = [...pm, ...win.map((b) => ({ ...b, v: Math.round(b.v / div) }))];
    return { date: d, scope: histScope, bars, coverage: [{ from: etToUtc(d, '04:00:00'), to: etToUtc(d, '09:35:00') }] };
  });
  let bars = genPreMarket(rand, { date, prevClose, pmVolume, path: spec.path, volX: spec.volX, pushX: spec.pushX, pullX: spec.pullX, thin: spec.thin, noisy: spec.noisy ?? 0.0008 });
  const last = bars.at(-1)?.c ?? prevClose * (1 + spec.path(329));
  let regular = spec.halt ? [] : genRegular(rand, { date, startPrice: last * (1 + (rand() - 0.5) * 0.002), window: spec.window, perMinute: spec.adv / 390, drift: spec.drift ?? 0, prevClose });
  if (spec.halt) {
    // Halted 09:05 → resumes 10:05: no prints in between.
    const resume = etToUtc(date, `${spec.halt[1]}:00`);
    bars = bars.filter((b) => b.t < etToUtc(date, `${spec.halt[0]}:00`));
    regular = genRegular(rand, { date, startPrice: last, window: null, perMinute: spec.adv / 390, drift: -0.004 }).filter((b) => b.t >= resume);
  }
  const all = [...bars, ...regular];
  let quotes = genQuotes(rand, all, { spreadBps: spec.spreadBps ?? 5, thin: spec.thin, date, prevClose });
  if (spec.halt) { const h0 = etToUtc(date, `${spec.halt[0]}:00`); const h1 = etToUtc(date, `${spec.halt[1]}:00`); quotes = quotes.filter((q) => q.t < h0 || q.t >= h1); }
  // Coverage of today's feed.
  let coverage = [{ from: etToUtc(date, spec.observeFrom ? `${spec.observeFrom}:00` : '04:00:00'), to: etToUtc(date, '16:00:00') }];
  if (spec.observeFrom) { const from = etToUtc(date, `${spec.observeFrom}:00`); bars = bars.filter((b) => b.t >= from); quotes = quotes.filter((q) => q.t >= from); }
  if (spec.gaps) {
    for (const [a, b] of spec.gaps) {
      const ga = etToUtc(date, `${a}:00`); const gb = etToUtc(date, `${b}:00`);
      coverage = coverage.flatMap((c) => (c.from < gb && c.to > ga ? [{ from: c.from, to: ga }, { from: gb, to: c.to }] : [c]));
      bars = bars.filter((x) => x.t < ga || x.t >= gb);
      quotes = quotes.filter((q) => q.t < ga || q.t >= gb);
    }
  }
  if (spec.lateFill) {
    // Minutes in [a, b) were missed live (reconnect) and only backfilled at `avail`: unknown to earlier snapshots.
    const [a, b, avail] = spec.lateFill.map((x) => etToUtc(date, `${x}:00`));
    coverage = coverage.flatMap((c) => (c.from < b && c.to > a ? [{ from: c.from, to: a }, { from: b, to: c.to }, { from: a, to: b, availableAt: avail }] : [c]));
    bars = bars.map((x) => (x.t >= a && x.t < b ? { ...x, availableAt: avail } : x));
    quotes = quotes.filter((q) => q.t < a || q.t >= b);
  }
  if (spec.delayMs) bars = bars.map((x) => ({ ...x, availableAt: x.availableAt + spec.delayMs }));
  if (spec.delayMs) regular = regular.map((x) => ({ ...x, availableAt: x.availableAt + spec.delayMs }));
  if (spec.delayMs) quotes = quotes.map((q) => ({ ...q, availableAt: q.availableAt + spec.delayMs }));
  let todayBars = [...bars, ...regular];
  let cumulativeCheck = null;
  if (spec.cumulative) {
    // The provider sends "volume so far today" every 15 s, often repeating the same value.
    const snaps = [];
    let cum = 0;
    for (const b of bars) { snaps.push({ t: b.t + 1_000, cumVolume: cum, availableAt: b.t + 1_100 }); cum += b.v; snaps.push({ t: b.t + 59_000, cumVolume: cum, availableAt: b.t + 59_100 }); snaps.push({ t: b.t + 59_500, cumVolume: cum, availableAt: b.t + 59_600 }); }
    const inc = cumulativeToIncrements(snaps).increments;
    const byT = new Map(inc.map((x) => [x.t, x.v]));
    cumulativeCheck = { snapshots: snaps.length, original: bars.reduce((s, b) => s + b.v, 0), counted: inc.reduce((s, x) => s + x.v, 0) };
    todayBars = [...bars.map((b) => ({ ...b, v: byT.get(b.t) ?? 0, vw: null, n: null })).filter((b) => b.v > 0), ...regular];
  }
  if (spec.duplicates) {
    const extra = [];
    bars.forEach((b, i) => { extra.push({ ...b, availableAt: b.availableAt + 5_000 }); if (i % 7 === 0) extra.push({ ...b, v: b.v + 100, availableAt: b.availableAt + 9_000 }); });
    todayBars = [...todayBars, ...extra];
  }
  const news = (spec.news ?? []).map((n, i) => {
    const pub = n.prevDay ? etToUtc(prevDate, `${n.prevDay}:00`) : etToUtc(date, `${n.at}:00`);
    return { id: `${spec.sym}-n${i}`, headline: n.headline, source: n.source, sourceKind: n.sourceKind, url: `https://example.invalid/demo/${spec.sym.toLowerCase()}/${i}`, publishedAt: pub, firstSeenAt: pub + 45_000, demo: true };
  });
  const corporateActions = spec.split ? [{ type: 'split', exDate: previousTradingDays(date, spec.split.ago)[spec.split.ago - 1], ratio: spec.split.ratio, source: 'DEMO' }] : [];
  const sectorEtf = spec.etf;
  return {
    symbol: spec.sym, instrumentId: `DEMO-${spec.sym}`,
    meta: { name: spec.name, securityType: kind === 'etf' ? 'ETF' : 'Common Stock', sector: spec.sector ?? SECTOR_OF[sectorEtf] ?? null, sectorEtf: kind === 'etf' ? null : sectorEtf, marketCap: Math.round(spec.price * spec.adv * 60), roundLot: 100, benchmark: kind === 'etf', demoCase: spec.case ?? null, listing: 'Nasdaq (DEMO)' },
    scope,
    prevClose: { price: prevClose, date: prevDate, source: 'DEMO official close' },
    daily, history,
    today: { bars: todayBars, coverage, quotes },
    prevAfterHours: spec.afterHours ? { last: round(prevClose * (1 + spec.afterHours)) } : null,
    news, newsChecked: true,
    halts: spec.halt ? [{ haltAt: etToUtc(date, `${spec.halt[0]}:00`), resumeAt: etToUtc(date, `${spec.halt[1]}:00`), reason: spec.halt[2], firstSeenAt: etToUtc(date, `${spec.halt[0]}:00`) + 60_000, source: 'DEMO halt feed' }] : [],
    haltsChecked: true,
    noii: spec.noii ? genNoii(rand, { date, ref: last, ...spec.noii }) : null,
    noiiReason: spec.noii ? null : 'no simulated NOII for this symbol',
    typicalCrossVolume: Math.round(spec.adv * 0.01),
    corporateActions,
    float: { value: Math.round(spec.adv * 45), asOf: previousTradingDays(date, 30)[29], kind: 'shares outstanding (not free float)', source: 'DEMO' },
    borrow: spec.borrow ? { ...spec.borrow, asOf: prevDate, source: 'DEMO broker' } : null,
    cumulativeCheck,
    demoCase: spec.case ?? null,
  };
}

/** The whole simulated session. */
export function demoSession({ date = DEMO_DATE, seed = DEMO_SEED } = {}) {
  const rand = rng(seed);
  const variant = seed !== DEMO_SEED;
  const times = sessionTimes(date);
  const instruments = {};
  for (const [sym, name, price, adv, move] of BENCH) {
    instruments[sym] = instrument(rand, { sym, name, price, adv, atrPct: 0.012, path: (m) => (m < M('07:00') ? move * 0.3 : move), volX: () => 1.2, window: [[Math.sign(move) || 1, 6, 1.2], [1, 3, 1], [-1, 2, 1], [Math.sign(move) || 1, 4, 1.1], [1, 2, 1]], drift: move * 0.3, spreadBps: 1, etf: null }, date, times, 'etf');
  }
  for (const spec of SCENARIOS) instruments[spec.sym] = instrument(rand, spec, date, times, 'stock', variant);
  // Filler names so tracked-universe breadth has a real denominator.
  for (let i = 1; i <= 16; i++) {
    const etf = SECTOR_ETFS[i % SECTOR_ETFS.length];
    const g = (rand() - 0.45) * 0.025;
    const sym = `ZX${String(i).padStart(2, '0')}`;
    instruments[sym] = instrument(rand, { sym, name: `Filler Company ${i}`, sector: SECTOR_OF[etf], etf, price: 10 + rand() * 90, adv: 500_000 + rand() * 3_000_000, path: (m) => (m < M('07:00') ? g * 0.2 : g), volX: () => 0.9 + rand() * 0.6, window: null, drift: 0, spreadBps: 8, borrow: null, case: 'filler (breadth denominator)' }, date, times, 'stock', variant);
  }
  return {
    date, mode: 'DEMO', profile: 'DEMO', dataLabel: 'DEMO — deterministic simulated data, not market data',
    seed, generatedBy: 'demoSession v1', variant, variantNote: variant ? 'validation variant: post-decision moves randomised' : 'canonical scenario session',
    benchmarks: BENCH.map((b) => b[0]),
    universe: { name: 'DEMO universe', note: 'fictional symbols; not Nasdaq-listed', totalEligible: Object.keys(instruments).length, tracked: Object.keys(instruments) },
    instruments,
  };
}

export const DEMO_CASES = SCENARIOS.map((s) => ({ symbol: s.sym, case: s.case }));
