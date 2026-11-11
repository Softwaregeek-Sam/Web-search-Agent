import * as chrono from "chrono-node";

/** [startMs, endMs) in epoch ms, aligned to the user's local midnight. */
export interface DayRange {
  startMs: number;
  endMs: number;
  label: string;
}

export interface TemporalRef {
  text: string;
  ranges: DayRange[];
  /** True when the phrase could mean more than one date (e.g. "last Tuesday" on a Wednesday). */
  ambiguous: boolean;
}

interface YMD {
  y: number;
  m: number;
  d: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, tues: 2, wednesday: 3, thursday: 4, thurs: 4, friday: 5, saturday: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(ms: number, tz: string) {
  const out: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

export function tzOffsetMs(utcMs: number, tz: string): number {
  const p = parts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export function zonedYMD(ms: number, tz: string): YMD {
  const p = parts(ms, tz);
  return { y: p.year, m: p.month, d: p.day };
}

function addDays(a: YMD, n: number): YMD {
  const t = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(a: YMD): number {
  return new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
}

/** Epoch ms of local midnight for a calendar day in tz (DST-safe). */
export function startOfZonedDay(a: YMD, tz: string): number {
  const guess = Date.UTC(a.y, a.m - 1, a.d);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

const dayLabel = (a: YMD) => `${WEEKDAYS[weekdayOf(a)]!.slice(0, 3)} ${a.d} ${MONTHS[a.m - 1]} ${a.y}`;

function dayRange(a: YMD, tz: string, days = 1, label?: string): DayRange {
  return {
    startMs: startOfZonedDay(a, tz),
    endMs: startOfZonedDay(addDays(a, days), tz),
    label: label ?? dayLabel(a),
  };
}

/** "Wednesday 11 November 2026, 14:32 (Asia/Kolkata)" */
export function formatNow(nowMs: number, tz: string): string {
  const p = parts(nowMs, tz);
  const ymd = { y: p.year, m: p.month, d: p.day };
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${WEEKDAYS[weekdayOf(ymd)]} ${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${hh}:${mm} (${tz})`;
}

/** "Mon 9 Nov 2026, 10:42" in the given zone. */
export function formatInstant(ms: number, tz: string): string {
  const p = parts(ms, tz);
  const ymd = { y: p.year, m: p.month, d: p.day };
  return `${dayLabel(ymd)}, ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const FUTURE_MARKERS = /\b(will|going to|gonna|upcoming|tomorrow|schedule[d]?|due|deadline|remind me|coming up)\b/i;
const WEEKDAY_RE = /\b(?:(last|past|previous|this|next)\s+)?(sunday|monday|tuesday|tues|wednesday|thursday|thurs|friday|saturday)\b/gi;
const WEEK_RE = /\b(last|this)\s+week\b/gi;
const MONTH_RE = /\blast\s+month\b/gi;

interface Span {
  start: number;
  end: number;
  ref: TemporalRef | null;
}

function weekdayRef(match: RegExpMatchArray, today: YMD, tz: string, futureTense: boolean): TemporalRef | null {
  const mod = match[1]?.toLowerCase();
  const idx = WEEKDAY_INDEX[match[2]!.toLowerCase()]!;
  const todayIdx = weekdayOf(today);
  const back = (todayIdx - idx + 7) % 7; // 0..6 days since the most recent occurrence (0 = today)
  const monBased = (i: number) => (i + 6) % 7;
  let candidates: number[];
  if (mod === "next") return null; // future, nothing to recall
  if (mod === "this") {
    candidates = [monBased(todayIdx) - monBased(idx)]; // same Mon-Sun week, may be negative (future)
  } else if (mod === "last" || mod === "past" || mod === "previous") {
    const mostRecentPast = back === 0 ? 7 : back;
    const previousWeek = monBased(todayIdx) - monBased(idx) + 7;
    candidates = [...new Set([mostRecentPast, previousWeek])];
  } else {
    if (futureTense) return null;
    candidates = back === 0 ? [0, 7] : [back];
  }
  const ranges = candidates
    .filter((n) => n >= 0)
    .map((n) => dayRange(addDays(today, -n), tz));
  if (ranges.length === 0) return null;
  return { text: match[0], ranges, ambiguous: ranges.length > 1 };
}

/**
 * Resolves date phrases in a user message into absolute day ranges in the user's timezone.
 * Bias is toward the past because the output feeds recall of earlier conversations.
 */
export function resolveTemporalRefs(text: string, nowMs: number, tz: string): TemporalRef[] {
  const today = zonedYMD(nowMs, tz);
  const futureTense = FUTURE_MARKERS.test(text);
  const spans: Span[] = [];

  for (const m of text.matchAll(WEEKDAY_RE)) {
    spans.push({ start: m.index!, end: m.index! + m[0].length, ref: weekdayRef(m, today, tz, futureTense) });
  }
  for (const m of text.matchAll(WEEK_RE)) {
    const thisMon = addDays(today, -((weekdayOf(today) + 6) % 7));
    const isLast = m[1]!.toLowerCase() === "last";
    const monday = isLast ? addDays(thisMon, -7) : thisMon;
    const sunday = addDays(monday, 6);
    const label = `week of ${dayLabel(monday)} to ${dayLabel(sunday)}`;
    spans.push({
      start: m.index!, end: m.index! + m[0].length,
      ref: { text: m[0], ranges: [dayRange(monday, tz, 7, label)], ambiguous: false },
    });
  }
  for (const m of text.matchAll(MONTH_RE)) {
    const first = { y: today.m === 1 ? today.y - 1 : today.y, m: today.m === 1 ? 12 : today.m - 1, d: 1 };
    const days = Math.round((Date.UTC(today.y, today.m - 1, 1) - Date.UTC(first.y, first.m - 1, 1)) / 86400000);
    spans.push({
      start: m.index!, end: m.index! + m[0].length,
      ref: { text: m[0], ranges: [dayRange(first, tz, days, `${MONTHS[first.m - 1]} ${first.y}`)], ambiguous: false },
    });
  }

  // Mask handled spans so chrono does not parse them again.
  let masked = text;
  for (const s of spans) masked = masked.slice(0, s.start) + " ".repeat(s.end - s.start) + masked.slice(s.end);

  const refs: TemporalRef[] = spans.flatMap((s) => (s.ref ? [s.ref] : []));

  const results = chrono.parse(masked, { instant: new Date(nowMs), timezone: tz }, { forwardDate: false });
  for (const r of results) {
    const dateLike =
      r.start.isCertain("day") || r.start.isCertain("month") || /\b(today|yesterday|tonight|ago)\b/i.test(r.text);
    if (!dateLike) continue;
    let ymd = zonedYMD(r.start.date().getTime(), tz);
    // A date with no stated year that lands in the future almost always means the most recent past occurrence.
    if (!r.start.isCertain("year") && startOfZonedDay(ymd, tz) > nowMs) ymd = { ...ymd, y: ymd.y - 1 };
    let days = 1;
    let label = dayLabel(ymd);
    if (r.end) {
      const endYmd = zonedYMD(r.end.date().getTime(), tz);
      const span = Math.round((Date.UTC(endYmd.y, endYmd.m - 1, endYmd.d) - Date.UTC(ymd.y, ymd.m - 1, ymd.d)) / 86400000);
      if (span > 0 && span < 62) {
        days = span + 1;
        label = `${dayLabel(ymd)} to ${dayLabel(endYmd)}`;
      }
    }
    refs.push({ text: r.text, ranges: [dayRange(ymd, tz, days, label)], ambiguous: false });
  }

  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.text.toLowerCase()) ? false : (seen.add(r.text.toLowerCase()), true)));
}

/** One line per phrase, for the prompt, so the model states the dates it relied on. */
export function describeRefs(refs: TemporalRef[]): string | null {
  if (refs.length === 0) return null;
  return refs
    .map((r) => {
      const dates = r.ranges.map((x) => x.label).join(" or ");
      return `"${r.text}" -> ${r.ambiguous ? `ambiguous: ${dates}` : dates}`;
    })
    .join("\n");
}
