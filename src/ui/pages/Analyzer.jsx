import React, { useState } from 'react';
import { useApi, Loading, SortTable, ScoreBar, OutcomeChip, LabelChip, States, pct, n2, money, both, signCls } from '../lib.jsx';

export const SNAP_KEYS = [['preliminary', '09:20 preliminary'], ['earlyAuction', '09:25 early auction'], ['main', '09:28 main'], ['final', 'Final (09:29:50)']];

export function SnapshotPicker({ value, onChange, available }) {
  return (
    <span className="pill-tabs">
      {SNAP_KEYS.map(([k, label]) => <button key={k} className={value === k ? 'on' : ''} disabled={available && !available.includes(k)} onClick={() => onChange(k)}>{label}</button>)}
    </span>
  );
}

export function MarketPanel({ snap }) {
  const b = snap.breadth;
  return (
    <div className="panel">
      <h2>Market & breadth at {both(snap.asOf)}</h2>
      <div className="row" style={{ gap: 18 }}>
        {Object.entries(snap.market).map(([k, v]) => (
          <div key={k} className="small"><b>{k}</b> <span className={signCls(v.gapPct)}>{pct(v.gapPct)}</span>{v.rvol != null && <span className="muted"> · RVOL {n2(v.rvol)}</span>}</div>
        ))}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Tracked-universe breadth: <b className="pos">{b.up} up</b> / <b className="neg">{b.down} down</b> / {b.flat} flat of {b.counted} counted
        ({b.excluded} stale excluded, {b.total} tracked){b.aboveVwapShare != null && <> · {Math.round(b.aboveVwapShare * 100)}% above pre-market VWAP</>}.
        Gap distribution: {Object.entries(b.gapDistribution).map(([k, v]) => `${k}: ${v}`).join(' · ')}. <i>{b.note}.</i> Universe: {snap.universe.name} — {snap.universe.note ?? `${snap.universe.tracked} tracked`}.
      </p>
    </div>
  );
}

const OUTCOMES = ['all', 'LONG CANDIDATE', 'SHORT CANDIDATE', 'WATCH', 'NO TRADE'];

export default function Analyzer({ sessionId, session, go, nav, tick }) {
  const s = useApi(sessionId ? `/sessions/${sessionId}` : null, [tick]);
  const key = nav.snap ?? 'main';
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  if (!sessionId) return null;
  return (
    <Loading state={s}>
      {s.data && (() => {
        const snap = s.data.snapshots[key];
        if (!snap) return <div className="panel">No {key} snapshot in this session{s.data.mode === 'LIVE' ? ' (missed or not yet taken)' : ''}.</div>;
        const rows = snap.rows.filter((r) => (filter === 'all' || r.outcome === filter) && (!q || `${r.symbol} ${r.name}`.toLowerCase().includes(q.toLowerCase())));
        const columns = [
          { key: 'symbol', label: 'Symbol', render: (r) => <span><b>{r.symbol}</b><div className="small muted">{r.name}</div></span> },
          { key: 'type', label: 'Type / sector', sortable: false, render: (r) => <span className="small">{r.securityType}<div className="muted">{r.sector ?? '—'}{r.sectorEtf ? ` (${r.sectorEtf})` : ''}</div></span> },
          { key: 'marketCap', label: 'Mkt cap', num: true, render: (r) => money(r.marketCap) },
          { key: 'floatAsOf', label: 'Float / SO date', render: (r) => <span className="small" title={r.floatKind ?? ''}>{r.floatAsOf ?? '—'}</span> },
          { key: 'gapPct', label: 'Gap', num: true, render: (r) => <span className={signCls(r.gapPct)}>{pct(r.gapPct)}</span> },
          { key: 'gapAtr', label: 'Gap ATR', num: true, render: (r) => n2(r.gapAtr) },
          { key: 'cumDollar', label: 'PM $ vol', num: true, render: (r) => money(r.cumDollar) },
          { key: 'rvol', label: 'Same-time RVOL', num: true, title: 'Cumulative pre-market volume ÷ same-clock median (same feed)', render: (r) => (r.rvol != null ? <span>{n2(r.rvol)}<span className="muted small"> n={r.rvolSample}</span></span> : <span className="muted small" title={r.rvolReason}>refused</span>) },
          { key: 'spreadBps', label: 'Spread bps', num: true, render: (r) => n2(r.spreadBps, 1) },
          { key: 'catalyst', label: 'Catalyst', sortable: false, wrap: true, render: (r) => <span className="small">{r.catalyst ? <a href={r.catalyst.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{r.catalyst.headline}</a> : <span className="muted">{r.catalystDetail}</span>}</span> },
          { key: 'auction', label: 'Auction', sortable: false, render: (r) => (r.auction ? <span className={r.auction.side > 0 ? 'pos' : r.auction.side < 0 ? 'neg' : ''}>{r.auction.side > 0 ? 'BUY' : r.auction.side < 0 ? 'SELL' : 'none'} {Math.round((r.auction.persistence ?? 0) * 100)}%</span> : <span className="muted small">n/a</span>) },
          { key: 'longScore', label: 'Long', num: true, render: (r) => <span><ScoreBar value={r.longScore} dir={1} /><div><LabelChip label={r.longLabel} /></div></span> },
          { key: 'shortScore', label: 'Short', num: true, render: (r) => <span><ScoreBar value={r.shortScore} dir={-1} /><div><LabelChip label={r.shortLabel} /></div></span> },
          { key: 'volumeScore', label: 'Volume ev.', num: true, title: 'Volume-evidence score (the four volume groups only)', render: (r) => r.volumeScore ?? '—' },
          { key: 'coverage', label: 'Coverage', num: true, render: (r) => `${Math.round((r.coverage ?? 0) * 100)}%` },
          { key: 'quality', label: 'Data', sortable: false, render: (r) => <States mode={s.data.mode} quality={r.quality} /> },
          { key: 'setup', label: 'Setup', sortable: false, render: (r) => <span className="small">{r.setup?.classification ?? '—'}{r.setup?.absorptionInference ? ' · absorption?' : ''}</span> },
          { key: 'outcome', label: 'Outcome', render: (r) => <OutcomeChip outcome={r.outcome} /> },
          { key: 'eligibility', label: 'Eligibility / primary reason', wrap: true, render: (r) => <span className="small"><span className={`chip ${r.eligibility}`}>{r.eligibility}</span> {r.primaryReason}</span> },
        ];
        return (
          <>
            <div className="panel">
              <div className="row">
                <SnapshotPicker value={key} onChange={(k) => go({ snap: k })} available={Object.keys(s.data.snapshots)} />
                <span className="small muted">Snapshot {snap.label} · as of {both(snap.asOf)} · published {both(snap.publishedAt)} · {snap.presetLabel} · score {snap.scoreVersion} · config {snap.configHash}</span>
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>Scores rank setups; a score of 80 is not an 80% probability. Long and short are scored separately; volume amplifies price evidence but never picks the side. {snap.dataLabel ?? ''}</p>
            </div>
            <MarketPanel snap={snap} />
            <div className="panel">
              <div className="row" style={{ marginBottom: 8 }}>
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select>
                <input placeholder="Search symbol or name" value={q} onChange={(e) => setQ(e.target.value)} />
                <span className="small muted">{rows.length} of {snap.rows.length} · click a row for the full explanation</span>
              </div>
              <SortTable columns={columns} rows={rows} onRow={(r) => go({ tab: 'stock', symbol: r.symbol })} />
            </div>
          </>
        );
      })()}
    </Loading>
  );
}
