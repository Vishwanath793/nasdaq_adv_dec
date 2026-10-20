import React from 'react';
import { api, useApi, Loading, SortTable, usd, n2, both, signCls } from '../lib.jsx';

function Positions({ list, title, note }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      {note && <p className="small muted">{note}</p>}
      <SortTable rowKey={(p) => p.id} rows={list} empty="none"
        columns={[
          { key: 'symbol', label: 'Symbol', render: (p) => <b>{p.symbol}</b> },
          { key: 'side', label: 'Side', render: (p) => <span className={`chip ${p.direction > 0 ? 'long' : 'short'}`}>{p.side}</span> },
          { key: 'strategy', label: 'Strategy' },
          { key: 'entryQty', label: 'Qty', num: true },
          { key: 'avgEntry', label: 'Avg entry', num: true, render: (p) => n2(p.avgEntry, 4) },
          { key: 'entries', label: 'Entry fills', sortable: false, render: (p) => <span className="small mono">{p.entries.map((e, i) => <div key={i}>{e.qty} @ {n2(e.price, 4)} {both(e.at)}</div>)}</span> },
          { key: 'exits', label: 'Exits', sortable: false, render: (p) => <span className="small mono">{p.exits.map((e, i) => <div key={i}>{e.kind}: {e.qty} @ {n2(e.price, 4)} {both(e.at)}</div>)}</span> },
          { key: 'status', label: 'Status' },
          { key: 'costs', label: 'Costs', num: true, render: (p) => usd(p.costs) },
          { key: 'net', label: 'Net', num: true, render: (p) => <b className={signCls(p.net)}>{usd(p.net)}</b> },
        ]} />
    </div>
  );
}

export default function Paper({ sessionId, session, tick, status }) {
  const s = useApi(sessionId ? `/sessions/${sessionId}` : null, [tick]);
  const liveLedger = status?.live?.ledger;
  if (!sessionId) return null;
  return (
    <Loading state={s}>
      {s.data && (() => {
        const st = s.data.paper?.state;
        if (!st) return <div className="panel">No paper ledger for this session.</div>;
        const real = st.positions.filter((p) => !p.hypothetical);
        const hyp = st.positions.filter((p) => p.hypothetical);
        return (
          <>
            <div className="panel">
              <h2>Paper ledger · {st.date}</h2>
              <div className="row" style={{ gap: 24 }}>
                <div>Realised (after costs) <b className={signCls(st.realised)}>{usd(st.realised)}</b></div>
                <div>Costs <b>{usd(st.costs)}</b></div>
                <div>Trades {st.trades} · wins {st.wins} · losses {st.losses}</div>
                <div className="muted">Hypothetical shorts (not executable) {usd(st.hypotheticalRealised)}</div>
              </div>
              <p className="small muted">
                Fill model: orders active only from decision publication + latency; buys at the ask + slippage, sells at the bid − slippage, limited to the displayed size of each quote (never reused) and a participation cap of the minute&apos;s volume;
                stops exit at the touch and can fill worse than the stop; targets need a trade-through, a touch is not a fill. {s.data.paper.approxPrints ? 'This session had bars only, so trigger prints are approximated from each bar (order of high/low unknown).' : ''}
              </p>
              {session?.mode === 'LIVE' && liveLedger && (
                <div className="row">
                  <button onClick={() => api('/live/kill', { method: 'POST', body: { on: !liveLedger.killSwitch } })}>{liveLedger.killSwitch ? 'Release kill switch' : 'Kill switch'}</button>
                  <button onClick={() => api('/live/close-all', { method: 'POST' })}>Square off all (paper)</button>
                </div>
              )}
            </div>
            <Positions list={real} title="Paper positions (borrow-verified or long)" />
            <Positions list={hyp} title="Hypothetical shorts" note="Short signals without verified shortability/borrow. Tracked with the same fill model but never counted as paper entries or in risk limits." />
            <div className="panel">
              <h2>Orders</h2>
              <SortTable rowKey={(o) => o.id} rows={st.orders}
                columns={[
                  { key: 'id', label: 'Order id', render: (o) => <span className="mono small">{o.id}</span> },
                  { key: 'side', label: 'Side' }, { key: 'qty', label: 'Qty', num: true }, { key: 'filledQty', label: 'Filled', num: true },
                  { key: 'trigger', label: 'Trigger', num: true, render: (o) => n2(o.trigger, 4) }, { key: 'maxEntry', label: 'Max entry', num: true, render: (o) => n2(o.maxEntry, 4) },
                  { key: 'activeAt', label: 'Active from', render: (o) => <span className="small">{both(o.activeAt)}</span> },
                  { key: 'expiresAt', label: 'Expires', render: (o) => <span className="small">{both(o.expiresAt)}</span> },
                  { key: 'status', label: 'Status' }, { key: 'reason', label: 'Reason', wrap: true, render: (o) => <span className="small">{o.reason ?? ''}</span> },
                ]} />
            </div>
          </>
        );
      })()}
    </Loading>
  );
}
