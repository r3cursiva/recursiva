// Date expressions of filters: absolute days, comparisons and relative presets, all resolved to an inclusive
// DateRange of calendar days (YYYY-MM-DD). Days are those of the person's zone: the viewer's browser, or on the server
// the zone of their Profile (QueryContext.timeZone). Weeks start on the Profile's first day (QueryContext.weekStart).
//
// Grammar (case-insensitive):
//   day       = YYYY-MM-DD | today | yesterday | tomorrow
//   expr      = day                          exactly that day
//             | (<|<=|>|>=) day              before / on or before / after / on or after
//             | day? .. day?                 inclusive range, either side open
//             | (this|last|next)-(week|month)
//             | (last|next)-N-(day|days|week|weeks|month|months)
//                                            last-7-days = the 7 days ending today; next-2-weeks = the 14 days from today
//             | none                         no such date: due:none, start:none
//
// An expression with a relative word keeps its text as `preset`, so a saved or shared filter means "the last 7 days"
// on the day it is opened, not on the day it was written.
import { addDays, dayIn, localDay } from "@rsva/schema/days";
import type { DateRange, QueryContext } from "./index.ts";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today as YYYY-MM-DD in `timeZone`, or in the runtime's zone when it is absent. */
export function localToday(now = new Date(), timeZone?: string): string {
  return dayIn(now, timeZone);
}

/** The day a query's relative dates mean: the context's `today`, else today in its zone. */
export function todayOf(ctx: Pick<QueryContext, "today" | "timeZone">): string {
  return ctx.today ?? localToday(undefined, ctx.timeZone);
}

/** Local noon of a day: its weekday and month in the runtime's zone, away from any DST edge. */
function noon(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12);
}

function addMonths(day: string, n: number): string {
  const d = noon(day);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
  // Clamp: Jan 31 + 1 month = Feb 28/29.
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return localDay(target);
}

function isValidDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
  return localDay(noon(s)) === s;
}

/** The first day of the day's week; `first` as getDay counts (1 Monday, 0 Sunday, 6 Saturday). */
function weekStart(day: string, first: number): string {
  const dow = (noon(day).getDay() - first + 7) % 7;
  return addDays(day, -dow);
}

function monthStart(day: string): string {
  return `${day.slice(0, 8)}01`;
}

const RELATIVE_DAYS: Record<string, number> = { yesterday: -1, today: 0, tomorrow: 1 };

function resolveDay(s: string, today: string): string | null {
  const rel = RELATIVE_DAYS[s];
  if (rel !== undefined) return addDays(today, rel);
  return isValidDay(s) ? s : null;
}

const UNITS: Record<string, "day" | "week" | "month"> = {
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month",
};

export type DateResult = { range: DateRange } | { error: string };

/** Preset names the menus offer and the parser suggests. */
export const DATE_PRESETS = [
  "today",
  "yesterday",
  "tomorrow",
  "<today",
  "this-week",
  "last-week",
  "next-week",
  "this-month",
  "last-month",
  "next-month",
  "last-7-days",
  "last-30-days",
  "next-7-days",
  "next-2-weeks",
  "next-30-days",
] as const;

/** True if the expression depends on the current day. */
function isRelative(expr: string): boolean {
  return /today|yesterday|tomorrow|this-|last-|next-/.test(expr);
}

/**
 * Resolves a date expression to an inclusive range of days. Relative expressions keep their canonical text in
 * `preset` (lowercase, as written). Weeks start on `weekStart` (as getDay counts; Monday when absent).
 */
export function resolveDateExpr(raw: string, today: string, weekStart = 1): DateResult {
  const expr = raw.trim().toLowerCase();
  if (!expr) return { error: "Empty date" };
  if (expr === "none") return { range: { none: true } };
  const range = resolveRange(expr, today, weekStart);
  if ("error" in range) return range;
  return { range: isRelative(expr) ? { ...range.range, preset: expr } : range.range };
}

function resolveRange(expr: string, today: string, first: number): DateResult {
  const cmp = /^(<=|>=|<|>)(.+)$/.exec(expr);
  if (cmp) {
    const day = resolveDay(cmp[2]!, today);
    if (!day) return { error: `Not a date: "${cmp[2]}"` };
    switch (cmp[1]) {
      case "<":
        return { range: { to: addDays(day, -1) } };
      case "<=":
        return { range: { to: day } };
      case ">":
        return { range: { from: addDays(day, 1) } };
      default:
        return { range: { from: day } };
    }
  }
  const dots = expr.indexOf("..");
  if (dots >= 0) {
    const a = expr.slice(0, dots);
    const b = expr.slice(dots + 2);
    const from = a ? resolveDay(a, today) : undefined;
    const to = b ? resolveDay(b, today) : undefined;
    if (from === null) return { error: `Not a date: "${a}"` };
    if (to === null) return { error: `Not a date: "${b}"` };
    if (from === undefined && to === undefined) return { error: "A range needs at least one end" };
    if (from && to && from > to) return { error: `The range ends before it starts: ${from} > ${to}` };
    return { range: { ...(from ? { from } : {}), ...(to ? { to } : {}) } };
  }
  const day = resolveDay(expr, today);
  if (day) return { range: { from: day, to: day } };
  const period = /^(this|last|next)-(week|month)$/.exec(expr);
  if (period) {
    const [, which, unit] = period;
    const shift = which === "last" ? -1 : which === "next" ? 1 : 0;
    if (unit === "week") {
      const from = addDays(weekStart(today, first), shift * 7);
      return { range: { from, to: addDays(from, 6) } };
    }
    const from = addMonths(monthStart(today), shift);
    return { range: { from, to: addDays(addMonths(from, 1), -1) } };
  }
  const span = /^(last|next)-(\d{1,4})-([a-z]+)$/.exec(expr);
  if (span && UNITS[span[3]!]) {
    const n = Number(span[2]);
    if (n < 1) return { error: "The period must be at least 1" };
    const unit = UNITS[span[3]!]!;
    // last-7-days: the 7 days ending today; next-2-weeks: the 14 days starting today. Months are calendar months.
    if (span[1] === "last") {
      const from = unit === "month" ? addMonths(today, -n) : addDays(today, -(unit === "week" ? n * 7 : n) + 1);
      return { range: { from, to: today } };
    }
    const to = unit === "month" ? addMonths(today, n) : addDays(today, (unit === "week" ? n * 7 : n) - 1);
    return { range: { from: today, to } };
  }
  return { error: `Not a date expression: "${expr}"` };
}

/** The text form of a range: its preset if it has one, otherwise absolute days. */
export function formatDateRange(r: DateRange): string {
  if (r.none) return "none";
  if (r.preset) return r.preset;
  if (r.from && r.to) return r.from === r.to ? r.from : `${r.from}..${r.to}`;
  if (r.from) return `>=${r.from}`;
  if (r.to) return `<=${r.to}`;
  return "";
}

/** A range with its preset re-resolved for `today` and weeks from `weekStart`; absolute ranges come back as they are. */
export function currentRange(r: DateRange, today: string, weekStart = 1): DateRange {
  if (!r.preset) return r;
  const res = resolveDateExpr(r.preset, today, weekStart);
  return "range" in res ? res.range : r;
}

/** Human text for chips and menus: "Last 7 days", "After today", "2026-10-01 – 2026-10-31", "On or before 2026-11-01". */
export function describeDateRange(r: DateRange): string {
  if (r.none) return "No date";
  if (r.preset) {
    const p = r.preset;
    if (p === "<today") return "Overdue";
    const t = p.replace(/^([<>]=?)/, (m) => ({ "<": "before ", "<=": "on or before ", ">": "after ", ">=": "on or after " })[m] ?? m);
    const s = t.replace(/-/g, " ").replace(/\.\./g, " – ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  if (r.from && r.to) return r.from === r.to ? r.from : `${r.from} – ${r.to}`;
  if (r.from) return `On or after ${r.from}`;
  if (r.to) return `On or before ${r.to}`;
  return "Any time";
}
