/**
 * LIVE LIMITED-COVERAGE collector (Alpaca IEX, free). Builds the same "day" object the
 * DEMO session produces, so every decision runs through utils/pipeline.js unchanged.
 *
 * Plan for a trading day (ET):
 *  prepare  — verified calendar, Nasdaq universe, screen broadly with snapshots, pick a shortlist,
 *             backfill daily + 20 sessions of same-feed minute history, borrow flags, news/filings.
 *  collect  — stream the shortlist (≤30 symbols on Basic), REST-poll benchmarks every minute,
 *             record coverage (connect/disconnect, subscribe/unsubscribe) so gaps are explicit.
 *             The shortlist is frozen from 09:00 so rotation cannot open gaps near the open.
 *  decide   — immutable snapshots at 09:20 / 09:25 / 09:28 / final; seal at 09:35 + grace.
 *  paper    — orders become active at publication + latency; fills from live quotes/trades.
 *  close    — square-off, store the day input for replay, compute outcomes.
 * A snapshot whose time has already passed when the collector starts is marked MISSED,
 * never produced late from data that was not available at the time.
 */

import * as alpaca from './providers/alpaca.js';
import { fetchSymbolDirectory, eligibleUniverse, fetchHalts } from './providers/nasdaqTrader.js';
import * as enr from './providers/enrichment.js';
import { configured, redact } from './env.js';
import { appendNdjson, writeJson, writeImmutable, readJson } from './store.js';
import { saveDayInput, sessionId } from './sessions.js';
import { runSnapshot, runConfirmation, outcomesFor } from '../utils/pipeline.js';
import { emptyLedger, orderEvents, stepMarket, applyEvent } from '../utils/paperLedger.js';
import { cleanRiskSettings } from '../utils/risk.js';
import { sessionTimes, etParts, etToUtc, previousTradingDays, previousTradingDay, SNAPSHOT_KEYS, dayStatus, minuteOf } from '../utils/clock.js';

export const BENCHMARKS = ['QQQ', 'SPY', 'IWM', 'XLK', 'XLV', 'XLY', 'XLC', 'XLF', 'XLI', 'XLE', 'XLU', 'XLP', 'XLB', 'XLRE', 'SMH', 'XBI'];
const MIN = 60_000;

export function createLiveSession({ getConfig, onEvent = () => {} }) {
  const s = {
    status: 'idle', date: null, id: null, log: [], timers: [], stream: null, polls: [], day: null,
    shortlist: [], omitted: [], snapshots: {}, missed: [], confirm: null, ledger: null, lastQuotes: new Map(), frozen: false,
  };
  const note = (level, message, extra = {}) => {
    const e = { at: Date.now(), level, message: redact(message), ...extra };
    s.log.push(e); if (s.log.length > 500) s.log.shift();
    onEvent({ type: 'live-log', entry: e });
    if (s.id) appendNdjson(`sessions/${s.id}/live-log.ndjson`, e);
  };

  const inst = (sym) => s.day?.instruments[sym];
  const coverageOpen = new Map(); // symbol → from (ms) while observed by the stream

  function openCoverage(sym, at) { if (!coverageOpen.has(sym)) coverageOpen.set(sym, at); }
  function closeCoverage(sym, at) {
    const from = coverageOpen.get(sym);
    if (from == null) return;
    coverageOpen.delete(sym);
    inst(sym)?.today.coverage.push({ from, to: at, availableAt: at, source: 'stream' });
  }
  /** Coverage including still-open stream intervals, for a decision at `asOf`. */
  function coverageView() {
    const now = Date.now();
    for (const [sym, from] of coverageOpen) {
      const i = inst(sym);
      if (!i) continue;
      i.today.coverage = i.today.coverage.filter((c) => !c.live);
      i.today.coverage.push({ from, to: now, live: true, source: 'stream (open)' });
    }
  }

  async function buildInstrument(sym, meta, date, histDates, scope) {
    const prev = previousTradingDay(date);
    return {
      symbol: sym, instrumentId: `NASDAQ:${sym}`, meta, scope,
      prevClose: null, daily: [], history: [],
      today: { bars: [], tradeDetail: [], quotes: [], coverage: [] },
      news: [], newsChecked: false, halts: [], haltsChecked: false,
      noii: null, noiiReason: 'NOII requires a licensed feed (not available on free data)', corporateActions: [], float: null, borrow: null,
      prevDate: prev, histDates,
    };
  }

  async function prepare() {
    if (!configured().alpaca) { s.status = 'not configured'; note('warn', 'LIVE needs ALPACA_KEY_ID and ALPACA_SECRET_KEY (free paper account). DEMO and REPLAY still work.'); return false; }
    const cfg = getConfig();
    const now = Date.now();
    const date = etParts(now).date;
    s.date = date;
    s.id = sessionId(date, 'LIVE');
    s.status = 'preparing';
    note('info', `preparing ${date}`);
    let calendar = null;
    try { calendar = await alpaca.calendar(`${date.slice(0, 4)}-01-01`, `${date.slice(0, 4)}-12-31`); } catch (e) { note('warn', `calendar check failed, using fallback table: ${e.message}`); }
    const st = dayStatus(date, calendar);
    if (st !== 'open' && st !== 'early') { s.status = `market ${st}`; note('info', `no session today (${st})`); return false; }
    const times = sessionTimes(date, cfg.schedule, calendar);
    // Universe.
    let universe;
    try {
      const dir = await fetchSymbolDirectory();
      universe = eligibleUniverse(dir.rows, { includeAdrs: cfg.universe?.includeAdrs ?? true });
      writeJson(`universe/${date}.json`, { createdAt: dir.createdAt, fetchedAt: dir.fetchedAt, eligible: universe.eligible.length, etfs: universe.etfs.length, excluded: universe.excluded.length, symbols: universe.eligible.map((r) => [r.symbol, r.securityType, r.roundLot, r.financialStatus]) });
    } catch (e) { note('error', `symbol directory failed: ${e.message}`); s.status = 'failed'; return false; }
    // Screen broadly: snapshots for every eligible symbol (≈11 calls for ~5k symbols).
    const syms = universe.eligible.map((r) => r.symbol);
    const snap = await alpaca.snapshots(syms, { feed: 'iex' });
    const scored = [];
    for (const sym of syms) {
      const x = snap[sym];
      const pc = x?.prevDailyBar?.c; const last = x?.latestTrade?.p;
      if (!pc || !last || pc < (cfg.universe?.minPrice ?? 2)) continue;
      const dollarPrev = (x.prevDailyBar.v ?? 0) * pc;
      scored.push({ sym, gap: (last / pc - 1) * 100, dollarPrev, todayVol: x.dailyBar?.v ?? 0 });
    }
    // Rank by |gap| weighted by liquidity; the stream holds 30 symbols, benchmarks are polled by REST.
    scored.sort((a, b) => Math.abs(b.gap) * Math.log10(10 + b.dollarPrev) - Math.abs(a.gap) * Math.log10(10 + a.dollarPrev));
    const max = cfg.live?.maxCandidates ?? 30;
    s.shortlist = scored.slice(0, max).map((x) => x.sym);
    s.omitted = scored.slice(max).length;
    note('info', `screened ${scored.length} symbols; shortlist ${s.shortlist.length}; ${s.omitted} omitted (budget)`);
    const histDates = previousTradingDays(date, 20, calendar);
    const scope = alpaca.scopeFor('iex');
    const meta = new Map(universe.eligible.map((r) => [r.symbol, r]));
    s.day = { date, mode: 'LIVE', profile: 'LIMITED', calendar, dataLabel: 'LIVE LIMITED-COVERAGE — Alpaca IEX (single venue)', benchmarks: BENCHMARKS, universe: { name: 'Nasdaq-listed eligible (screened)', totalEligible: universe.eligible.length, tracked: s.shortlist, note: `${s.shortlist.length} streamed candidates of ${universe.eligible.length} eligible; breadth covers the tracked set only` }, instruments: {} };
    for (const sym of [...s.shortlist, ...BENCHMARKS]) {
      const m = meta.get(sym);
      s.day.instruments[sym] = await buildInstrument(sym, { name: m?.name ?? sym, securityType: BENCHMARKS.includes(sym) ? 'ETF' : m?.securityType, roundLot: m?.roundLot ?? 100, benchmark: BENCHMARKS.includes(sym), sector: null, sectorEtf: cfg.sectorMap?.[sym] ?? null }, date, histDates, scope);
    }
    // Backfill: daily bars, same-feed minute history, splits, borrow, prev close.
    const all = Object.keys(s.day.instruments);
    const dailyFrom = previousTradingDays(date, 260, calendar).at(-1);
    const daily = await alpaca.bars(all, { start: etToUtc(dailyFrom, '00:00:00'), end: etToUtc(date, '00:00:00'), timeframe: '1Day', feed: 'iex' });
    for (const sym of all) {
      const d = (daily[sym] ?? []).map((b) => ({ date: etParts(b.t + 12 * 3_600_000).date, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
      inst(sym).daily = d;
      // IEX daily bars are venue-only; the official consolidated close comes from the SIP daily bar (≥15 min old).
    }
    try {
      const sipDaily = await alpaca.bars(all, { start: etToUtc(previousTradingDay(date, calendar), '00:00:00'), end: etToUtc(date, '00:00:00'), timeframe: '1Day', feed: 'sip' });
      for (const sym of all) { const b = sipDaily[sym]?.at(-1); if (b) inst(sym).prevClose = { price: b.c, date: previousTradingDay(date, calendar), source: 'Alpaca SIP daily bar (consolidated close)' }; }
    } catch (e) { note('warn', `consolidated previous close unavailable: ${e.message}`); }
    for (const sym of all) if (!inst(sym).prevClose) { const last = inst(sym).daily.at(-1); if (last) inst(sym).prevClose = { price: last.c, date: last.date, source: 'IEX daily bar close (venue close, not the official close)', issue: 'previous close from a single venue: not the official consolidated close' }; }
    for (const hd of histDates) {
      const bars = await alpaca.bars(all, { start: etToUtc(hd, '04:00:00'), end: etToUtc(hd, '09:35:00'), feed: 'iex', priority: 6 });
      for (const sym of all) inst(sym).history.push({ date: hd, scope, bars: bars[sym] ?? [], coverage: [{ from: etToUtc(hd, '04:00:00'), to: etToUtc(hd, '09:35:00') }] });
    }
    try { const sp = await alpaca.splits(all, { start: histDates.at(-1), end: date }); for (const x of sp) inst(x.symbol)?.corporateActions.push(x); } catch (e) { note('warn', `splits unavailable (baselines refuse unknown splits): ${e.message}`); }
    for (const sym of s.shortlist) { try { inst(sym).borrow = await alpaca.asset(sym); } catch { /* stays unknown → hypothetical shorts */ } }
    // Today so far (REST backfill): known from the moment we fetched it.
    const fetchedAt = Date.now();
    const sofar = await alpaca.bars(all, { start: etToUtc(date, '04:00:00'), end: fetchedAt, feed: 'iex' });
    const lastComplete = minuteOf(fetchedAt);
    for (const sym of all) {
      inst(sym).today.bars.push(...(sofar[sym] ?? []).filter((b) => b.t < lastComplete).map((b) => ({ ...b, availableAt: fetchedAt })));
      inst(sym).today.coverage.push({ from: etToUtc(date, '04:00:00'), to: lastComplete, availableAt: fetchedAt, source: 'REST backfill' });
    }
    await refreshEnrichment();
    writeJson(`sessions/${s.id}/meta.json`, { id: s.id, date, mode: 'LIVE', profile: 'LIMITED', source: { kind: 'live', provider: 'alpaca', feed: 'iex' }, createdAt: Date.now(), config: cfg, dataLabel: s.day.dataLabel });
    s.times = times;
    s.status = 'collecting';
    startStream();
    startPolling();
    scheduleDecisions(times);
    return true;
  }

  async function refreshEnrichment() {
    const date = s.date;
    const since = s.times?.previousRegularClose ?? etToUtc(previousTradingDay(date), '16:00:00');
    const cfg = configured();
    try {
      const halts = await fetchHalts();
      for (const i of Object.values(s.day.instruments)) { i.halts = halts.filter((h) => h.symbol === i.symbol); i.haltsChecked = true; }
    } catch (e) { note('warn', `halts RSS failed: halt status UNKNOWN until the next poll (${e.message})`); for (const i of Object.values(s.day.instruments)) i.haltsChecked = false; }
    for (const sym of s.shortlist) {
      const i = inst(sym);
      const items = [];
      let checked = false;
      if (cfg.finnhub) { try { items.push(...await enr.finnhubNews(sym, previousTradingDay(date), date)); checked = true; } catch (e) { note('warn', `Finnhub news ${sym}: ${e.message}`); } }
      try { items.push(...await alpaca.news([sym], { start: since, end: Date.now() })); checked = true; } catch { /* news may not be included in the plan */ }
      if (cfg.sec) {
        try { s.cik ??= await enr.secCikMap(); const cik = s.cik[sym]; if (cik) { items.push(...await enr.secFilings(cik, sym, since)); if (!i.float) i.float = await enr.secSharesOutstanding(cik); checked = true; } } catch (e) { note('warn', `SEC ${sym}: ${e.message}`); }
      }
      // Keep the first-seen time of anything seen before.
      const seen = new Map(i.news.map((n) => [n.id, n.firstSeenAt]));
      i.news = items.map((n) => ({ ...n, firstSeenAt: seen.get(n.id) ?? n.firstSeenAt }));
      i.newsChecked = checked;
    }
  }

  function record(kind, sym, rec) { appendNdjson(`raw/${s.date}/alpaca-iex.ndjson`, { k: kind, s: sym, r: rec }); }

  function onStream(e) {
    const now = e.receivedAt;
    if (e.kind === 'connected') { note('info', 'stream connected'); for (const sym of s.stream?.symbols ?? []) openCoverage(sym, now); return; }
    if (e.kind === 'disconnected') { note('warn', 'stream disconnected: coverage gap opened (reconnecting)'); for (const sym of [...coverageOpen.keys()]) closeCoverage(sym, now); return; }
    if (e.kind === 'error') { note('error', `stream: ${e.message}`); return; }
    const i = inst(e.symbol);
    if (!i) return;
    if (e.kind === 'bar') { i.today.bars.push(e.record); record('b', e.symbol, e.record); }
    else if (e.kind === 'trade' || e.kind === 'correction' || e.kind === 'cancel') { i.today.tradeDetail.push(e.record); record('t', e.symbol, e.record); paperOn({ kind: 'trade', symbol: e.symbol, t: e.record.t, price: e.record.price, size: e.record.size }, e.kind); }
    else if (e.kind === 'quote') {
      // Keep one quote per symbol per second (the last), to bound memory and storage.
      const q = e.record;
      const prev = i.today.quotes.at(-1);
      if (prev && Math.floor(prev.t / 1000) === Math.floor(q.t / 1000)) i.today.quotes[i.today.quotes.length - 1] = q; else { i.today.quotes.push(q); if (prev) record('q', e.symbol, prev); }
      s.lastQuotes.set(e.symbol, q);
      const mult = q && i.scope.quoteSizeUnit === 'round_lots' ? (i.meta.roundLot ?? 100) : 1;
      paperOn({ kind: 'quote', symbol: e.symbol, t: q.t, bid: q.bid, ask: q.ask, bidSize: q.bidSize * mult, askSize: q.askSize * mult }, 'quote');
    } else if (e.kind === 'status') {
      record('s', e.symbol, e.record);
      const halted = /^(H|T|P|M)$/i.test(e.record.code ?? ''); // Alpaca status codes: H = halted, T = trading, … (verify codes)
      if (halted) i.halts.push({ haltAt: e.record.t, resumeAt: null, reason: e.record.reason ?? e.record.code, firstSeenAt: now, source: 'Alpaca status stream' });
    }
  }

  function startStream() {
    const syms = s.shortlist.slice(0, 30);
    s.stream = alpaca.stream({ feed: 'iex', symbols: syms, onEvent: onStream });
  }

  function startPolling() {
    // Benchmarks (and anything not streamed): REST minute bars once a minute, multi-symbol.
    const polled = BENCHMARKS.filter((b) => !(s.stream?.symbols ?? []).includes(b));
    let from = minuteOf(Date.now());
    const tick = async () => {
      const at = Date.now();
      const to = minuteOf(at);
      if (to <= from) return;
      try {
        const got = await alpaca.bars(polled, { start: from, end: to, feed: 'iex', priority: 2 });
        for (const sym of polled) {
          inst(sym)?.today.bars.push(...(got[sym] ?? []).map((b) => ({ ...b, availableAt: at })));
          inst(sym)?.today.coverage.push({ from, to, availableAt: at, source: 'REST poll' });
        }
        from = to;
      } catch (e) { note('warn', `benchmark poll failed (gap kept explicit): ${e.message}`); }
    };
    s.polls.push(setInterval(tick, 60_000));
    s.polls.push(setInterval(() => { refreshEnrichment().catch((e) => note('warn', e.message)); }, 5 * MIN));
  }

  function at(ms, fn) {
    const d = ms - Date.now();
    if (d < 0) return false;
    s.timers.push(setTimeout(fn, d));
    return true;
  }

  function scheduleDecisions(times) {
    const cfg = getConfig();
    at(etToUtc(s.date, '09:00:00'), () => { s.frozen = true; note('info', 'shortlist frozen for the open (no rotation gaps near 09:30)'); });
    for (const key of SNAPSHOT_KEYS) {
      if (!at(times[key], () => takeSnapshot(key))) { s.missed.push(key); note('warn', `${key} snapshot MISSED: the collector started after ${new Date(times[key]).toISOString()}`); }
    }
    if (!at(times.confirmPublish, () => seal())) note('warn', 'confirmation MISSED: started after the 09:35 seal');
    const risk = cleanRiskSettings(cfg.risk);
    at(etToUtc(s.date, `${risk.squareOffAt}:00`) + 1_000, () => { note('info', 'square-off time'); });
    at(times.regularClose + 5 * MIN, () => closeDay());
  }

  function takeSnapshot(key) {
    coverageView();
    const snap = runSnapshot(s.day, key, getConfig(), { publishedAt: Date.now() });
    const res = writeImmutable(`sessions/${s.id}/snapshots/${key}.json`, snap);
    s.snapshots[key] = snap;
    note('info', `${key} snapshot sealed (${snap.rows.length} rows)${res.written ? '' : ` — ${res.reason}`}`);
    onEvent({ type: 'snapshot', key, id: snap.id });
  }

  function seal() {
    coverageView();
    const pre = s.snapshots.final ?? s.snapshots.main ?? null;
    const cfg = getConfig();
    const confirm = runConfirmation(s.day, pre, cfg, { publishedAt: Date.now() });
    writeImmutable(`sessions/${s.id}/confirm.json`, confirm);
    s.confirm = confirm;
    const risk = cleanRiskSettings(cfg.risk);
    s.ledger = emptyLedger(s.date);
    const events = [{ type: 'decided', at: confirm.publishedAt }, ...orderEvents(s.ledger, confirm.rows, { publishedAt: confirm.publishedAt, latencyMs: risk.latencyMs, expiresAt: etToUtc(s.date, `${risk.entryUntil}:00`) })];
    for (const e of events) applyEvent(s.ledger, e);
    appendNdjson(`sessions/${s.id}/paper.ndjson`, events);
    note('info', `09:35 sealed: ${confirm.rows.filter((r) => r.decision === 'PAPER ENTRY ELIGIBLE').length} paper entries`);
    onEvent({ type: 'confirm', id: confirm.id });
    // Ordered symbols must stay streamed after the open.
    const need = [...new Set(s.ledger.orders.map((o) => o.symbol))];
    if (s.stream && need.some((x) => !s.stream.symbols.includes(x))) s.stream.setSymbols([...new Set([...need, ...s.stream.symbols])]);
  }

  function paperOn(m) {
    if (!s.ledger) return;
    const risk = cleanRiskSettings(getConfig().risk);
    const evs = stepMarket(s.ledger, m, risk, { squareOffAt: etToUtc(s.date, `${risk.squareOffAt}:00`) });
    if (evs.length) { appendNdjson(`sessions/${s.id}/paper.ndjson`, evs); writeJson(`sessions/${s.id}/paper.json`, { state: s.ledger }); onEvent({ type: 'paper', events: evs.length }); }
  }

  function closeDay() {
    coverageView();
    for (const sym of [...coverageOpen.keys()]) closeCoverage(sym, Date.now());
    saveDayInput(s.id, s.day);
    const outcomes = {};
    for (const k of Object.keys(s.snapshots)) outcomes[k] = outcomesFor(s.day, s.snapshots[k]);
    if (s.confirm) outcomes.confirm = outcomesFor(s.day, s.confirm);
    writeJson(`sessions/${s.id}/outcomes.json`, { computedAt: Date.now(), ...outcomes });
    stop();
    s.status = 'closed';
    note('info', 'day closed: input stored for replay, outcomes computed');
  }

  function stop() {
    s.timers.forEach(clearTimeout); s.timers = [];
    s.polls.forEach(clearInterval); s.polls = [];
    s.stream?.close(); s.stream = null;
  }

  return {
    prepare: () => prepare().catch((e) => { s.status = 'failed'; note('error', `prepare failed: ${e.message}`); return false; }),
    stop: () => { stop(); s.status = 'stopped'; },
    kill: (on = true) => { if (!s.ledger) return null; const e = { type: 'kill', on, at: Date.now(), reason: 'kill switch (user)' }; applyEvent(s.ledger, e); appendNdjson(`sessions/${s.id}/paper.ndjson`, [e]); return s.ledger; },
    closeAll: () => { if (!s.ledger) return null; const e = { type: 'close-all', at: Date.now(), reason: 'square off all (user)' }; applyEvent(s.ledger, e); appendNdjson(`sessions/${s.id}/paper.ndjson`, [e]); return s.ledger; },
    status: () => ({
      status: s.status, date: s.date, id: s.id, shortlist: s.shortlist, omitted: s.omitted, streamed: s.stream?.symbols ?? [], frozen: s.frozen,
      snapshots: Object.keys(s.snapshots), missed: s.missed, sealed: Boolean(s.confirm), log: s.log.slice(-60),
      coverage: s.day ? Object.fromEntries(Object.values(s.day.instruments).map((i) => [i.symbol, { intervals: i.today.coverage.length, bars: i.today.bars.length, quotes: i.today.quotes.length, open: coverageOpen.has(i.symbol) }])) : {},
      ledger: s.ledger ? { realised: s.ledger.realised, positions: s.ledger.positions.length, orders: s.ledger.orders.length, killSwitch: s.ledger.killSwitch } : null,
    }),
    get day() { return s.day; },
    get id() { return s.id; },
  };
}
