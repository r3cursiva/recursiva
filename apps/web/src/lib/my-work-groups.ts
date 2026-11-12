// My work grouped another way than by section (owner, 2026-11-08): by project, by status or by priority. The issues are
// the same, what the visible sections hold; only how they are laid out changes. Status is the state's group and, for a
// started one, its stage, so that the columns are the same in every project and workspace whatever their states are
// called.
import type { WorkItem } from "@rsva/protocol/my-work";
import { PRIORITIES, startedStage, type Issue, type StartedStage, type StateGroup } from "@rsva/schema/models";
import type { SyncStore } from "@rsva/sync";

export const GROUP_BYS = ["section", "status", "priority", "project"] as const;
export type MyWorkGroupBy = (typeof GROUP_BYS)[number];
export const GROUP_BY_NAMES: Record<MyWorkGroupBy, string> = { section: "Section", status: "Status", priority: "Priority", project: "Project" };

/** A status column: a state group, or a stage of the started one. */
type StatusKey = Exclude<StateGroup, "started"> | StartedStage;
const STATUS: readonly { key: StatusKey; name: string; group: StateGroup; stage?: StartedStage }[] = [
  { key: "backlog", name: "Backlog", group: "backlog" },
  { key: "unstarted", name: "Todo", group: "unstarted" },
  { key: "progress", name: "In Progress", group: "started", stage: "progress" },
  { key: "review", name: "In Review", group: "started", stage: "review" },
  { key: "approved", name: "Approved", group: "started", stage: "approved" },
  { key: "completed", name: "Done", group: "completed" },
  { key: "cancelled", name: "Cancelled", group: "cancelled" },
];

export interface Lane {
  /** `g:` and the value: never a section's id. */
  id: string;
  name: string;
  rows: WorkItem[];
  /** What the lane's header draws before its name. */
  status?: { group: StateGroup; stage?: StartedStage };
  priority?: number;
}

function statusOf(e: SyncStore, issue: Issue): StatusKey | null {
  const s = e.states.get(issue.stateId);
  if (!s) return null;
  return s.group === "started" ? (startedStage(e.statesOf(issue.projectId), s.id) ?? "progress") : (s.group as StatusKey);
}

/**
 * The lanes of `items` (in their order, which they keep within a lane). Status and priority have every column, empty
 * ones too, so a card can be dropped there; projects are those that have work, the busiest first.
 */
export function regroup(by: Exclude<MyWorkGroupBy, "section">, items: readonly WorkItem[], engineOf: (x: WorkItem) => SyncStore, workspaceName: (slug: string) => string, many: boolean): Lane[] {
  if (by === "status") {
    const lanes = STATUS.map((s) => ({ id: `g:${s.key}`, name: s.name, rows: [] as WorkItem[], status: { group: s.group, ...(s.stage ? { stage: s.stage } : {}) } }));
    for (const x of items) lanes.find((l) => l.id === `g:${statusOf(engineOf(x), x.issue)}`)?.rows.push(x);
    return lanes;
  }
  if (by === "priority") {
    const lanes = PRIORITIES.map((p) => ({ id: `g:${p.code}`, name: p.name, rows: [] as WorkItem[], priority: p.code }));
    for (const x of items) lanes.find((l) => l.priority === x.issue.priority)?.rows.push(x);
    return lanes;
  }
  const lanes = new Map<string, Lane>();
  for (const x of items) {
    const id = `g:${x.ws}/${x.issue.projectId}`;
    let lane = lanes.get(id);
    if (!lane) {
      const p = engineOf(x).projects.get(x.issue.projectId);
      lanes.set(id, (lane = { id, name: `${p?.name ?? "?"}${many ? ` · ${workspaceName(x.ws)}` : ""}`, rows: [] }));
    }
    lane.rows.push(x);
  }
  return [...lanes.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
}
