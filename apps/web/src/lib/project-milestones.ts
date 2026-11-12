// The Timeline's coarsest level (PLNR-120, the HistoryMilestones artboard): a project's cycles as events on the calendar.
// A cycle's start, its end with how it went, and the dates still ahead as planned ones. Everything here is in the pool
// already, so the level costs no request. Releases and milestones of the artboard have no model yet (see
// docs/research/timeline-artboards-2026-11-01.md). Pure: the screen passes what it reads from the store.
import { daysBetween } from "@rsva/schema/days";
import { cycleStatus, type Cycle, type Issue } from "@rsva/schema/models";
import { percentDone, type CycleCounts } from "./cycles.ts";
import { dayKey } from "./project-history.ts";

type CycleMark = "start" | "end" | "planned";

/** One date of a cycle. `edge` is which of its two dates it is, `mark` how the rail draws it. */
export interface CycleEvent {
  key: string;
  edge: "start" | "end";
  mark: CycleMark;
  cycle: Cycle;
}

export interface CycleDay {
  /** Local date, YYYY-MM-DD. */
  key: string;
  /** "Cycle 11 · day 14 of 14", "between cycles". */
  context: string;
  rows: CycleEvent[];
}

const event = (cycle: Cycle, edge: CycleEvent["edge"], mark: CycleMark): CycleEvent => ({ key: `${edge}:${cycle.id}`, edge, mark, cycle });

/** Where a day stands among the cycles. */
function contextOf(day: string, cycles: readonly Cycle[]): string {
  const c = cycles.find((x) => x.startDate && x.endDate && x.startDate <= day && day <= x.endDate);
  if (!c) return "between cycles";
  return `${c.name} · day ${daysBetween(c.startDate!, day) + 1} of ${daysBetween(c.startDate!, c.endDate!) + 1}`;
}

/** The project's cycles by day, the latest first, so what is planned sits above today as in the other levels' order. */
export function cycleDays(cycles: readonly Cycle[], today: string): CycleDay[] {
  const byDay = new Map<string, CycleEvent[]>();
  const add = (day: string, e: CycleEvent) => {
    const list = byDay.get(day);
    if (list) list.push(e);
    else byDay.set(day, [e]);
  };
  for (const c of cycles) {
    const status = cycleStatus(c, today);
    if (status === "draft") continue;
    add(c.startDate!, event(c, "start", status === "upcoming" ? "planned" : "start"));
    if (c.completedAt) add(dayKey(c.completedAt), event(c, "end", "end"));
    else add(c.endDate!, event(c, "end", status === "ended" ? "end" : "planned"));
  }
  return [...byDay]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, rows]) => ({
      key,
      context: contextOf(key, cycles),
      // A day's later event first, as in the feed: a cycle that starts on the day another one ended comes on top.
      rows: rows.sort((a, b) => (a.edge === b.edge ? 0 : a.edge === "start" ? -1 : 1)),
    }));
}

/** What the rows need to know of the issues: their keys, who to credit, where a cycle's open ones went. */
export interface CycleWords {
  issue(id: string): Issue | undefined;
  key(issue: Issue): string;
  /** Who did it: the agent working on it, else its first assignee; null for nobody. */
  doer(issue: Issue): string | null;
  cycleName(id: string): string | undefined;
  issuesIn(cycleId: string): readonly Issue[];
  /** Tells whether an issue counts as done, as the summary does. */
  done(issue: Issue): boolean;
}

/** A completed cycle's open issues by where they went: another cycle's name, or null when they stayed or left cycles. */
function openIssues(c: Cycle, words: CycleWords): { moved: Map<string, Issue[]>; out: Issue[]; stayed: Issue[] } {
  const moved = new Map<string, Issue[]>();
  const out: Issue[] = [];
  const stayed: Issue[] = [];
  for (const id of c.summary?.open ?? []) {
    const i = words.issue(id);
    if (!i) continue;
    if (i.cycleId === c.id) stayed.push(i);
    else if (!i.cycleId) out.push(i);
    else {
      const list = moved.get(i.cycleId);
      if (list) list.push(i);
      else moved.set(i.cycleId, [i]);
    }
  }
  return { moved, out, stayed };
}

/** "13 of 15 done · 87% · 2 moved to Cycle 11": how a cycle ended. */
export function endText(c: Cycle, counts: CycleCounts, words: CycleWords): string {
  const parts = [`${counts.completed} of ${counts.total - counts.cancelled} done`, `${percentDone(counts)}%`];
  if (!c.completedAt) parts.push("not completed");
  const { moved } = openIssues(c, words);
  const n = [...moved.values()].reduce((sum, list) => sum + list.length, 0);
  const only = moved.size === 1 ? words.cycleName([...moved.keys()][0]!) : undefined;
  if (n) parts.push(only ? `${n} moved to ${only}` : `${n} moved`);
  return parts.join(" · ");
}

/** A line of an opened cycle: a label and what it counts. */
export interface CycleLine {
  label: string;
  value: string;
}

const keys = (issues: readonly Issue[], words: CycleWords) => issues.map((i) => words.key(i)).join(", ");

/** What an opened cycle says: who finished what, where the unfinished went, how far the scope grew. */
export function cycleLines(c: Cycle, counts: CycleCounts, words: CycleWords, name: (userId: string) => string): CycleLine[] {
  const by = new Map<string | null, number>();
  for (const i of words.issuesIn(c.id)) {
    if (!words.done(i)) continue;
    const who = words.doer(i);
    by.set(who, (by.get(who) ?? 0) + 1);
  }
  const credit = [...by]
    .sort((a, b) => b[1] - a[1])
    .map(([who, n]) => `${who ? name(who) : "nobody"} ${n}`)
    .join(", ");
  const lines: CycleLine[] = [{ label: `Done ${counts.completed}`, value: credit }];
  const { moved, out, stayed } = openIssues(c, words);
  for (const [cycleId, list] of moved) lines.push({ label: `Moved to ${words.cycleName(cycleId) ?? "another cycle"}`, value: keys(list, words) });
  if (out.length) lines.push({ label: "Moved out of cycles", value: keys(out, words) });
  if (stayed.length) lines.push({ label: "Left unfinished", value: keys(stayed, words) });
  const scope = c.summary?.scope;
  const added = scope?.length ? scope.at(-1)! - scope[0]! : 0;
  if (added > 0) lines.push({ label: "Added mid-cycle", value: String(added) });
  return lines;
}
