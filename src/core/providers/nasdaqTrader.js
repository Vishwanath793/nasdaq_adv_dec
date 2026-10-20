/**
 * Nasdaq Trader public resources (keyless, official):
 *  - Symbol directory: https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt (pipe-delimited,
 *    refreshed by Nasdaq during the day; we cache it for 6 h and use the file's own creation time).
 *  - Trade halts RSS: https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts (an RSS feed, NOT a low-latency
 *    status stream; polled at most every 60 s, first-seen time recorded).
 */

import { get } from '../http.js';
import { etToUtc } from '../../utils/clock.js';

export const SYMBOL_DIR_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
export const HALTS_URL = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';

const MARKET_CATEGORY = { Q: 'Global Select', G: 'Global Market', S: 'Capital Market' };
const FIN_STATUS = { N: 'normal', D: 'deficient', E: 'delinquent', Q: 'bankrupt', G: 'deficient and bankrupt', H: 'deficient and delinquent', J: 'delinquent and bankrupt', K: 'deficient, delinquent and bankrupt' };

/** Security-type classification from the security name (Nasdaq's file has no explicit type column). */
export function classifySecurity(name, etf) {
  const n = name.toLowerCase();
  if (etf) return 'ETF';
  if (/\bwarrants?\b/.test(n)) return 'Warrant';
  if (/\brights?\b/.test(n)) return 'Right';
  if (/\bunits?\b/.test(n)) return 'Unit';
  if (/\bpreferred\b|\bpfd\b|depositary shares,? each representing a 1\/\d+/.test(n)) return 'Preferred';
  if (/\bnotes?\b|\bdebentures?\b|\bbonds?\b/.test(n)) return 'Debt';
  if (/american depositary|\bads\b|\badr\b/.test(n)) return 'ADR';
  if (/common stock|ordinary shares?|common shares?|class [a-c] (common|ordinary)|\bshares of beneficial interest\b/.test(n)) return 'Common Stock';
  return 'Other';
}

/** Parse nasdaqlisted.txt into instruments. Footer "File Creation Time: MMDDYYYYHH:MM" gives the as-of time (ET). */
export function parseSymbolDirectory(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split('|');
  const idx = (k) => header.indexOf(k);
  let createdAt = null;
  const rows = [];
  for (const line of lines) {
    if (line.startsWith('File Creation Time')) {
      const m = /(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})/.exec(line);
      if (m) createdAt = etToUtc(`${m[3]}-${m[1]}-${m[2]}`, `${m[4]}:${m[5]}:00`);
      continue;
    }
    const c = line.split('|');
    const symbol = c[idx('Symbol')];
    const name = c[idx('Security Name')];
    const etf = c[idx('ETF')] === 'Y';
    const test = c[idx('Test Issue')] === 'Y';
    rows.push({
      symbol, name, etf, test,
      marketCategory: MARKET_CATEGORY[c[idx('Market Category')]] ?? c[idx('Market Category')],
      financialStatus: FIN_STATUS[c[idx('Financial Status')]] ?? c[idx('Financial Status')],
      roundLot: Number(c[idx('Round Lot Size')]) || 100,
      nextShares: c[idx('NextShares')] === 'Y',
      securityType: classifySecurity(name, etf),
    });
  }
  return { createdAt, rows };
}

/** Eligible universe with explicit, configurable treatment of ADRs and other types. */
export function eligibleUniverse(rows, { includeAdrs = true, includeTypes = [] } = {}) {
  const allowed = new Set(['Common Stock', ...(includeAdrs ? ['ADR'] : []), ...includeTypes]);
  const lists = { eligible: [], etfs: [], excluded: [] };
  for (const r of rows) {
    if (r.test) { lists.excluded.push({ ...r, why: 'test issue' }); continue; }
    if (r.securityType === 'ETF') { lists.etfs.push(r); continue; }
    if (allowed.has(r.securityType)) lists.eligible.push(r);
    else lists.excluded.push({ ...r, why: `${r.securityType} (not enabled)` });
  }
  return lists;
}

export async function fetchSymbolDirectory() {
  const text = await get(SYMBOL_DIR_URL, { provider: 'nasdaqTrader', as: 'text', ttlMs: 6 * 3_600_000 });
  return { ...parseSymbolDirectory(text), fetchedAt: Date.now(), source: SYMBOL_DIR_URL };
}

const tag = (xml, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? m[1].trim() : null; };

/** Parse the halts RSS. Times in the feed are ET wall clock. */
export function parseHalts(xml, firstSeenAt = Date.now()) {
  const items = xml.split('<item>').slice(1).map((s) => s.split('</item>')[0]);
  const toUtc = (d, t) => {
    if (!d || !t) return null;
    const [mm, dd, yyyy] = d.split('/');
    return etToUtc(`${yyyy}-${mm}-${dd}`, t.slice(0, 8));
  };
  return items.map((x) => ({
    symbol: tag(x, 'ndaq:IssueSymbol'),
    name: tag(x, 'ndaq:IssueName'),
    market: tag(x, 'ndaq:Market'),
    reason: tag(x, 'ndaq:ReasonCode'),
    haltAt: toUtc(tag(x, 'ndaq:HaltDate'), tag(x, 'ndaq:HaltTime')),
    resumeQuoteAt: toUtc(tag(x, 'ndaq:ResumptionDate'), tag(x, 'ndaq:ResumptionQuoteTime')),
    resumeAt: toUtc(tag(x, 'ndaq:ResumptionDate'), tag(x, 'ndaq:ResumptionTradeTime')),
    firstSeenAt,
    source: 'Nasdaq Trader halts RSS',
  })).filter((h) => h.symbol);
}

export async function fetchHalts() {
  const xml = await get(HALTS_URL, { provider: 'nasdaqTrader', as: 'text', ttlMs: 60_000 });
  return parseHalts(xml);
}
