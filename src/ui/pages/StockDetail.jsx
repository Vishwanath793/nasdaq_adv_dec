import React, { useState } from 'react';
import { useApi, Loading, LabelChip, OutcomeChip, States, pct, n2, money, both, et, signCls } from '../lib.jsx';
import { SnapshotPicker } from './Analyzer.jsx';

/** Extended-hours + regular-session chart: candles, separate VWAPs, previous close, opening range, plan levels. */
function PriceChart({ chart, confirm }) {
  const bars = chart.bars;
  if (!bars.length) return <p className="muted">No bars.</p>;
  const W = 980; const H = 330; const VH = 70; const L = 50; const R = 10;
  const t0 = bars[0].t; const t1 = bars.at(-1).t + 60_000;
  const plan = confirm?.plan;
  const levels = [chart.prevClose, plan?.trigger, plan?.stop, plan?.target1, plan?.target2, confirm?.window?.orHigh, confirm?.window?.orLow].filter((x) => x != null);
  const lo = Math.min(...bars.map((b) => b.l), ...levels);
  const hi = Math.max(...bars.map((b) => b.h), ...levels);
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (p) => 10 + (1 - (p - lo) / (hi - lo || 1)) * (H - VH - 30);
  const maxV = Math.max(...bars.map((b) => b.v), 1);
  const bw = Math.max(1, ((W - L - R) / ((t1 - t0) / 60_000)) * 0.7);
  const line = (pts, color, dash) => <polyline fill="none" stroke={color} strokeWidth="1.4" strokeDasharray={dash} points={pts.filter((p) => p.vwap != null).map((p) => `${x(p.t + 30_000)},${y(p.vwap)}`).join(' ')} />;
  const hline = (p, color, label, dash = '4 3') => (p == null ? null : <g key={label}><line x1={L} x2={W - R} y1={y(p)} y2={y(p)} stroke={color} strokeDasharray={dash} /><text x={W - R - 2} y={y(p) - 2} textAnchor="end" style={{ fill: color }}>{label} {n2(p)}</text></g>);
  const ticks = [];
  for (let t = Math.ceil(t0 / 1_800_000) * 1_800_000; t < t1; t += 1_800_000) ticks.push(t);
  const vline = (t, color, label) => (t == null || t < t0 || t > t1 ? null : <g key={label}><line x1={x(t)} x2={x(t)} y1={6} y2={H - 16} stroke={color} strokeDasharray="2 3" /><text x={x(t) + 3} y={16} style={{ fill: color }}>{label}</text></g>);
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={10} y2={H - 16} stroke="var(--line)" /><text x={x(t)} y={H - 4} textAnchor="middle">{et(t).slice(0, 5)}</text></g>)}
        {[lo, (lo + hi) / 2, hi].map((p) => <text key={p} x={4} y={y(p) + 3}>{n2(p)}</text>)}
        {vline(chart.times.open, 'var(--ink)', '09:30')}
        {vline(chart.times.windowEnd, 'var(--accent)', '09:35 seal')}
        {vline(chart.times.snapshotAt, 'var(--warn)', 'snapshot')}
        {hline(chart.prevClose, 'var(--muted)', 'prev close')}
        {hline(confirm?.window?.orHigh, 'var(--info)', 'OR high', '1 2')}
        {hline(confirm?.window?.orLow, 'var(--info)', 'OR low', '1 2')}
        {plan && hline(plan.trigger, 'var(--accent)', 'trigger')}
        {plan && hline(plan.stop, 'var(--short)', 'stop')}
        {plan && hline(plan.target1, 'var(--long)', 'T1')}
        {plan && hline(plan.target2, 'var(--long)', 'T2')}
        {bars.map((b) => {
          const up = b.c >= b.o;
          const col = up ? 'var(--long)' : 'var(--short)';
          return (
            <g key={b.t} opacity={b.knownAtSnapshot || b.t >= chart.times.open ? 1 : 0.35}>
              <line x1={x(b.t + 30_000)} x2={x(b.t + 30_000)} y1={y(b.h)} y2={y(b.l)} stroke={col} />
              <rect x={x(b.t + 30_000) - bw / 2} width={bw} y={y(Math.max(b.o, b.c))} height={Math.max(1, Math.abs(y(b.o) - y(b.c)))} fill={col} />
              <rect x={x(b.t + 30_000) - bw / 2} width={bw} y={H - 16 - (b.v / maxV) * VH} height={(b.v / maxV) * VH} fill={col} opacity={0.35} />
            </g>
          );
        })}
        {line(chart.pmVwap, 'var(--warn)', '5 3')}
        {line(chart.rthVwap, 'var(--accent)')}
      </svg>
      <div className="legend">
        <span><i style={{ background: 'var(--warn)' }} />pre-market VWAP</span><span><i style={{ background: 'var(--accent)' }} />regular-session VWAP (from 09:30)</span>
        <span>faded bars = not yet available at the snapshot (late/delayed records)</span><span>regular session after 09:35 shown after the fact</span>
      </div>
    </>
  );
}

function FactorTable({ score }) {
  return (
    <div className="tbl-wrap">
      <table>
        <thead><tr><th>Group</th><th>Factor</th><th className="num">Value</th><th className="num">Weight in score</th><th className="num">Contribution</th><th>Raw / transform</th><th>Explanation or missing reason</th><th>Lineage</th><th>Family</th></tr></thead>
        <tbody>
          {score.factors.map((f) => (
            <tr key={f.key} className={`factor-${f.status}`}>
              <td className="small">{score.groups[f.group]?.label}</td>
              <td title={f.describe}><b>{f.label}</b><div className="small muted">{f.role}</div></td>
              <td className="num">{f.status === 'used' ? n2(f.value) : f.status === 'na' ? 'n/a' : 'missing'}</td>
              <td className="num">{f.weightInScore != null ? `${(f.weightInScore * 100).toFixed(1)}%` : '—'}</td>
              <td className={`num ${signCls(f.contribution)}`}>{f.contribution != null ? `${f.contribution > 0 ? '+' : ''}${f.contribution.toFixed(1)}` : '—'}</td>
              <td className="small mono">{f.raw != null && typeof f.raw === 'number' ? n2(f.raw) : f.raw ?? ''} {f.units}<div className="muted">{f.transform}</div></td>
              <td className="wrap small">{f.detail ?? <span>{f.missingKind ? <b>{f.missingKind}: </b> : null}{f.reason}</span>}{f.evidence && <div><a href={f.evidence.url} target="_blank" rel="noreferrer">{f.evidence.headline}</a> · {f.evidence.source} · published {both(f.evidence.publishedAt)} · first seen {both(f.evidence.firstSeenAt)}</div>}</td>
              <td className="small muted wrap">{f.source}</td>
              <td className="small muted">{f.family}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Checklist({ title, items }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.map((c) => <div key={c.key} className="small">{c.met === true ? '✔' : c.met === false ? '✘' : '·'} <b>{c.label}</b> <span className="muted">{c.evaluable ? c.detail : 'not evaluable'}</span></div>)}
    </div>
  );
}

export default function StockDetail({ sessionId, nav, go, tick }) {
  const symbol = nav.symbol;
  const key = nav.snap ?? 'main';
  const d = useApi(sessionId && symbol ? `/sessions/${sessionId}/stock/${symbol}?snapshot=${key}` : null, [tick]);
  const [side, setSide] = useState(null);
  if (!symbol) return <div className="panel">Pick a stock from the analyzer table.</div>;
  return (
    <Loading state={d}>
      {d.data && (() => {
        const { row, confirm, chart } = d.data;
        if (!row) return <div className="panel">{symbol} is not in the {key} snapshot.</div>;
        const lead = side ?? (row.longScore >= row.shortScore ? 'long' : 'short');
        const score = row.scores[lead];
        const f = row.features;
        return (
          <>
            <div className="panel">
              <div className="row">
                <h2 style={{ margin: 0 }}>{row.symbol} · {row.name}</h2>
                <States mode={d.data.session.mode} quality={row.quality} />
                <OutcomeChip outcome={row.outcome} />
                {confirm && <OutcomeChip outcome={confirm.decision} />}
                <SnapshotPicker value={key} onChange={(k) => go({ snap: k })} available={d.data.snapshotsAvailable} />
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>{row.securityType} · {row.sector ?? 'sector n/a'} · market cap {money(row.marketCap)} · {f.scope?.label ?? f.scope?.feed} · snapshot as of {both(d.data.snapshotAsOf)}{chart?.demoCase ? ` · DEMO case: ${chart.demoCase}` : ''}</p>
            </div>
            {chart && <div className="panel"><PriceChart chart={chart} confirm={confirm} /></div>}
            <div className="grid2">
              <div className="panel">
                <h2>Why it scored this way</h2>
                <div className="row">
                  <span className="pill-tabs"><button className={lead === 'long' ? 'on' : ''} onClick={() => setSide('long')}>Long {row.longScore}</button><button className={lead === 'short' ? 'on' : ''} onClick={() => setSide('short')}>Short {row.shortScore}</button></span>
                  <LabelChip label={score.label.label} /> <span className="small muted">{score.label.why}</span>
                </div>
                <div className="kv small" style={{ marginTop: 8 }}>
                  <div>Adjusted / raw</div><div>{score.adjustedScore} / {score.rawScore} (adjusted = 50 + (raw − 50) × coverage)</div>
                  <div>Volume evidence</div><div>{score.volumeEvidenceScore ?? '—'}</div>
                  <div>Coverage</div><div>profile {Math.round(score.coverage.profile * 100)}% · mandatory {score.coverage.mandatoryOk ? 'ok' : 'MISSING'} · volume groups {Math.round(score.coverage.volume * 100)}% · factors {Math.round(score.coverage.factors * 100)}%</div>
                  <div>Groups</div><div>{Object.values(score.groups).map((g) => <span key={g.key} style={{ marginRight: 10 }}>{g.label}: <b className={g.score == null ? 'muted' : g.score >= 0.6 ? 'pos' : g.score <= 0.4 ? 'neg' : ''}>{g.score == null ? 'missing' : n2(g.score)}</b> <span className="muted">({Math.round(g.share * 100)}%)</span></span>)}</div>
                </div>
                <h3>Supporting evidence</h3>
                {score.supporting.slice(0, 6).map((x) => <div key={x.key} className="small pos">+{x.contribution.toFixed(1)} {x.label}: <span className="muted">{x.detail}</span></div>)}
                {!score.supporting.length && <div className="small muted">none</div>}
                <h3>Opposing evidence</h3>
                {score.opposing.slice(0, 6).map((x) => <div key={x.key} className="small neg">{x.contribution.toFixed(1)} {x.label}: <span className="muted">{x.detail}</span></div>)}
                {!score.opposing.length && <div className="small muted">none</div>}
              </div>
              <div className="panel">
                <h2>Setup: {row.setup?.classification ?? '—'}</h2>
                {row.setup && <>
                  <Checklist title={`Continuation (${row.setup.continuationMet}/${row.setup.continuationEvaluable})`} items={row.setup.continuation} />
                  <Checklist title={`Exhaustion / failure (${row.setup.exhaustionMet}/${row.setup.exhaustionEvaluable}) — fade score ${row.setup.fadeScore ?? 'n/a'}`} items={row.setup.exhaustion} />
                  {row.setup.absorptionInference && <p className="small"><b>Inference:</b> {row.setup.absorptionInference}</p>}
                </>}
                <h3>Eligibility gates ({row.eligibility})</h3>
                {row.gates.gates.map((g) => <div key={g.key} className="small"><span className={`chip ${g.state === 'pass' ? 'eligible' : g.state === 'fail' ? 'blocked' : 'unverified'}`}>{g.state}</span> <b>{g.label}</b> <span className="muted">{g.detail}{g.critical ? '' : ' (non-critical)'}</span></div>)}
              </div>
            </div>
            <div className="panel"><h2>Factor contributions — {lead}</h2><FactorTable score={score} /></div>
            <div className="grid2">
              <div className="panel">
                <h2>Data lineage & quality</h2>
                <div className="kv small">
                  <div>Feed / scope</div><div>{f.scope?.provider}/{f.scope?.feed} · conditions {f.scope?.conditionPolicy} · {f.scope?.adjustment} · quote sizes in {f.scope?.quoteSizeUnit}</div>
                  <div>Series source</div><div>{f.seriesSource} · duplicates {f.seriesStats?.duplicates ?? 0} · revisions {f.seriesStats?.revisions ?? 0}</div>
                  <div>Data cutoff</div><div>{both(f.dataCutoff)} (lag {f.cutoffLagMs == null ? 'n/a' : `${Math.round(f.cutoffLagMs / 1000)} s`})</div>
                  <div>Observed</div><div>{Math.round((f.preMarketObserved ?? 0) * 100)}% of the pre-market window · {f.activeMinutes} active · {f.genuineZeroMinutes} genuine zero-volume · {f.missingMinutes} not observed</div>
                  <div>Coverage gaps</div><div>{f.coverageGaps?.length ? f.coverageGaps.map((g) => `${et(g.from)}–${et(g.to)}`).join(', ') : 'none'}</div>
                  <div>Previous close</div><div>{n2(f.prevClose)} {f.prevCloseIssue ? <b className="neg">{f.prevCloseIssue}</b> : ''}</div>
                  <div>Reference price</div><div>{n2(f.refPrice)} ({f.refPriceSource})</div>
                  <div>RVOL method</div><div>{f.rvol?.method} {f.rvol?.ok ? `· n=${f.rvol.sample} · baseline ${Math.round(f.rvol.baseline)} sh${f.rvol.floored ? ' (floored)' : ''}` : `· refused: ${f.rvol?.reason}`}{f.rvol?.flags?.length ? ` · ${f.rvol.flags.join('; ')}` : ''}</div>
                  <div>Volume profile</div><div>{f.profile ? `${f.profile.estimated ? 'ESTIMATED from bars' : 'from trades'} · POC ${n2(f.profile.poc)} · value area ${n2(f.profile.valueLow)}–${n2(f.profile.valueHigh)}` : '—'}</div>
                  <div>Order flow</div><div>{f.orderflow ? `${f.orderflow.method}: est. buy ${f.orderflow.estBuyVolume} / sell ${f.orderflow.estSellVolume} / unclassified ${f.orderflow.unclassifiedVolume}` : 'not available (needs trades + quotes)'}</div>
                  <div>Float / turnover</div><div>{f.turnover ? `${(f.turnover.value * 100).toFixed(2)}% of ${f.turnover.kind} (as of ${f.turnover.asOf})` : 'no dated float'}</div>
                  <div>Auction</div><div>{f.auction?.available ? `${f.auction.messages} NOII messages` : f.auction?.reason}</div>
                  {chart?.cumulativeCheck && <><div>Cumulative feed</div><div>{chart.cumulativeCheck.snapshots} snapshots → counted {chart.cumulativeCheck.counted} shares (original {chart.cumulativeCheck.original}); repeated snapshots add nothing</div></>}
                </div>
                <h3>Missing data</h3>
                {Object.entries(f.missing ?? {}).map(([k, v]) => <div key={k} className="small muted">{k}: {v}</div>)}
              </div>
              <div className="panel">
                <h2>Catalyst sources</h2>
                {chart?.news?.length ? chart.news.map((n, i) => <div key={i} className="small"><a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a> · {n.source}{n.demo ? ' (DEMO)' : ''}<div className="muted">published {both(n.publishedAt)} · first seen {both(n.firstSeenAt)}</div></div>) : <p className="small muted">No news or filings recorded.</p>}
                <h2 style={{ marginTop: 14 }}>Paper plan</h2>
                {confirm?.plan ? (
                  <div className="kv small">
                    <div>Strategy</div><div>{confirm.strategyLabel} ({confirm.strategyKind}) · {confirm.decision}</div>
                    <div>Entry</div><div>{confirm.plan.side} {confirm.plan.qty} sh, trigger {n2(confirm.plan.trigger, 4)}, max entry {n2(confirm.plan.maxEntry, 4)}{confirm.plan.immediate ? ' (marketable after the seal)' : ' (stop-entry)'}</div>
                    <div>Stop / targets</div><div>{n2(confirm.plan.stop, 4)} / {n2(confirm.plan.target1, 4)} / {n2(confirm.plan.target2, 4)}</div>
                    <div>Risk / reward</div><div>${n2(confirm.plan.riskAmount)} / ${n2(confirm.plan.rewardAmount)} → {n2(confirm.plan.rewardRisk)} after costs</div>
                    <div>Invalidation</div><div>{confirm.plan.invalidation}</div>
                    <div>Note</div><div>{confirm.plan.note}</div>
                  </div>
                ) : <p className="small muted">No plan{confirm ? `: ${confirm.reasons.slice(0, 3).join('; ')}` : ' (no sealed decision)'}.</p>}
                {confirm?.confirmation && <>
                  <h3>Opening confirmation ({confirm.direction > 0 ? 'long' : 'short'})</h3>
                  {(confirm.direction > 0 ? confirm.confirmation.long : confirm.confirmation.short).factors.map((x) => <div key={x.key} className="small">{x.status === 'used' ? n2(x.value) : 'missing'} · <b>{x.label}</b> <span className="muted">{x.detail}</span></div>)}
                  <h3>Strategy checks</h3>
                  {confirm.strategies.map((st) => <details key={st.strategy}><summary>{st.label}: {st.pass ? 'PASS' : st.applies ? 'fail' : `n/a (${st.reason})`}</summary>{st.checks.map((c) => <div key={c.key} className="small">{c.ok ? '✔' : '✘'} {c.label} <span className="muted">{c.detail}</span></div>)}</details>)}
                </>}
              </div>
            </div>
          </>
        );
      })()}
    </Loading>
  );
}
