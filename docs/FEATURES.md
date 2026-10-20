# Feature dictionary and source lineage (feat-1.0.0)

Code: `src/utils/features.js`, plus `baseline.js`, `series.js`, `orderflow.js`, `auction.js`, `catalyst.js` and `patterns.js`.

Every field has exactly one role:
- **D** — directional evidence (scored)
- **L** — liquidity / execution evidence (gates, sizing, fills)
- **R** — risk filter (hard gate or penalty)
- **C** — market / regime context
- **X** — research-only (capped family or report card)
- **V** — display-only

A field enters scoring only through the factor registry (`FACTORS` in `conviction.js`), by a versioned change. New API fields are never scored on discovery.

## Lineage rules

- **One canonical source per calculation.** These are never summed with each other:
  - Live: Alpaca IEX minute bars, with the IEX trade stream kept alongside for detail only.
  - Demo: simulated bars.
  - Research: SIP history or Massive aggregates.
- **Scope** = provider / feed / trade-condition policy (`cond-v1`) / adjustment. RVOL refuses a different scope, so IEX today is never divided by SIP history.
- **Timestamps on every record:**
  - event time `t`
  - `availableAt`: the local receive time for live data, or the fetch time for REST backfills
  - provider ids where available
- `buildSeries(…, asOf)` drops anything not yet available. That includes later corrections and backfills, so snapshots are reproducible and free of look-ahead.
- **Missing vs zero:** a minute without a bar counts as zero volume only inside an observed coverage interval (stream connected, or the REST range actually queried).
- **News and filings** keep three times: publication (`publishedAt`, SEC `acceptanceDateTime`), first seen (`firstSeenAt`) and updated. Only items first seen by the decision time are used.

## Price structure

| Field | Units | Role | Source / definition |
|---|---|---|---|
| prevClose | $ | D (reference) | Live: Alpaca **SIP** daily bar (consolidated official close). A fallback to the IEX venue close is flagged as an issue that fails the reference gate. Demo: simulated |
| refPrice, refPriceSource | $ | D | last eligible trade (price-eligible conditions); else the quote midpoint, labelled |
| gapPct, gapAtr | %, ATR | D | (ref − prevClose)/prevClose; ÷ Wilder ATR(14) from completed daily bars |
| afterHoursMovePct / overnightMovePct | % | V | when previous after-hours / overnight data exists |
| pm.open/high/low/close, pmVwap | $ | D | pre-market minute bars; **pre-market VWAP is separate from regular-session VWAP** |
| distVwapPct, distPmHighPct, distPmLowPct, pullbackDepth | %, share | D | relative to the pre-market VWAP / extremes |
| returns r1/r5/r15/r30/r60 | % | D (trend), X | ref vs price N minutes earlier |
| trendConsistency | share | D | 5-minute steps over the last 30 minutes in the gap direction |
| prevRangePosition, beyondPrevRange | share, ±1 | D | vs the previous day's high/low |
| hist.atr14, realizedVol20, ret5, ret20, closeLocation, distSma20/50/200 | various | C | daily bars (≥ 15 / 21 / 20 / 50 / 200 sessions needed, otherwise missing) |
| hist.gapContinuationRate (+ sample) | rate | C | the stock's prior ≥ 2% gaps: did open→close continue? Needs ≥ 5 gaps |

## Participation (volume families A–J)

| Field | Units | Role | Definition |
|---|---|---|---|
| cumVolume, cumDollar (+ cumDollarExact) | sh, $ | D (via RVOL), L | eligible volume since the session start. Dollars = Σ price × size from trades; else bar VWAP × volume; else close × volume, labelled approximate |
| vol1/5/15/30, dollar1/5/15/30 | sh, $ | L, V | last N minutes |
| tradeCount, avgTradeSize | n, sh | V | when supplied |
| activeMinutes, observedMinutes, activeShare, genuineZeroMinutes, missingMinutes | n | R (gate), V | minute grid over [start, asOf) |
| lastTradeAgeMs | ms | V | activity, **not** a freshness gate (freshness = how far the observation reaches) |
| **rvol** (same-time) | × | **D** | today [start, t) ÷ **median** of the same ET clock interval over ≤ 20 comparable completed sessions of the same scope. Reports sample, method, MAD robust z, percentile, exclusions; floors tiny baselines (2,000 shares) |
| rvolDollar | × | D (same family as rvol) | same, in dollars |
| rvol15 | × | D | rolling last-15-minute same-clock window |
| accel (recentVsExpected, priorVsExpected, ratio, state) | ratio | D | clock-normalised, so the natural rise toward 09:30 is not "unusual"; expanding ≥ 1.3, fading ≤ 0.7 |
| rawRateRatio | ratio | V | the un-normalised last 15 vs prior 15 minutes (display only) |
| persistence, longestActiveRun | share, min | D | meaningful-activity minutes since the first trade |
| largestMinuteShare, top3PrintShare, postSpikePersistence | share | R (penalty) | a one-print spike followed by silence is not sustained participation |
| pvLong / pvShort (pushRate, pullRate, pushPullRatio, progressAtr) | ratio, ATR | D | clock-normalised volume on minutes moving with / against the direction |
| heavyRejections.up/down | bars | R (penalty) | heavy bars in the last 60 minutes with a ≥ 60% wick |
| breaks.up/down (failed, level, volumeRatio) | — | D | a material break of the earlier pre-market extreme, holding or failed |
| vwap.timeAboveVwap, volumeAboveVwapShare, vwapSlopeBps15, vwapCrossings, vwapCrossings60 | share, bps, n | D / R | running pre-market VWAP |
| profile (POC, value area, estimated flag) | $ | V | from trades = exact; from bars = **estimated** (volume spread evenly across each bar's range) |
| turnover (value, kind, asOf) | share | C / V | volume ÷ **dated** float or shares outstanding, labelled with which it is; never invented |
| orderShareOfVol30 | share | L | proposed order ÷ last-30-minute volume |
| orderflow (estBuyVolume, estSellVolume, unclassifiedVolume, coverage, imbalance) | sh | D (capped as a family) | Lee–Ready estimate; method and uncertainty documented; never "institutional" |
| research (obvNorm, cmf20, mfi14, adNorm, vptPct) | — | X | derived transformations of the same bars; capped research family |

## Liquidity and quotes

| Field | Units | Role | Definition |
|---|---|---|---|
| quote.bid/ask/mid, quoteAgeMs | $, ms | L | latest quote available at asOf. On IEX this is the IEX book, **not the NBBO** |
| bidSizeShares/askSizeShares (sizeUnit, roundLot) | sh | L | converted from round lots when the provider reports lots, using the instrument's round-lot size (not always 100) |
| spreadBps, medianSpreadBps, spreadStability | bps, 0–1 | L / R | last 15 minutes |
| crossedShare, lockedShare, crossedNow | share | R | invalid or persistently crossed markets fail the quote gate |
| topOfBookImbalance | −1..1 | V | displayed size only; **not** order flow, not intent |

## Auction (NOII; licensed feeds only)

| Field | Role | Definition |
|---|---|---|
| side, pairedShares, imbalanceShares, signedImbalance | D | normalised from ITCH (B/S/N/O) or Databento (B/A/N) codes |
| imbalanceToPaired, imbalanceToTypicalCross | D | signed imbalance ÷ paired shares; ÷ typical opening-cross volume |
| pairedGrowth, persistence, sideChanges, refChangeBps1m | D | evolution across messages |
| nearPrice/farPrice/nearFarAvailable, nearFarDivergenceBps | D / V | **unavailable before about 09:28**; placeholders (0 / sentinel) become null, never $0 |
| indicativeVsVwapBps, agreesWithPreMarket | D | vs pre-market VWAP and the pre-market direction |
| stages.early/main/latest | V | 09:25 → 09:28 → final |

The realised cross price and volume are recorded after the open only and are never used in earlier snapshots.

## Status, events, positioning

| Field | Role | Source |
|---|---|---|
| halt (halted, current, statusKnown) | R | Nasdaq Trader halts RSS (polled, first-seen recorded); Alpaca status messages when streamed. Not checked → unknown |
| borrow (shortable, easyToBorrow, asOf) | L | Alpaca asset flags (not a borrow-fee quote). Unknown → hypothetical short |
| news / filings → catalyst | D | Finnhub, Alpaca news, SEC submissions; deterministic rules (`catalyst.js`); untrusted text is only pattern-matched |
| FINRA short-sale volume (previous day) | X | available from 18:00 ET on the trade date; **not short interest** |
| LULD | R (unknown pre-market) | bands apply in the regular session; extended-hours values are unknown, never "unrestricted" |

## Excluded or not transferred (and why)

- **NSE gap sweet spot, delivery %, FII/DII flows, futures OI build-up, circuit-room logic, NSE pre-open buy/sell quantities.** They have no Nasdaq equivalent, or they would be mislabelled.
- **Finnhub quote volume and Twelve Data extended hours.** No volume, or not free.
- **Quote sizes as an "imbalance" or NOII proxy.** Forbidden by design.
- **Options (OPRA), futures, dealer positioning, borrow fees.** No free source with genuine timestamps. These are not implemented and are shown as unavailable.
- **Nasdaq-100 constituents.** Licensed data. The universe view states that Nasdaq-listed is not the Nasdaq-100.
