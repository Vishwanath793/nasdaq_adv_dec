/**
 * Paper ledger, event-sourced and pure. state = events.reduce(applyEvent, emptyLedger(date)).
 *
 * Fill model (stepMarket):
 *  - An order is ACTIVE only from activeAt = decision publication + latency. Nothing
 *    fills on data stamped before that, so no fill can precede the decision.
 *  - Stop-entries trigger on an eligible trade print at/through the trigger; immediate
 *    entries trigger on the first quote after activeAt.
 *  - Triggered entries fill on QUOTES: buys at the ask + slippage, sells at the bid −
 *    slippage, only within maxEntry, and only up to the displayed size of that quote
 *    not already used by this ledger (displayed liquidity is not reused) and the
 *    participation cap of the minute's traded volume. The rest stays open (partial).
 *    A top-of-book feed says nothing about deeper liquidity, so nothing fills beyond it.
 *  - Stops are market exits once the bid (ask for shorts) reaches the stop: filled at
 *    the bid − slippage, which can be worse than the stop; quantity beyond the displayed
 *    size takes an extra slippage step per displayed lot (unknown depth, penalised).
 *  - Targets are resting limits: a touch is not a fill. They fill only when the bid
 *    trades through (bid > target for a long) or a print trades through the level.
 *  - Square-off / kill / close-all exit at the touch − slippage.
 * Hypothetical shorts (no verified borrow) run in the same model but are flagged and totalled separately.
 */

import { cleanRiskSettings, tradeCosts, DEFAULT_COSTS } from './risk.js';

export const emptyLedger = (date, ledger = 'day') => ({
  date, ledger, mode: 'PAPER', killSwitch: false, closingAll: null, decidedAt: null,
  orders: [], positions: [], realised: 0, hypotheticalRealised: 0, costs: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, events: 0,
  consumed: {}, minuteVolume: {},
});

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10_000) / 10_000;

function closePosition(state, p, at, costs) {
  const entrySide = p.direction > 0 ? 'BUY' : 'SELL';
  const exitSide = p.direction > 0 ? 'SELL' : 'BUY';
  const exitValue = p.exits.reduce((s, x) => s + x.qty * x.price, 0);
  const gross = p.direction * (exitValue - p.entryValue);
  const c = tradeCosts([...p.entries.map((e) => ({ side: entrySide, qty: e.qty, price: e.price })), ...p.exits.map((x) => ({ side: exitSide, qty: x.qty, price: x.price }))], costs);
  Object.assign(p, { status: 'CLOSED', closedAt: at, gross: r2(gross), costs: c.total, net: r2(gross - c.total) });
  if (p.hypothetical) { state.hypotheticalRealised = r2(state.hypotheticalRealised + p.net); return; }
  state.realised = r2(state.realised + p.net);
  state.costs = r2(state.costs + c.total);
  if (p.net < 0) { state.losses++; state.consecutiveLosses++; } else { state.wins++; state.consecutiveLosses = 0; }
}

export function applyEvent(state, e, costs = DEFAULT_COSTS) {
  state.events++;
  const order = e.orderId ? state.orders.find((o) => o.id === e.orderId) : null;
  const pos = e.positionId ? state.positions.find((p) => p.id === e.positionId) : null;
  switch (e.type) {
    case 'decided': if (!state.decidedAt) state.decidedAt = e.at; break;
    case 'order':
      if (!state.orders.some((o) => o.id === e.order.id)) state.orders.push({ ...e.order, status: 'PENDING', open: true, filledQty: 0, avgPrice: null, createdAt: e.at });
      break;
    case 'triggered': if (order?.open && order.status === 'PENDING') { order.status = 'TRIGGERED'; order.triggeredAt = e.at; } break;
    case 'fill': {
      if (!order?.open) break;
      const qty = Math.min(e.qty, order.qty - order.filledQty);
      if (qty <= 0) break;
      order.avgPrice = r4(((order.avgPrice ?? 0) * order.filledQty + e.price * qty) / (order.filledQty + qty));
      order.filledQty += qty;
      order.status = order.filledQty >= order.qty ? 'FILLED' : 'PARTIAL';
      if (order.filledQty >= order.qty) order.open = false;
      if (e.liquidityKey) state.consumed[e.liquidityKey] = (state.consumed[e.liquidityKey] ?? 0) + qty;
      if (e.minuteKey) state.minuteVolume[`used:${e.minuteKey}`] = (state.minuteVolume[`used:${e.minuteKey}`] ?? 0) + qty;
      let p = state.positions.find((x) => x.id === order.id);
      if (!p) {
        p = { id: order.id, symbol: order.symbol, side: order.side, direction: order.direction, strategy: order.strategy, hypothetical: Boolean(order.hypothetical),
          qty: 0, entryQty: 0, avgEntry: null, entryValue: 0, entries: [], stop: order.stop, target1: order.target1, target2: order.target2, firstExitQty: order.firstExitQty,
          t1Done: false, exits: [], status: 'OPEN', openedAt: e.at, sector: order.sector ?? null };
        state.positions.push(p);
        if (!p.hypothetical) state.trades++;
      }
      p.entries.push({ qty, price: e.price, at: e.at });
      p.entryValue = r4(p.entryValue + qty * e.price);
      p.entryQty += qty; p.qty += qty;
      p.avgEntry = r4(p.entryValue / p.entryQty);
      break;
    }
    case 'cancel':
      if (order?.open) { order.open = false; order.status = order.filledQty ? 'PARTIAL' : e.expired ? 'EXPIRED' : 'CANCELLED'; order.reason = e.reason; }
      break;
    case 'reject':
      if (order?.open) { order.open = false; order.status = order.filledQty ? 'PARTIAL' : 'REJECTED'; order.reason = e.reason; }
      break;
    case 'exit': {
      if (!pos || pos.status !== 'OPEN') break;
      const qty = Math.min(e.qty, pos.qty);
      if (qty <= 0) break;
      pos.exits.push({ qty, price: e.price, kind: e.kind, reason: e.reason, at: e.at });
      pos.qty -= qty;
      if (e.kind === 'target1') pos.t1Done = true;
      if (pos.qty === 0) closePosition(state, pos, e.at, costs);
      break;
    }
    case 'stop': if (pos?.status === 'OPEN') { pos.stop = e.stop; pos.stopReason = e.reason; } break;
    case 'kill': state.killSwitch = Boolean(e.on); state.closingAll = e.on ? (e.reason ?? 'kill switch') : null; break;
    case 'close-all': state.closingAll = e.reason ?? 'square off all'; break;
    default: break;
  }
  return state;
}

export const rebuildLedger = (date, events, ledger = 'day', costs = DEFAULT_COSTS) => events.reduce((s, e) => applyEvent(s, e, costs), emptyLedger(date, ledger));

/** Orders for PAPER ENTRY ELIGIBLE decisions (and, separately flagged, hypothetical shorts). Ids are per day/symbol/strategy. */
export function orderEvents(state, decisions, { publishedAt, latencyMs, expiresAt }) {
  const out = [];
  for (const d of decisions) {
    const hyp = d.hypotheticalShort;
    if (d.decision !== 'PAPER ENTRY ELIGIBLE' && !hyp) continue;
    const id = `${state.date}-${d.symbol}-${d.strategy}${hyp ? '-HYP' : ''}`;
    if (state.orders.some((o) => o.id === id)) continue;
    const p = d.plan;
    out.push({ type: 'order', at: publishedAt, order: {
      id, symbol: d.symbol, side: p.side, direction: p.direction, strategy: d.strategy, qty: p.qty, firstExitQty: p.firstExitQty,
      trigger: p.trigger, maxEntry: p.maxEntry, stop: p.stop, target1: p.target1, target2: p.target2, immediate: p.immediate,
      activeAt: publishedAt + latencyMs, expiresAt, hypothetical: Boolean(hyp), score: d.confirmScore, sector: d.sector ?? null,
    } });
  }
  return out;
}

/** Ledger events caused by one market event { kind:'quote'|'trade', symbol, t, bid, ask, bidSize, askSize (shares) | price, size }. */
export function stepMarket(state, m, risk, { squareOffAt = null, costs = DEFAULT_COSTS } = {}) {
  const s = cleanRiskSettings(risk);
  const slip = s.slippageBps / 10_000;
  const events = [];
  const emit = (e) => { const ev = { at: m.t, ...e }; events.push(ev); applyEvent(state, ev, costs); };
  const minuteKey = `${m.symbol}:${Math.floor(m.t / 60_000)}`;
  if (m.kind === 'trade') state.minuteVolume[minuteKey] = (state.minuteVolume[minuteKey] ?? 0) + m.size;

  for (const o of state.orders.filter((x) => x.open && x.symbol === m.symbol)) {
    if (m.t < o.activeAt) continue; // the order did not exist yet (decision + latency)
    if (state.killSwitch || state.closingAll) { emit({ type: 'cancel', orderId: o.id, reason: state.closingAll ?? 'kill switch' }); continue; }
    if (o.expiresAt && m.t >= o.expiresAt) { emit({ type: 'cancel', orderId: o.id, expired: true, reason: o.filledQty ? 'remainder not filled by the entry expiry' : 'not triggered by the entry expiry' }); continue; }
    const up = o.direction > 0;
    if (o.status === 'PENDING') {
      const crossed = o.immediate ? m.kind === 'quote' : m.kind === 'trade' && (up ? m.price >= o.trigger : m.price <= o.trigger);
      if (!crossed) continue;
      if (!o.hypothetical) {
        const hit = state.realised <= -(s.capital * s.dailyLossPct) / 100 ? 'daily loss limit reached' : state.consecutiveLosses >= s.maxConsecutiveLosses ? `${state.consecutiveLosses} losses in a row` : null;
        if (hit) { emit({ type: 'reject', orderId: o.id, reason: `${hit}: entry not taken` }); continue; }
      }
      emit({ type: 'triggered', orderId: o.id });
    }
    if (m.kind !== 'quote') continue;
    const px = up ? m.ask : m.bid;
    const size = up ? m.askSize : m.bidSize;
    if (!(px > 0) || !(size > 0)) continue;
    const price = r4(up ? px * (1 + slip) : px * (1 - slip));
    if (up ? price > o.maxEntry : price < o.maxEntry) continue; // beyond the limit: wait, like a stop-limit
    const liquidityKey = `${m.symbol}:${m.t}:${px}:${up ? 'A' : 'B'}`;
    const displayedLeft = size - (state.consumed[liquidityKey] ?? 0);
    const minuteTraded = state.minuteVolume[minuteKey] ?? 0;
    const capLeft = Math.floor(minuteTraded * s.participationCap) - (state.minuteVolume[`used:${minuteKey}`] ?? 0);
    // Before any print this minute there is no participation evidence; allow up to the displayed size of one quote.
    const cap = minuteTraded > 0 ? capLeft : displayedLeft;
    const qty = Math.min(o.qty - o.filledQty, displayedLeft, cap);
    if (qty > 0) emit({ type: 'fill', orderId: o.id, qty, price, liquidityKey, minuteKey, partialReason: qty < o.qty - o.filledQty ? 'limited by displayed size / participation cap' : null });
  }

  for (const p of state.positions.filter((x) => x.status === 'OPEN' && x.symbol === m.symbol)) {
    const up = p.direction > 0;
    const order = state.orders.find((o) => o.id === p.id);
    if (m.kind === 'quote') {
      const touch = up ? m.bid : m.ask;
      const touchSize = up ? m.bidSize : m.askSize;
      if (!(touch > 0)) continue;
      const exitPrice = (qty) => {
        const extraSteps = touchSize > 0 ? Math.max(0, Math.ceil(qty / touchSize) - 1) : 3;
        const k = slip * (1 + extraSteps);
        return r4(up ? touch * (1 - k) : touch * (1 + k));
      };
      const exitAll = (kind, reason) => {
        if (order?.open) emit({ type: 'cancel', orderId: order.id, reason: `position closed (${reason})` });
        emit({ type: 'exit', positionId: p.id, qty: p.qty, price: exitPrice(p.qty), kind, reason });
      };
      if (state.killSwitch || state.closingAll) { exitAll('close-all', state.closingAll ?? 'kill switch'); continue; }
      if (squareOffAt != null && m.t >= squareOffAt) { exitAll('squareoff', `square-off at ${s.squareOffAt} ET`); continue; }
      if (up ? touch <= p.stop : touch >= p.stop) { exitAll('stop', p.t1Done ? 'breakeven stop' : 'stop loss (filled at the touch, can be worse than the stop)'); continue; }
      const through = (lvl) => (up ? touch > lvl : touch < lvl);
      if (!p.t1Done && through(p.target1)) {
        const q = Math.min(p.qty, p.firstExitQty || Math.floor(p.qty / 2) || p.qty);
        emit({ type: 'exit', positionId: p.id, qty: q, price: p.target1, kind: 'target1', reason: 'target 1 (traded through)' });
        if (p.status === 'OPEN') emit({ type: 'stop', positionId: p.id, stop: p.avgEntry, reason: 'moved to entry after target 1' });
        continue;
      }
      if (p.t1Done && through(p.target2)) {
        if (order?.open) emit({ type: 'cancel', orderId: order.id, reason: 'position closed (target 2)' });
        emit({ type: 'exit', positionId: p.id, qty: p.qty, price: p.target2, kind: 'target2', reason: 'target 2 (traded through)' });
      }
    } else if (m.kind === 'trade') {
      // A print beyond a resting target fills it (trade-through), limited to the print size.
      const through = (lvl) => (up ? m.price > lvl : m.price < lvl);
      if (!p.t1Done && through(p.target1)) {
        const q = Math.min(p.qty, p.firstExitQty || Math.floor(p.qty / 2) || p.qty, m.size);
        emit({ type: 'exit', positionId: p.id, qty: q, price: p.target1, kind: 'target1', reason: 'target 1 (print traded through)' });
        if (p.status === 'OPEN' && p.t1Done) emit({ type: 'stop', positionId: p.id, stop: p.avgEntry, reason: 'moved to entry after target 1' });
      } else if (p.t1Done && through(p.target2)) {
        emit({ type: 'exit', positionId: p.id, qty: Math.min(p.qty, m.size), price: p.target2, kind: 'target2', reason: 'target 2 (print traded through)' });
      }
    }
  }
  return events;
}

export const ledgerDay = (state) => ({
  killSwitch: state.killSwitch, realised: state.realised, trades: state.trades, consecutiveLosses: state.consecutiveLosses,
  open: state.positions.filter((p) => p.status === 'OPEN' && !p.hypothetical).length,
  sectors: state.positions.filter((p) => p.status === 'OPEN' && !p.hypothetical && p.sector).reduce((a, p) => ({ ...a, [p.sector]: (a[p.sector] ?? 0) + 1 }), {}),
});

/** Unrealised P&L at the latest touch (never the last trade). */
export function markToMarket(state, lastQuotes) {
  let total = 0;
  const rows = state.positions.filter((p) => p.status === 'OPEN').map((p) => {
    const q = lastQuotes.get(p.symbol);
    const touch = q ? (p.direction > 0 ? q.bid : q.ask) : null;
    const pnl = touch ? r2(p.direction * (touch - p.avgEntry) * p.qty) : null;
    if (pnl != null && !p.hypothetical) total += pnl;
    return { id: p.id, mark: touch, unrealised: pnl, hypothetical: p.hypothetical };
  });
  return { total: r2(total), rows };
}
