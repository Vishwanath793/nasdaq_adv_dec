import React, { useState } from 'react';
import { api, useApi, Loading, SortTable, pct, n2, usd } from '../lib.jsx';

const p = (x) => (x == null ? '—' : pct(x));
const rate = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export default function ReportCard({ tick }) {
  const [horizon, setHorizon] = useState('m30');
  const [snap, setSnap] = useState('main');
  const rc = useApi(`/reportcard?horizon=${horizon}&snapshot=${snap}`, [tick]);
  const [ab, setAb] = useState(null);
  const [busy, setBusy] = useState(false);
  async function runAblation() {
    setBusy(true);
    try { setAb(await api('/ablation', { method: 'POST', body: { horizon } })); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  return (
    <Loading state={rc}>
      {rc.data && (() => {
        const r = rc.data;
        return (
          <>
            {r.warning && <div className="banner demo">{r.warning}</div>}
            <div className="panel">
              <div className="row">
                <h2 style={{ margin: 0 }}>Report card</h2>
                <select value={snap} onChange={(e) => setSnap(e.target.value)}>{['preliminary', 'earlyAuction', 'main', 'final'].map((k) => <option key={k}>{k}</option>)}</select>
                <select value={horizon} onChange={(e) => setHorizon(e.target.value)}>{['m5', 'm15', 'm30', 'm60'].map((k) => <option key={k} value={k}>{k.slice(1)} min</option>)}</select>
                <span className="small muted">{r.generatedFor.sessions} session(s) · {r.observations} observations · modes {r.generatedFor.modes.join(', ')}</span>
              </div>
              <p className="small muted">Returns are in the scored direction from the first bar open after the decision time (a reference, not a fill), before costs. Paper P&L is after modelled costs. Every table shows its sample size; small samples are flagged, not interpreted.</p>
              <div className="row" style={{ gap: 24 }}>
                <div>Rank correlation (score vs return): <b>{n2(r.rankCorrelation)}</b></div>
                <div>Continuation rate (60 min): <b>{rate(r.continuationRate)}</b></div>
                <div>Median MFE / MAE (60 min): <b>{p(r.mfeMae.medianMfe)} / {p(r.mfeMae.medianMae)}</b></div>
              </div>
            </div>
            <div className="grid2">
              <div className="panel"><h2>Score bands</h2>
                <SortTable rowKey={(x) => x.band} rows={r.bands} columns={[
                  { key: 'band', label: 'Adjusted score' }, { key: 'n', label: 'n', num: true }, { key: 'meanRet', label: 'Mean', num: true, render: (x) => p(x.meanRet) },
                  { key: 'ci90', label: '90% CI', sortable: false, render: (x) => (x.ci90 ? `${p(x.ci90[0])} … ${p(x.ci90[1])}` : '—') },
                  { key: 'hitRate', label: 'Hit', num: true, render: (x) => rate(x.hitRate) }, { key: 'meanMfe', label: 'MFE', num: true, render: (x) => p(x.meanMfe) }, { key: 'meanMae', label: 'MAE', num: true, render: (x) => p(x.meanMae) },
                  { key: 'note', label: '', sortable: false, render: (x) => <span className="small muted">{x.note}</span> },
                ]} /></div>
              <div className="panel"><h2>By conviction label</h2>
                <SortTable rowKey={(x) => x.label} rows={r.byLabel} columns={[{ key: 'label', label: 'Label' }, { key: 'n', label: 'n', num: true }, { key: 'meanRet', label: 'Mean', num: true, render: (x) => p(x.meanRet) }, { key: 'rankCorr', label: 'Rank corr', num: true, render: (x) => n2(x.rankCorr) }, { key: 'note', label: '', render: (x) => <span className="small muted">{x.note}</span> }]} /></div>
              <div className="panel"><h2>By pre-market liquidity</h2>
                <SortTable rowKey={(x) => x.liquidity} rows={r.byLiquidity} columns={[{ key: 'liquidity', label: 'Pre-market $' }, { key: 'n', label: 'n', num: true }, { key: 'meanRet', label: 'Mean', num: true, render: (x) => p(x.meanRet) }, { key: 'rankCorr', label: 'Rank corr', num: true, render: (x) => n2(x.rankCorr) }, { key: 'note', label: '', render: (x) => <span className="small muted">{x.note}</span> }]} /></div>
              <div className="panel"><h2>By market cap & setup</h2>
                <SortTable rowKey={(x) => x.marketCap} rows={r.byMarketCap} columns={[{ key: 'marketCap', label: 'Market cap' }, { key: 'n', label: 'n', num: true }, { key: 'meanRet', label: 'Mean', num: true, render: (x) => p(x.meanRet) }, { key: 'rankCorr', label: 'Rank corr', num: true, render: (x) => n2(x.rankCorr) }]} />
                <SortTable rowKey={(x) => x.setup} rows={r.bySetup} columns={[{ key: 'setup', label: 'Setup' }, { key: 'n', label: 'n', num: true }, { key: 'meanRet', label: 'Mean', num: true, render: (x) => p(x.meanRet) }, { key: 'rankCorr', label: 'Rank corr', num: true, render: (x) => n2(x.rankCorr) }]} /></div>
              <div className="panel"><h2>Opening confirmation verdicts</h2>
                <SortTable rowKey={(x) => x.verdict} rows={r.confirmation} columns={[{ key: 'verdict', label: 'Verdict' }, { key: 'n', label: 'n', num: true }, { key: 'meanRet', label: 'Mean after seal', num: true, render: (x) => p(x.meanRet) }, { key: 'hitRate', label: 'Hit', num: true, render: (x) => rate(x.hitRate) }, { key: 'note', label: '', render: (x) => <span className="small muted">{x.note}</span> }]} /></div>
              <div className="panel"><h2>Decisions, coverage & paper</h2>
                <div className="kv small">
                  <div>No-trade rate</div><div>{rate(r.decisions.noTradeRate)}</div>
                  <div>Insufficient evidence</div><div>{rate(r.decisions.insufficientRate)}</div>
                  <div>Blocked by gates</div><div>{rate(r.decisions.blockedRate)}</div>
                  <div>Paper entries</div><div>{r.decisions.paperEntries}</div>
                  <div>Top reasons</div><div>{r.decisions.topReasons.map(([k, v]) => `${k} (${v})`).join(' · ')}</div>
                  <div>Paper trades</div><div>{r.paper.trades} · net {usd(r.paper.netTotal)} · expectancy {usd(r.paper.expectancy)} · win {rate(r.paper.winRate)} · max DD {usd(r.paper.maxDrawdown)} · {r.paper.note}</div>
                  <div>Hypothetical shorts</div><div>{r.paper.hypotheticalShorts.n} · {usd(r.paper.hypotheticalShorts.net)} ({r.paper.hypotheticalShorts.note})</div>
                </div>
              </div>
            </div>
            <div className="panel">
              <div className="row"><h2 style={{ margin: 0 }}>Ablation: does each data family help?</h2><button onClick={runAblation} disabled={busy}>{busy ? 'Re-scoring…' : 'Run ablation'}</button></div>
              <p className="small muted">Every stored session is re-scored under each preset from the same records at the same decision time. Chronological split: earliest 60% of dates = development, the rest held out. Do not tune weights on a few days.</p>
              {ab && <SortTable rowKey={(x) => x.preset} rows={ab.rows} columns={[
                { key: 'preset', label: 'Preset' }, { key: 'n', label: 'n', num: true }, { key: 'devRankCorr', label: 'Dev rank corr', num: true, render: (x) => n2(x.devRankCorr) },
                { key: 'testRankCorr', label: 'Held-out rank corr', num: true, render: (x) => n2(x.testRankCorr) }, { key: 'testTopQuintileRet', label: 'Held-out top quintile', num: true, render: (x) => p(x.testTopQuintileRet) },
                { key: 'note', label: '', render: (x) => <span className="small muted">{x.note}</span> },
              ]} />}
            </div>
          </>
        );
      })()}
    </Loading>
  );
}
