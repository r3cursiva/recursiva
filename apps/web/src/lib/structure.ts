// What a project is made of (RSVA-570, the Quire artboard FramedProjectHomeStructure): its issues under their parent
// issues, or under their labels, each row counted the way My work's Home counts a project — what is live, by kind, and
// what is done, open and in the backlog. Pure: the widget passes what it reads from the store.
//
// Rows could also have been the project's cycles (a cycle already has its page and its widget) or its assignees (the
// chart widget draws those); parents and labels are the two ways people already cut a project into pieces of work.
import type { Issue, StartedStage } from "@rsva/schema/models";

export type StructureBy = "parent" | "label";

export interface StructureRow {
  /** The parent issue's id, the label's, or "rest" for what has neither. */
  id: string;
  kind: StructureBy | "rest";
  /** Open issues waiting on the viewer, theirs in progress, with their agents; in review; waiting on another issue. */
  wait: number;
  doing: number;
  agents: number;
  review: number;
  blocked: number;
  done: number;
  /** Open and out of the backlog: todo and started. */
  open: number;
  backlog: number;
  /** The last change to any issue of the row. */
  changed: string | null;
}

export const rowTotal = (r: StructureRow): number => r.done + r.open + r.backlog;

export interface StructureFacts {
  /** The group of the issue's state: backlog, unstarted, started, completed, cancelled. */
  groupOf(issue: Issue): string | undefined;
  stageOf(issue: Issue): StartedStage | undefined;
  /** The viewer's My work in this project, by issue id. */
  wait: ReadonlySet<string>;
  doing: ReadonlySet<string>;
  agents: ReadonlySet<string>;
  /** Open issues waiting on another open issue. */
  blocked: ReadonlySet<string>;
}

/** True when the project's open work hangs under parent issues: the cut the widget opens on. */
export const hasParents = (issues: readonly Issue[], facts: Pick<StructureFacts, "groupOf">): boolean =>
  issues.some((i) => i.parentId && isOpen(facts.groupOf(i)));

const isOpen = (g: string | undefined) => g !== "completed" && g !== "cancelled";

/**
 * A row per parent issue with everything under it at any depth (the parent itself is the row, not one of its issues),
 * or per label (an issue with two labels is in both rows); what has no parent and no sub-issues, or no label, is the
 * "rest" row. Cancelled issues are not counted; a row with nothing left open is left out.
 */
export function structure(by: StructureBy, issues: readonly Issue[], f: StructureFacts): StructureRow[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const parents = new Set(issues.map((i) => i.parentId).filter((id): id is string => !!id && byId.has(id)));
  /** The topmost issue above this one, within the project; a loop ends where it began. */
  const rootOf = (i: Issue): Issue => {
    const seen = new Set<string>([i.id]);
    let at = i;
    for (let up = at.parentId ? byId.get(at.parentId) : undefined; up && !seen.has(up.id); up = at.parentId ? byId.get(at.parentId) : undefined) {
      seen.add(up.id);
      at = up;
    }
    return at;
  };
  const rows = new Map<string, StructureRow>();
  const row = (id: string, kind: StructureRow["kind"]) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, kind, wait: 0, doing: 0, agents: 0, review: 0, blocked: 0, done: 0, open: 0, backlog: 0, changed: null }));
    return r;
  };
  for (const i of issues) {
    const group = f.groupOf(i);
    if (!group || group === "cancelled") continue;
    let into: StructureRow[];
    if (by === "label") into = i.labelIds.length ? i.labelIds.map((id) => row(id, "label")) : [row("rest", "rest")];
    else {
      const root = rootOf(i);
      // The parent is its row: its own state is not one of the row's issues.
      if (root === i && parents.has(i.id)) continue;
      into = [root === i ? row("rest", "rest") : row(root.id, "parent")];
    }
    for (const r of into) {
      if (!r.changed || i.updatedAt > r.changed) r.changed = i.updatedAt;
      if (group === "completed") {
        r.done++;
        continue;
      }
      r[group === "backlog" ? "backlog" : "open"]++;
      if (f.blocked.has(i.id)) r.blocked++;
      if (f.wait.has(i.id)) r.wait++;
      else if (f.doing.has(i.id)) r.doing++;
      else if (f.agents.has(i.id)) r.agents++;
      else if (group === "started" && f.stageOf(i) !== "progress") r.review++;
    }
  }
  return [...rows.values()].filter((r) => r.open + r.backlog > 0);
}

/** A row with open work and no change for this many days has stalled. */
const STALL_DAYS = 7;

export type StructureGroup = "need" | "moving" | "stalled";
export const STRUCTURE_GROUPS: readonly { id: StructureGroup; name: string }[] = [
  { id: "need", name: "Need you" },
  { id: "moving", name: "Moving" },
  { id: "stalled", name: "Stalled" },
];

export const groupOfRow = (r: StructureRow, now: number): StructureGroup =>
  r.wait > 0 ? "need" : r.changed && now - Date.parse(r.changed) >= STALL_DAYS * 86_400_000 ? "stalled" : "moving";

/** The rows in their groups' order, the most open work first; the rest row last in its group. */
export function sortRows(rows: StructureRow[], now: number): StructureRow[] {
  const at = (r: StructureRow) => STRUCTURE_GROUPS.findIndex((g) => g.id === groupOfRow(r, now));
  return rows.sort((a, b) => at(a) - at(b) || Number(a.kind === "rest") - Number(b.kind === "rest") || b.open + b.backlog - (a.open + a.backlog));
}
