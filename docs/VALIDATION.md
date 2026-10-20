# Validation method

The generated numbers are in [VALIDATION_RESULTS.md](VALIDATION_RESULTS.md) (`npm run validate`).

## What is validated now (mechanics, on simulated sessions)

- **No look-ahead.** A snapshot computed on the full day equals one computed after deleting every record not available at the decision time (`test/pipeline.test.js`). Late backfills, delayed feeds and news first seen later are invisible to earlier decisions.
- **Determinism.** Replaying a stored session under the same settings gives identical decisions (test plus a check in `npm run validate`).
- **Coverage and labels.** Each spec §10 case has a DEMO scenario and an assertion:
  - large gap on no volume
  - sustained RVOL
  - one-print spike
  - push / light pullback / recovery
  - failed breakout
  - heavy selling with progress
  - absorption-like behaviour
  - missing pre-market volume
  - delayed data
  - IEX/SIP mismatch
  - known and unknown splits
  - missing vs zero minutes
  - cumulative snapshots
  - reconnect gaps
  - duplicates
  - late backfill
- **Paper fills.** Fills never happen before decision + latency; displayed size is never reused; participation is capped; stops can slip; a touched target is not a fill.
- **No synthetic edge.** In validation seeds the moves *after* the decision are randomised, so the report card shows noise-level results. The canonical DEMO seed keeps each scenario's designed outcome so the UI walk-through is readable.

## What real validation needs (not yet possible here)

Recorded LIVE (IEX) or DELAYED (SIP history) sessions. Then:

1. **Horizons.** Returns at 5, 15, 30 and 60 minutes and at the close, in the scored direction, from the first bar after the decision (a reference, not a fill). Also MFE and MAE over 60 minutes.
2. **Score-band results** with bootstrap intervals, plus rank correlation, continuation and fade rates, and no-trade and coverage-failure rates.
3. **Net expectancy after costs** from the paper ledger, with drawdown and execution shortfall (plan entry vs simulated fill).
4. **Results by bucket:** liquidity, market cap, strategy, setup and regime.
5. **Comparisons:**
   - gap only
   - gap + same-time RVOL
   - price + volume without news
   - equal groups
   - the volume-first preset
   - the full free-data model
   - later, + NOII / depth / options when such data exists
6. **Ablation.** `POST /api/ablation` or the Report card button: each family on and off, re-scored from the same records.
7. **Chronological walk-forward.** The earliest 60% of dates is development; the rest is held out. Keep an untouched final period. Report sample sizes; tables with n < 30 are flagged "too small to interpret".
8. **No overfitting.** Do not fit dozens of weights on a few days. Promote an indicator only if it improves held-out results, or if it has a clear risk or quality function.
