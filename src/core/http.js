/**
 * Budget-aware HTTP client. Per-provider rate limits (per second / minute / day),
 * a priority queue (benchmarks and near-open candidates first), retry with
 * exponential backoff + jitter, honouring 429 Retry-After, a TTL cache and
 * in-flight de-duplication so UI re-renders never multiply API calls.
 * Daily counts persist to .data/budget.json so a restart cannot overspend.
 * Never bypasses limits (no key rotation, no multiple accounts).
 */

import { readJson, writeJson } from './store.js';
import { redact } from './env.js';

export const LIMITS = {
  alpaca: { perMinute: 190, perSecond: 10 }, // free Basic: 200 historical calls/min (docs); keep headroom
  finnhub: { perMinute: 55, perSecond: 25 }, // free: commonly 60/min, 30/s — verify with probe
  alphaVantage: { perDay: 25, perMinute: 5 }, // free: 25 requests/day
  massive: { perMinute: 5 }, // free Stocks Basic: 5 calls/min
  sec: { perSecond: 8 }, // SEC fair access: ≤10 requests/second
  nasdaqTrader: { perMinute: 20 },
  finra: { perMinute: 20 },
  fred: { perMinute: 100 },
  twelveData: { perMinute: 8, perDay: 800 },
};

const state = {
  providers: {},
  cache: new Map(),
  inflight: new Map(),
  day: null,
  counts: {},
};

const today = () => new Date().toISOString().slice(0, 10);

function loadCounts() {
  if (state.day === today()) return;
  const saved = readJson('budget.json', {});
  state.day = today();
  state.counts = saved.day === state.day ? saved.counts ?? {} : {};
}
function saveCounts() { try { writeJson('budget.json', { day: state.day, counts: state.counts }); } catch { /* best effort */ } }

function prov(name) {
  if (!state.providers[name]) state.providers[name] = { recent: [], queue: [], running: false, failures: 0, lastError: null, lastOkAt: null, blockedUntil: 0, calls: 0 };
  return state.providers[name];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(name) {
  const lim = LIMITS[name] ?? {};
  const p = prov(name);
  const now = Date.now();
  p.recent = p.recent.filter((t) => now - t < 60_000);
  if (p.blockedUntil > now) return p.blockedUntil - now;
  if (lim.perDay && (state.counts[name] ?? 0) >= lim.perDay) return Infinity;
  if (lim.perSecond && p.recent.filter((t) => now - t < 1_000).length >= lim.perSecond) return 1_000 - (now - p.recent.filter((t) => now - t < 1_000)[0]);
  if (lim.perMinute && p.recent.length >= lim.perMinute) return 60_000 - (now - p.recent[0]);
  return 0;
}

async function pump(name) {
  const p = prov(name);
  if (p.running) return;
  p.running = true;
  try {
    while (p.queue.length) {
      p.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const w = waitFor(name);
      if (w === Infinity) {
        for (const job of p.queue.splice(0)) job.reject(Object.assign(new Error(`${name}: daily request budget exhausted (${LIMITS[name].perDay}/day)`), { budget: true }));
        break;
      }
      if (w > 0) { await sleep(Math.min(w + 5, 5_000)); continue; }
      const job = p.queue.shift();
      p.recent.push(Date.now());
      loadCounts();
      state.counts[name] = (state.counts[name] ?? 0) + 1;
      p.calls++;
      saveCounts();
      job.run();
    }
  } finally { p.running = false; }
}

function schedule(name, priority, fn) {
  return new Promise((resolve, reject) => {
    const p = prov(name);
    p.queue.push({ priority, seq: Math.random(), run: () => fn().then(resolve, reject), reject });
    pump(name);
  });
}

export class HttpError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

/**
 * GET JSON/text through the budget. opts: { provider, headers, ttlMs, priority (0 = highest), retries, as: 'json'|'text', timeoutMs }
 * The cache key is the URL (keys in query strings are redacted from errors, never logged).
 */
export async function get(url, { provider, headers = {}, ttlMs = 0, priority = 5, retries = 3, as = 'json', timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
  const key = `${provider}:${url}`;
  const hit = state.cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (state.inflight.has(key)) return state.inflight.get(key);
  const attempt = async () => {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await schedule(provider, priority, async () => {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), timeoutMs);
          try { return await fetchImpl(url, { headers, signal: ctl.signal }); } finally { clearTimeout(timer); }
        });
        if (res.status === 429) {
          const ra = Number(res.headers?.get?.('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1_000 : 2 ** i * 2_000;
          prov(provider).blockedUntil = Date.now() + wait;
          throw Object.assign(new HttpError(429, `${provider}: rate limited (429), backing off ${Math.round(wait / 1000)} s`), { retryable: true });
        }
        if (res.status >= 500) throw Object.assign(new HttpError(res.status, `${provider}: server error ${res.status}`), { retryable: true });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new HttpError(res.status, `${provider}: HTTP ${res.status} ${redact(body).slice(0, 200)}`, redact(body));
        }
        const value = as === 'text' ? await res.text() : await res.json();
        const p = prov(provider);
        p.failures = 0; p.lastOkAt = Date.now(); p.lastError = null;
        if (ttlMs > 0) state.cache.set(key, { value, until: Date.now() + ttlMs });
        return value;
      } catch (e) {
        lastErr = e;
        const retryable = e.retryable || e.name === 'AbortError' || e.name === 'TypeError';
        if (!retryable || i === retries || e.budget) break;
        await sleep(Math.min(30_000, 2 ** i * 500 + Math.random() * 400)); // backoff with jitter
      }
    }
    const p = prov(provider);
    p.failures++;
    p.lastError = { at: Date.now(), message: redact(lastErr?.message ?? 'unknown error'), status: lastErr?.status ?? null };
    throw lastErr;
  };
  const pr = attempt().finally(() => state.inflight.delete(key));
  state.inflight.set(key, pr);
  return pr;
}

/** Health/budget view for the UI (no secrets). */
export function budgetStatus() {
  loadCounts();
  return Object.fromEntries(Object.keys(LIMITS).map((name) => {
    const p = prov(name);
    const lim = LIMITS[name];
    const now = Date.now();
    const usedMinute = p.recent.filter((t) => now - t < 60_000).length;
    return [name, {
      limits: lim, usedToday: state.counts[name] ?? 0, usedLastMinute: usedMinute,
      remainingToday: lim.perDay ? Math.max(0, lim.perDay - (state.counts[name] ?? 0)) : null,
      remainingThisMinute: lim.perMinute ? Math.max(0, lim.perMinute - usedMinute) : null,
      queued: p.queue.length, failures: p.failures, lastError: p.lastError, lastOkAt: p.lastOkAt, blockedUntil: p.blockedUntil > now ? p.blockedUntil : null,
    }];
  }));
}

export function clearCache() { state.cache.clear(); }
