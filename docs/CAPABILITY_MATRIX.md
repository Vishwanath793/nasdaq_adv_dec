# Free-source capability matrix

Generated from `src/core/registry.js` (documented capability) and `.data/probe-results.json` (live probe). Documented ≠ verified: the last column only says "verified" when a live call succeeded.

| Source | Product | Needs | Real-time / delay | Volume | Extended hours | History | Limits | Role | Status | Live verification |
|---|---|---|---|---|---|---|---|---|---|---|
| Alpaca | Market Data API — Basic (free), IEX feed | ALPACA_KEY_ID, ALPACA_SECRET_KEY | real-time, IEX venue only | yes — venue-specific (IEX), not consolidated | partial (IEX sessions only; do not assume 04:00 coverage) | since 2016 | 200 historical calls/min; 30 WebSocket symbols | primary live price/volume (LIVE LIMITED-COVERAGE) | implemented | not probed (key not configured) |
| Alpaca | Market Data API — Basic, SIP historical (≥15 min old) | ALPACA_KEY_ID, ALPACA_SECRET_KEY | DELAYED (≥15 min) | yes — consolidated | yes (04:00–20:00 ET in consolidated data) | since 2016 | shared 200 calls/min | delayed research / historical replay | implemented | not probed (key not configured) |
| Alpaca | Trading API (paper) — calendar & assets | ALPACA_KEY_ID, ALPACA_SECRET_KEY | reference data | n/a | n/a | calendar 1970–2029 | 200 calls/min | reference / execution eligibility | implemented | not probed (key not configured) |
| Nasdaq Trader | Symbol directory nasdaqlisted.txt | none | refreshed by Nasdaq during the day; file creation time recorded | no | n/a | current only (we version daily copies) | courtesy polling (we cache 6 h) | universe / reference | implemented | verified 2026-10-20: {"rows":5631,"createdAt":"2026-10-20T01:31:00.000Z"} |
| Nasdaq Trader | Trade halts RSS | none | RSS (ttl 1 min) — NOT a low-latency status stream | no | yes | current day(s) | polled ≤ once/minute | risk filter | implemented | verified 2026-10-20: {"items":16} |
| SEC | EDGAR submissions & XBRL company concept | SEC_USER_AGENT (name + contact email) | filings appear after acceptance (acceptanceDateTime) | no | n/a | full filing history | ≤10 requests/second | catalyst / float context | implemented | Not verified: a request without a contact e-mail got HTTP 403 (expected). Set SEC_USER_AGENT and run the probe. |
| FINRA | Reg SHO daily short-sale volume files | none | published after the trading day (treated as available 18:00 ET) | short-sale volume only | n/a | daily files | courtesy | research-only (short-sale volume ≠ short interest, not a real-time signal) | implemented | verified 2026-10-20: {"symbols":12329,"date":"2026-10-19"} |
| Finnhub | Free tier: company news, profile2, earnings calendar | FINNHUB_API_KEY | news near real time | not used (free quote has no volume; trade-stream venue scope undocumented) | not used | news ~1 year on free tier (verify) | commonly 60 calls/min, 30/s (verify with probe) | catalyst / enrichment | implemented | not probed (key not configured) |
| Alpha Vantage | Free key — EARNINGS_CALENDAR (CSV) | ALPHAVANTAGE_API_KEY | daily | not used | not used (premium intraday not assumed) | 3-month horizon | 25/day (we use 1/day) | catalyst expectations (supplementary) | implemented | not probed (key not configured) |
| Massive (formerly Polygon.io) | Stocks Basic (free): end-of-day aggregates | MASSIVE_API_KEY | END OF DAY — not a live feed | yes — consolidated (historical only) | yes in minute aggregates (verify) | 2 years | 5 calls/min | historical research (never mixed with IEX scope) | implemented | not probed (key not configured) |
| FRED / ALFRED | Daily macro observations | FRED_API_KEY | daily observations, published with lag | n/a | n/a | long; ALFRED vintages for point-in-time | generous | display-only context | implemented (display only) | not probed (key not configured) |
| Twelve Data | Basic (free) | TWELVEDATA_API_KEY | regular-session data | extended-hours data requires a paid plan and has no volume | paid only | — | 8/min | excluded — adds no distinct free capability (no free pre-market volume); not integrated to avoid redundant API counts | excluded | not probed (key not configured) |
| Nasdaq (TotalView-ITCH NOII) / Databento XNAS.ITCH | Opening-cross imbalance (NOII) | paid licence | — | paired/imbalance shares | 09:25 early / 09:28 full dissemination | — | — | enhanced profile only | unavailable (paid) | not probed (key not configured) |
| — | Undocumented website endpoints / scraping libraries | none | — | — | — | — | — | excluded by policy (not a supported exchange API) | excluded | not probed (key not configured) |

## Details

### Alpaca — Market Data API — Basic (free), IEX feed

- Endpoints: GET /v2/stocks/bars (1Min, feed=iex); GET /v2/stocks/trades; GET /v2/stocks/quotes; GET /v2/stocks/snapshots; wss://stream.data.alpaca.markets/v2/iex (trades, quotes, bars, statuses)
- Entitlement: Free Basic plan (paper account). No payment card required.
- Coverage: IEX executions/quotes only — a small share of US volume. IEX hours documented 08:00–17:00 ET (IEX 2015 notice; verify); the app measures observed coverage.
- Timestamps: RFC-3339 nanosecond event times; local receive time recorded
- Restrictions: Display/redistribution per Alpaca terms; personal research use.
- Features enabled: Pre-market participation (IEX scope); Same-time RVOL vs IEX history (same scope only); Quotes/spread (IEX book, not NBBO); Opening window; Paper fills (IEX top of book); Aggressor estimate (trades+quotes)
- Fallback: Without keys: DEMO and REPLAY only. Never substituted for SIP.

### Alpaca — Market Data API — Basic, SIP historical (≥15 min old)

- Endpoints: GET /v2/stocks/bars?feed=sip (end ≤ now − 15 min); GET /v2/stocks/trades?feed=sip
- Entitlement: Free Basic: historical SIP except the latest 15 minutes
- Coverage: consolidated (all US venues)
- Timestamps: event times; data cutoff = now − 15 min
- Restrictions: as above
- Features enabled: DELAYED CONSOLIDATED RESEARCH mode; Consolidated same-time baselines for research; Replay/backtests with consolidated volume
- Fallback: Shown with its true cutoff; can never produce a current 09:28 conviction.

### Alpaca — Trading API (paper) — calendar & assets

- Endpoints: GET /v2/calendar; GET /v2/assets/{symbol} (shortable, easy_to_borrow); GET /v1/corporate-actions (splits, Market Data API)
- Entitlement: Free paper account
- Coverage: US equities
- Timestamps: dates
- Restrictions: —
- Features enabled: Verified exchange calendar (cross-checks the fallback table); Shortability/ETB flags for paper shorts (not borrow fees); Split ratios for baseline adjustment
- Fallback: Fallback holiday table 2025–2027; unknown years fail closed. Shorts without flags stay hypothetical.

### Nasdaq Trader — Symbol directory nasdaqlisted.txt

- Endpoints: https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt
- Entitlement: Public, keyless
- Coverage: All Nasdaq-listed securities (incl. ETFs, test issues)
- Timestamps: File Creation Time footer (ET)
- Restrictions: Nasdaq Trader terms
- Features enabled: Universe: Nasdaq-listed common stocks, ADR toggle, separate ETF list, test-issue exclusion; Round-lot size; Financial status flags
- Fallback: Last stored copy, labelled with its date.

### Nasdaq Trader — Trade halts RSS

- Endpoints: https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts
- Entitlement: Public, keyless
- Coverage: Halts on Nasdaq-listed and other securities
- Timestamps: halt/resume ET wall clock; first-seen time recorded
- Restrictions: Nasdaq Trader terms
- Features enabled: Halt gate (hard block); Resumption times
- Fallback: If not polled: halt status UNKNOWN (never "not halted").

### SEC — EDGAR submissions & XBRL company concept

- Endpoints: https://www.sec.gov/files/company_tickers.json; https://data.sec.gov/submissions/CIK##########.json; https://data.sec.gov/api/xbrl/companyconcept/CIK…/dei/EntityCommonStockSharesOutstanding.json
- Entitlement: Public; requires descriptive User-Agent; fair access ≤10 req/s
- Coverage: SEC registrants
- Timestamps: acceptanceDateTime (publication), first-seen recorded
- Restrictions: Public data
- Features enabled: Catalysts from filings (8-K, 424B prospectus = offering being sold, S-3 shelf ≠ executed offering); Dated shares outstanding (not free float)
- Fallback: Without a compliant User-Agent the SEC returns 403; filings are then "not checked".

### FINRA — Reg SHO daily short-sale volume files

- Endpoints: https://cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt
- Entitlement: Public, keyless
- Coverage: FINRA-reported trades (off-exchange) + consolidated file
- Timestamps: trade date; availability after publication
- Restrictions: FINRA terms
- Features enabled: Research/display: previous-day short-sale volume share
- Fallback: —

### Finnhub — Free tier: company news, profile2, earnings calendar

- Endpoints: GET /api/v1/company-news; GET /api/v1/stock/profile2; GET /api/v1/calendar/earnings
- Entitlement: Free key
- Coverage: US companies
- Timestamps: news datetime (publication); first-seen recorded
- Restrictions: Finnhub terms
- Features enabled: News catalysts; Industry / shares outstanding (labelled, not float); Earnings actuals
- Fallback: Alpaca news, SEC filings; else catalyst "not checked".
- Explicitly not used: candles (premium since 2024); quote volume

### Alpha Vantage — Free key — EARNINGS_CALENDAR (CSV)

- Endpoints: GET /query?function=EARNINGS_CALENDAR&horizon=3month
- Entitlement: Free key, 25 requests/day
- Coverage: US listings
- Timestamps: report dates
- Restrictions: AV terms
- Features enabled: Consensus EPS estimate → measured earnings surprise when an actual is published
- Fallback: Earnings direction "unknown" without consensus (never bullish by default).

### Massive (formerly Polygon.io) — Stocks Basic (free): end-of-day aggregates

- Endpoints: GET /v2/aggs/ticker/{t}/range/1/minute/{from}/{to}
- Entitlement: Free, 5 calls/min, 2 years history, end-of-day data
- Coverage: consolidated aggregates
- Timestamps: bar start (ms)
- Restrictions: Massive terms
- Features enabled: Historical consolidated minute baselines for research/replay
- Fallback: Alpaca SIP history

### FRED / ALFRED — Daily macro observations

- Endpoints: GET /fred/series/observations
- Entitlement: Free key
- Coverage: US macro
- Timestamps: observation date + realtime_start
- Restrictions: per series
- Features enabled: Display-only macro context (e.g. 10-year yield, VIX close) — not live yields/futures, not consensus surprises
- Fallback: —

### Twelve Data — Basic (free)

- Endpoints: —
- Entitlement: Free key, 8 calls/min, 800/day
- Coverage: —
- Timestamps: —
- Restrictions: —
- Features enabled: —
- Fallback: —

### Nasdaq (TotalView-ITCH NOII) / Databento XNAS.ITCH — Opening-cross imbalance (NOII)

- Endpoints: (model + normaliser implemented; no free source)
- Entitlement: PAID — not available in free profiles
- Coverage: Nasdaq opening cross
- Timestamps: —
- Restrictions: licensed
- Features enabled: Auction monitor & auction factors run on DEMO data only
- Fallback: Marked unavailable; never synthesised from quotes.

### — — Undocumented website endpoints / scraping libraries

- Endpoints: —
- Entitlement: —
- Coverage: —
- Timestamps: —
- Restrictions: —
- Features enabled: —
- Fallback: —

## Operating modes

- **LIVE LIMITED-COVERAGE**: Alpaca IEX real-time: single-venue volume, labelled; same-scope (IEX) baselines only.
- **DELAYED CONSOLIDATED RESEARCH**: Alpaca SIP history ≥15 min old: consolidated, shown with its true cutoff; cannot produce a current conviction.
- **HISTORICAL REPLAY**: Recorded sessions replayed through the same feature and scoring code.
- **DEMO**: Deterministic simulated session, labelled DEMO everywhere.

## Features by profile

| Feature | DEMO | LIVE LIMITED (IEX) | DELAYED (SIP ≥15 min) | ENHANCED (paid) |
|---|---|---|---|---|
| Pre-market price & gap | simulated | yes (IEX prints) | yes, ≥15 min old | yes |
| Same-time RVOL | simulated | IEX vs IEX history | SIP vs SIP history | yes |
| Quotes / spread | simulated | IEX book (not NBBO) | historical | yes |
| Aggressor estimate | bars only | trades + IEX quotes (estimate) | trades + quotes | yes |
| NOII auction factors | simulated | unavailable | unavailable | licensed feed |
| News / filings | simulated | Finnhub / Alpaca news / SEC (keys) | same | same |
| Halts | simulated | Nasdaq Trader RSS | RSS (historical not available) | same |
| Executable decision | demo only | yes (paper) | never (data not current) | yes (paper) |
