// My work at the scale of projects (RSVA-563, RSVA-564): what turns a long queue into a picture of every project.
//
// Proposals fold (RSVA-563). Agents propose more than a person triages in a day: on 2026-11-09 Waiting on you held 233
// rows, about 225 of them proposals, and the few reviews that waited that day were lost among them. A project's
// proposals become one row that unfolds in place; urgent ones and a project's only one stay rows of their own.
//
// Projects (RSVA-564, RSVA-568): a row per project of every workspace, how it stands for the viewer (waiting on them,
// proposals, theirs in progress, with agents) and on its own (overdue, in review, parked, open, the active cycle, the
// last change), from the engines My work already holds: no request. Home draws them (screens/my-work-home.tsx).
//
// The rows were first a band of numbers above the queue (RSVA-564): a table over a table, read as one more section of
// issues. Home took them (RSVA-568, owner 2026-11-10) and the queue is issues only. For the proposals: rows folded
// in place (chosen: the keys, the undo and the docked issue work on them unchanged), a sixth group "To triage" (a change
// to the protocol, the bot's /my and every stored set of sections for the same effect), and leaving them to a page of
// their own (the queue would lose the keyboard flow it has).
import {
  cycleStatus,
  isLiveIssue,
  isOpenIssue,
  startedStage,
  type Cycle,
  type Issue,
  type Project,
  type WorkflowState,
} from "@rsva/schema/models";
import { asksViewer, isIdle, proposedLabels, toTriage, type WorkItem } from "./my-work.ts";
import { countIssues, type CycleCounts } from "./cycles.ts";

// ── Proposals folded per project ─────────────────────────────────────────────────────────────────────────────

export interface Bundle {
  kind: "bundle";
  /** `b:<workspace>/<project id>`. */
  id: string;
  ws: string;
  projectId: string;
  /** The project's folded proposals, in the group's order. */
  items: WorkItem[];
  /** When the oldest of them was proposed. */
  oldest: string;
  open: boolean;
}

/** A row of the list: an issue, or a project's folded proposals. */
export type Entry = WorkItem | Bundle;
export const isBundle = (e: Entry): e is Bundle =>
  "kind" in e && e.kind === "bundle";
export const entryId = (e: Entry): string =>
  isBundle(e) ? e.id : `${e.ws}/${e.issue.id}`;

const foldable = (x: WorkItem) =>
  x.ask === "proposed" && x.issue.priority !== 1;

/**
 * Waiting on you with the proposals folded: the rows that stay rows first, in their order, then a project's proposals as
 * one row, the biggest pile first (the oldest first among equals); an open one is followed by its proposals. A project
 * with one proposal keeps it as a row: a fold of one hides nothing.
 */
export function foldProposals(
  rows: readonly WorkItem[],
  open: ReadonlySet<string>,
): Entry[] {
  const piles = new Map<string, WorkItem[]>();
  for (const x of rows) {
    if (!foldable(x)) continue;
    const id = `b:${x.ws}/${x.issue.projectId}`;
    const pile = piles.get(id);
    if (pile) pile.push(x);
    else piles.set(id, [x]);
  }
  for (const [id, items] of piles) if (items.length < 2) piles.delete(id);
  const folded = new Set([...piles.values()].flat());
  const bundles: Bundle[] = [...piles].map(([id, items]) => ({
    kind: "bundle",
    id,
    ws: items[0]!.ws,
    projectId: items[0]!.issue.projectId,
    items,
    oldest: items.reduce(
      (a, x) => (x.since < a ? x.since : a),
      items[0]!.since,
    ),
    open: open.has(id),
  }));
  bundles.sort(
    (a, b) =>
      b.items.length - a.items.length || a.oldest.localeCompare(b.oldest),
  );
  return [
    ...rows.filter((x) => !folded.has(x)),
    ...bundles.flatMap((b): Entry[] => (b.open ? [b, ...b.items] : [b])),
  ];
}

// ── Projects ────────────────────────────────────────────────────────────────────────────────────────────

/** What the projects' rows read of a workspace's engine. */
export interface PulseSource {
  projectList(): Project[];
  issues: { values(): Iterable<Issue> };
  states: ReadonlyMap<string, WorkflowState>;
  labels: { values(): Iterable<{ id: string; name: string }> };
  statesOf(projectId: string): readonly WorkflowState[];
  cyclesOf(projectId: string): Cycle[];
  issuesInCycle(cycleId: string): Issue[];
}

/** A todo that nobody touched for this long is still: a promise that sits. */
export const STILL_DAYS = 14;

/** Open issues nobody works on, each counted once: the first that fits, in this order. */
export interface Parked {
  /** Proposals in the backlog, waiting to be triaged. */
  proposed: number;
  /** Todo, unchanged for STILL_DAYS. */
  still: number;
  todo: number;
  backlog: number;
}
export const PARKED = ["still", "todo", "backlog", "proposed"] as const;
export const parkedTotal = (p: Parked): number =>
  p.still + p.todo + p.backlog + p.proposed;

export interface Pulse {
  ws: string;
  project: Project;
  /** Reviews, mentions and replies waiting on the viewer. */
  wait: number;
  /** Proposals waiting on the viewer to triage. */
  triage: number;
  doing: number;
  agents: number;
  /** Of `agents`, those whose issue has not changed for two days. */
  idle: number;
  /** Open issues of the project past their due date, whoever has them. */
  overdue: number;
  /** Open issues in review or approved, whoever has them, but for those waiting on the viewer. */
  review: number;
  parked: Parked;
  /** Open issues of the project. */
  open: number;
  /** The cycle in progress, counted; null without one. */
  cycle: { cycle: Cycle; counts: CycleCounts } | null;
  /** The last change to any of its live issues. */
  changed: string | null;
  /** In Quiet by the sidebar's rule (the person's quiet days, Mark as quiet, Keep visible); false when none was given. */
  quiet: boolean;
}

/** A project's row before anything is counted. */
export const blankPulse = (ws: string, project: Project): Pulse => ({
  ws,
  project,
  wait: 0,
  triage: 0,
  doing: 0,
  agents: 0,
  idle: 0,
  overdue: 0,
  review: 0,
  parked: { proposed: 0, still: 0, todo: 0, backlog: 0 },
  open: 0,
  cycle: null,
  changed: null,
  quiet: false,
});

/**
 * A row per project of the workspace, in its own order; `items` are the workspace's My work. `quiet` says, of a counted
 * row, whether the project is quiet: Home passes the sidebar's rule so the two never differ.
 */
export function pulses(
  ws: string,
  s: PulseSource,
  items: readonly WorkItem[],
  today: string,
  now: number,
  quiet?: (p: Pulse) => boolean,
): Pulse[] {
  const byProject = new Map<string, Pulse>();
  for (const project of s.projectList())
    byProject.set(project.id, blankPulse(ws, project));
  const proposed = proposedLabels(s);
  const waiting = new Set(
    items.filter((x) => x.group === "wait").map((x) => x.issue.id),
  );
  // Moments are compared as numbers: the same instant is written with and without milliseconds.
  const stillBefore = now - STILL_DAYS * 86_400_000;
  for (const i of s.issues.values()) {
    const p = byProject.get(i.projectId);
    if (!p || !isLiveIssue(i)) continue;
    if (!p.changed || i.updatedAt > p.changed) p.changed = i.updatedAt;
    const group = s.states.get(i.stateId)?.group;
    if (!isOpenIssue(i, group)) continue;
    p.open++;
    if (i.dueDate && i.dueDate < today) p.overdue++;
    if (group === "backlog")
      p.parked[
        i.labelIds.some((id) => proposed.has(id)) ? "proposed" : "backlog"
      ]++;
    else if (group === "unstarted")
      p.parked[Date.parse(i.updatedAt) <= stillBefore ? "still" : "todo"]++;
    else if (
      !waiting.has(i.id) &&
      startedStage(s.statesOf(i.projectId), i.stateId) !== "progress"
    )
      p.review++;
  }
  for (const x of items) {
    const p = byProject.get(x.issue.projectId);
    if (!p) continue;
    if (asksViewer(x)) p.wait++;
    else if (toTriage(x)) p.triage++;
    else if (x.group === "doing") p.doing++;
    else if (x.group === "agents") (p.agents++, isIdle(x, now) && p.idle++);
  }
  for (const p of byProject.values()) {
    const cycle = s
      .cyclesOf(p.project.id)
      .find((c) => cycleStatus(c, today) === "active");
    if (cycle)
      p.cycle = {
        cycle,
        counts: countIssues(s.issuesInCycle(cycle.id), s.states, (id) =>
          s.statesOf(id),
        ),
      };
  }
  const rows = [...byProject.values()];
  if (quiet) for (const p of rows) p.quiet = quiet(p);
  return rows;
}

/**
 * The rows' order: what waits on the viewer, then what is late, proposals, their work and their agents', a running
 * cycle; the quiet ones last; among equals the most recently changed first.
 */
export function sortPulses(list: Pulse[]): Pulse[] {
  const keys = (p: Pulse) => [
    Number(p.quiet),
    -p.wait,
    -p.overdue,
    -p.triage,
    -(p.doing + p.agents),
    -Number(!!p.cycle),
  ];
  return list.sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++)
      if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return (b.changed ?? "").localeCompare(a.changed ?? "");
  });
}
