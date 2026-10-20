import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSymbolDirectory, eligibleUniverse, parseHalts } from '../src/core/providers/nasdaqTrader.js';
import { parseFinraShortVolume, parseSubmissions, parseSharesOutstanding, parseFinnhubNews, parseFinnhubProfile, parseAvEarningsCsv, parseMassiveAggs } from '../src/core/providers/enrichment.js';
import { parseTrade, parseQuote, parseBar, scopeFor } from '../src/core/providers/alpaca.js';
import { redact } from '../src/core/env.js';
import { get, budgetStatus } from '../src/core/http.js';

const fx = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('Nasdaq symbol directory: types, test issues, ETFs and ADR toggle', () => {
  const d = parseSymbolDirectory(fx('nasdaqlisted.txt'));
  assert.equal(new Date(d.createdAt).toISOString(), '2026-10-20T01:31:00.000Z'); // 21:31 ET (EDT)
  const t = Object.fromEntries(d.rows.map((r) => [r.symbol, r.securityType]));
  assert.equal(t.AAAP, 'ETF');
  assert.equal(t.AACG, 'ADR');
  assert.equal(t.AACIU, 'Unit');
  assert.equal(t.AACIW, 'Warrant');
  assert.equal(t.AACI, 'Common Stock');
  assert.equal(t.ZYME, 'Common Stock');
  assert.equal(t.XYZP, 'Preferred');
  const u = eligibleUniverse(d.rows, { includeAdrs: false });
  assert.deepEqual(u.eligible.map((r) => r.symbol).sort(), ['AACI', 'ZYME']);
  assert.ok(u.excluded.some((r) => r.symbol === 'ZAZZT' && r.why === 'test issue'));
  assert.equal(u.etfs.length, 1);
  assert.ok(eligibleUniverse(d.rows, { includeAdrs: true }).eligible.some((r) => r.symbol === 'AACG'));
});

test('Nasdaq halts RSS: ET wall-clock times converted to UTC; first-seen recorded', () => {
  const h = parseHalts(fx('halts.xml'), 123);
  assert.ok(h.length >= 1);
  assert.ok(h[0].symbol && h[0].reason);
  assert.equal(typeof h[0].haltAt, 'number');
  assert.equal(h[0].firstSeenAt, 123);
});

test('FINRA short-sale volume: availability after publication, labelled as volume not short interest', () => {
  const r = parseFinraShortVolume(fx('finra.txt'), '2026-10-19');
  assert.equal(Object.keys(r).length, 3);
  assert.ok(r.A.shortShare > 0.5 && r.A.shortShare < 0.55);
  assert.equal(new Date(r.A.availableAt).toISOString(), '2026-10-19T22:00:00.000Z');
  assert.match(r.A.note, /not short interest/);
});

test('SEC submissions: acceptance time is the publication time; shares outstanding is labelled (not float)', () => {
  const body = { cik: '320193', filings: { recent: { accessionNumber: ['0000320193-26-000001', '0000320193-25-000009'], acceptanceDateTime: ['2026-10-19T16:05:12.000Z', '2025-01-02T12:00:00.000Z'], form: ['8-K', '10-Q'], primaryDocument: ['a.htm', 'b.htm'], items: ['2.02', ''] } } };
  const f = parseSubmissions(body, 'AAPL', { since: Date.parse('2026-10-01'), seenAt: 5 });
  assert.equal(f.length, 1);
  assert.equal(f[0].formType, '8-K');
  assert.equal(f[0].publishedAt, Date.parse('2026-10-19T16:05:12.000Z'));
  assert.match(f[0].url, /edgar\/data\/320193\/000032019326000001\/a\.htm/);
  const so = parseSharesOutstanding({ units: { shares: [{ end: '2026-06-30', val: 100, filed: '2026-07-30', form: '10-Q' }, { end: '2026-09-30', val: 99, filed: '2026-10-30', form: '10-Q' }] } });
  assert.equal(so.value, 99);
  assert.match(so.kind, /not free float/);
});

test('Alpaca record parsing keeps provider ids, conditions and receive times', () => {
  const t = parseTrade({ t: '2026-10-19T13:30:00.123456789Z', x: 'V', p: 10.5, s: 100, c: ['@', 'T'], i: 42, z: 'C' }, 999);
  assert.equal(t.id, 'V:42');
  assert.deepEqual(t.conditions, ['@', 'T']);
  assert.equal(t.availableAt, 999);
  const q = parseQuote({ t: '2026-10-19T13:30:00Z', bp: 10, ap: 10.02, bs: 3, as: 4, bx: 'V', ax: 'V' });
  assert.equal(q.askSize, 4);
  const b = parseBar({ t: '2026-10-19T13:30:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 1000, n: 10, vw: 1.2 });
  assert.equal(b.availableAt, Date.parse('2026-10-19T13:31:00Z')); // a REST bar is complete at minute end
  assert.equal(scopeFor('iex').feed, 'iex');
  assert.equal(scopeFor('sip').delayMs, 15 * 60_000);
});

test('enrichment parsers: Finnhub news/profile, Alpha Vantage CSV, Massive aggregates', () => {
  const n = parseFinnhubNews([{ id: 7, datetime: 1_792_400_000, headline: 'h', source: 's', url: 'u', summary: '', category: 'company' }], 'X', 1);
  assert.equal(n[0].publishedAt, 1_792_400_000_000);
  const p = parseFinnhubProfile({ ticker: 'X', name: 'X Inc', shareOutstanding: 12.5, marketCapitalization: 1000 });
  assert.equal(p.sharesOutstanding.value, 12_500_000);
  assert.match(p.sharesOutstanding.kind, /not free float/);
  const av = parseAvEarningsCsv('symbol,name,reportDate,fiscalDateEnding,estimate,currency\nX,X Inc,2026-10-20,2026-09-30,1.23,USD\nY,Y Inc,2026-10-21,2026-09-30,,USD');
  assert.equal(av[0].epsEstimate, 1.23);
  assert.equal(av[1].epsEstimate, null);
  assert.equal(parseMassiveAggs({ results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 5 }] })[0].v, 5);
});

test('secrets are redacted from any message', () => {
  process.env.FINNHUB_API_KEY = 'abcdef123456';
  assert.equal(redact('GET /x?token=abcdef123456 failed'), 'GET /x?token=[redacted] failed');
  assert.equal(redact('key abcdef123456 here'), 'key [FINNHUB_API_KEY] here');
});

test('HTTP client: 429 Retry-After backoff, in-flight de-duplication and TTL cache', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) return { status: 429, ok: false, headers: { get: () => '0.05' }, text: async () => '' };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ v: calls }) };
  };
  const [a, b] = await Promise.all([
    get('https://example.invalid/x', { provider: 'fred', ttlMs: 60_000, fetchImpl: fake }),
    get('https://example.invalid/x', { provider: 'fred', ttlMs: 60_000, fetchImpl: fake }),
  ]);
  assert.deepEqual(a, { v: 2 });
  assert.equal(a, b); // one request in flight served both callers
  const c = await get('https://example.invalid/x', { provider: 'fred', ttlMs: 60_000, fetchImpl: fake });
  assert.equal(c, a); // cached
  assert.equal(calls, 2);
  assert.ok(budgetStatus().fred.usedToday >= 2);
});
