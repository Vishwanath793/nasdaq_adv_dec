/**
 * Enrichment adapters (free tiers), each with a pure parser:
 *  - Finnhub: company news, profile2 (shares outstanding, industry), earnings calendar. Prices/volume from
 *    Finnhub are NOT used for volume features (venue scope of its free trade stream is not documented as consolidated).
 *  - SEC EDGAR: ticker→CIK map, submissions (filings with acceptance time), dated shares outstanding (dei).
 *    Requires a descriptive User-Agent with a contact email (SEC_USER_AGENT); ≤10 requests/second.
 *  - FINRA Reg SHO daily short-sale volume files (keyless): research/display only, published after the
 *    trading day; short-sale volume is NOT short interest.
 *  - Alpha Vantage EARNINGS_CALENDAR (CSV, consensus estimate): 25 requests/day budget, fetched once a day.
 *  - Massive (formerly Polygon) Stocks Basic: end-of-day minute aggregates for historical research (5 calls/min).
 *  - FRED: daily macro observations for display/context only (not live yields or futures).
 */

import { get } from '../http.js';
import { etToUtc } from '../../utils/clock.js';

// ---------- Finnhub
const FH = 'https://finnhub.io/api/v1';
const fhKey = () => process.env.FINNHUB_API_KEY ?? '';

export const parseFinnhubNews = (rows, symbol, seenAt = Date.now()) => (rows ?? []).map((n) => ({
  id: `finnhub-${n.id}`, headline: n.headline, summary: n.summary, url: n.url, source: n.source, sourceKind: 'news', symbols: [symbol],
  publishedAt: n.datetime * 1000, firstSeenAt: seenAt, provider: 'finnhub', category: n.category,
}));
export async function finnhubNews(symbol, from, to) {
  const rows = await get(`${FH}/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${fhKey()}`, { provider: 'finnhub', ttlMs: 120_000 });
  return parseFinnhubNews(rows, symbol);
}

export const parseFinnhubProfile = (p) => (p && p.ticker ? {
  name: p.name, industry: p.finnhubIndustry, exchange: p.exchange, country: p.country, ipo: p.ipo,
  marketCap: p.marketCapitalization ? p.marketCapitalization * 1e6 : null,
  sharesOutstanding: p.shareOutstanding ? { value: p.shareOutstanding * 1e6, kind: 'shares outstanding (Finnhub profile, not free float)', asOf: null, source: 'Finnhub profile2' } : null,
} : null);
export async function finnhubProfile(symbol) {
  return parseFinnhubProfile(await get(`${FH}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${fhKey()}`, { provider: 'finnhub', ttlMs: 24 * 3_600_000 }));
}

export const parseFinnhubEarnings = (body) => (body?.earningsCalendar ?? []).map((e) => ({
  symbol: e.symbol, date: e.date, hour: e.hour, epsActual: e.epsActual ?? null, epsEstimate: e.epsEstimate ?? null,
  revenueActual: e.revenueActual ?? null, revenueEstimate: e.revenueEstimate ?? null, source: 'Finnhub earnings calendar',
}));
export async function finnhubEarnings(from, to) {
  return parseFinnhubEarnings(await get(`${FH}/calendar/earnings?from=${from}&to=${to}&token=${fhKey()}`, { provider: 'finnhub', ttlMs: 3_600_000 }));
}

// ---------- SEC EDGAR
const secHeaders = () => ({ 'User-Agent': process.env.SEC_USER_AGENT ?? '', 'Accept-Encoding': 'gzip, deflate' });

export const parseCikMap = (body) => Object.fromEntries(Object.values(body ?? {}).map((x) => [x.ticker, String(x.cik_str).padStart(10, '0')]));
export async function secCikMap() {
  return parseCikMap(await get('https://www.sec.gov/files/company_tickers.json', { provider: 'sec', headers: secHeaders(), ttlMs: 24 * 3_600_000 }));
}

/** Recent filings as catalyst candidates; acceptanceDateTime is the publication (first-knowable) time. */
export function parseSubmissions(body, symbol, { since = 0, seenAt = Date.now() } = {}) {
  const r = body?.filings?.recent;
  if (!r) return [];
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    const accepted = Date.parse(r.acceptanceDateTime[i]);
    if (!(accepted >= since)) continue;
    const acc = r.accessionNumber[i];
    out.push({
      id: `sec-${acc}`, formType: r.form[i], headline: `${r.form[i]} filed${r.items?.[i] ? ` (items ${r.items[i]})` : ''}`,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(body.cik)}/${acc.replace(/-/g, '')}/${r.primaryDocument[i]}`,
      source: 'SEC EDGAR', sourceKind: 'sec', symbols: [symbol], publishedAt: accepted, firstSeenAt: seenAt, provider: 'sec', items: r.items?.[i] ?? null,
    });
  }
  return out;
}
export async function secFilings(cik, symbol, since) {
  return parseSubmissions(await get(`https://data.sec.gov/submissions/CIK${cik}.json`, { provider: 'sec', headers: secHeaders(), ttlMs: 120_000 }), symbol, { since });
}

/** Latest dated dei:EntityCommonStockSharesOutstanding (shares outstanding, not free float). */
export function parseSharesOutstanding(body) {
  const rows = body?.units?.shares ?? [];
  if (!rows.length) return null;
  const last = [...rows].sort((a, b) => (a.end < b.end ? -1 : 1)).at(-1);
  return { value: last.val, asOf: last.end, filed: last.filed, form: last.form, kind: 'shares outstanding (SEC dei, not free float)', source: 'SEC companyconcept' };
}
export async function secSharesOutstanding(cik) {
  return parseSharesOutstanding(await get(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityCommonStockSharesOutstanding.json`, { provider: 'sec', headers: secHeaders(), ttlMs: 24 * 3_600_000 }));
}

// ---------- FINRA Reg SHO daily short-sale volume
export const finraUrl = (date) => `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${date.replace(/-/g, '')}.txt`;
/** FINRA publishes the file after the trading day; treat it as available from 18:00 ET that day (conservative). */
export function parseFinraShortVolume(text, date) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  lines.shift();
  const availableAt = etToUtc(date, '18:00:00');
  const out = {};
  for (const l of lines) {
    const [d, sym, sv, sev, tv, mkt] = l.split('|');
    if (!sym || !/^\d{8}$/.test(d)) continue;
    out[sym] = { date, shortVolume: Number(sv), shortExemptVolume: Number(sev), totalVolume: Number(tv), markets: mkt, shortShare: Number(tv) ? Number(sv) / Number(tv) : null, availableAt, note: 'FINRA-reported off-exchange/consolidated short-sale VOLUME; not short interest' };
  }
  return out;
}
export async function finraShortVolume(date) {
  return parseFinraShortVolume(await get(finraUrl(date), { provider: 'finra', as: 'text', ttlMs: 24 * 3_600_000 }), date);
}

// ---------- Alpha Vantage earnings calendar (CSV)
export function parseAvEarningsCsv(csv) {
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  const cols = head.split(',');
  return rows.map((r) => {
    const c = r.split(',');
    const o = Object.fromEntries(cols.map((k, i) => [k, c[i]]));
    return { symbol: o.symbol, name: o.name, reportDate: o.reportDate, fiscalDateEnding: o.fiscalDateEnding, epsEstimate: o.estimate === '' || o.estimate == null ? null : Number(o.estimate), currency: o.currency, source: 'Alpha Vantage EARNINGS_CALENDAR' };
  });
}
export async function avEarningsCalendar() {
  const key = process.env.ALPHAVANTAGE_API_KEY ?? '';
  return parseAvEarningsCsv(await get(`https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${key}`, { provider: 'alphaVantage', as: 'text', ttlMs: 20 * 3_600_000 }));
}

// ---------- Massive (formerly Polygon) aggregates — end-of-day on the free plan
const MASSIVE = process.env.MASSIVE_BASE_URL ?? 'https://api.massive.com';
export const parseMassiveAggs = (body) => (body?.results ?? []).map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, vw: r.vw ?? null, n: r.n ?? null, availableAt: null }));
export async function massiveMinuteAggs(symbol, from, to) {
  const key = process.env.MASSIVE_API_KEY ?? '';
  return parseMassiveAggs(await get(`${MASSIVE}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${from}/${to}?adjusted=false&sort=asc&limit=50000&apiKey=${key}`, { provider: 'massive', ttlMs: 24 * 3_600_000, priority: 9 }));
}

// ---------- FRED (daily observations, display only)
export const parseFred = (body) => (body?.observations ?? []).filter((o) => o.value !== '.').map((o) => ({ date: o.date, value: Number(o.value), realtimeStart: o.realtime_start }));
export async function fredSeries(id, start) {
  const key = process.env.FRED_API_KEY ?? '';
  return parseFred(await get(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&observation_start=${start}&api_key=${key}&file_type=json`, { provider: 'fred', ttlMs: 6 * 3_600_000 }));
}
