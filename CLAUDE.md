# CLAUDE.md — project handoff

Read [DEVLOG.md](DEVLOG.md) first: what was built, tested, and left unverified. The governing spec is `analyser.md.txt`. It is the base prompt plus the "free APIs only + volume-first" addendum, and the addendum overrides the base.

## What this is

- A Nasdaq pre-market conviction analyzer and 09:30–09:35 opening confirmation system.
- Free data only. **PAPER simulation only — live order execution is out of scope.**
- The NSE app at `C:\Users\Public\advdec_nse` is a **read-only reference**. Never modify it: not its trading setup, TV research, credentials, scheduled orders, or uncommitted work.

## Layout

```
src/utils/   pure functions shared by live, DEMO and replay (no I/O)
  clock.js        ET/IST via Intl, NYSE/Nasdaq calendar (fallback 2025–27, unknown years fail closed), phases, snapshot times
  series.js       canonical minute series per scope; availableAt look-ahead filter; missing vs zero; dedupe/corrections; cumulative snapshots
  baseline.js     same-clock RVOL (scope check, split adjustment, min sample, floors)
  features.js     computeFeatures(inst, asOf, ctx): price structure, volume families A–J, quotes, auction, status
  conviction.js   factor registry (FACTORS), groups/families, presets, scoreDirection/scoreStock, labels
  patterns.js     continuation vs exhaustion checklists, absorption inference, fade score
  tradeability.js tri-state gates
  confirmation.js 09:30–09:35 window features and confirmation score/verdict
  strategies.js   ORB, gap pullback (mirrored), momentum, gap failure (reversal)
  risk.js         USD risk settings, US costs (SEC §31, FINRA TAF), sizing, trade plan
  decision.js     pre-open outcomes; 09:35 decision and slot filling
  paperLedger.js  event-sourced ledger; quote-driven fills with latency, displayed-size and participation limits
  pipeline.js     runSnapshot / runConfirmation / simulatePaper / outcomesFor  ← the one pipeline
  reportCard.js   report card, ablation
  demoSession.js  deterministic DEMO day (20 scenarios + benchmarks + fillers)
src/core/    I/O: store (.data/), env (+redaction), http (budget, retry, cache), providers/, registry, probe, sessions, liveSession, settings, cli
server/      Express API + SSE (port 3101)
src/ui/      React + Vite UI (port 5183, proxies /api)
test/        node --test (npm test)
docs/        SETUP, CAPABILITY_MATRIX (generated), FEATURES, SCORING, VALIDATION(+_RESULTS generated), REUSE_PLAN
```

## Rules that matter

- **One pipeline.** Live, DEMO and replay all call `utils/pipeline.js`. Never fork scoring logic per mode.
- **Look-ahead.** Every record needs `availableAt`. Decisions use `buildSeries(…, asOf)`. Stored snapshots are immutable (`writeImmutable`). Changed settings produce research replays, never overwrites.
- **Scope.** Never mix feeds (IEX vs SIP vs Massive) in one calculation, or sum them into "total volume".
- **Missing data** carries a reason and kind. It is never 0 or neutral by default. The coverage denominator is fixed.
- **New fields** go into the feature registry with a role first. Scoring changes are versioned (`SCORE_VERSION`, `FEATURE_VERSION`).
- **Never claim** institutional or smart-money buying, real CVD, or NOII from quote sizes. Up-bar volume is not buy volume.
- **Secrets** stay in `.env` (server only). The UI gets booleans. Run errors through `redact()`.
- **Never** purchase anything, bypass rate limits, rotate keys, or use scraping or undocumented endpoints.
- Do not call an integration "verified" unless `npm run probe` succeeded for it.

## Working on this machine (Windows)

- Node 24 is installed and Python is not. The Bash tool is Git Bash; use the Edit/Write tools for code containing template literals.
- `npm test`, then `npx vite build`, before calling something done.
- Restart the backend after server-side changes. It has no watch mode. `.claude/launch.json` has `backend` and `ui`.
- The DEMO session regenerates from its seed, and the server caches day inputs. If you change the generator, delete `.data/sessions` and rerun `npm run demo`.
