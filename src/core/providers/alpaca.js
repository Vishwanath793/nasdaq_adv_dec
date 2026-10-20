/**
 * Alpaca Market Data (free "Basic" plan) — documented at docs.alpaca.markets.
 *  - Real-time: IEX venue only (limited venue coverage; IEX volume is NOT total US volume).
 *  - Historical: since 2016; on Basic the latest 15 minutes of SIP data are not available.
 *    feed=iex history is used for same-scope RVOL baselines; feed=sip history (≥15 min old)
 *    is a separate DELAYED CONSOLIDATED RESEARCH scope and is never mixed with IEX.
 *  - Limits on Basic: 200 historical calls/min, 30 WebSocket symbols.
 * The trading API (paper account) supplies the calendar and asset shortability.
 *
 * Quote sizes: Alpaca has historically reported quote sizes in round lots. The unit is
 * configurable (ALPACA_QUOTE_SIZE_UNIT = round_lots | shares) and `npm run probe` reports
 * what the configured account returns. Treat it as unverified until probed.
 */

import { get } from '../http.js';
import { CONDITION_POLICY } from '../../utils/series.js';

export const DATA_URL = 'https://data.alpaca.markets';
export const TRADING_URL = process.env.ALPACA_TRADING_URL ?? 'https://paper-api.alpaca.markets';
export const STREAM_URL = (feed) => `wss://stream.data.alpaca.markets/v2/${feed}`;

const headers = () => ({ 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID ?? '', 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '' });
export const quoteSizeUnit = () => (process.env.ALPACA_QUOTE_SIZE_UNIT === 'shares' ? 'shares' : 'round_lots');

export const scopeFor = (feed) => ({
  provider: 'alpaca', feed, conditionPolicy: CONDITION_POLICY.version, adjustment: 'raw', quoteSizeUnit: quoteSizeUnit(),
  venueStart: '04:00:00',
  label: feed === 'iex' ? 'Alpaca IEX (single venue, real-time)' : 'Alpaca SIP history (consolidated, ≥15 min old on Basic)',
  ...(feed === 'sip' ? { delayMs: 15 * 60_000 } : {}),
});

const ms = (iso) => Date.parse(iso);

export const parseBar = (b, receivedAt = null) => ({ t: ms(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: b.n ?? null, vw: b.vw ?? null, availableAt: receivedAt ?? ms(b.t) + 60_000 });
export const parseTrade = (x, receivedAt = null) => ({ id: `${x.x}:${x.i}`, t: ms(x.t), price: x.p, size: x.s, exchange: x.x, conditions: x.c ?? [], tape: x.z, availableAt: receivedAt ?? ms(x.t) });
export const parseQuote = (q, receivedAt = null) => ({ t: ms(q.t), bid: q.bp, ask: q.ap, bidSize: q.bs, askSize: q.as, bidExchange: q.bx, askExchange: q.ax, conditions: q.c ?? [], availableAt: receivedAt ?? ms(q.t) });

/** Page through a multi-symbol historical endpoint: kind = 'bars' | 'trades' | 'quotes'. */
async function paged(kind, params, { priority = 5 } = {}) {
  const out = {};
  let token = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ ...params, limit: '10000', ...(token ? { page_token: token } : {}) });
    const body = await get(`${DATA_URL}/v2/stocks/${kind}?${qs}`, { provider: 'alpaca', headers: headers(), priority });
    for (const [sym, rows] of Object.entries(body[kind] ?? {})) (out[sym] ??= []).push(...rows);
    token = body.next_page_token;
    pages++;
  } while (token && pages < 200);
  return out;
}

export async function bars(symbols, { start, end, timeframe = '1Min', feed = 'iex', adjustment = 'raw', priority } = {}) {
  const raw = await paged('bars', { symbols: symbols.join(','), timeframe, start: new Date(start).toISOString(), end: new Date(end).toISOString(), feed, adjustment }, { priority });
  return Object.fromEntries(Object.entries(raw).map(([s, rows]) => [s, rows.map((b) => parseBar(b))]));
}

export async function trades(symbols, { start, end, feed = 'iex', priority } = {}) {
  const raw = await paged('trades', { symbols: symbols.join(','), start: new Date(start).toISOString(), end: new Date(end).toISOString(), feed }, { priority });
  return Object.fromEntries(Object.entries(raw).map(([s, rows]) => [s, rows.map((x) => parseTrade(x))]));
}

export async function quotes(symbols, { start, end, feed = 'iex', priority } = {}) {
  const raw = await paged('quotes', { symbols: symbols.join(','), start: new Date(start).toISOString(), end: new Date(end).toISOString(), feed }, { priority });
  return Object.fromEntries(Object.entries(raw).map(([s, rows]) => [s, rows.map((q) => parseQuote(q))]));
}

/** Snapshots for screening: latest trade/quote, minute bar, daily bar, previous daily bar. */
export async function snapshots(symbols, { feed = 'iex', priority = 3 } = {}) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 500) {
    const qs = new URLSearchParams({ symbols: symbols.slice(i, i + 500).join(','), feed });
    Object.assign(out, await get(`${DATA_URL}/v2/stocks/snapshots?${qs}`, { provider: 'alpaca', headers: headers(), priority, ttlMs: 20_000 }));
  }
  return out;
}

/** Splits for adjustment checks (Alpaca corporate actions API). */
export async function splits(symbols, { start, end } = {}) {
  const qs = new URLSearchParams({ symbols: symbols.join(','), types: 'forward_split,reverse_split', start, end });
  const body = await get(`${DATA_URL}/v1/corporate-actions?${qs}`, { provider: 'alpaca', headers: headers(), ttlMs: 6 * 3_600_000 });
  const ca = body.corporate_actions ?? {};
  return [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])].map((x) => ({ symbol: x.symbol, type: 'split', exDate: x.ex_date, ratio: x.new_rate && x.old_rate ? x.new_rate / x.old_rate : null, source: 'Alpaca corporate actions' }));
}

export async function news(symbols, { start, end, limit = 50 } = {}) {
  const qs = new URLSearchParams({ symbols: symbols.join(','), start: new Date(start).toISOString(), end: new Date(end).toISOString(), limit: String(limit), sort: 'desc' });
  const body = await get(`${DATA_URL}/v1beta1/news?${qs}`, { provider: 'alpaca', headers: headers(), ttlMs: 60_000 });
  const seen = Date.now();
  return (body.news ?? []).map((n) => ({ id: `alpaca-${n.id}`, headline: n.headline, summary: n.summary, url: n.url, source: n.source ?? 'Alpaca news', sourceKind: 'news', symbols: n.symbols, publishedAt: ms(n.created_at), updatedAt: ms(n.updated_at), firstSeenAt: seen, provider: 'alpaca' }));
}

/** Exchange calendar from the trading API: { from, to, days: { date: { open, close } } }. */
export async function calendar(from, to) {
  const body = await get(`${TRADING_URL}/v2/calendar?start=${from}&end=${to}`, { provider: 'alpaca', headers: headers(), ttlMs: 24 * 3_600_000 });
  return { from, to, days: Object.fromEntries(body.map((d) => [d.date, { open: d.open, close: d.close }])), source: 'Alpaca /v2/calendar' };
}

export async function asset(symbol) {
  const a = await get(`${TRADING_URL}/v2/assets/${encodeURIComponent(symbol)}`, { provider: 'alpaca', headers: headers(), ttlMs: 3_600_000 });
  return { symbol: a.symbol, exchange: a.exchange, tradable: a.tradable, shortable: a.shortable, easyToBorrow: a.easy_to_borrow, fractionable: a.fractionable, status: a.status, asOf: new Date().toISOString().slice(0, 10), source: 'Alpaca assets (broker flags, not a borrow-fee quote)' };
}

/**
 * Stream client. onEvent receives normalised records:
 * { kind: 'trade'|'quote'|'bar'|'correction'|'cancel'|'status'|'luld'|'connected'|'disconnected'|'error', symbol, record, receivedAt }
 * Reconnects with backoff; every disconnect is reported so the caller can record a coverage gap.
 */
export function stream({ feed = 'iex', symbols = [], onEvent, WebSocketImpl = globalThis.WebSocket }) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let subscribed = new Set(symbols);
  const emit = (e) => { try { onEvent({ receivedAt: Date.now(), ...e }); } catch { /* consumer errors never kill the stream */ } };
  const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
  const subMsg = (action, syms) => ({ action, trades: syms, quotes: syms, bars: syms, updatedBars: syms, statuses: syms, lulds: syms });
  const connect = () => {
    ws = new WebSocketImpl(STREAM_URL(feed));
    ws.onopen = () => send({ action: 'auth', key: process.env.ALPACA_KEY_ID, secret: process.env.ALPACA_SECRET_KEY });
    ws.onmessage = (m) => {
      const receivedAt = Date.now();
      let arr;
      try { arr = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')); } catch { return; }
      for (const x of arr) {
        if (x.T === 'success' && x.msg === 'authenticated') { attempt = 0; emit({ kind: 'connected' }); if (subscribed.size) send(subMsg('subscribe', [...subscribed])); }
        else if (x.T === 'error') emit({ kind: 'error', message: `${x.code}: ${x.msg}` });
        else if (x.T === 't') emit({ kind: 'trade', symbol: x.S, record: parseTrade(x, receivedAt), receivedAt });
        else if (x.T === 'q') emit({ kind: 'quote', symbol: x.S, record: parseQuote(x, receivedAt), receivedAt });
        else if (x.T === 'b' || x.T === 'u') emit({ kind: 'bar', symbol: x.S, record: parseBar(x, receivedAt), updated: x.T === 'u', receivedAt });
        else if (x.T === 'c') emit({ kind: 'correction', symbol: x.S, record: { id: `${x.x}:corr:${x.ci}`, t: ms(x.t), price: x.cp, size: x.cs, conditions: x.cc ?? [], correction: { type: 'correct', of: `${x.x}:${x.oi}` }, availableAt: receivedAt }, receivedAt });
        else if (x.T === 'x') emit({ kind: 'cancel', symbol: x.S, record: { id: `${x.x}:cxl:${x.i}`, t: ms(x.t), correction: { type: 'cancel', of: `${x.x}:${x.i}` }, availableAt: receivedAt }, receivedAt });
        else if (x.T === 's') emit({ kind: 'status', symbol: x.S, record: { t: ms(x.t), code: x.sc, message: x.sm, reasonCode: x.rc, reason: x.rm, availableAt: receivedAt }, receivedAt });
        else if (x.T === 'l') emit({ kind: 'luld', symbol: x.S, record: { t: ms(x.t), up: x.u, down: x.d, indicator: x.i, availableAt: receivedAt }, receivedAt });
      }
    };
    ws.onclose = () => {
      emit({ kind: 'disconnected' });
      if (closed) return;
      attempt++;
      setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5) + Math.random() * 500));
    };
    ws.onerror = () => emit({ kind: 'error', message: 'websocket error' });
  };
  connect();
  return {
    setSymbols(next) {
      const n = new Set(next.slice(0, 30)); // Basic plan: 30 symbols
      const add = [...n].filter((s) => !subscribed.has(s));
      const remove = [...subscribed].filter((s) => !n.has(s));
      if (remove.length) send(subMsg('unsubscribe', remove));
      if (add.length) send(subMsg('subscribe', add));
      subscribed = n;
      return { added: add, removed: remove };
    },
    close() { closed = true; ws?.close(); },
    get symbols() { return [...subscribed]; },
  };
}
