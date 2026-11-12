// The cycle dialog's calendar (PLNR-63): a month as weeks from the person's first day of the week, the dates a new cycle is offered, the cycle a
// range collides with and the first start that clears it. Pure, over the project's cycles; the server checks the same
// overlap rule (cyclesOverlap) and has the last word.
import { addDays, daysBetween } from "@rsva/schema/days";
import { cyclesOverlap, type Cycle } from "@rsva/schema/models";

export interface Range {
  startDate: string;
  endDate: string;
}

/**
 * The days on a month's page: from the week's first day (`weekStart`, as getDay counts; Monday by default) on or before
 * the 1st to the day before it on or after the month's last day.
 */
export function monthGrid(year: number, month: number, weekStart = 1): string[] {
  const first = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const back = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7;
  const start = addDays(first, -back(first));
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const end = addDays(lastDay, 6 - back(lastDay));
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const dated = (cycles: readonly Cycle[], self: string | null) => cycles.filter((c) => c.id !== self && c.startDate && c.endDate);

/** The first of the project's other cycles the range meets, else null. */
export function clashWith(cycles: readonly Cycle[], self: string | null, r: Range): Cycle | null {
  return dated(cycles, self).find((c) => cyclesOverlap(c, r)) ?? null;
}

/** The same length moved on past whatever it meets: the first start that collides with nothing. */
export function freeStart(cycles: readonly Cycle[], self: string | null, r: Range): Range {
  const len = daysBetween(r.startDate, r.endDate);
  let at = r;
  for (let guard = 0; guard < 100; guard++) {
    const hit = clashWith(cycles, self, at);
    if (!hit) return at;
    const start = addDays(hit.endDate!, 1);
    at = { startDate: start, endDate: addDays(start, len) };
  }
  return at;
}

/**
 * Dates a new cycle is offered: the day after the project's last cycle ends (from today if that is past), as long as
 * that cycle was (two weeks for the first), and clear of every other cycle.
 */
export function suggestDates(cycles: readonly Cycle[], today: string): Range {
  const last = dated(cycles, null).sort((a, b) => (a.endDate! < b.endDate! ? 1 : -1))[0];
  const len = last ? daysBetween(last.startDate!, last.endDate!) : 13;
  const start = last && last.endDate! >= today ? addDays(last.endDate!, 1) : today;
  return freeStart(cycles, null, { startDate: start, endDate: addDays(start, len) });
}

/** The name a new cycle is offered: "Cycle N" after the project's highest number. */
export const nextCycleName = (cycles: readonly Cycle[]): string => `Cycle ${Math.max(0, ...cycles.map((c) => c.number)) + 1}`;

/** The page of a calendar that shows `day` (YYYY-MM-DD). */
export const monthOf = (day: string) => ({ y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)) - 1 });

/** The page `by` months from `page`, across year ends. */
export function shifted({ y, m }: { y: number; m: number }, by: number) {
  const n = y * 12 + m + by;
  return { y: Math.floor(n / 12), m: ((n % 12) + 12) % 12 };
}
