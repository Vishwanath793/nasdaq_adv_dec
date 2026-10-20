import React, { useEffect, useState } from 'react';
import { api, useApi, Loading, SortTable, both, et } from '../lib.jsx';

function SettingsForm() {
  const s = useApi('/settings');
  const dict = useApi('/dictionary');
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  useEffect(() => { if (s.data) setDraft(s.data.settings); }, [s.data]);
  if (!draft || !dict.data) return <Loading state={s.data ? dict : s}><div /></Loading>;
  const preset = dict.data.presets[draft.preset];
  const weights = { ...preset.groups, ...(draft.groupWeights ?? {}) };
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setRisk = (k, v) => set({ risk: { ...draft.risk, [k]: v } });
  async function save() { const r = await api('/settings', { method: 'PUT', body: draft }); setDraft(r.settings); setSaved(Date.now()); }
  const off = new Set(draft.factorsOff);
  return (
    <div className="panel">
      <h2>Scoring & risk settings</h2>
      <p className="small muted">Changing settings never rewrites stored snapshots: a session already analysed under other settings is replayed as a separate research version. Weights are research hypotheses, not validated optima; keep the equal-groups baseline for comparison.</p>
      <div className="row">
        <label>Preset <select value={draft.preset} onChange={(e) => set({ preset: e.target.value, groupWeights: null })}>{Object.entries(dict.data.presets).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>Final pre-open snapshot <input value={draft.schedule.final} onChange={(e) => set({ schedule: { ...draft.schedule, final: e.target.value } })} style={{ width: 90 }} /> ET</label>
        <label><input type="checkbox" checked={draft.universe.includeAdrs} onChange={(e) => set({ universe: { ...draft.universe, includeAdrs: e.target.checked } })} /> include ADRs</label>
      </div>
      <h3>Group weights</h3>
      <div className="row">
        {Object.entries(dict.data.groups).map(([g, meta]) => (
          <label key={g} className="small" style={{ minWidth: 200 }}>{meta.label}{meta.volume ? ' (volume)' : ''}
            <input type="number" min="0" max="100" value={weights[g] ?? 0} style={{ width: 64, marginLeft: 6 }} onChange={(e) => set({ groupWeights: { ...weights, [g]: Number(e.target.value) } })} />
          </label>
        ))}
      </div>
      <h3>Factor switches</h3>
      <div className="row">{dict.data.factors.map((f) => (
        <label key={f.key} className="small" title={f.describe} style={{ minWidth: 230 }}>
          <input type="checkbox" checked={!off.has(f.key)} onChange={(e) => set({ factorsOff: e.target.checked ? draft.factorsOff.filter((k) => k !== f.key) : [...draft.factorsOff, f.key] })} /> {f.label} <span className="muted">({f.group})</span>
        </label>))}</div>
      <h3>Paper risk (USD)</h3>
      <div className="row">
        {[['capital', 'Capital'], ['riskPerTradePct', 'Risk/trade %'], ['dailyLossPct', 'Max daily loss %'], ['maxOpenPositions', 'Max open'], ['maxTradesPerDay', 'Max trades/day'], ['maxPerSector', 'Max per sector'], ['minRewardRisk', 'Min R/R after costs'], ['slippageBps', 'Slippage bps'], ['maxSpreadBps', 'Max spread bps'], ['latencyMs', 'Latency ms'], ['participationCap', 'Participation cap']].map(([k, label]) => (
          <label key={k} className="small">{label} <input type="number" value={draft.risk[k]} style={{ width: 80 }} onChange={(e) => setRisk(k, Number(e.target.value))} /></label>
        ))}
        <label className="small">Entry expiry <input value={draft.risk.entryUntil} style={{ width: 60 }} onChange={(e) => setRisk('entryUntil', e.target.value)} /> ET</label>
        <label className="small">Square-off <input value={draft.risk.squareOffAt} style={{ width: 60 }} onChange={(e) => setRisk('squareOffAt', e.target.value)} /> ET</label>
      </div>
      <div className="row" style={{ marginTop: 10 }}><button className="primary" onClick={save}>Save settings</button>{saved && <span className="small muted">saved {et(saved)}</span>}</div>
    </div>
  );
}

export default function Providers({ status, reloadStatus }) {
  const reg = useApi('/registry');
  const [busy, setBusy] = useState(null);
  const [universe, setUniverse] = useState(null);
  const live = status?.live;
  async function act(name, fn) { setBusy(name); try { await fn(); } catch (e) { alert(e.message); } finally { setBusy(null); reg.reload(); reloadStatus(); } }
  return (
    <>
      <div className="panel">
        <h2>Configured sources</h2>
        <div className="row small">{Object.entries(status?.configured ?? {}).map(([k, v]) => <span key={k} className={`chip ${v ? 'eligible' : 'none'}`}>{k}: {v ? 'configured' : 'not configured'}</span>)}</div>
        <p className="small muted">Keys live only in the server's <code>.env</code> (see docs/SETUP.md); the browser only sees these booleans. Nothing is purchased; every source is a free tier, public file or official API.</p>
        <div className="row">
          <button onClick={() => act('probe', () => api('/probe', { method: 'POST' }))} disabled={busy}>{busy === 'probe' ? 'Probing…' : 'Run live probe'}</button>
          <button onClick={() => act('prepare', () => api('/live/prepare', { method: 'POST' }))} disabled={busy}>{busy === 'prepare' ? 'Preparing…' : 'Start LIVE limited-coverage collector'}</button>
          <button onClick={() => act('stop', () => api('/live/stop', { method: 'POST' }))} disabled={busy}>Stop collector</button>
          <button onClick={() => act('universe', async () => setUniverse(await api('/universe?refresh=1')))} disabled={busy}>{busy === 'universe' ? 'Loading…' : 'Load Nasdaq universe'}</button>
        </div>
        {live && <div className="small" style={{ marginTop: 8 }}>
          Collector: <b>{live.status}</b>{live.date ? ` · ${live.date}` : ''} · streamed {live.streamed.length} · shortlist {live.shortlist.length} · omitted {live.omitted ?? 0} · snapshots {live.snapshots.join(', ') || 'none'}{live.missed.length ? ` · MISSED ${live.missed.join(', ')}` : ''}
          {live.log.slice(-8).map((e, i) => <div key={i} className={e.level === 'error' ? 'err' : 'muted'}>{both(e.at)} {e.level}: {e.message}</div>)}
        </div>}
        {universe && <p className="small">Universe ({universe.createdAt ? `file created ${both(universe.createdAt)}` : ''}): <b>{universe.eligible}</b> eligible common stocks{universe.byType ? ` · types ${Object.entries(universe.byType).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''} · {universe.etfs} ETFs listed separately · {universe.excluded} excluded. {universe.note}</p>}
      </div>
      <Loading state={reg}>
        {reg.data && (() => {
          const probe = new Map((reg.data.probe?.results ?? []).map((r) => [r.id, r]));
          return (
            <>
              <div className="panel">
                <h2>Free-source capability matrix</h2>
                <p className="small muted">Documented capability (read from current docs) vs live verification (the probe). "Implemented" never means "verified". Last probe: {reg.data.probe ? both(reg.data.probe.ranAt) : 'never'}.</p>
                <SortTable rowKey={(x) => x.id} rows={reg.data.sources} columns={[
                  { key: 'provider', label: 'Source', render: (x) => <span><b>{x.provider}</b><div className="small muted">{x.product}</div></span> },
                  { key: 'realtime', label: 'Real-time / delay', wrap: true, render: (x) => <span className="small">{x.realtime}</span> },
                  { key: 'volume', label: 'Volume', wrap: true, render: (x) => <span className="small">{x.volume}</span> },
                  { key: 'limits', label: 'Limits', wrap: true, render: (x) => <span className="small">{x.limits}</span> },
                  { key: 'role', label: 'Role', wrap: true, render: (x) => <span className="small">{x.role}</span> },
                  { key: 'status', label: 'Status', render: (x) => <span className={`chip ${x.status.startsWith('implemented') ? 'eligible' : x.status === 'excluded' ? 'none' : 'unverified'}`}>{x.status}</span> },
                  { key: 'verified', label: 'Live verification', wrap: true, sortable: false, render: (x) => { const v = probe.get(x.id); return <span className="small">{v ? (v.ok ? <span className="pos">OK {both(v.at)} {JSON.stringify(v.detail)}</span> : <span className="neg">FAILED: {v.error}</span>) : <span className="muted">{x.liveVerifiedNote ?? 'not probed'}</span>}</span>; } },
                ]} />
              </div>
              <div className="grid2">
                <div className="panel"><h2>Operating modes</h2>{Object.entries(reg.data.modes).map(([k, v]) => <p key={k} className="small"><b>{k}</b> — {v}</p>)}
                  <h3>Features by profile</h3>
                  <table><thead><tr><th>Feature</th><th>DEMO</th><th>LIMITED</th><th>DELAYED</th><th>ENHANCED</th></tr></thead><tbody>{reg.data.profileFeatures.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i} className="small wrap">{c}</td>)}</tr>)}</tbody></table>
                </div>
                <div className="panel"><h2>Request budget</h2>
                  <SortTable rowKey={(x) => x.name} rows={Object.entries(reg.data.budget).map(([name, b]) => ({ name, ...b }))} columns={[
                    { key: 'name', label: 'Provider' }, { key: 'usedToday', label: 'Used today', num: true }, { key: 'remainingToday', label: 'Left today', num: true, render: (x) => x.remainingToday ?? '∞' },
                    { key: 'remainingThisMinute', label: 'Left this min', num: true, render: (x) => x.remainingThisMinute ?? '—' }, { key: 'queued', label: 'Queued', num: true },
                    { key: 'lastError', label: 'Last error', wrap: true, render: (x) => <span className="small err">{x.lastError?.message ?? ''}</span> },
                  ]} />
                </div>
              </div>
            </>
          );
        })()}
      </Loading>
      <SettingsForm />
    </>
  );
}
