# Nasdaq pre-market analyzer (free data, volume-first, paper only)

This app finds Nasdaq-listed stocks with credible directional setups before the 09:30 ET open, explains every score, and uses 09:30–09:35 to confirm or reject them. It is a research analyzer with a **paper** simulation. It never places live orders.

- Only **free data** is used: Alpaca Basic (IEX), Nasdaq Trader files, FINRA files, SEC EDGAR, Finnhub, Alpha Vantage, Massive and FRED free tiers.
- **Volume and price–volume behaviour drive 60%** of the default conviction weight.
- Volume **never** decides long vs short on its own.
- The app always shows how much data it actually had: venue coverage, delays, gaps, refused baselines.

## Quick start

```bash
npm install
```

```bash
npm run server
```

```bash
npm run dev
```

Open http://localhost:5183 and click **Run DEMO session**. Or run `npm run build` and use http://localhost:3101 with only the server running.

## Modes

| Mode | Data | Can it make a current decision? |
|---|---|---|
| **DEMO** | Deterministic simulated session with fictional symbols (`ZPPR`, `ZDWN`, …), labelled everywhere | demo only |
| **LIVE LIMITED-COVERAGE** | Alpaca IEX real-time (one venue), same-feed RVOL baselines | yes, on paper; IEX coverage is disclosed |
| **DELAYED CONSOLIDATED RESEARCH** | Alpaca SIP history ≥ 15 min old | **never**: the "current data" gate fails by design |
| **HISTORICAL REPLAY** | Any recorded session, through the same code | reproduces the original decisions |
| ENHANCED | Adds NOII; needs a paid licence | model and normaliser are implemented; data is simulated in DEMO only |

## Pages

- **Pre-market analyzer** — snapshots at 09:20, 09:25, 09:28 and the final pre-open time; market and breadth (with denominators); the main table:
  - gap and ATR gap, pre-market $ volume, same-time RVOL with its sample size
  - spread, catalyst, auction, long and short scores with labels, volume evidence
  - coverage, data badges, setup, outcome, eligibility and primary reason
- **Auction monitor** — NOII evolution and timeline from 09:25 (early) through 09:28 (full) to final. Simulated in DEMO; unavailable on free data.
- **Opening confirmation** — the sealed 09:35 decision: strategy, verdict, plan (trigger, stop, targets, R/R after costs) and reasons.
- **Stock detail** — pre-market plus regular-session chart with separate VWAPs, the opening range and plan levels. Also shows:
  - factor contributions, supporting and opposing evidence
  - continuation and exhaustion checklists
  - gates, lineage, missing data, catalyst sources
- **Paper** — positions, fills and exits after costs; hypothetical shorts kept separate; kill switch (LIVE).
- **Report card** — score bands with confidence intervals, rank correlation, MFE/MAE, results by label, liquidity, market cap and setup, confirmation verdicts, paper results, and an ablation across presets.
- **Providers & settings** — the capability matrix with live probe results, request budgets, the live collector, the Nasdaq universe, and scoring and risk settings.

Every page shows ET and IST. DEMO, REAL-TIME, DELAYED, STALE, PARTIAL and REPLAY states are shown as badges.

## Commands

| Command | What it does |
|---|---|
| `npm test` | 46 tests: DST/holidays, snapshot boundaries, late events, NOII placeholders and side mapping, halts, duplicate/corrected trades, reconnect gaps, quote-size units, splits, RVOL and missing baselines, coverage, minimum-evidence labels, no-look-ahead, feed scope, replay determinism, paper-fill timing and liquidity limits, provider parsers |
| `npm run demo` | Generate and analyse the deterministic DEMO day → `.data/sessions/` |
| `npm run replay -- <sessionId> [--preset name]` | Replay a stored session (stored as a research copy) |
| `npm run validate` | 12 simulated sessions + report card + ablation + determinism → `docs/VALIDATION_RESULTS.md` |
| `npm run probe` | Call each configured free source once and record what actually works |
| `npm run registry` | Regenerate `docs/CAPABILITY_MATRIX.md` |

## Documents

- [docs/SETUP.md](docs/SETUP.md) — free API keys, live day, recording and replay, storage and budget estimates
- [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) — free-source registry, documented vs live-verified
- [docs/FEATURES.md](docs/FEATURES.md) — feature dictionary, roles and source lineage
- [docs/SCORING.md](docs/SCORING.md) — formulas, presets, labels, gates, confirmation, strategies
- [docs/VALIDATION.md](docs/VALIDATION.md) and [docs/VALIDATION_RESULTS.md](docs/VALIDATION_RESULTS.md) — method and the generated results
- [docs/REUSE_PLAN.md](docs/REUSE_PLAN.md) — what was reused from the NSE app and what was deliberately not transferred
- [DEVLOG.md](DEVLOG.md) — what was built, tested and left unverified

## Live-verified vs unverified (as of 2026-10-20)

- **Live-verified (keyless):**
  - Nasdaq Trader symbol directory: 5,631 rows, file creation time parsed.
  - Nasdaq Trader halts RSS.
  - FINRA Reg SHO daily short-sale volume file for 2026-10-19.
- **Implemented, fixture-tested, NOT live-verified** (no keys configured on this machine):
  - Alpaca IEX REST and stream, SIP history, calendar, assets, splits and news
  - Finnhub
  - SEC EDGAR (a request without a contact e-mail correctly got HTTP 403)
  - Alpha Vantage
  - Massive
  - FRED
- **Not available on free data:** NOII and depth, OPRA options, futures, borrow fees, Nasdaq-100 constituents.
- **Not yet run during market hours:**
  - the live collector, scheduled snapshots, the live 09:35 seal and live paper fills
  - the Alpaca quote-size unit (run `npm run probe`)

## Important

Scores rank setups; they are not probabilities and not recommendations. The thresholds and weights are hypotheses until recorded live sessions validate them. The DEMO and validation sessions are simulated and say nothing about real-market performance.
