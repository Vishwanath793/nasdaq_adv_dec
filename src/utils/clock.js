/**
 * Market clock (pure). Timestamps are stored as UTC epoch milliseconds; all
 * session logic runs in America/New_York through Intl, so daylight-saving
 * transitions come from the platform's time-zone database. There is no fixed
 * ET-to-IST offset anywhere: IST is formatted through Intl too.
 *
 * The holiday table below is a fallback. When an Alpaca key is configured the
 * server cross-checks it against Alpaca's /v2/calendar; years not in the table
 * fail closed (treated as "calendar unknown", never as a normal trading day).
 */

export const ET = 'America/New_York';
export const IST = 'Asia/Kolkata';

/** Full-day closures (Nasdaq follows the NYSE holiday schedule). Source: NYSE/Nasdaq published calendars. */
export const HOLIDAYS = {
  2025: ['2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
};
/** 13:00 ET early closes. */
export const EARLY_CLOSES = {
  2025: ['2025-07-03', '2025-11-28', '2025-12-24'],
  2026: ['2026-11-27', '2026-12-24'],
  2027: ['2027-11-26'],
};

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

// The offset only changes on the hour in America/New_York, so cache it per UTC hour (Intl is the hot spot).
const offsetCache = new Map();
/** Offset (ms) of a time zone from UTC at an instant: local = utc + offset. */
export function tzOffset(ms, tz = ET) {
  const hourKey = `${tz}:${Math.floor(ms / 3_600_000)}`;
  const hit = offsetCache.get(hourKey);
  if (hit != null) return hit;
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = local - Math.floor(ms / 1000) * 1000;
  if (offsetCache.size > 20_000) offsetCache.clear();
  offsetCache.set(hourKey, off);
  return off;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Wall-clock parts in a zone: { date 'YYYY-MM-DD', time 'HH:MM:SS', minutes (since local midnight, fractional), weekday 0–6 }. */
export function zoneParts(ms, tz = ET) {
  const d = new Date(ms + tzOffset(ms, tz));
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return {
    date, time, weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60_000,
  };
}

export const etParts = (ms) => zoneParts(ms, ET);

/** UTC ms for a wall-clock time on a date in a zone ('2026-10-20', '09:28:00'). Correct across DST changes. */
export function zoneToUtc(date, time = '00:00:00', tz = ET) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, Math.floor(ss), Math.round((ss % 1) * 1000));
  let guess = wall - tzOffset(wall, tz);
  guess = wall - tzOffset(guess, tz); // second pass settles the offset on DST days
  return guess;
}
export const etToUtc = (date, time) => zoneToUtc(date, time, ET);

/** "09:28:00 ET · 18:58:00 IST" style labels. */
export function formatEt(ms, withDate = false) {
  if (ms == null) return '—';
  const p = zoneParts(ms, ET);
  return withDate ? `${p.date} ${p.time} ET` : `${p.time} ET`;
}
export function formatIst(ms, withDate = false) {
  if (ms == null) return '—';
  const p = zoneParts(ms, IST);
  return withDate ? `${p.date} ${p.time} IST` : `${p.time} IST`;
}
export const formatBoth = (ms, withDate = false) => `${formatEt(ms, withDate)} · ${formatIst(ms, withDate)}`;

/** Add calendar days to an ISO date. */
export function addDays(date, n) {
  const t = Date.UTC(...date.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Day status from the fallback table: 'open' | 'early' | 'holiday' | 'weekend' | 'unknown'. */
export function dayStatus(date, calendar = null) {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return 'weekend';
  if (calendar) {
    // A verified calendar from the provider: { [date]: { open:'09:30', close:'16:00' } } for trading days only.
    const entry = calendar.days?.[date];
    if (calendar.from <= date && date <= calendar.to) return entry ? (entry.close < '16:00' ? 'early' : 'open') : 'holiday';
  }
  const year = Number(date.slice(0, 4));
  if (!HOLIDAYS[year]) return 'unknown';
  if (HOLIDAYS[year].includes(date)) return 'holiday';
  if (EARLY_CLOSES[year]?.includes(date)) return 'early';
  return 'open';
}
export const isTradingDay = (date, calendar) => ['open', 'early'].includes(dayStatus(date, calendar));

/** Previous trading day (null when the calendar is unknown). */
export function previousTradingDay(date, calendar = null) {
  let d = date;
  for (let i = 0; i < 15; i++) {
    d = addDays(d, -1);
    const s = dayStatus(d, calendar);
    if (s === 'unknown') return null;
    if (s === 'open' || s === 'early') return d;
  }
  return null;
}

/** The last N completed trading days before `date`, most recent first. */
export function previousTradingDays(date, n, calendar = null) {
  const out = [];
  let d = date;
  while (out.length < n) {
    d = previousTradingDay(d, calendar);
    if (!d) break;
    out.push(d);
  }
  return out;
}

/** Default snapshot / window configuration (ET wall-clock). */
export const DEFAULT_SCHEDULE = {
  preMarketStart: '04:00:00',
  preliminary: '09:20:00',
  earlyAuction: '09:25:00', // Nasdaq: MOO/LOO cancellations stop; early NOII begins (no near/far prices yet)
  main: '09:28:00', // MOO entry stops; full NOII (near/far) dissemination begins
  final: '09:29:50', // configurable final pre-open snapshot
  open: '09:30:00',
  windowEnd: '09:35:00', // opening window is [09:30:00, 09:35:00)
  confirmGraceMs: 5_000, // wait this long after 09:35 for late-arriving window events before sealing
  regularClose: '16:00:00',
  earlyClose: '13:00:00',
  afterHoursEnd: '20:00:00',
};

export const SNAPSHOT_KEYS = ['preliminary', 'earlyAuction', 'main', 'final'];
export const SNAPSHOT_LABEL = {
  preliminary: '09:20 preliminary watchlist', earlyAuction: '09:25 early auction monitoring',
  main: '09:28 main pre-open conviction', final: 'final pre-open', confirm: '09:35 sealed confirmation',
};

/** Every instant (UTC ms) that matters on a trading date. */
export function sessionTimes(date, schedule = DEFAULT_SCHEDULE, calendar = null) {
  const s = { ...DEFAULT_SCHEDULE, ...schedule };
  const status = dayStatus(date, calendar);
  const prev = previousTradingDay(date, calendar);
  const at = (t) => etToUtc(date, t);
  const close = status === 'early' ? s.earlyClose : s.regularClose;
  return {
    date, status, previousDate: prev,
    previousRegularClose: prev ? etToUtc(prev, dayStatus(prev, calendar) === 'early' ? s.earlyClose : s.regularClose) : null,
    previousAfterHoursEnd: prev ? etToUtc(prev, s.afterHoursEnd) : null,
    preMarketStart: at(s.preMarketStart),
    preliminary: at(s.preliminary), earlyAuction: at(s.earlyAuction), main: at(s.main), final: at(s.final),
    open: at(s.open), windowEnd: at(s.windowEnd), confirmPublish: at(s.windowEnd) + s.confirmGraceMs,
    regularClose: at(close),
  };
}

/**
 * Phase of an instant relative to a trading date's session:
 * 'previousRegular' | 'previousAfterHours' | 'overnight' | 'preMarket' | 'openingAuction' | 'openingWindow' | 'regular' | 'closed'.
 * 'openingAuction' covers 09:25–09:30, when NOII is disseminated.
 */
export function phaseAt(ms, times) {
  if (times.previousRegularClose && ms < times.previousRegularClose) return 'previousRegular';
  if (times.previousAfterHoursEnd && ms < times.previousAfterHoursEnd) return 'previousAfterHours';
  if (ms < times.preMarketStart) return 'overnight';
  if (ms < times.earlyAuction) return 'preMarket';
  if (ms < times.open) return 'openingAuction';
  if (ms < times.windowEnd) return 'openingWindow';
  if (ms < times.regularClose) return 'regular';
  return 'closed';
}

/** NOII stage at an instant: 'none' before 09:25, 'early' 09:25–09:28 (no near/far), 'full' from 09:28 to the cross. */
export function noiiStage(ms, times) {
  if (ms < times.earlyAuction) return 'none';
  if (ms < times.main) return 'early';
  if (ms < times.open) return 'full';
  return 'after';
}

/** Minute start (ms) containing an instant. */
export const minuteOf = (ms) => Math.floor(ms / 60_000) * 60_000;
