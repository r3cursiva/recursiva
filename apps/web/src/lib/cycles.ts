// What the cycle screens read off a cycle and its issues (PLNR-63): its place on the calendar in words, its issues
// counted by state, and its burn-up. Pure, except cycleProgress, which asks the server once per cycle and day for the
// days that are over; today's point is counted here from the issues the store holds, so it moves with every delta.
import { addDays, dayStart, daysBetween } from "@rsva/schema/days";
import { doneShare, type CycleProgress } from "@rsva/protocol";
import { cycleStatus, startedStage, type Cycle, type CycleStatus, type Issue, type WorkflowState } from "@rsva/schema/models";
import { observable, runInAction } from "mobx";
import { dayRange, formatDate } from "@rsva/display/time";
import { localToday } from "@rsva/query";
import { plural } from "@rsva/schema/util";
import { deviceTimeZone } from "../account.ts";

/** "C12": the sidebar's badge and the short name agents and `cycle:` also take. */
export const cycleShort = (c: Pick<Cycle, "number">) => `C${c.number}`;

export const statusOf = (c: Cycle, now = localToday()): CycleStatus => cycleStatus(c, now);

/** "Oct 27 – Nov 9", or "No dates" for a draft. */
export function cycleRange(c: Pick<Cycle, "startDate" | "endDate">): string {
  return c.startDate && c.endDate ? dayRange(c.startDate, c.endDate) : "No dates";
}

/** Days in the cycle, both ends counted; 0 for a draft. */
export const cycleDays = (c: Pick<Cycle, "startDate" | "endDate">): number => (c.startDate && c.endDate ? daysBetween(c.startDate, c.endDate) + 1 : 0);

/** "2 weeks", "10 days". */
export function lengthText(days: number): string {
  return days > 0 && days % 7 === 0 ? plural(days / 7, "week") : plural(days, "day");
}

/** Where the cycle is, in words: "day 4 of 14 · 10 days left", "starts in 11 days", "ended 2 days ago", "completed Oct 26". */
export function cycleWhen(c: Cycle, now = localToday()): string {
  switch (statusOf(c, now)) {
    case "draft":
      return "no dates yet";
    case "completed":
      return `completed ${formatDate(c.completedAt!.slice(0, 10))}`;
    case "upcoming": {
      const n = daysBetween(now, c.startDate!);
      return n === 1 ? "starts tomorrow" : `starts in ${n} days`;
    }
    case "ended": {
      const n = daysBetween(c.endDate!, now);
      return n === 1 ? "ended yesterday" : `ended ${n} days ago`;
    }
    case "active": {
      const day = daysBetween(c.startDate!, now) + 1;
      const left = daysBetween(now, c.endDate!);
      return `day ${day} of ${cycleDays(c)} · ${left === 0 ? "last day" : `${plural(left, "day")} left`}`;
    }
  }
}

/** "9d left", "last day": what a chip or a picker row has room for. */
export function daysLeft(c: Cycle, now = localToday()): string {
  const left = c.endDate ? daysBetween(now, c.endDate) : 0;
  return left > 0 ? `${left}d left` : "last day";
}

/** A cycle's issues by state group, the started ones also by stage (In Progress, In Review, Approved). */
export interface CycleCounts {
  total: number;
  backlog: number;
  unstarted: number;
  started: number;
  completed: number;
  cancelled: number;
  progress: number;
  review: number;
  approved: number;
}

export function countIssues(issues: readonly Issue[], states: ReadonlyMap<string, WorkflowState>, statesOf: (projectId: string) => readonly WorkflowState[]): CycleCounts {
  const n: CycleCounts = { total: 0, backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0, progress: 0, review: 0, approved: 0 };
  for (const i of issues) {
    const s = states.get(i.stateId);
    n.total++;
    const g = s?.group;
    if (g === "backlog" || g === "unstarted" || g === "completed" || g === "cancelled") n[g]++;
    else if (g === "started") {
      n.started++;
      n[startedStage(statesOf(i.projectId), i.stateId) ?? "progress"]++;
    }
  }
  return n;
}

/** Counts frozen in a completed cycle's summary, in the same shape. */
export function summaryCounts(c: Cycle): CycleCounts | null {
  const g = c.summary?.groups;
  if (!g) return null;
  const at = (k: string) => g[k] ?? 0;
  const started = at("started");
  return {
    total: Object.values(g).reduce((a, b) => a + b, 0),
    backlog: at("backlog"),
    unstarted: at("unstarted"),
    started,
    completed: at("completed"),
    cancelled: at("cancelled"),
    progress: started,
    review: 0,
    approved: 0,
  };
}

/** Done ÷ (scope − cancelled), as Plane counts a cycle's progress. */
export const percentDone = (n: CycleCounts): number => doneShare(n.completed, n.total, n.cancelled);

/**
 * Issues in the cycle, started or done, done: point 0 at the cycle's first moment, point k at the end of its day k, the
 * last one now while the cycle is in progress (RSVA-528). The chart puts point k at k days from the start.
 */
export interface BurnSeries {
  start: string;
  days: number;
  scope: number[];
  started: number[];
  done: number[];
  /** Index of today's point, when the cycle is in progress. */
  today: number | null;
  /** Where now is, in days from the start (1.8: four fifths through day 2), when the cycle is in progress. */
  now: number | null;
}

/** Where point k sits, in days from the start: today's at now. */
export const pointAt = (s: BurnSeries, k: number): number => (k === s.today && s.now !== null ? s.now : k);

/**
 * The burn-up: the start and the days that are over from the server, today from the store's issues. A completed cycle
 * reads its frozen summary. Points the server has not answered yet repeat the last known count, or today's before any,
 * so the line never drops to zero while loading.
 */
export function burnSeries(c: Cycle, past: CycleProgress | null, counts: CycleCounts, at = new Date()): BurnSeries | null {
  if (!c.startDate || !c.endDate) return null;
  const days = cycleDays(c);
  const empty = { start: c.startDate, days, today: null, now: null };
  if (c.summary) return { ...empty, scope: c.summary.scope, started: c.summary.started, done: c.summary.done };
  const day = localToday(at);
  const status = statusOf(c, day);
  if (status === "upcoming") return { ...empty, scope: [], started: [], done: [] };
  const today = status === "active" ? daysBetween(c.startDate, day) + 1 : null;
  const point = { scope: counts.total, started: counts.started + counts.completed, done: counts.completed };
  const out: BurnSeries = { ...empty, scope: [], started: [], done: [], today, now: today === null ? null : today - 1 + dayShare(day, at) };
  for (let k = 0; k <= (today ?? days); k++) {
    for (const f of ["scope", "started", "done"] as const) {
      if (k === today) out[f].push(point[f]);
      else if (past && k < past[f].length) out[f].push(past[f][k]!);
      else out[f].push(out[f].at(-1) ?? point[f]);
    }
  }
  return out;
}

/** How much of the local day has gone by at `at`, 0 to 1. */
function dayShare(day: string, at: Date): number {
  const from = dayStart(day).getTime();
  return Math.min(1, Math.max(0, (at.getTime() - from) / (dayStart(addDays(day, 1)).getTime() - from)));
}

/** The straight line from nothing at the start to the scope at the end of the last day, `x` days in. */
export const idealAt = (s: BurnSeries, x: number): number => Math.round(((s.scope.at(-1) ?? 0) * x) / Math.max(1, s.days));

/**
 * Where the done line ends if the cycle goes on as it has: what is done now, at the same rate to the last day, the scope
 * at most. Null before a cycle in progress has a rate to speak of (its first hours) and for any other cycle.
 */
export function paceEnd(s: BurnSeries): number | null {
  if (s.now === null || s.now < 0.5) return null;
  return Math.min(s.scope.at(-1) ?? 0, Math.round(((s.done.at(-1) ?? 0) / s.now) * s.days));
}

/** The date of day k of a series, 0 the first. */
export const dayOf = (s: Pick<BurnSeries, "start">, k: number): string => addDays(s.start, k);

const progress = observable.map<string, CycleProgress>(undefined, { deep: false });
const asked = new Set<string>();

/**
 * The cycle's start and finished days in this browser's time zone, the one localToday counts in: asked once per cycle,
 * dates and day (they never change), null until the answer comes. A completed cycle and a draft need no request.
 */
export function cycleProgress(c: Cycle): CycleProgress | null {
  if (c.summary || !c.startDate || !c.endDate || c.startDate > localToday()) return null;
  const key = `${c.id}:${c.startDate}:${c.endDate}:${localToday()}`;
  if (!asked.has(key)) {
    asked.add(key);
    fetch(`/sync/cycle-progress/${c.id}?tz=${encodeURIComponent(deviceTimeZone())}`)
      .then((r) => (r.ok ? (r.json() as Promise<CycleProgress>) : null))
      .then((p) => p && runInAction(() => progress.set(key, p)))
      .catch(() => asked.delete(key));
  }
  return progress.get(key) ?? null;
}
