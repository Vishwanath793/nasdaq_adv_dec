import React, { useEffect, useState, useCallback } from 'react';

export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** Fetch once per key; refetch on demand. Never refetches on re-render. */
export function useApi(path, deps = []) {
  const [state, set] = useState({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    if (!path) { set({ data: null, error: null, loading: false }); return; }
    set((s) => ({ ...s, loading: true }));
    api(path).then((data) => set({ data, error: null, loading: false }), (e) => set({ data: null, error: e.message, loading: false }));
  }, [path]);
  useEffect(load, [load, ...deps]);
  return { ...state, reload: load };
}

const fmtZone = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
export const et = (ms) => (ms == null ? '—' : `${fmtZone(ms, 'America/New_York')} ET`);
export const ist = (ms) => (ms == null ? '—' : `${fmtZone(ms, 'Asia/Kolkata')} IST`);
export const both = (ms) => (ms == null ? '—' : `${et(ms)} · ${ist(ms)}`);

export const n2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
export const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
export const money = (x) => {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  return `${x < 0 ? '−' : ''}$${a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0)}`;
};
export const usd = (x) => (x == null ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`);
export const signCls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

export function Badge({ kind, children, title }) { return <span className={`badge ${kind}`} title={title}>{children ?? kind}</span>; }

/** Data-state badge for a session/row: DEMO, REAL-TIME, DELAYED, STALE, PARTIAL, REPLAY. */
export function dataStates(mode, quality) {
  const out = [];
  if (mode === 'DEMO') out.push(['DEMO', 'Deterministic simulated data — not market data']);
  else if (mode === 'REPLAY') out.push(['REPLAY', 'Recorded session replayed through the same code']);
  else if (mode === 'LIVE') out.push(['REALTIME', 'Live IEX (single venue) data']);
  if (quality?.delayed) out.push(['DELAYED', 'Feed is delayed: data cutoff is before the decision time']);
  else if (quality?.cutoffLagMs > 90_000) out.push(['STALE', `Data ends ${Math.round(quality.cutoffLagMs / 1000)} s before the decision`]);
  if (quality && (quality.gaps > 0 || quality.observed < 0.95)) out.push(['PARTIAL', `${Math.round((quality.observed ?? 0) * 100)}% of the window observed, ${quality.gaps} gap(s)`]);
  return out;
}
export function States({ mode, quality }) {
  return <span className="row" style={{ gap: 4, display: 'inline-flex' }}>{dataStates(mode, quality).map(([k, t]) => <Badge key={k} kind={k} title={t}>{k === 'REALTIME' ? 'REAL-TIME' : k}</Badge>)}</span>;
}

export function ScoreBar({ value, dir }) {
  if (value == null) return <span className="muted">—</span>;
  const color = dir > 0 ? 'var(--long)' : 'var(--short)';
  return <span className="score"><span className="num mono" style={{ minWidth: 22 }}>{value}</span><span className="bar"><i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color, opacity: value >= 60 ? 1 : 0.45 }} /></span></span>;
}

export function OutcomeChip({ outcome }) {
  const cls = outcome === 'LONG CANDIDATE' ? 'long' : outcome === 'SHORT CANDIDATE' ? 'short' : outcome === 'WATCH' ? 'watch' : outcome === 'PAPER ENTRY ELIGIBLE' ? 'eligible' : 'none';
  return <span className={`chip ${cls}`}>{outcome}</span>;
}

export function LabelChip({ label }) {
  const cls = label === 'strong' ? 'eligible' : label === 'moderate' ? 'watch' : label === 'insufficient evidence' ? 'unverified' : 'none';
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function SortTable({ columns, rows, initial, onRow, rowKey = (r) => r.symbol, empty = 'No rows' }) {
  const [sort, setSort] = useState(initial ?? null);
  const sorted = sort ? [...rows].sort((a, b) => {
    const c = columns.find((x) => x.key === sort.key);
    const va = c.sortValue ? c.sortValue(a) : a[c.key];
    const vb = c.sortValue ? c.sortValue(b) : b[c.key];
    const d = (va == null) - (vb == null) || (va > vb ? 1 : va < vb ? -1 : 0);
    return sort.desc ? -d : d;
  }) : rows;
  return (
    <div className="tbl-wrap">
      <table>
        <thead><tr>{columns.map((c) => (
          <th key={c.key} className={`${c.num ? 'num' : ''} ${c.sortable !== false ? 'sort' : ''}`} title={c.title}
            onClick={() => c.sortable !== false && setSort((s) => ({ key: c.key, desc: s?.key === c.key ? !s.desc : true }))}>
            {c.label}{sort?.key === c.key ? (sort.desc ? ' ▾' : ' ▴') : ''}
          </th>))}</tr></thead>
        <tbody>
          {sorted.length === 0 && <tr><td colSpan={columns.length} className="muted">{empty}</td></tr>}
          {sorted.map((r) => (
            <tr key={rowKey(r)} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(r) : undefined}>
              {columns.map((c) => <td key={c.key} className={`${c.num ? 'num' : ''} ${c.wrap ? 'wrap' : ''}`}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Loading({ state, children }) {
  if (state.loading && !state.data) return <div className="panel muted">Loading…</div>;
  if (state.error) return <div className="panel err">{state.error}</div>;
  return children;
}
