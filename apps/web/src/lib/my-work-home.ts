// What was closed, day by day and since a given moment: the count under the project home's year grid (home-year.tsx).
// It was My work's Home's (RSVA-568), with the running cycles on one calendar and what has stopped; the page went with the
// Triage split (owner 2026-11-11).
import { addDays, localDay } from "@rsva/schema/days";
import {
  isLiveIssue,
  isOpenIssue,
  type Issue,
  type WorkflowState,
} from "@rsva/schema/models";

// ── Closed, day by day ───────────────────────────────────────────────────────────────────────────────────────

interface ClosedDay {
  day: string;
  people: number;
  /** Closed with an agent as the delegate. */
  agents: number;
}

export interface Closed {
  /** The last `days` days, oldest first, today last. */
  days: ClosedDay[];
  /** Since the last visit: closed, of them by agents, and open issues whose due date passed. */
  since: { closed: number; agents: number; overdue: number } | null;
}

/** What the page reads of a workspace's issues. */
export interface ClosedSource {
  issues: { values(): Iterable<Issue> };
  states: ReadonlyMap<string, WorkflowState>;
}

/**
 * One pass over each workspace's issues that `keep` lets through: completed ones by the local day they were completed on, and what
 * happened since `since` (the last visit; null on the first).
 */
export function closed(
  sources: Iterable<readonly [ws: string, source: ClosedSource]>,
  keep: (ws: string, issue: Issue) => boolean,
  now: number,
  since: string | null,
  days = 14,
): Closed {
  const today = localDay(new Date(now));
  const first = addDays(today, 1 - days);
  const byDay = new Map<string, ClosedDay>();
  for (let k = 0; k < days; k++) {
    const day = addDays(first, k);
    byDay.set(day, { day, people: 0, agents: 0 });
  }
  const after = since ? { closed: 0, agents: 0, overdue: 0 } : null;
  const sinceAt = since ? Date.parse(since) : 0;
  const sinceDay = since ? localDay(new Date(since)) : "";
  for (const [ws, s] of sources)
    for (const i of s.issues.values()) {
      if (!isLiveIssue(i) || !keep(ws, i)) continue;
      const group = s.states.get(i.stateId)?.group;
      if (group === "completed" && i.completedAt) {
        const d = byDay.get(localDay(new Date(i.completedAt)));
        if (d) d[i.delegateId ? "agents" : "people"]++;
        if (after && Date.parse(i.completedAt) > sinceAt) {
          after.closed++;
          if (i.delegateId) after.agents++;
        }
      } else if (
        after &&
        i.dueDate &&
        i.dueDate < today &&
        i.dueDate >= sinceDay &&
        isOpenIssue(i, group)
      )
        after.overdue++;
    }
  return { days: [...byDay.values()], since: after };
}
