/**
 * Live capability probe: calls each configured source once and records what actually
 * worked (status, row counts, quote-size unit evidence). Results go to
 * .data/probe-results.json and appear in the Providers page next to the documented matrix.
 * Run: npm run probe
 */

import { loadEnv, configured, redact } from './env.js';
import { writeJson } from './store.js';
import { fetchSymbolDirectory, fetchHalts } from './providers/nasdaqTrader.js';
import * as alpaca from './providers/alpaca.js';
import * as enr from './providers/enrichment.js';
import { previousTradingDay, etToUtc } from '../utils/clock.js';

loadEnv();

async function attempt(id, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    return { id, ok: true, at: startedAt, ms: Date.now() - startedAt, detail };
  } catch (e) {
    return { id, ok: false, at: startedAt, ms: Date.now() - startedAt, error: redact(e.message), status: e.status ?? null };
  }
}

export async function runProbe() {
  const cfg = configured();
  const today = new Date().toISOString().slice(0, 10);
  const prev = previousTradingDay(today) ?? today;
  const results = [];
  results.push(await attempt('nasdaq-symdir', async () => { const d = await fetchSymbolDirectory(); return { rows: d.rows.length, createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null }; }));
  results.push(await attempt('nasdaq-halts', async () => ({ items: (await fetchHalts()).length })));
  results.push(await attempt('finra-shvol', async () => ({ symbols: Object.keys(await enr.finraShortVolume(prev)).length, date: prev })));
  if (cfg.alpaca) {
    results.push(await attempt('alpaca-iex', async () => {
      const b = await alpaca.bars(['AAPL', 'QQQ'], { start: etToUtc(prev, '04:00:00'), end: etToUtc(prev, '09:35:00'), feed: 'iex' });
      const first = b.AAPL?.[0];
      const q = await alpaca.quotes(['AAPL'], { start: etToUtc(prev, '09:30:00'), end: etToUtc(prev, '09:31:00'), feed: 'iex' });
      const sizes = (q.AAPL ?? []).flatMap((x) => [x.bidSize, x.askSize]).filter((x) => x > 0);
      const smallInts = sizes.filter((s) => s < 100).length / Math.max(1, sizes.length);
      return {
        aaplBars: b.AAPL?.length ?? 0, firstBarEt: first ? new Date(first.t).toISOString() : null, qqqBars: b.QQQ?.length ?? 0, quotes: q.AAPL?.length ?? 0,
        quoteSizeEvidence: sizes.length ? (smallInts > 0.8 ? 'sizes mostly < 100: likely ROUND LOTS' : 'sizes mostly ≥ 100: likely SHARES') : 'no quotes', configuredUnit: alpaca.quoteSizeUnit(),
      };
    }));
    results.push(await attempt('alpaca-sip-hist', async () => {
      const b = await alpaca.bars(['AAPL'], { start: etToUtc(prev, '04:00:00'), end: etToUtc(prev, '09:35:00'), feed: 'sip' });
      return { bars: b.AAPL?.length ?? 0, firstBar: b.AAPL?.[0] ? new Date(b.AAPL[0].t).toISOString() : null };
    }));
    results.push(await attempt('alpaca-trading', async () => {
      const c = await alpaca.calendar(`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`);
      const a = await alpaca.asset('AAPL');
      return { calendarDays: Object.keys(c.days).length, aaplShortable: a.shortable, aaplEtb: a.easyToBorrow };
    }));
    results.push(await attempt('alpaca-news', async () => ({ items: (await alpaca.news(['AAPL'], { start: Date.now() - 3 * 86_400_000, end: Date.now() })).length })));
  }
  if (cfg.finnhub) {
    results.push(await attempt('finnhub', async () => {
      const n = await enr.finnhubNews('AAPL', prev, today);
      const p = await enr.finnhubProfile('AAPL');
      return { news: n.length, profile: Boolean(p), sharesOutstanding: p?.sharesOutstanding?.value ?? null };
    }));
  }
  if (cfg.sec) {
    results.push(await attempt('sec-edgar', async () => {
      const map = await enr.secCikMap();
      const cik = map.AAPL;
      const f = await enr.secFilings(cik, 'AAPL', Date.now() - 30 * 86_400_000);
      const so = await enr.secSharesOutstanding(cik);
      return { tickers: Object.keys(map).length, filings30d: f.length, sharesOutstandingAsOf: so?.asOf ?? null };
    }));
  }
  if (cfg.alphaVantage) results.push(await attempt('alphavantage', async () => ({ rows: (await enr.avEarningsCalendar()).length })));
  if (cfg.massive) results.push(await attempt('massive', async () => ({ bars: (await enr.massiveMinuteAggs('AAPL', prev, prev)).length })));
  if (cfg.fred) results.push(await attempt('fred', async () => ({ obs: (await enr.fredSeries('DGS10', prev)).length })));
  const out = { ranAt: Date.now(), configured: cfg, results };
  writeJson('probe-results.json', out);
  return out;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('probe.js')) {
  runProbe().then((r) => {
    for (const x of r.results) console.log(`${x.ok ? 'OK  ' : 'FAIL'} ${x.id.padEnd(16)} ${x.ms} ms ${x.ok ? JSON.stringify(x.detail) : x.error}`);
    const missing = Object.entries(r.configured).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) console.log(`Not configured (skipped): ${missing.join(', ')} — see docs/SETUP.md`);
  });
}
