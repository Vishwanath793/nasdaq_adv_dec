import React, { useState } from 'react';
import { useApi, Loading, SortTable, OutcomeChip, pct, n2, both, signCls } from '../lib.jsx';

const DECISIONS = ['all', 'PAPER ENTRY ELIGIBLE', 'LONG CANDIDATE', 'SHORT CANDIDATE', 'WATCH', 'NO TRADE'];

export default function Confirm({ sessionId, go, tick }) {
  const s = useApi(sessionId ? `/sessions/${sessionId}` : null, [tick]);
  const [filter, setFilter] = useState('all');
  if (!sessionId) return null;
  return (
    <Loading state={s}>
      {s.data && (() => {
        const c = s.data.confirm;
        if (!c) return <div className="panel">No sealed 09:35 decision in this session yet.</div>;
        const rows = c.rows.filter((r) => filter === 'all' || r.decision === filter);
        return (
          <>
            <div className="panel">
              <h2>09:35 sealed confirmation</h2>
              <p className="small muted" style={{ margin: 0 }}>
                Window [{both(c.windowFrom)}, {both(c.windowTo)}) · sealed at {both(c.sealAt)} (grace {Math.round(c.graceMs / 1000)} s) · published {both(c.publishedAt)}.
                Records arriving after the seal are ignored for this decision. Default is NO TRADE; continuation strategies must agree with the pre-market evidence, and gap failure is a separate reversal strategy.
                Paper orders become active only after publication + latency.
              </p>
            </div>
            <div className="panel">
              <div className="row" style={{ marginBottom: 8 }}>
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>{DECISIONS.map((d) => <option key={d}>{d}</option>)}</select>
                <span className="small muted">{rows.length} of {c.rows.length}</span>
              </div>
              <SortTable rows={rows} onRow={(r) => go({ tab: 'stock', symbol: r.symbol })}
                columns={[
                  { key: 'symbol', label: 'Symbol', render: (r) => <b>{r.symbol}</b> },
                  { key: 'decision', label: 'Decision', render: (r) => <span><OutcomeChip outcome={r.decision} />{r.hypotheticalShort && <div className="small muted">hypothetical (no borrow)</div>}</span> },
                  { key: 'preOutcome', label: 'Pre-open', render: (r) => <span className="small">{r.preOutcome ?? '—'}<div className="muted">L {r.preLongScore ?? '—'} / S {r.preShortScore ?? '—'}</div></span> },
                  { key: 'strategyLabel', label: 'Strategy', render: (r) => <span className="small">{r.strategyLabel ?? '—'}{r.strategyKind ? <div className="muted">{r.strategyKind}</div> : null}</span> },
                  { key: 'direction', label: 'Side', render: (r) => <span className={`chip ${r.direction > 0 ? 'long' : 'short'}`}>{r.direction > 0 ? 'LONG' : 'SHORT'}</span> },
                  { key: 'confirmScore', label: 'Confirm', num: true, render: (r) => <span>{r.confirmScore ?? '—'}<div className="small muted">{r.confirmVerdict}</div></span> },
                  { key: 'ret', label: 'Open→09:35', num: true, sortValue: (r) => r.window?.ret5Pct, render: (r) => <span className={signCls(r.window?.ret5Pct)}>{pct(r.window?.ret5Pct)}</span> },
                  { key: 'rvol', label: 'Window RVOL', num: true, sortValue: (r) => r.window?.rvol, render: (r) => n2(r.window?.rvol) },
                  { key: 'plan', label: 'Plan', sortable: false, render: (r) => (r.plan ? <span className="small mono">{r.plan.side} {r.plan.qty} @ {n2(r.plan.trigger)}<div>stop {n2(r.plan.stop)} · T1 {n2(r.plan.target1)} · T2 {n2(r.plan.target2)}</div><div>R/R {n2(r.plan.rewardRisk)} after costs</div></span> : '—') },
                  { key: 'reasons', label: 'Reasons', sortable: false, wrap: true, render: (r) => <span className="small">{r.reasons.length ? r.reasons.slice(0, 4).map((x, i) => <div key={i}>• {x}</div>) : <span className="muted">all checks passed</span>}</span> },
                ]} />
            </div>
          </>
        );
      })()}
    </Loading>
  );
}
