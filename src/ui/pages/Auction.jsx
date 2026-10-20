import React from 'react';
import { useApi, Loading, SortTable, n2, both, et } from '../lib.jsx';

export function NoiiChart({ noii, times }) {
  if (!noii?.length) return <p className="muted">No NOII messages for this symbol.</p>;
  const W = 640; const H = 180; const pad = 36;
  const t0 = noii[0].t; const t1 = noii.at(-1).t;
  const maxImb = Math.max(...noii.map((m) => m.imbalance), 1);
  const maxPaired = Math.max(...noii.map((m) => m.paired), 1);
  const x = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad * 2);
  const yI = (v) => H / 2 - (v / maxImb) * (H / 2 - 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }}>
      <line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} stroke="var(--line)" />
      {times?.main && times.main >= t0 && <><line x1={x(times.main)} x2={x(times.main)} y1={6} y2={H - 6} stroke="var(--warn)" strokeDasharray="3 3" /><text x={x(times.main) + 3} y={14}>09:28 near/far start</text></>}
      {noii.map((m, i) => {
        const sgn = m.side === 'B' ? 1 : m.side === 'S' ? -1 : 0;
        return <rect key={i} x={x(m.t) - 2} width={4} y={sgn > 0 ? yI(m.imbalance) : H / 2} height={Math.abs(yI(m.imbalance) - H / 2)} fill={sgn > 0 ? 'var(--long)' : 'var(--short)'} opacity={0.8} />;
      })}
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.5" points={noii.map((m) => `${x(m.t)},${H - 8 - (m.paired / maxPaired) * (H / 2 - 16)}`).join(' ')} />
      <text x={pad} y={H - 2}>{et(t0)}</text><text x={W - pad - 60} y={H - 2}>{et(t1)}</text>
      <text x={2} y={14}>imb</text>
    </svg>
  );
}

export default function Auction({ sessionId, go, tick }) {
  const s = useApi(sessionId ? `/sessions/${sessionId}` : null, [tick]);
  if (!sessionId) return null;
  return (
    <Loading state={s}>
      {s.data && (() => {
        const stages = ['earlyAuction', 'main', 'final'].map((k) => [k, s.data.snapshots[k]]).filter(([, v]) => v);
        const syms = new Map();
        for (const [k, snap] of stages) for (const r of snap.rows) { if (!syms.has(r.symbol)) syms.set(r.symbol, { symbol: r.symbol, name: r.name }); syms.get(r.symbol)[k] = r.auction; syms.get(r.symbol).gapPct = r.gapPct; }
        const rows = [...syms.values()].filter((r) => stages.some(([k]) => r[k]));
        const cell = (a) => (a ? <span className={a.side > 0 ? 'pos' : a.side < 0 ? 'neg' : ''}>{a.side > 0 ? 'BUY' : a.side < 0 ? 'SELL' : 'none'} {n2(a.imbalanceToPaired)} · {Math.round((a.persistence ?? 0) * 100)}%{a.nearFarAvailable ? '' : ' · no near/far'}</span> : <span className="muted">—</span>);
        return (
          <>
            <div className={`banner ${s.data.mode === 'DEMO' ? 'demo' : 'warn'}`}>
              {s.data.mode === 'DEMO'
                ? 'Simulated NOII (DEMO). Real Nasdaq NOII needs a licensed feed (TotalView-ITCH or a vendor such as Databento); the free profiles mark every auction factor UNAVAILABLE and never derive it from quote sizes.'
                : 'NOII is not available on the configured free data. Auction factors are marked unavailable; the analyzer continues with the documented non-auction profile.'}
            </div>
            <div className="panel">
              <h2>Auction evolution: 09:25 early → 09:28 full → final</h2>
              <p className="small muted">Early NOII (from about 09:25 ET) carries placeholder near/far prices, which are shown as unavailable, not $0. Values: side, imbalance ÷ paired shares, share of messages on the current side. Paired + imbalance shares are not the full auction curve. The realised cross is never used in earlier snapshots.</p>
              <SortTable rowKey={(r) => r.symbol} onRow={(r) => go({ tab: 'stock', symbol: r.symbol })} empty="No symbol has NOII data in this session."
                columns={[
                  { key: 'symbol', label: 'Symbol', render: (r) => <b>{r.symbol}</b> },
                  { key: 'gapPct', label: 'Pre-market gap', num: true, render: (r) => `${n2(r.gapPct)}%` },
                  ...stages.map(([k, snap]) => ({ key: k, label: `${snap.label} (${et(snap.asOf)})`, sortable: false, render: (r) => cell(r[k]) })),
                ]} rows={rows} />
            </div>
            {rows[0] && <AuctionDetail sessionId={sessionId} symbol={rows[0].symbol} rows={rows} />}
          </>
        );
      })()}
    </Loading>
  );
}

function AuctionDetail({ sessionId, rows }) {
  const [sym, setSym] = React.useState(rows[0].symbol);
  const d = useApi(`/sessions/${sessionId}/stock/${sym}?snapshot=final`);
  return (
    <div className="panel">
      <div className="row"><h2 style={{ margin: 0 }}>NOII timeline</h2><select value={sym} onChange={(e) => setSym(e.target.value)}>{rows.map((r) => <option key={r.symbol}>{r.symbol}</option>)}</select></div>
      <div className="legend"><span><i style={{ background: 'var(--long)' }} />buy imbalance</span><span><i style={{ background: 'var(--short)' }} />sell imbalance</span><span><i style={{ background: 'var(--accent)' }} />paired shares</span></div>
      <Loading state={d}>{d.data && <NoiiChart noii={d.data.chart?.noii} times={d.data.chart?.times} />}</Loading>
      {d.data?.chart?.noii?.length > 0 && <p className="small muted">{d.data.chart.noii.length} messages · last at {both(d.data.chart.noii.at(-1).t)}</p>}
    </div>
  );
}
