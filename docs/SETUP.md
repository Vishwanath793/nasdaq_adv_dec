# API setup guide (free sources only)

Nothing here costs money. No source needs a payment card, a trial or promotional credits.
Every key is optional: without keys you still get the DEMO session, replay, the report card, and the keyless Nasdaq Trader and FINRA files.

## 1. Install and run

```bash
npm install
```

```bash
npm run server
```

```bash
npm run dev
```

- The backend runs on http://localhost:3101 and the UI on http://localhost:5183. The UI proxies `/api` to the backend.
- Alternatively, run `npm run build` once, then `npm run server` serves the built UI at http://localhost:3101.
- To get a full day to explore immediately, click **Run DEMO session** in the header, or run `npm run demo`.

## 2. Keys (copy `.env.example` to `.env`)

| Variable | Where to get it (free) | What it enables |
|---|---|---|
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | alpaca.markets → sign up → **Paper** account → API keys | LIVE LIMITED-COVERAGE (IEX real-time stream, 30 symbols); same-feed minute history for RVOL baselines; SIP history ≥15 min old; trading calendar; shortable / easy-to-borrow flags; split ratios; Alpaca news |
| `ALPACA_QUOTE_SIZE_UNIT` | — | Set to `round_lots` or `shares`. Run `npm run probe`: it reports what your account returns |
| `FINNHUB_API_KEY` | finnhub.io/register | Company news, profile (industry, shares outstanding), earnings actuals |
| `SEC_USER_AGENT` | Your own name and e-mail, e.g. `Jane Doe jane@example.com` | SEC filings (8-K, 424B, S-3…) with acceptance times; dated shares outstanding. SEC refuses requests without it (HTTP 403) |
| `ALPHAVANTAGE_API_KEY` | alphavantage.co/support/#api-key | Earnings calendar with consensus estimate (fetched once a day; the free limit is 25 requests/day) |
| `MASSIVE_API_KEY` | massive.com (formerly Polygon.io) → free Stocks Basic | End-of-day consolidated minute aggregates for historical research |
| `FRED_API_KEY` | fred.stlouisfed.org → API keys | Display-only macro context |

Keys are read only by the server. The browser sees only *configured: yes/no* booleans. Keys are redacted from every error message and log, and `.env` is gitignored.

## 3. Verify what actually works

```bash
npm run probe
```

The probe calls each configured source once and writes `.data/probe-results.json`. The **Providers & settings** page shows those results next to the documented capability matrix. An adapter with passing fixture tests is **not** "verified" until the probe succeeds with your key.

You can regenerate the capability matrix document with:

```bash
npm run registry
```

## 4. Live day (LIVE LIMITED-COVERAGE)

- Start the backend before 09:15 ET. That is 18:45 IST while the US is on daylight time and 19:45 IST in US winter; the app always shows both clocks.
- Then click **Start LIVE limited-coverage collector** on the Providers page, or call `POST /api/live/prepare`.
- What the collector does:
  - It screens all eligible Nasdaq-listed common stocks with Alpaca snapshots.
  - It streams up to 30 candidates over IEX.
  - It polls the benchmark ETFs once a minute.
  - It seals snapshots at 09:20, 09:25, 09:28 and the configured final time (default 09:29:50), and seals the opening decision at 09:35:05.
  - It runs paper fills from live IEX quotes.
- Snapshots whose time has already passed when you start are recorded as **MISSED**, never produced late.
- The shortlist is frozen from 09:00 so subscription rotation cannot open observation gaps near the open.

**Limitations you should know:**
- IEX is one venue. Its volume is a small share of US volume.
- RVOL compares IEX today with IEX history only.
- Quotes and spreads are IEX's own book, not the NBBO.
- NOII (opening auction imbalance) is not available on any free source; auction factors stay unavailable.

## 5. Recording and replay

- Every run stores the following under `.data/sessions/<date>-<mode>[-s<seed>]/`:
  - immutable snapshots
  - the sealed 09:35 decision
  - the paper event log
  - after-the-fact outcomes
  - for LIVE runs, the assembled day input (`input.json.gz`) and the raw stream (`.data/raw/<date>/`)
- Replay a stored session through the same code:

  ```bash
  npm run replay -- 2026-10-19-DEMO-s20261019
  ```

  ```bash
  npm run replay -- 2026-10-19-DEMO-s20261019 --preset equalGroups
  ```

  Replays are stored as research copies under `research/`. Originals are never overwritten.

## 6. Validation

```bash
npm run validate
```

This builds 12 simulated sessions, runs the report card, ablation and a determinism check, and writes `docs/VALIDATION_RESULTS.md`. Simulated sessions validate the mechanics only.

## 7. Storage and request budget

- **Storage:** a session with about 35 tracked symbols stores about 8 MB of snapshots, mostly per-factor explanations. A LIVE IEX stream for 30 symbols writes about 20–60 MB of raw NDJSON per day: all trades and bars, quotes sampled to one per second. `GET /api/status` reports total storage.
- **Alpaca (200/min):**
  - preparing a day: about 11 snapshot calls for about 5,000 symbols, plus about 25–40 history calls
  - during the day: 1 benchmark poll per minute
- **Finnhub:** news refresh every 5 minutes for the 30 candidates is about 6 calls/min, inside the free limit.
- **Alpha Vantage:** 1 call per day.
- **SEC:** at most 8 requests/second.
- **Remaining quotas:** shown on the Providers page.
