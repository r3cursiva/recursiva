// A project's closed issues over twelve months, a cell a day (RSVA-576, the Quire artboards FramedProjectHomeYear…):
// when the project worked and when it stood still, which nothing else on its home says. The days are My work Home's
// own count (`closed`, my-work-home.ts) over more of them; here is the shape the grid draws and the two lines under it.
//
// The artboard for older months kept in an archive is not built: the pool holds every issue of the workspace, so there
// is nothing to load.
import { addDays, localDay } from "@rsva/schema/days";
import type { Closed } from "./my-work-home.ts";

/** Whose closes a cell counts. */
export const YEAR_WHO = ["all", "people", "agents"] as const;
export type YearWho = (typeof YEAR_WHO)[number];

/** The weeks across: a year and the week it began in. */
export const YEAR_WEEKS = 53;

/** The days the grid covers on `today`, from the first day of the first week: what `closed` is asked for. */
export const yearDays = (today: string, weekStart: number): number => (YEAR_WEEKS - 1) * 7 + ((weekdayOf(today) - weekStart + 7) % 7) + 1;

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

export interface YearCell {
  day: string;
  /** Before the project began: not a day when nothing was closed, and drawn as no day at all. */
  before: boolean;
  n: number;
  /** 0 nothing, 1…4 by how the day stands among the project's own days. */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface Year {
  /** The first day that counts, when it is inside the grid; null when the whole grid counts. */
  since: string | null;
  /** A cell a day, oldest first, today last; the first is the first day of a week. */
  cells: YearCell[];
  total: number;
  /** Of `total`, with an agent as the delegate; whatever `who` is. */
  agents: number;
  /** Where a month's name stands: the week (0 first) whose first day is the first in that month. */
  months: { week: number; day: string }[];
  /** The longest run of days with nothing closed after the first close, a week or more; null when there is none. */
  pause: { days: number; from: string; to: string } | null;
  /** The week most was closed in, by its first day; null when nothing was. */
  busiest: { from: string; n: number } | null;
}

/** A month's name needs this many weeks of room before the next one. */
const MONTH_ROOM = 3;
const PAUSE_MIN = 7;

/**
 * The top level is the day a tenth of the working days pass: one day when forty issues were closed at once (an import,
 * a cleanup) would otherwise leave every other day at the lowest level.
 */
function levels(counts: readonly number[]): (n: number) => YearCell["level"] {
  const worked = counts.filter((n) => n > 0).sort((a, b) => a - b);
  const top = worked[Math.floor((worked.length - 1) * 0.9)] ?? 1;
  return (n) => (n <= 0 ? 0 : (Math.min(4, Math.ceil((4 * n) / top)) as YearCell["level"]));
}

/**
 * `began` is the day the project's days start to count (yearBegan): a young project's year is mostly days it was not
 * there for, and those must not read as days of no work. The grid keeps its year all the same: cut to the project's
 * age, two weeks would fill the widget with cells of another size, and two projects could not be compared by eye.
 */
export function closedYear(days: Closed["days"], who: YearWho, began: string | null = null): Year {
  const count = (d: Closed["days"][number]) => (who === "all" ? d.people + d.agents : d[who]);
  const level = levels(days.map(count));
  const cells = days.map((d) => ({ day: d.day, before: !!began && d.day < began, n: count(d), level: level(count(d)) }));
  const since = began && days[0] && began > days[0].day ? began : null;
  const year: Year = { since, cells, total: 0, agents: 0, months: [], pause: null, busiest: null };
  // Before the first close there is no pause: the project was not there, or its history did not come with it.
  let quiet = -Infinity;
  for (const [k, d] of days.entries()) {
    const n = count(d);
    year.total += n;
    year.agents += d.agents;
    if (k % 7 === 0) {
      const week = cells.slice(k, k + 7).reduce((sum, c) => sum + c.n, 0);
      if (week > (year.busiest?.n ?? 0)) year.busiest = { from: d.day, n: week };
      if (k === 0 || d.day.slice(0, 7) !== days[k - 7]!.day.slice(0, 7)) year.months.push({ week: k / 7, day: d.day });
    }
    quiet = n ? 0 : quiet + 1;
    if (quiet >= PAUSE_MIN && quiet > (year.pause?.days ?? 0)) year.pause = { days: quiet, from: addDays(d.day, 1 - quiet), to: d.day };
  }
  // The first week's month has no room when the next month begins right after it.
  const [first, second] = year.months;
  if (first && second && second.week - first.week < MONTH_ROOM) year.months.shift();
  return year;
}

/** The day a project's year counts from: the day it was made, or its first close when that came before (an import). */
export function yearBegan(createdAt: string, closes: Iterable<string | null>): string {
  let first = createdAt;
  for (const at of closes) if (at && Date.parse(at) < Date.parse(first)) first = at;
  return localDay(new Date(first));
}

/**
 * The cell an arrow key goes to from cell `k` of those from `first` up to `n`: a day up or down, a week left or right;
 * -1 when there is none.
 */
export function yearStep(k: number, n: number, key: string, first = 0): number {
  const by = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[key];
  if (by === undefined) return -1;
  const to = k + by;
  // Up and down stay in the week.
  if (Math.abs(by) === 1 && Math.floor(to / 7) !== Math.floor(k / 7)) return -1;
  return to >= first && to < n ? to : -1;
}
