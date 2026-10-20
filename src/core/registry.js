/**
 * Source registry / capability matrix — documented capabilities only.
 * Live verification is separate (`npm run probe` → .data/probe-results.json) and merged
 * at display time, so "implemented" is never confused with "live-verified".
 * Docs were read on 2026-10-20; re-check before relying on any limit.
 */

export const SOURCES = [
  {
    id: 'alpaca-iex', provider: 'Alpaca', product: 'Market Data API — Basic (free), IEX feed', key: 'alpaca', needs: ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY'],
    endpoints: ['GET /v2/stocks/bars (1Min, feed=iex)', 'GET /v2/stocks/trades', 'GET /v2/stocks/quotes', 'GET /v2/stocks/snapshots', 'wss://stream.data.alpaca.markets/v2/iex (trades, quotes, bars, statuses)'],
    entitlement: 'Free Basic plan (paper account). No payment card required.',
    realtime: 'real-time, IEX venue only', coverage: 'IEX executions/quotes only — a small share of US volume. IEX hours documented 08:00–17:00 ET (IEX 2015 notice; verify); the app measures observed coverage.',
    volume: 'yes — venue-specific (IEX), not consolidated', extendedHours: 'partial (IEX sessions only; do not assume 04:00 coverage)',
    history: 'since 2016', limits: '200 historical calls/min; 30 WebSocket symbols', timestamps: 'RFC-3339 nanosecond event times; local receive time recorded',
    restrictions: 'Display/redistribution per Alpaca terms; personal research use.',
    features: ['Pre-market participation (IEX scope)', 'Same-time RVOL vs IEX history (same scope only)', 'Quotes/spread (IEX book, not NBBO)', 'Opening window', 'Paper fills (IEX top of book)', 'Aggressor estimate (trades+quotes)'],
    fallback: 'Without keys: DEMO and REPLAY only. Never substituted for SIP.', status: 'implemented', role: 'primary live price/volume (LIVE LIMITED-COVERAGE)',
  },
  {
    id: 'alpaca-sip-hist', provider: 'Alpaca', product: 'Market Data API — Basic, SIP historical (≥15 min old)', key: 'alpaca', needs: ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY'],
    endpoints: ['GET /v2/stocks/bars?feed=sip (end ≤ now − 15 min)', 'GET /v2/stocks/trades?feed=sip'],
    entitlement: 'Free Basic: historical SIP except the latest 15 minutes', realtime: 'DELAYED (≥15 min)', coverage: 'consolidated (all US venues)',
    volume: 'yes — consolidated', extendedHours: 'yes (04:00–20:00 ET in consolidated data)', history: 'since 2016', limits: 'shared 200 calls/min',
    timestamps: 'event times; data cutoff = now − 15 min', restrictions: 'as above',
    features: ['DELAYED CONSOLIDATED RESEARCH mode', 'Consolidated same-time baselines for research', 'Replay/backtests with consolidated volume'],
    fallback: 'Shown with its true cutoff; can never produce a current 09:28 conviction.', status: 'implemented', role: 'delayed research / historical replay',
  },
  {
    id: 'alpaca-trading', provider: 'Alpaca', product: 'Trading API (paper) — calendar & assets', key: 'alpaca', needs: ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY'],
    endpoints: ['GET /v2/calendar', 'GET /v2/assets/{symbol} (shortable, easy_to_borrow)', 'GET /v1/corporate-actions (splits, Market Data API)'],
    entitlement: 'Free paper account', realtime: 'reference data', coverage: 'US equities', volume: 'n/a', extendedHours: 'n/a', history: 'calendar 1970–2029',
    limits: '200 calls/min', timestamps: 'dates', restrictions: '—',
    features: ['Verified exchange calendar (cross-checks the fallback table)', 'Shortability/ETB flags for paper shorts (not borrow fees)', 'Split ratios for baseline adjustment'],
    fallback: 'Fallback holiday table 2025–2027; unknown years fail closed. Shorts without flags stay hypothetical.', status: 'implemented', role: 'reference / execution eligibility',
  },
  {
    id: 'nasdaq-symdir', provider: 'Nasdaq Trader', product: 'Symbol directory nasdaqlisted.txt', key: 'nasdaqTrader', needs: [],
    endpoints: ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'], entitlement: 'Public, keyless', realtime: 'refreshed by Nasdaq during the day; file creation time recorded',
    coverage: 'All Nasdaq-listed securities (incl. ETFs, test issues)', volume: 'no', extendedHours: 'n/a', history: 'current only (we version daily copies)', limits: 'courtesy polling (we cache 6 h)',
    timestamps: 'File Creation Time footer (ET)', restrictions: 'Nasdaq Trader terms',
    features: ['Universe: Nasdaq-listed common stocks, ADR toggle, separate ETF list, test-issue exclusion', 'Round-lot size', 'Financial status flags'],
    fallback: 'Last stored copy, labelled with its date.', status: 'implemented', role: 'universe / reference', liveVerifiedNote: 'keyless — verified 2026-10-20 (HTTP 200, ~5.3k rows)',
  },
  {
    id: 'nasdaq-halts', provider: 'Nasdaq Trader', product: 'Trade halts RSS', key: 'nasdaqTrader', needs: [],
    endpoints: ['https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts'], entitlement: 'Public, keyless', realtime: 'RSS (ttl 1 min) — NOT a low-latency status stream',
    coverage: 'Halts on Nasdaq-listed and other securities', volume: 'no', extendedHours: 'yes', history: 'current day(s)', limits: 'polled ≤ once/minute',
    timestamps: 'halt/resume ET wall clock; first-seen time recorded', restrictions: 'Nasdaq Trader terms',
    features: ['Halt gate (hard block)', 'Resumption times'], fallback: 'If not polled: halt status UNKNOWN (never "not halted").', status: 'implemented', role: 'risk filter', liveVerifiedNote: 'keyless — verified 2026-10-20 (HTTP 200)',
  },
  {
    id: 'sec-edgar', provider: 'SEC', product: 'EDGAR submissions & XBRL company concept', key: 'sec', needs: ['SEC_USER_AGENT (name + contact email)'],
    endpoints: ['https://www.sec.gov/files/company_tickers.json', 'https://data.sec.gov/submissions/CIK##########.json', 'https://data.sec.gov/api/xbrl/companyconcept/CIK…/dei/EntityCommonStockSharesOutstanding.json'],
    entitlement: 'Public; requires descriptive User-Agent; fair access ≤10 req/s', realtime: 'filings appear after acceptance (acceptanceDateTime)', coverage: 'SEC registrants',
    volume: 'no', extendedHours: 'n/a', history: 'full filing history', limits: '≤10 requests/second', timestamps: 'acceptanceDateTime (publication), first-seen recorded',
    restrictions: 'Public data', features: ['Catalysts from filings (8-K, 424B prospectus = offering being sold, S-3 shelf ≠ executed offering)', 'Dated shares outstanding (not free float)'],
    fallback: 'Without a compliant User-Agent the SEC returns 403; filings are then "not checked".', status: 'implemented', role: 'catalyst / float context',
    liveVerifiedNote: 'Not verified: a request without a contact e-mail got HTTP 403 (expected). Set SEC_USER_AGENT and run the probe.',
  },
  {
    id: 'finra-shvol', provider: 'FINRA', product: 'Reg SHO daily short-sale volume files', key: 'finra', needs: [],
    endpoints: ['https://cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt'], entitlement: 'Public, keyless', realtime: 'published after the trading day (treated as available 18:00 ET)',
    coverage: 'FINRA-reported trades (off-exchange) + consolidated file', volume: 'short-sale volume only', extendedHours: 'n/a', history: 'daily files', limits: 'courtesy',
    timestamps: 'trade date; availability after publication', restrictions: 'FINRA terms',
    features: ['Research/display: previous-day short-sale volume share'], fallback: '—', status: 'implemented', role: 'research-only (short-sale volume ≠ short interest, not a real-time signal)',
    liveVerifiedNote: 'keyless — verified 2026-10-20 (2026-10-19 file, HTTP 200)',
  },
  {
    id: 'finnhub', provider: 'Finnhub', product: 'Free tier: company news, profile2, earnings calendar', key: 'finnhub', needs: ['FINNHUB_API_KEY'],
    endpoints: ['GET /api/v1/company-news', 'GET /api/v1/stock/profile2', 'GET /api/v1/calendar/earnings'], entitlement: 'Free key',
    realtime: 'news near real time', coverage: 'US companies', volume: 'not used (free quote has no volume; trade-stream venue scope undocumented)',
    extendedHours: 'not used', history: 'news ~1 year on free tier (verify)', limits: 'commonly 60 calls/min, 30/s (verify with probe)',
    timestamps: 'news datetime (publication); first-seen recorded', restrictions: 'Finnhub terms',
    features: ['News catalysts', 'Industry / shares outstanding (labelled, not float)', 'Earnings actuals'], fallback: 'Alpaca news, SEC filings; else catalyst "not checked".',
    status: 'implemented', role: 'catalyst / enrichment', excluded: ['candles (premium since 2024)', 'quote volume'],
  },
  {
    id: 'alphavantage', provider: 'Alpha Vantage', product: 'Free key — EARNINGS_CALENDAR (CSV)', key: 'alphaVantage', needs: ['ALPHAVANTAGE_API_KEY'],
    endpoints: ['GET /query?function=EARNINGS_CALENDAR&horizon=3month'], entitlement: 'Free key, 25 requests/day', realtime: 'daily', coverage: 'US listings',
    volume: 'not used', extendedHours: 'not used (premium intraday not assumed)', history: '3-month horizon', limits: '25/day (we use 1/day)', timestamps: 'report dates', restrictions: 'AV terms',
    features: ['Consensus EPS estimate → measured earnings surprise when an actual is published'], fallback: 'Earnings direction "unknown" without consensus (never bullish by default).', status: 'implemented', role: 'catalyst expectations (supplementary)',
  },
  {
    id: 'massive', provider: 'Massive (formerly Polygon.io)', product: 'Stocks Basic (free): end-of-day aggregates', key: 'massive', needs: ['MASSIVE_API_KEY'],
    endpoints: ['GET /v2/aggs/ticker/{t}/range/1/minute/{from}/{to}'], entitlement: 'Free, 5 calls/min, 2 years history, end-of-day data', realtime: 'END OF DAY — not a live feed',
    coverage: 'consolidated aggregates', volume: 'yes — consolidated (historical only)', extendedHours: 'yes in minute aggregates (verify)', history: '2 years', limits: '5 calls/min',
    timestamps: 'bar start (ms)', restrictions: 'Massive terms', features: ['Historical consolidated minute baselines for research/replay'], fallback: 'Alpaca SIP history',
    status: 'implemented', role: 'historical research (never mixed with IEX scope)',
  },
  {
    id: 'fred', provider: 'FRED / ALFRED', product: 'Daily macro observations', key: 'fred', needs: ['FRED_API_KEY'],
    endpoints: ['GET /fred/series/observations'], entitlement: 'Free key', realtime: 'daily observations, published with lag', coverage: 'US macro', volume: 'n/a', extendedHours: 'n/a',
    history: 'long; ALFRED vintages for point-in-time', limits: 'generous', timestamps: 'observation date + realtime_start', restrictions: 'per series',
    features: ['Display-only macro context (e.g. 10-year yield, VIX close) — not live yields/futures, not consensus surprises'], fallback: '—', status: 'implemented (display only)', role: 'display-only context',
  },
  {
    id: 'twelvedata', provider: 'Twelve Data', product: 'Basic (free)', key: 'twelveData', needs: ['TWELVEDATA_API_KEY'],
    endpoints: ['—'], entitlement: 'Free key, 8 calls/min, 800/day', realtime: 'regular-session data', coverage: '—', volume: 'extended-hours data requires a paid plan and has no volume',
    extendedHours: 'paid only', history: '—', limits: '8/min', timestamps: '—', restrictions: '—', features: [], fallback: '—', status: 'excluded',
    role: 'excluded — adds no distinct free capability (no free pre-market volume); not integrated to avoid redundant API counts',
  },
  {
    id: 'noii', provider: 'Nasdaq (TotalView-ITCH NOII) / Databento XNAS.ITCH', product: 'Opening-cross imbalance (NOII)', key: null, needs: ['paid licence'],
    endpoints: ['(model + normaliser implemented; no free source)'], entitlement: 'PAID — not available in free profiles', realtime: '—', coverage: 'Nasdaq opening cross', volume: 'paired/imbalance shares',
    extendedHours: '09:25 early / 09:28 full dissemination', history: '—', limits: '—', timestamps: '—', restrictions: 'licensed',
    features: ['Auction monitor & auction factors run on DEMO data only'], fallback: 'Marked unavailable; never synthesised from quotes.', status: 'unavailable (paid)', role: 'enhanced profile only',
  },
  {
    id: 'scraping', provider: '—', product: 'Undocumented website endpoints / scraping libraries', key: null, needs: [],
    endpoints: ['—'], entitlement: '—', realtime: '—', coverage: '—', volume: '—', extendedHours: '—', history: '—', limits: '—', timestamps: '—', restrictions: '—', features: [], fallback: '—',
    status: 'excluded', role: 'excluded by policy (not a supported exchange API)',
  },
];

export const MODES = {
  'LIVE LIMITED-COVERAGE': 'Alpaca IEX real-time: single-venue volume, labelled; same-scope (IEX) baselines only.',
  'DELAYED CONSOLIDATED RESEARCH': 'Alpaca SIP history ≥15 min old: consolidated, shown with its true cutoff; cannot produce a current conviction.',
  'HISTORICAL REPLAY': 'Recorded sessions replayed through the same feature and scoring code.',
  DEMO: 'Deterministic simulated session, labelled DEMO everywhere.',
};

export const PROFILE_FEATURES = [
  // [feature, DEMO, LIMITED (IEX live), DELAYED (SIP research), ENHANCED (paid NOII)]
  ['Pre-market price & gap', 'simulated', 'yes (IEX prints)', 'yes, ≥15 min old', 'yes'],
  ['Same-time RVOL', 'simulated', 'IEX vs IEX history', 'SIP vs SIP history', 'yes'],
  ['Quotes / spread', 'simulated', 'IEX book (not NBBO)', 'historical', 'yes'],
  ['Aggressor estimate', 'bars only', 'trades + IEX quotes (estimate)', 'trades + quotes', 'yes'],
  ['NOII auction factors', 'simulated', 'unavailable', 'unavailable', 'licensed feed'],
  ['News / filings', 'simulated', 'Finnhub / Alpaca news / SEC (keys)', 'same', 'same'],
  ['Halts', 'simulated', 'Nasdaq Trader RSS', 'RSS (historical not available)', 'same'],
  ['Executable decision', 'demo only', 'yes (paper)', 'never (data not current)', 'yes (paper)'],
];
