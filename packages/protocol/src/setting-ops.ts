// Settings changes that take more than one op, built alike by the browser (packages/sync) and the agent API
// (apps/server/src/api-settings.ts, api-cycles.ts): what the write pipeline requires around the change itself
// (sync/settings.ts, sync/cycles.ts). A
// project comes with its states; a default state is replaced, never switched off; a state or a label in use is emptied
// first, as ordinary issue updates, so each move is in the issue's history.
import { DEFAULT_WORKFLOW, type Issue, type Label, type ProjectCreate, type WorkflowState } from "@rsva/schema/models";
import type { Op } from "./index.ts";

/**
 * A new project's states as stored, whichever way the project is made (New project and the agent API through
 * newProjectOps, a new workspace's projects inserted directly): Plane's default workflow in order, positions with room
 * between them, the first the default.
 */
export const DEFAULT_STATES = DEFAULT_WORKFLOW.map((s, i) => ({ name: s.name, group: s.group, position: (i + 1) * 1000, isDefault: i === 0, onlyPeople: s.onlyPeople ?? false }));

/**
 * A new project with the default states, in one transaction. A state's op says isDefault and onlyPeople only when true:
 * an explicit `onlyPeople: false` is an admin's choice to leave a guard off (packages/policy, deniedOps).
 */
export function newProjectOps(id: string, set: ProjectCreate, newId: () => string): Op[] {
  const states: Op[] = DEFAULT_STATES.map((s) => ({
    op: "create",
    m: "WorkflowState",
    id: newId(),
    set: { projectId: id, name: s.name, group: s.group, position: s.position, ...(s.isDefault ? { isDefault: true } : {}), ...(s.onlyPeople ? { onlyPeople: true } : {}) },
  }));
  return [{ op: "create", m: "Project", id, set: { name: set.name, key: set.key, color: set.color ?? null } }, ...states];
}

/** The other defaults off, for a state becoming the default in the same transaction: never two, never none. */
export function defaultOffOps(states: Iterable<Pick<WorkflowState, "id" | "isDefault">>, id: string): Op[] {
  const out: Op[] = [];
  for (const s of states) if (s.isDefault && s.id !== id) out.push({ op: "update", m: "WorkflowState", id: s.id, set: { isDefault: false } });
  return out;
}

/** Ops in two parts: `first` may go in as many transactions as it takes, `last` goes with the end of it. */
export interface SplitOps {
  first: Op[];
  last: Op[];
}

/** Deleting a state: its issues, archived and deleted ones too, move to `moveTo` first, which becomes the default if this one was. */
export function deleteStateOps(state: Pick<WorkflowState, "id" | "isDefault">, issueIds: Iterable<string>, moveTo: string): SplitOps {
  const first: Op[] = [];
  for (const id of issueIds) first.push({ op: "update", m: "Issue", id, set: { stateId: moveTo } });
  const last: Op[] = [{ op: "delete", m: "WorkflowState", id: state.id }];
  if (state.isDefault) last.unshift({ op: "update", m: "WorkflowState", id: moveTo, set: { isDefault: true } });
  return { first, last };
}

/**
 * Deleting a label: off every issue, the labels inside it up one level, then the label. Each issue's list as read is the
 * base, so a label someone adds to the issue meanwhile stays (the server merges lists, write.ts).
 */
export function deleteLabelOps(label: Pick<Label, "id" | "parentId">, issues: Iterable<Pick<Issue, "id" | "labelIds">>, labels: Iterable<Pick<Label, "id" | "parentId">>): SplitOps {
  const first: Op[] = [];
  for (const i of issues) {
    if (i.labelIds.includes(label.id)) first.push({ op: "update", m: "Issue", id: i.id, set: { labelIds: i.labelIds.filter((l) => l !== label.id) }, base: { labelIds: [...i.labelIds] } });
  }
  for (const l of labels) if (l.parentId === label.id) first.push({ op: "update", m: "Label", id: l.id, set: { parentId: label.parentId } });
  return { first, last: [{ op: "delete", m: "Label", id: label.id }] };
}

/**
 * Completing a cycle: the completion, then the moves of the issues that leave it (its open ones not kept) to `moveTo`, or
 * out of any cycle. The completion heads `first`, so it goes in the first transaction and the server freezes the summary
 * from the issues as they were (sync/cycles.ts); the moves follow in as many as they take.
 */
export function completeCycleOps(id: string, moving: Iterable<string>, moveTo: string | null): SplitOps {
  const first: Op[] = [{ op: "update", m: "Cycle", id, set: { completedAt: new Date().toISOString() } }];
  for (const i of moving) first.push({ op: "update", m: "Issue", id: i, set: { cycleId: moveTo } });
  return { first, last: [] };
}

/** Deleting a cycle: its issues, archived and deleted ones too, out of it first (the server refuses while any is in), then the cycle. */
export function deleteCycleOps(id: string, issueIds: Iterable<string>): SplitOps {
  const first: Op[] = [];
  for (const i of issueIds) first.push({ op: "update", m: "Issue", id: i, set: { cycleId: null } });
  return { first, last: [{ op: "delete", m: "Cycle", id }] };
}

/** The transactions of split ops, at most `max` ops each. */
export function txChunks({ first, last }: SplitOps, max: number): Op[][] {
  const out: Op[][] = [];
  let i = 0;
  for (; first.length - i + last.length > max; i += max) out.push(first.slice(i, i + max));
  out.push([...first.slice(i), ...last]);
  return out;
}
