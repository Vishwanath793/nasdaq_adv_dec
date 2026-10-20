# Reference app inspection and reuse plan

The reference is the NSE Advance/Decline app at `C:\Users\Public\advdec_nse`, used **read-only**. Nothing in that repository was modified. That includes its trading setup, TV research, credentials, the scheduled PERSISTENT order, and its uncommitted work.

## What was inspected

- `CLAUDE.md` (project handoff) and `DEVLOG.md`
- `src/utils/conviction.js`, `tradeability.js`, `decision.js`, `strategies.js`, `paperLedger.js` and `risk.js`
- the architecture and milestone notes for `openingCollector.js`, `confirmation.js`, `tradePlan.js`, `reportCard.js`, `recorder.js` and `marketContext.js`

## Reused (ideas and structure, rewritten for US markets)

| NSE strength | Nasdaq implementation |
|---|---|
| Direction-aware conviction, factor switches and weights, equal-weight defaults | `conviction.js`: long and short scored separately; group weights with an equal-groups baseline; factor switches in Settings |
| Missing-factor exclusion with weight rescaling | Kept the exclusion, but coverage now uses a **fixed configured denominator** and a conservative adjusted score. NSE rescaling let a failed API silently raise the score |
| Per-factor explanations | Every factor shows value, weight in score, contribution, transform, lineage, family and a missing reason |
| Tradeability blocks and score caps | Tri-state gates (pass / fail / unknown). A failed gate blocks; a critical unknown prevents an executable decision |
| Separate opening-window confirmation | 09:30–09:35 window sealed at 09:35 + grace; separate confirmation score and verdict |
| Strategy-specific decisions and plans | ORB, gap pullback (mirrored), momentum, and gap failure as a separate reversal strategy; plans with invalidation |
| Event-sourced paper ledger, risk limits, kill switch | `paperLedger.js`: latency, quote-driven fills, non-reusable displayed size, participation cap, trade-through targets, hypothetical shorts kept separate |
| Recorder, replay, report card | Immutable snapshots per session, research replays stored separately, report card with sample sizes, ablation and walk-forward split |
| Simulated morning for tests | `demoSession.js`: 20 scenario stocks covering every spec §10 case, plus benchmarks and breadth fillers |

## Not transferred (NSE-specific)

- NSE gap sweet spots (0.75–2% / 0.75–3%). These were measured on two NSE days and are not Nasdaq thresholds; the Nasdaq gap factor is a plain bounded ramp.
- Delivery % (no US equivalent).
- FII/DII flows (no stock-level US replacement).
- Futures OI build-up. It is not relabelled as options positioning.
- Circuit limits. US LULD is different: it applies in the regular session and is unknown pre-market.
- NSE pre-open buy/sell quantities. These are not consolidated quotes and not NOII.
- Zerodha charges, MIS leverage, NSE holidays and session times. Replaced by US costs (SEC Section 31 $20.60/M, FINRA TAF), cash-account sizing, and the NYSE/Nasdaq calendar with DST via Intl.

## Stack choice

- Same stack as the reference: Node 22+ ES modules, Express, React 18 + Vite, file storage under `.data/`, SSE for the UI, and `node --test`.
- `src/utils/` holds pure functions shared by live, demo and replay; `src/core/` holds I/O.
