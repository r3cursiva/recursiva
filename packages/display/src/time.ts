// A feed's day marks, clock times, short dates and date fields, for the web (apps/web lib/time.ts) and the TUI's issue screen.

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const shortDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const thisYear = new Date().getFullYear();
const dateShort = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const dateLong = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Oct 29". */
export const shortDate = (iso: string): string => shortDay.format(new Date(iso));

/** "17:02", in a feed whose days are marked. */
export function clockTime(iso: string): string {
  return clock.format(new Date(iso));
}

/** "Today", "Yesterday", "Mon, Oct 27": a feed's day marks. */
export function dayLabel(iso: string, now: number): string {
  const days = (Date.parse(new Date(now).toDateString()) - Date.parse(new Date(iso).toDateString())) / 86_400_000;
  const n = Math.round(days);
  return n === 0 ? "Today" : n === 1 ? "Yesterday" : day.format(new Date(iso));
}

/** "17:02" today, "Oct 29" before: a time where days are not marked. */
export const clockOrDate = (iso: string, now: number): string => (dayLabel(iso, now) === "Today" ? clockTime(iso) : shortDate(iso));

/** A date field, "2026-11-03" → "Nov 3"; another year adds it: "Nov 3, 2025". */
export function formatDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return (d.getUTCFullYear() === thisYear ? dateShort : dateLong).format(d);
}

/**
 * Two date fields as a span: "Oct 27 – Nov 9", another year added as formatDate adds it. `collapse` writes a span inside
 * one month with the month once, "Nov 3 – 16" (the TUI's rows, as its canvas has them).
 */
export function dayRange(start: string, end: string, collapse = false): string {
  if (!collapse || start.slice(0, 7) !== end.slice(0, 7)) return `${formatDate(start)} – ${formatDate(end)}`;
  const d = new Date(`${start}T00:00:00Z`);
  const year = d.getUTCFullYear();
  return `${dateShort.format(d)} – ${Number(end.slice(8, 10))}${year === thisYear ? "" : `, ${year}`}`;
}

/** "now", "40m", "2h", "3d": how long ago, in whole units rounded down. */
export function compactAge(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  return min < 24 * 60 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / (24 * 60))}d`;
}
