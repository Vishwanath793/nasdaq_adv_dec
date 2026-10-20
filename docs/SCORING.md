# Scoring specification (score-1.0.0)

Code: `src/utils/conviction.js` (pre-open), `src/utils/confirmation.js` (09:35), `src/utils/decision.js`, `src/utils/tradeability.js`.
A score is a **ranking**, not a probability: 80 does not mean an 80% chance of anything.

## 1. Outputs per stock and snapshot

Each snapshot computes the following separately for each stock:
- long setup score
- short setup score
- continuation vs exhaustion classification, with a separate fade score
- volume-evidence score
- data coverage
- data quality
- execution eligibility (gates)
- pre-open outcome

Every snapshot also stores the score version, feature version, configuration hash and snapshot id.

## 2. Formula

For a direction `d` (+1 long, −1 short):

```
factor value v ∈ [0,1]           0.5 = neutral; direction-specific transform (below)
family score  = mean(v of usable factors in the same correlation family)
group score   = mean(family scores in the group)
rawScore      = 100 × Σ_g w_g·group_g / Σ_g w_g            over USABLE groups
coverage      = Σ_g w_g (usable) / Σ_g w_g (all configured) the denominator never shrinks because a source failed
adjustedScore = 50 + (rawScore − 50) × coverage             conservative; raw stays visible
contribution_f = (w_g / Σ usable w) / (#families in g) / (#factors in family) × (v_f − 0.5) × 100
                 (50 + Σ contributions = rawScore)
```

**Correlation families** cap redundancy. For example, shares-RVOL, dollar-RVOL and percentile describe the same activity, so they share one "activity" slot. A group with many similar API columns therefore cannot dominate.

**Factor states.** A factor is in exactly one of three states:
- `used`
- `na` (not applicable). Penalty-only factors such as rejection or choppiness are `na` when the pattern is absent. They count as covered and do not dilute the score.
- `missing`, with a kind: unsupported, not entitled, stale, delayed, not applicable, failed, or insufficient history.

Missing is never silently 0 or 0.5.

## 3. Presets (hypotheses, not fitted optima)

| Group | volumeFirst | equalGroups | priceVolumeNoNews | fullFree | enhanced |
|---|---|---|---|---|---|
| Relative participation (volume) | 20 | 1 | 20 | 20 | 20 |
| Acceleration & persistence (volume) | 15 | 1 | 15 | 15 | 15 |
| Price–volume agreement (volume) | 15 | 1 | 15 | 15 | 15 |
| VWAP & acceptance (volume) | 10 | 1 | 10 | 10 | 10 |
| Price structure & gap | 15 | 1 | 15 | 15 | 15 |
| Market & sector | 10 | 1 | 10 | 10 | 10 |
| Verified catalyst | 10 | 1 | — | 10 | 10 |
| Historical context | 5 | 1 | 5 | 5 | 5 |
| Research indicators (capped ≤5% of total) | — | — | — | 5 | — |
| Auction (NOII, licensed) | — | — | — | — | 15 |

The baselines `gapOnly` (the gap factor only) and `gapRvol` (gap + same-time RVOL only) exist for ablation.

## 4. Volume never picks the side

Participation strength `s ∈ [−1, 1]` (e.g. `log₄(RVOL)`) is combined with **price alignment** `a ∈ [−1, 1]`:
- `a` is the mean of the gap in ATR units divided by 0.75 and the distance from pre-market VWAP divided by 0.75%, each clamped and signed by `d`.
- When `s ≥ 0`: `v = 0.5 + 0.5·s·a`.
- When `s < 0`: `v = 0.5 − 0.3·|s|`.

So:
- heavy volume in the direction of the price move supports that side
- heavy volume against it opposes that side
- volume on a flat price is neutral
- below-normal participation weakens both sides

## 5. Factor transforms (summary — full list in docs/FEATURES.md)

| Factor | Transform |
|---|---|
| Same-time RVOL (cumulative / dollar / last 15 min) | log₄ × price alignment; floored baselines capped at s ≤ 0.5 |
| Clock-normalised acceleration | (last 15 min ÷ same-clock expectation) ÷ (prior 15 min ÷ its expectation); log₂.₅ × alignment |
| Persistence | share of observed minutes since the first trade with activity ≥ 25% of the same-clock expectation; (p − 0.3)/0.5 × alignment |
| Concentration | penalty only: largest minute (or top-3 prints) > 25% of volume, extra penalty if later minutes go quiet |
| Push vs pullback volume | clock-normalised volume rate of minutes moving with `d` ÷ against it; log₂ |
| Progress per activity | gap in ATR units in direction; RVOL ≥ 2 with < 0.2 ATR progress scores 0.3 (exhaustion rule) |
| High-volume rejection | penalty only: heavy bars (≥ 3× same-clock expectation and ≥ 2× the recent median, range ≥ 0.2%) with a ≥ 60% wick against `d` |
| Pre-market break | a material break of the earlier pre-market extreme (≥ 0.15% or 0.1 ATR) that holds on renewed volume = 0.85; a failed break = 0.15 |
| Estimated aggressor imbalance | Lee–Ready estimate, needs trades + quotes; `(buy − sell)/(buy + sell)` ÷ 0.4 |
| VWAP side / time & volume on side / slope / choppiness | distance ÷ 1%; acceptance share; slope ÷ 30 bps; penalty if ≥ 8 crossings in the last hour |
| Gap | gap in ATR ÷ 1 (or gap% ÷ 3 without ATR). **No NSE sweet spot is transferred**; a plain ramp until validated |
| Trend consistency / holding the extreme / beyond yesterday's range | share; 1 − giveback; 0.8 beyond / 0.2 against / n/a inside |
| QQQ / sector ETF / relative strength / breadth | benchmark move ÷ 0.5% / 0.75%; stock − benchmark ÷ 2%; share of the tracked universe moving in `d` (≥ 10 symbols) |
| Catalyst | strongest rule-classified item since the previous close: materiality, specificity and source reliability; signed by category; earnings use measured surprise only when a consensus exists; scaled by price/volume reaction |
| Historical gap continuation / prior trend | the stock's past ≥ 2% gaps (≥ 5 needed); 5- and 20-day returns, close location |
| NOII (enhanced only) | signed imbalance ÷ paired shares ÷ 0.5; side persistence; indicative vs pre-market VWAP ÷ 50 bps |
| Research (CMF, OBV, MFI) | derived from the same bars; a capped family |

## 6. Labels (minimum-evidence policy)

These rules apply in order:

1. **Insufficient evidence.** Either:
   - mandatory inputs are missing (same-time RVOL and price structure), or
   - profile coverage is below 50%.
2. **Strong.** All of these must hold:
   - adjusted ≥ 68 and raw ≥ 70
   - ≥ 3 supporting groups (group score ≥ 0.6), including ≥ 2 volume groups
   - coverage ≥ 75%
   - no volume group below 0.35
   - volume-evidence score ≥ 62
   - data mode LIVE (or DEMO/REPLAY); a DELAYED feed caps the label at moderate
3. **Weak.** Either:
   - the volume-evidence score is below 55, or
   - relative participation is below 0.5 (price without participation).
4. **Moderate.** Adjusted ≥ 58 and ≥ 2 supporting groups.
5. **Weak / none.** Otherwise: adjusted ≥ 50 is weak; below 50 is none.

After labelling:
- If **≥ 2 exhaustion signals** are met in the gap direction, a strong label is capped at moderate, with the reasons listed.
- Continuation and fade evidence are never blended into one score.

## 7. Pre-open outcomes

- **NO TRADE** is the default.
- A blocked gate → NO TRADE.
- Insufficient evidence → WATCH (or NO TRADE when the gates are also unverified).
- Strong or moderate → LONG CANDIDATE or SHORT CANDIDATE, downgraded to WATCH when any of these apply:
  - the gates are unverified
  - long and short are within 5 points
  - the exhaustion checklist is met
- Pre-open snapshots never produce PAPER ENTRY ELIGIBLE.

## 8. Tradeability gates (hard; they take precedence over any score)

Each gate is pass, fail or unknown. A critical unknown prevents an executable decision. The gates:
- halt or suspension (an unknown status is not "not halted")
- data current — a DELAYED feed always fails; otherwise the observation must reach within 90 s of the decision
- enough observation (≥ 80% of the window, ≥ 10 active minutes)
- reference price valid (an unresolved corporate action or a venue-only close fails)
- two-sided, current, uncrossed quote
- spread ≤ 60 bps pre-market (the risk setting at entry)
- liquidity (pre-market ≥ $250k and 20-day median ≥ $5M)
- order fits the displayed size (non-critical; deeper liquidity is unknown)
- LULD context (unknown in extended hours; non-critical, never "safe")
- borrow for shorts (unknown → the short stays hypothetical)
- risk limits

## 9. Opening confirmation (09:35)

- **Window:** [09:30:00, 09:35:00). The seal is at 09:35:00 + 5 s grace, and only records available by then are used.
- **Groups:**
  - price 30 — move, close location, rejection wick, consistent minutes
  - volume 30 — opening RVOL vs historical 09:30–09:35 windows under the same auction policy, push vs pullback
  - VWAP 15 — side of regular-session VWAP, extension in ATR
  - market 15 — QQQ, sector ETF
  - liquidity 10 — spread vs the pre-market median
- **Verdicts:**
  - *rejected*: moved ≥ 0.3% against, or on the wrong side of VWAP with normal or heavy volume, or score < 50
  - *unconfirmed*: flat open
  - *confirmed*: score ≥ 65
  - *weak*: score 50–64
- A strong pre-market score that the open contradicts is reported as downgraded.

**Strategies** are separate, each with its own checks, trigger, stop, targets and invalidation:
- opening-range breakout/breakdown
- gap pullback & recovery (mirrored for gap-downs)
- opening momentum
- gap failure/reversal

The first three are **continuation** strategies. They must agree with the pre-market evidence: a pre-market label of "none" in that direction refuses them. Only the reversal strategy may trade against it.

**Decision at 09:35:**
- The setup must pass all of these:
  - the strategy passes
  - the plan is OK: reward/risk ≥ 1.5 after costs, and the spread is within the limit
  - confirmation is "confirmed" with score ≥ 65 (or, for the reversal strategy, its own checks)
  - all critical gates pass
- Eligible setups are ranked by confirmation score and fill slots under the limits: max open positions, trades per day, per-sector concentration, daily loss, losing streak, and the kill switch.
- Shorts without verified shortability become HYPOTHETICAL shorts, tracked separately.

## 10. Comparison with the NSE app

- **Kept from the NSE app:**
  - equal-weight ("unit") defaults
  - per-factor explanations
  - missing-factor exclusion
  - score caps and blocks
  - separate opening confirmation
  - strategy plans
  - the event-sourced paper ledger
- **Changed for Nasdaq:**
  - Weights are at **group** level with correlation families, because the NSE equal-factor approach lets many overlapping columns dominate.
  - Coverage uses a **fixed** denominator. NSE rescaling silently shrank the denominator.
  - A conservative adjusted score is shown next to the raw score.
  - NSE gap sweet spots, delivery %, FII/DII, futures OI and circuit logic are **not** transferred.
