/**
 * Minimal .env loader (no dependency) and redaction. Secrets stay server-side:
 * they are never sent to the browser, logged, or written into .data/.
 */

import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file = path.join(process.cwd(), '.env')) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const v = m[2].replace(/^['"]|['"]$/g, '');
      if (process.env[m[1]] == null) process.env[m[1]] = v;
    }
  } catch { /* no .env: keyless sources and DEMO still work */ }
}

export const SECRET_KEYS = ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'FINNHUB_API_KEY', 'ALPHAVANTAGE_API_KEY', 'MASSIVE_API_KEY', 'FRED_API_KEY', 'TWELVEDATA_API_KEY'];

/** Replace any configured secret value (and common key query parameters) in a string. */
export function redact(text) {
  let s = String(text ?? '');
  for (const k of SECRET_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 6) s = s.split(v).join(`[${k}]`);
  }
  return s.replace(/([?&](?:token|apikey|apiKey|api_key)=)[^&\s"]+/g, '$1[redacted]');
}

export const has = (k) => Boolean(process.env[k] && process.env[k].trim());

/** Which sources are configured — booleans only, safe for the UI. */
export function configured() {
  return {
    alpaca: has('ALPACA_KEY_ID') && has('ALPACA_SECRET_KEY'),
    finnhub: has('FINNHUB_API_KEY'),
    alphaVantage: has('ALPHAVANTAGE_API_KEY'),
    massive: has('MASSIVE_API_KEY'),
    fred: has('FRED_API_KEY'),
    twelveData: has('TWELVEDATA_API_KEY'),
    sec: has('SEC_USER_AGENT') && /@/.test(process.env.SEC_USER_AGENT),
    nasdaqTrader: true,
    finra: true,
  };
}
