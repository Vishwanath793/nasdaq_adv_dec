import React, { useEffect, useState } from 'react';
import { api, useApi, et, ist, Badge } from './lib.jsx';
import Analyzer from './pages/Analyzer.jsx';
import Auction from './pages/Auction.jsx';
import Confirm from './pages/Confirm.jsx';
import StockDetail from './pages/StockDetail.jsx';
import Paper from './pages/Paper.jsx';
import ReportCard from './pages/ReportCard.jsx';
import Providers from './pages/Providers.jsx';

const TABS = [['analyzer', 'Pre-market analyzer'], ['auction', 'Auction monitor'], ['confirm', 'Opening confirmation'], ['stock', 'Stock detail'], ['paper', 'Paper'], ['report', 'Report card'], ['providers', 'Providers & settings']];

const readHash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));

export default function App() {
  const [nav, setNav] = useState(() => ({ tab: 'analyzer', ...readHash() }));
  const status = useApi('/status');
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { const on = () => setNav((n) => ({ ...n, ...readHash() })); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  useEffect(() => { location.hash = new URLSearchParams(Object.entries(nav).filter(([, v]) => v != null && v !== '')).toString(); }, [nav]);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => { const e = JSON.parse(m.data); if (['session', 'snapshot', 'confirm', 'paper'].includes(e.type)) { status.reload(); setTick((x) => x + 1); } };
    return () => es.close();
  }, []);
  const sessions = status.data?.sessions ?? [];
  const sessionId = nav.session ?? sessions[0]?.id ?? null;
  const session = sessions.find((s) => s.id === sessionId) ?? null;
  const go = (patch) => setNav((n) => ({ ...n, ...patch }));

  async function runDemo() {
    setBusy(true);
    try { const r = await api('/demo', { method: 'POST', body: {} }); status.reload(); go({ session: r.replayOf ?? r.id }); setTick((x) => x + 1); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  const props = { sessionId, session, go, nav, tick, status: status.data };
  return (
    <>
      <header className="top">
        <h1>Nasdaq pre-market analyzer</h1>
        <Badge kind="PAPER" title="Paper simulation only: no live orders exist in this app">PAPER ONLY</Badge>
        <nav className="tabs">{TABS.map(([k, label]) => <button key={k} className={nav.tab === k ? 'on' : ''} onClick={() => go({ tab: k })}>{label}</button>)}</nav>
        <div className="row small">
          <select value={sessionId ?? ''} onChange={(e) => go({ session: e.target.value })} title="Recorded session">
            {sessions.length === 0 && <option value="">no sessions yet</option>}
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.date} · {s.mode}{s.source?.seed ? ` · seed ${s.source.seed}` : ''}</option>)}
          </select>
          <button onClick={runDemo} disabled={busy} title="Generate and analyse the deterministic DEMO session">{busy ? 'Running…' : 'Run DEMO session'}</button>
        </div>
        <div className="clock">
          <div>{et(now)} · {ist(now)}</div>
          <div>{status.data ? `${status.data.date} · ${status.data.dayStatus} · phase ${status.data.phase}` : '…'}</div>
        </div>
      </header>
      <main>
        {session?.mode === 'DEMO' && <div className="banner demo">DEMO — deterministic simulated data with fictional symbols. Nothing on this page is market data or a recommendation.</div>}
        {!sessions.length && status.data && (
          <div className="panel"><h2>No sessions yet</h2>
            <p>Run the deterministic DEMO session to see the whole workflow, or configure free API keys (Providers & settings) and start the LIVE limited-coverage collector.</p>
            <button className="primary" onClick={runDemo} disabled={busy}>Run DEMO session</button></div>
        )}
        {nav.tab === 'analyzer' && <Analyzer {...props} />}
        {nav.tab === 'auction' && <Auction {...props} />}
        {nav.tab === 'confirm' && <Confirm {...props} />}
        {nav.tab === 'stock' && <StockDetail {...props} />}
        {nav.tab === 'paper' && <Paper {...props} />}
        {nav.tab === 'report' && <ReportCard {...props} />}
        {nav.tab === 'providers' && <Providers {...props} reloadStatus={status.reload} />}
      </main>
    </>
  );
}
