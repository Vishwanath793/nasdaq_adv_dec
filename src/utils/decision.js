/**
 * Decisions (pure). Default for every stock is NO TRADE, with reasons.
 * Outcomes: NO TRADE | WATCH | LONG CANDIDATE | SHORT CANDIDATE | PAPER ENTRY ELIGIBLE.
 * Pre-open snapshots never produce PAPER ENTRY ELIGIBLE; only the sealed 09:35 decision can.
 */

import { confirmOpening } from './confirmation.js';
import { runStrategies, strategySettings } from './strategies.js';
import { buildTradePlan, cleanRiskSettings, tradeBlockers } from './risk.js';

export const OUTCOMES = ['NO TRADE', 'WATCH', 'LONG CANDIDATE', 'SHORT CANDIDATE', 'PAPER ENTRY ELIGIBLE'];
export const DEFAULT_DECISION_SETTINGS = { minConfirmScore: 65, watchScore: 55 };

/** Pre-open outcome for one scored stock. */
export function preOpenOutcome(scored, gates, settings = DEFAULT_DECISION_SETTINGS) {
  const lead = scored.leading > 0 ? scored.long : scored.short;
  const other = scored.leading > 0 ? scored.short : scored.long;
  const reasons = [];
  if (gates.status === 'blocked') return { outcome: 'NO TRADE', reasons: [gates.primaryReason] };
  const label = lead.label.label;
  if (label === 'insufficient evidence') return { outcome: gates.status === 'unverified' ? 'NO TRADE' : 'WATCH', reasons: [`insufficient evidence: ${lead.label.why}`] };
  if (label === 'strong' || label === 'moderate') {
    if (gates.status === 'unverified') reasons.push(`not executable yet: ${gates.primaryReason}`);
    if (other.adjustedScore != null && other.adjustedScore >= lead.adjustedScore - 5) reasons.push('long and short evidence are close: ambiguous');
    if (scored.setup?.classification === 'possible exhaustion / fade' && lead.direction === Math.sign(scored.setup.direction)) reasons.push('continuation scored, but the exhaustion checklist is also met: treat as fade risk');
    const outcome = reasons.length ? 'WATCH' : lead.direction > 0 ? 'LONG CANDIDATE' : 'SHORT CANDIDATE';
    return { outcome, reasons: [`${label} ${lead.direction > 0 ? 'long' : 'short'} conviction (${lead.adjustedScore}): ${lead.label.why}`, ...reasons] };
  }
  if (lead.adjustedScore >= settings.watchScore) return { outcome: 'WATCH', reasons: [`${label} conviction ${lead.adjustedScore}`] };
  return { outcome: 'NO TRADE', reasons: [`${label} conviction ${lead.adjustedScore ?? 'n/a'}`] };
}

/**
 * One stock at 09:35. input: { symbol, sector, w, pre, preScore (scoreStock), gates (entry gates for each dir), market, borrow }
 */
export function evaluateOpening(input, { strategies = {}, risk = {}, decision = DEFAULT_DECISION_SETTINGS } = {}) {
  const st = strategySettings(strategies);
  const rk = cleanRiskSettings(risk);
  const { w, pre, preScore, market } = input;
  const results = runStrategies({ w, pre, market }, st);
  const conf = {
    1: confirmOpening(w, 1, { market, sectorEtf: pre?.meta?.sectorEtf, pre: preScore?.long }),
    [-1]: confirmOpening(w, -1, { market, sectorEtf: pre?.meta?.sectorEtf, pre: preScore?.short }),
  };
  const tried = results.filter((r) => r.pass).map((r) => {
    const plan = buildTradePlan(r.signal, w, rk);
    const c = conf[r.direction];
    // A reversal strategy is judged by its own checks; continuation strategies also need the confirmation verdict.
    const confirmOk = r.kind === 'reversal' ? c.score != null && c.verdict !== 'no data' && c.verdict !== 'unconfirmed' : c.verdict === 'confirmed' && c.score >= decision.minConfirmScore;
    // The open confirms pre-market setups; a continuation entry against pre-market evidence that opposes it
    // (label "none") is not a confirmation. Missing pre-market evidence does not block opening-session analysis.
    const preLabel = preScore ? (r.direction > 0 ? preScore.long : preScore.short)?.label?.label : null;
    const preAgrees = r.kind === 'reversal' || preLabel !== 'none';
    return { r, plan, conf: c, confirmOk: confirmOk && preAgrees, preAgrees, preLabel };
  }).sort((a, b) => (b.plan.ok - a.plan.ok) || (b.confirmOk - a.confirmOk) || ((b.conf.score ?? 0) - (a.conf.score ?? 0)) || ((b.plan.rewardRisk ?? 0) - (a.plan.rewardRisk ?? 0)));
  const best = tried[0] ?? null;
  const direction = best?.r.direction ?? (Math.sign(w?.ret5Pct || pre?.gapPct || 0) || 1);
  const gates = input.gates?.[direction] ?? { status: 'unverified', gates: [], primaryReason: 'gates not evaluated' };
  const reasons = [];
  if (!w?.available) reasons.push(`opening window: ${w?.reason ?? 'unavailable'}`);
  if (!best) {
    reasons.push('no strategy setup');
    for (const r of results) reasons.push(`${r.label}: ${r.applies ? r.checks.filter((c) => !c.ok).map((c) => `${c.label.toLowerCase()} (${c.detail})`).join('; ') || r.reason || 'no signal' : r.reason}`);
  } else {
    if (!best.plan.ok) reasons.push(...best.plan.reasons);
    if (!best.preAgrees) reasons.push(`pre-market evidence opposes a ${best.r.direction > 0 ? 'long' : 'short'} (${best.preLabel}); only the separate reversal strategy may trade against it`);
    else if (!best.confirmOk) reasons.push(`confirmation ${best.conf.verdict} (${best.conf.score ?? 'n/a'})${best.conf.reasons.length ? `: ${best.conf.reasons.join('; ')}` : ''}`);
  }
  if (gates.status !== 'eligible') reasons.push(...gates.gates.filter((g) => g.state !== 'pass' && g.critical).map((g) => `${g.label} ${g.state}: ${g.detail}`));
  const shortNeedsBorrow = direction < 0 && !(input.borrow?.shortable && input.borrow?.easyToBorrow);
  const nonBorrowBlock = gates.gates.filter((g) => g.state !== 'pass' && g.critical && g.key !== 'borrow');
  const setupOk = Boolean(best) && best.plan.ok && best.confirmOk && nonBorrowBlock.length === 0;
  return {
    symbol: input.symbol, sector: input.sector, direction,
    strategy: best?.r.strategy ?? null, strategyLabel: best?.r.label ?? null, strategyKind: best?.r.kind ?? null,
    confirmation: { long: conf[1], short: conf[-1] },
    confirmScore: best?.conf.score ?? conf[direction].score, confirmVerdict: best?.conf.verdict ?? conf[direction].verdict,
    plan: best?.plan ?? null,
    preAgrees: best?.preAgrees ?? true,
    setupOk,
    eligible: setupOk && !shortNeedsBorrow,
    hypotheticalShort: setupOk && shortNeedsBorrow,
    gates,
    reasons,
    strategies: results.map((r) => ({ strategy: r.strategy, label: r.label, kind: r.kind, applies: r.applies, pass: r.pass, direction: r.direction ?? null, reason: r.reason ?? null, summary: r.summary ?? null, checks: r.checks, signal: r.signal ?? null })),
    alternatives: tried.slice(1).map((t) => ({ strategy: t.r.strategy, score: t.conf.score, ok: t.plan.ok, rewardRisk: t.plan.rewardRisk })),
  };
}

/** Rank eligible stocks and fill free slots under the risk limits. */
export function decideOpening(inputs, { strategies = {}, risk = {}, decision = DEFAULT_DECISION_SETTINGS, day = {} } = {}) {
  const rk = cleanRiskSettings(risk);
  const d0 = { killSwitch: false, realised: 0, trades: 0, open: 0, consecutiveLosses: 0, sectors: {}, ...day };
  const evals = inputs.map((x) => evaluateOpening(x, { strategies, risk: rk, decision }));
  const ranked = evals.filter((e) => e.eligible).sort((a, b) => (b.confirmScore ?? 0) - (a.confirmScore ?? 0) || (b.plan.rewardRisk ?? 0) - (a.plan.rewardRisk ?? 0));
  const taken = { ...d0, sectors: { ...d0.sectors } };
  ranked.forEach((e, i) => { e.rank = i + 1; });
  for (const e of evals) {
    e.decision = 'NO TRADE';
    if (e.hypotheticalShort) { e.decision = 'SHORT CANDIDATE'; e.reasons.push(rk.allowHypotheticalShorts ? 'borrow not verified: tracked as a HYPOTHETICAL short, separate from paper entries' : 'borrow not verified'); continue; }
    if (!e.eligible) {
      if (e.strategy && !e.preAgrees) e.decision = 'NO TRADE';
      else if (e.strategy && e.confirmVerdict === 'confirmed') e.decision = e.direction > 0 ? 'LONG CANDIDATE' : 'SHORT CANDIDATE';
      else if (e.strategy) e.decision = 'WATCH';
      continue;
    }
  }
  for (const e of ranked) {
    const blockers = tradeBlockers(taken, rk, e.sector);
    if (blockers.length) { e.decision = e.direction > 0 ? 'LONG CANDIDATE' : 'SHORT CANDIDATE'; e.reasons.push(...blockers); continue; }
    e.decision = 'PAPER ENTRY ELIGIBLE';
    taken.open += 1; taken.trades += 1;
    if (e.sector) taken.sectors[e.sector] = (taken.sectors[e.sector] ?? 0) + 1;
  }
  const order = Object.fromEntries(OUTCOMES.map((o, i) => [o, -i]));
  evals.sort((a, b) => order[a.decision] - order[b.decision] || (b.confirmScore ?? -1) - (a.confirmScore ?? -1));
  return { decisions: evals, settings: { risk: rk, strategies: strategySettings(strategies), decision } };
}
