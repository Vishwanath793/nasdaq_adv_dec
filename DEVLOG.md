# DEVLOG

## 2026-10-20 — Session 1: initial build

**Request:** build the analyzer from `analyser.md.txt` (base spec + free-APIs-only, volume-first addendum).

### Stage 1 — Reference inspection
- Found the NSE app at `C:\Users\Public\advdec_nse` and read it read-only: CLAUDE.md, conviction, tradeability, decision, strategies, paper ledger and risk. The reuse plan is in `docs/REUSE_PLAN.md`. Nothing in that repo was touched.
- Also found `C:\Users\Public\US_Market`, an earlier, separate Nasdaq attempt with the same spec. It was left untouched and not reused; this project is independent.

### Stage 2 — API verification (docs read 2026-10-20)
- **Alpaca Basic:** IEX-only real time, 30 WebSocket symbols, 200 historical calls/min, history since 2016, and the latest 15 minutes of SIP are unavailable.
- **Massive Basic:** 5 calls/min, 2 years, end-of-day data, minute aggregates.
- **IEX hours:** 08:00–17:00 ET per a 2015 IEX notice (to be verified with the probe).
- **SEC Section 31 fee:** $20.60/M from 2026-04-04.
- **Live keyless probes OK:** Nasdaq symbol directory (5,631 rows), halts RSS, FINRA 2026-10-19 file.
- **SEC** returned 403 without a contact User-Agent, as expected; this machine has no SEC_USER_AGENT.
- **Alpaca/Finnhub** returned 401 without keys, as expected.

### Stage 3 — Clock, universe, adapters, storage, demo
- **Works:**
  - ET/IST via Intl with a DST-safe offset cache; NYSE/Nasdaq holidays and early closes for 2025–27, with unknown years failing closed; snapshot schedule and phases
  - Nasdaq universe classification (common, ADR toggle, ETF list, test issues, warrants, rights, units, preferred, debt)
  - all adapters with pure parsers
  - budget-aware HTTP: limits, priority queue, 429 Retry-After, backoff with jitter, TTL cache, in-flight de-duplication, persisted daily counts
  - file store with immutable snapshots
  - DEMO day: 20 scenarios (every §10 case), 11 benchmark ETFs, 16 breadth fillers
- **Tested:** clock, data and provider test files.

### Stage 4 — Features and explainable scoring
- **Works:** the feature engine (families A–J, price structure, quotes, order-flow estimate, auction, status) and the factor registry (32 factors, 10 groups, correlation families). Also:
  - presets: volume-first, equal groups, gap only, gap+RVOL, price+volume without news, full free, enhanced
  - fixed-denominator coverage and the adjusted score
  - minimum-evidence labels
  - continuation and exhaustion checklists
- **Fixes made after the first smoke runs:**
  - A 9% gap on no volume was labelled "moderate". Labels now need volume evidence and normal participation.
  - A long ORB fired against strong pre-market short evidence. Continuation entries now require pre-market agreement; only the reversal strategy can trade against it.
  - Heavy-rejection and failed-break detectors fired on noise. They now need material moves.
  - Raw NOII was not normalised (side lost). It is now normalised in features.
  - VWAP choppiness is measured per hour, not per session.
- **Tested:** scoring tests (coverage, side neutrality of volume, minimum evidence, research cap, contributions add up, gates).

### Stage 5 — Auction, news, enrichment
- **NOII:** model and normaliser for the ITCH and Databento conventions. Early placeholders become unavailable, never $0. Paid, so DEMO only.
- **Catalysts:** deterministic rules (shelf ≠ priced offering; earnings need a consensus; syndication de-duplicated; first-seen gating). SEC filings carry acceptance times.

### Stage 6 — Confirmation and paper
- **Works:**
  - the 09:30–09:35 window sealed at 09:35:05; late records ignored and counted
  - auction volume policy per feed
  - four strategies with plans and invalidation
  - US costs and USD risk limits, including sector concentration
  - hypothetical shorts kept separate
  - paper ledger with latency, displayed-size consumption, participation cap, stop slippage and trade-through targets
- **Tested:** paper tests and pipeline tests.

### Stage 7 — UI, report card, validation
- **Works:**
  - 7 pages (analyzer, auction, confirmation, stock detail with chart, paper, report card with ablation, providers and settings)
  - SSE refresh
  - checked in the in-app browser against the DEMO session
- **Validation** (`npm run validate`, 12 simulated sessions): replay determinism IDENTICAL.
  - Validation seeds randomise post-decision moves. The first run without this showed a fake "97% win rate", which was fixed.
  - Results are now noise-level, as they should be on synthetic data.

### Test status
`npm test`: 46 tests, all passing. `npx vite build` passes.

### Not verified / open items
- **No keys configured.** None of these has been live-called: Alpaca (REST and stream), Finnhub, SEC, Alpha Vantage, Massive, FRED.
- **The live collector** (`src/core/liveSession.js`) has never run during market hours. Unverified:
  - the screening heuristic
  - stream status codes for halts
  - the coverage bookkeeping
  - the actual IEX pre-market start time
- **Alpaca quote-size unit** (round lots vs shares): run `npm run probe` with keys.
- **FINRA TAF rate** ($0.000166/share, max $8.30) is from 2024; check FINRA Schedule A.
- **Sector mapping** for live symbols is empty by default (Settings `sectorMap`), so the sector factor is "missing" live until it is configured. There is no free licensed classification source.
- **DELAYED CONSOLIDATED mode** is documented and its gates are enforced, but there is no dedicated UI flow yet. Use the SIP history via the live collector, or a replay.
- **Storage:** snapshots are about 2 MB each, mostly per-factor explanations. Compress them if storage becomes a concern.

### Next steps
1. Add free Alpaca keys, then run `npm run probe` and record the results.
2. Run the collector live one morning; check coverage, MISSED handling, the seal and paper fills.
3. Accumulate recorded sessions; only then look at the report card and ablation. Do not tune weights on a few days.
