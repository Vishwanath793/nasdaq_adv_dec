/** Small numeric helpers (pure). */

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x) => clamp(x, 0, 1);
export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : null);
export const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
export const r4 = (n) => (n == null ? null : Math.round(n * 10_000) / 10_000);

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation (raw, not scaled). */
export function mad(a) {
  const m = median(a);
  if (m == null) return null;
  return median(a.map((x) => Math.abs(x - m)));
}

export function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Fraction of values strictly below x plus half of the ties (0..1). */
export function percentileRank(values, x) {
  if (!values.length) return null;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (below + equal / 2) / values.length;
}

export function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}

/** Linear interpolation of x from [x0,x1] onto [y0,y1], clamped. */
export const lerp = (x, x0, x1, y0, y1) => y0 + (y1 - y0) * clamp01((x - x0) / (x1 - x0));

/** Ranks with ties averaged (1-based). */
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

export function pearson(x, y) {
  if (x.length < 3 || x.length !== y.length) return null;
  const mx = mean(x);
  const my = mean(y);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/** Spearman rank correlation, or null with fewer than 3 pairs. */
export const spearman = (x, y) => (x.length < 3 ? null : pearson(ranks(x), ranks(y)));

/** Deterministic PRNG (mulberry32) so demo sessions are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Stable short hash (FNV-1a, hex) of any JSON-serialisable value: used for configuration hashes. */
export function hashOf(value) {
  const s = stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** Bootstrap 90% interval of the mean (deterministic seed). */
export function bootstrapMeanCi(values, { n = 500, seed = 7 } = {}) {
  if (values.length < 5) return null;
  const rand = rng(seed);
  const means = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[Math.floor(rand() * values.length)];
    means.push(s / values.length);
  }
  return [quantile(means, 0.05), quantile(means, 0.95)];
}
