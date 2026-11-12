// The quick dates of a due date's menu (PLNR-117, after the LedgerNewIssue artboard): today, the coming Friday, the first
// day of next week and the end of the cycle. Days are local, as today() counts them; weeks start on the person's first
// day of the week (Settings › Profile), as the calendar draws them.
import { addDays } from "@rsva/schema/days";
import { cycleStatus, type Cycle } from "@rsva/schema/models";

/** Days from weekday `from` to the next `to`, both as getDay counts: 1 to 7, so the same weekday is a week on. */
export const daysToNext = (from: number, to: number): number => ((to - from + 6) % 7) + 1;

const FRIDAY = 5;

export interface DatePreset {
  label: string;
  day: string;
}

/**
 * The end of the issue's cycle while it runs or is to come, or of the project's cycle in progress when the issue has
 * none: null for a draft, an ended cycle or a completed one (even completed early), so a due date is never offered for
 * a cycle that is over. A cycle ending today is still in progress: its end is today.
 */
export function cycleEnd(cycle: Cycle | undefined, cycles: readonly Cycle[], today: string): string | null {
  const status = (c: Cycle) => cycleStatus(c, today);
  const live = cycle ? (status(cycle) === "active" || status(cycle) === "upcoming" ? cycle : undefined) : cycles.find((c) => status(c) === "active");
  return live?.endDate ?? null;
}

/** The presets, in the artboard's order; End of cycle only with a cycle's end (cycleEnd). */
export function datePresets(today: string, weekStart: number, end: string | null): DatePreset[] {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return [
    { label: "Today", day: today },
    { label: "Fri", day: addDays(today, daysToNext(weekday, FRIDAY)) },
    { label: "Next week", day: addDays(today, daysToNext(weekday, weekStart)) },
    ...(end ? [{ label: "End of cycle", day: end }] : []),
  ];
}
