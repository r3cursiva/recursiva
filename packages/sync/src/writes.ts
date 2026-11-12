// The ops a write sends: pure functions of the pool (and the viewer), so the engine only queues what they return and a
// test can check a write without an engine. An empty list means the write changes nothing and sends nothing.
import { ISSUE_LISTS, completeCycleOps, defaultOffOps, deleteCycleOps, deleteLabelOps, deleteStateOps, uuidv7, type ListBase, type Op, type SplitOps } from "@rsva/protocol";
import { cleanName, cleanUrl, isClosedGroup, moveLabels, moveState, relationPatches } from "@rsva/schema/models";
import type { IssueUpdate, Label, RelationType, StateGroup, StatePatch, WorkspacePatch } from "@rsva/schema/models";
import { same, type Pool, type Row } from "./pool.ts";
import type { WorkspaceInfo } from "./store.ts";

/**
 * Archive and delete times: the client sends any time and the server writes its own, so archiving an archived row (or
 * restoring a live one) is not a change, whatever time is sent.
 */
const MOMENTS = new Set(["archivedAt", "deletedAt"]);

/** The fields of `patch` that differ from the row, or null: a no-op edit sends nothing and leaves nothing pending. */
function changes(row: Row, patch: object): Row | null {
  const set: Row = {};
  for (const [k, v] of Object.entries(patch)) {
    if (MOMENTS.has(k) ? (v === null) !== (row[k] === null) : !same(row[k], v)) set[k] = v;
  }
  return Object.keys(set).length ? set : null;
}

/** Models whose edit is just their changed fields. */
type Patched = "Issue" | "Project" | "Label" | "Cycle";

/** An update of row `id` with the fields of `patch` that differ from it; nothing for a row not here or no change. */
export function rowUpdate(pool: Pool, m: Patched, id: string, patch: object): Op[] {
  const row = pool.get(m, id);
  const set = row && changes(row, patch);
  return set ? [{ op: "update", m, id, set } as Op] : [];
}

/** What an update of an issue's lists replaces, as shown here: the server merges the change into the list as it is then. */
export function withBase(pool: Pool, op: Op): Op {
  if (op.op !== "update" || op.m !== "Issue") return op;
  const row = pool.maps.Issue.get(op.id);
  const base: ListBase = {};
  for (const k of ISSUE_LISTS) if (row && op.set[k]) base[k] = [...row[k]];
  return Object.keys(base).length ? { ...op, base } : op;
}

/**
 * Issues to another project of the workspace (PLNR-448): each takes the state, labels and cycle the server will give it
 * (moveState, moveLabels; the cycle is cleared). Issues already there and deleted ones are left out.
 */
export function issueMoves(pool: Pool, ids: Iterable<string>, projectId: string): Op[] {
  const states = pool.statesOf(projectId);
  if (!states.length) return [];
  const labels = pool.maps.Label as unknown as ReadonlyMap<string, Label>;
  const target = pool.labelsOf(projectId);
  const ops: Op[] = [];
  for (const id of new Set(ids)) {
    const row = pool.maps.Issue.get(id);
    if (!row || row.projectId === projectId || row.deletedAt) continue;
    const set: IssueUpdate = {
      projectId,
      stateId: moveState(pool.maps.WorkflowState.get(row.stateId), states),
      labelIds: moveLabels(row.labelIds, labels, projectId, target).labelIds,
      ...(row.cycleId ? { cycleId: null } : {}),
    };
    ops.push({ op: "update", m: "Issue", id, set });
  }
  return ops;
}

/** A relation between two issues, or none (null type). One transaction: the pair never shows without one in between. */
export function relationChange(pool: Pool, issueId: string, type: RelationType | null, otherId: string): Op[] {
  const a = pool.maps.Issue.get(issueId);
  const b = pool.maps.Issue.get(otherId);
  if (!a || !b) return [];
  return relationPatches(a, b, type).map(({ id, set }) => ({ op: "update", m: "Issue", id, set }));
}

export function linkUpdate(pool: Pool, id: string, patch: { url?: string; title?: string }): Op[] {
  const row = pool.get("Attachment", id);
  if (!row) return [];
  const next: Row = {};
  if (patch.title !== undefined) next.title = cleanName(patch.title);
  if (patch.url !== undefined) {
    const clean = cleanUrl(patch.url);
    if (!clean) return [];
    next.url = clean;
  }
  const set = changes(row, next);
  return set ? [{ op: "update", m: "Attachment", id, set: set as { url?: string; title?: string } }] : [];
}

/** Alone in its transaction: the server locks the workspace row early (sync/settings.ts, updateWorkspace). */
export function workspaceUpdate(ws: WorkspaceInfo | null, patch: WorkspacePatch): Op[] {
  if (!ws) return [];
  const set: Row = {};
  for (const k in patch) if (!same(ws[k as keyof WorkspaceInfo], patch[k as keyof WorkspacePatch])) set[k] = patch[k as keyof WorkspacePatch];
  return Object.keys(set).length ? [{ op: "update", m: "Workspace", id: ws.id, set: set as WorkspacePatch }] : [];
}

/** A new state, last in its group: lists order states by group, then position. */
export function stateCreate(pool: Pool, id: string, projectId: string, name: string, group: StateGroup): Op[] {
  const all = pool.statesOf(projectId);
  const position = (all.filter((s) => s.group === group).at(-1) ?? all.at(-1))?.position ?? 0;
  return [{ op: "create", m: "WorkflowState", id, set: { projectId, name, group, position: position + 1 } }];
}

/** The default moves in one transaction, the old one off and the new one on: never two, never none. */
export function stateUpdate(pool: Pool, id: string, patch: StatePatch): Op[] {
  const row = pool.get("WorkflowState", id);
  const set = row && changes(row, patch);
  // A default is replaced, not switched off.
  if (!set || set.isDefault === false) return [];
  const off = set.isDefault === true ? defaultOffOps(pool.statesOf(row.projectId as string), id) : [];
  return [...off, { op: "update", m: "WorkflowState", id, set: set as StatePatch }];
}

export function stateDelete(pool: Pool, id: string, moveTo: string): SplitOps | null {
  const row = pool.maps.WorkflowState.get(id);
  const target = pool.maps.WorkflowState.get(moveTo);
  if (!row || !target || target.id === id || target.projectId !== row.projectId) return null;
  // Archived issues too: the server refuses while any issue is in the state.
  const issues = [...pool.maps.Issue.values()].filter((i) => i.stateId === id).map((i) => i.id);
  return deleteStateOps(row, issues, moveTo);
}

/** A new label, last of its project's. */
export function labelCreate(pool: Pool, id: string, projectId: string, name: string, color: string): Op[] {
  const position = (pool.labelsOf(projectId).at(-1)?.position ?? 0) + 1;
  return [{ op: "create", m: "Label", id, set: { projectId, name, color, position } }];
}

/** Off every issue, the labels inside it up a level, then the label: what the server requires, in that order. */
export function labelDelete(pool: Pool, id: string): SplitOps | null {
  const row = pool.maps.Label.get(id);
  return row ? deleteLabelOps(row, pool.maps.Issue.values(), pool.maps.Label.values()) : null;
}

export function cycleComplete(pool: Pool, id: string, moveTo: string | null, keep: readonly string[]): SplitOps | null {
  const row = pool.maps.Cycle.get(id);
  if (!row || row.completedAt) return null;
  const skip = new Set(keep);
  const moving = pool.issuesInCycle(id).filter((i) => !skip.has(i.id) && !isClosedGroup(pool.maps.WorkflowState.get(i.stateId)?.group));
  return completeCycleOps(id, moving.map((i) => i.id), moveTo);
}

export function cycleDelete(pool: Pool, id: string): SplitOps | null {
  const row = pool.maps.Cycle.get(id);
  if (!row || row.completedAt) return null;
  // Archived and deleted issues too: the server refuses while any issue is in the cycle.
  const issues = [...pool.maps.Issue.values()].filter((i) => i.cycleId === id).map((i) => i.id);
  return deleteCycleOps(id, issues);
}

/** The viewer's reaction off if they have it, on if not. */
export function reactionToggle(pool: Pool, me: string, issueId: string, commentId: string | null, emoji: string): Op[] {
  const mine = pool.reactionsOf(issueId).find((r) => r.userId === me && r.commentId === commentId && r.emoji === emoji);
  return mine ? [{ op: "delete", m: "Reaction", id: mine.id }] : [{ op: "create", m: "Reaction", id: uuidv7(), set: { issueId, commentId, emoji } }];
}
