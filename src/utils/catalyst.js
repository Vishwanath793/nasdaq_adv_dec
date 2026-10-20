/**
 * Deterministic catalyst extraction and scoring (pure). No LLM: headlines and
 * filing form types are matched against documented keyword rules, and anything
 * that does not match is "unclassified", not bullish.
 *
 * Article and filing text is untrusted data; it is only pattern-matched, never executed
 * or followed. Every catalyst keeps its source link, publication time and first-seen time.
 */

export const CATALYST_RULES = [
  // [category, regex, direction (+1/−1/0 = needs surprise/unknown), materiality 0..1, specificity 0..1]
  ['bankruptcy', /\b(chapter 11|bankruptcy|insolven|going concern)\b/i, -1, 1, 0.9],
  ['offering-priced', /\b(prices?|priced|pricing of)\b.*\b(offering|placement)\b|\bregistered direct\b/i, -1, 0.8, 0.9],
  ['offering-proposed', /\b(proposed|announces?)\b.*\b(public offering|private placement|convertible notes?)\b/i, -1, 0.6, 0.6],
  ['shelf', /\b(shelf registration|form s-3|at-the-market|atm program)\b/i, 0, 0.2, 0.3],
  ['fda-positive', /\b(fda approv|approval of|cleared by the fda|breakthrough therapy|met (its )?primary endpoint|positive topline)\b/i, 1, 0.9, 0.9],
  ['fda-negative', /\b(complete response letter|crl\b|failed to meet|did not meet|clinical hold|discontinu\w+ (the )?(trial|program))\b/i, -1, 0.9, 0.9],
  ['ma-target', /\b(to be acquired|agrees? to be acquired|definitive agreement to be acquired|takeover offer for|buyout)\b/i, 1, 1, 0.9],
  ['ma', /\b(acquire|acquisition|merger|merge with)\b/i, 0, 0.6, 0.6],
  ['guidance-up', /\b(raises?|raised|boosts?|lifts?) (its )?(full[- ]year |fy\d* |annual )?(guidance|outlook|forecast)\b/i, 1, 0.8, 0.8],
  ['guidance-down', /\b(cuts?|lowers?|lowered|slashes?|reduces?) (its )?(full[- ]year |fy\d* |annual )?(guidance|outlook|forecast)\b|\bwithdraws? (guidance|outlook)\b/i, -1, 0.8, 0.8],
  ['analyst-up', /\b(upgrade[sd]?|initiated? at (buy|outperform|overweight)|raises? (price )?target)\b/i, 1, 0.4, 0.6],
  ['analyst-down', /\b(downgrade[sd]?|cuts? (price )?target|initiated? at (sell|underperform|underweight))\b/i, -1, 0.4, 0.6],
  ['contract', /\b(awarded|wins?|secures?|signs?)\b.*\b(contract|order|agreement|partnership)\b/i, 1, 0.5, 0.6],
  ['earnings', /\b(earnings|quarterly results|q[1-4] (results|revenue)|reports? (first|second|third|fourth)[- ]quarter|eps)\b/i, 0, 0.8, 0.7],
  ['split', /\b(stock split|reverse split|share consolidation)\b/i, 0, 0.3, 0.9],
  ['dividend', /\b(dividend)\b/i, 0, 0.2, 0.7],
  ['legal-regulatory', /\b(sec investigation|subpoena|class action|doj|antitrust|recall)\b/i, -1, 0.5, 0.6],
];

/** SEC form types → category (8-K item detail is not parsed; the form alone is weak evidence). */
export const FORM_RULES = {
  '8-K': ['filing-8k', 0, 0.4, 0.3],
  '6-K': ['filing-6k', 0, 0.3, 0.2],
  '424B5': ['offering-priced', -1, 0.7, 0.8], // prospectus supplement: an offering is being sold
  '424B4': ['offering-priced', -1, 0.7, 0.8],
  'S-3': ['shelf', 0, 0.2, 0.3], // a shelf is not an executed offering
  'S-1': ['offering-proposed', -1, 0.4, 0.4],
  'SC 13D': ['ownership-13d', 0, 0.4, 0.5],
  '10-Q': ['periodic', 0, 0.2, 0.2],
  '10-K': ['periodic', 0, 0.2, 0.2],
};

const SOURCE_RELIABILITY = { sec: 1, issuer: 0.9, newswire: 0.8, news: 0.6, aggregator: 0.5, unknown: 0.4 };

export function classifyItem(item) {
  if (item.formType) {
    const f = FORM_RULES[item.formType.toUpperCase()];
    if (f) return { category: f[0], direction: f[1], materiality: f[2], specificity: f[3] };
  }
  const text = `${item.headline ?? ''} ${item.summary ?? ''}`;
  for (const [category, re, direction, materiality, specificity] of CATALYST_RULES) {
    if (re.test(text)) return { category, direction, materiality, specificity };
  }
  return { category: 'unclassified', direction: 0, materiality: 0.1, specificity: 0.1 };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function similar(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.7;
}

/** Deduplicate syndicated stories: keep the earliest first-seen copy, count the rest as syndication. */
export function dedupeNews(items) {
  const sorted = [...items].sort((a, b) => (a.firstSeenAt ?? a.publishedAt) - (b.firstSeenAt ?? b.publishedAt));
  const kept = [];
  for (const it of sorted) {
    const dup = kept.find((k) => (it.url && k.url === it.url) || similar(k.headline, it.headline));
    if (dup) { dup.syndicated = (dup.syndicated ?? 0) + 1; dup.sources = [...new Set([...(dup.sources ?? [dup.source]), it.source])]; continue; }
    kept.push({ ...it, syndicated: 0, sources: [it.source] });
  }
  return kept;
}

/**
 * Catalysts known at asOf for a trading date: items first seen after `since`
 * (usually the previous regular close) and no later than asOf.
 * Returns { items, best, direction, score:0..1|null, reason } where `score` is the
 * evidence strength for the given direction (0.5 neutral) and null when nothing was checked.
 */
export function catalystEvidence(news, { asOf, since, direction, checked = true, surprise = null, reaction = null }) {
  if (!checked) return { score: null, reason: 'news source not configured or not checked', items: [] };
  const known = (news ?? []).filter((n) => (n.firstSeenAt ?? n.publishedAt) <= asOf && (n.publishedAt ?? n.firstSeenAt) >= since);
  const items = dedupeNews(known).map((n) => {
    const c = classifyItem(n);
    const reliability = SOURCE_RELIABILITY[n.sourceKind ?? 'unknown'] ?? 0.4;
    let dir = c.direction;
    let surpriseNote = null;
    if (c.category === 'earnings') {
      const s = n.surprise ?? surprise;
      if (s?.epsActual != null && s?.epsEstimate != null) {
        const diff = s.epsActual - s.epsEstimate;
        dir = Math.abs(diff) < 0.005 ? 0 : Math.sign(diff);
        surpriseNote = `EPS ${s.epsActual} vs consensus ${s.epsEstimate}`;
      } else {
        surpriseNote = 'no valid consensus: direction unknown';
      }
    }
    const strength = c.materiality * 0.4 + c.specificity * 0.3 + reliability * 0.3;
    return { ...n, ...c, direction: dir, reliability, strength, surpriseNote };
  });
  if (!items.length) return { score: 0.5, reason: 'no news or filings since the previous close (neutral, not negative)', items: [], best: null };
  const directional = items.filter((i) => i.direction !== 0).sort((a, b) => b.strength - a.strength);
  const best = directional[0] ?? items.sort((a, b) => b.strength - a.strength)[0];
  if (!best.direction) {
    return { score: 0.5, best, items, reason: `${best.category} catalyst with no measurable direction (${best.surpriseNote ?? 'neutral'})` };
  }
  // Price/volume response: a catalyst the market is ignoring counts for less.
  const responded = reaction == null ? 1 : reaction;
  const value = 0.5 + 0.5 * best.direction * direction * best.strength * responded;
  return {
    score: Math.min(1, Math.max(0, value)), best, items,
    reason: `${best.category} (${best.sourceKind ?? 'source'}${best.syndicated ? `, +${best.syndicated} syndicated` : ''}): ${best.direction * direction > 0 ? 'supports' : 'opposes'} this direction`,
  };
}
