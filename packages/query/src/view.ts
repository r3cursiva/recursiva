// An issue as agents and the terminal read it: names and emails instead of ids. The agent API sends it (GET …/issues),
// the TUI builds the same thing from its copy (apps/tui) for its list rows, so the two name things alike.
import type { Cycle, Issue, Label, User, WorkflowState } from "@rsva/schema/models";
import { PRIORITY_KEYWORDS } from "./parse.ts";

/** The lookups an issue's names come from: the server's per-request maps or a client's copy. */
export interface ViewNames {
  states: ReadonlyMap<string, WorkflowState>;
  labels: ReadonlyMap<string, Label>;
  cycles: ReadonlyMap<string, Cycle>;
  users: ReadonlyMap<string, Pick<User, "email">>;
  issueKey(i: Issue): string;
}

export function issueView(n: ViewNames, i: Issue, parentKey: (id: string) => string | null) {
  const email = (id: string | null) => (id ? (n.users.get(id)?.email ?? null) : null);
  const state = n.states.get(i.stateId);
  return {
    key: n.issueKey(i),
    title: i.title,
    state: state?.name ?? null,
    stateGroup: state?.group ?? null,
    priority: PRIORITY_KEYWORDS[i.priority] ?? "none",
    labels: i.labelIds.map((id) => n.labels.get(id)?.name).filter((x): x is string => !!x),
    assignees: i.assigneeIds.map(email).filter((x): x is string => !!x),
    delegate: email(i.delegateId),
    parent: i.parentId ? parentKey(i.parentId) : null,
    cycle: i.cycleId ? (n.cycles.get(i.cycleId)?.name ?? null) : null,
    startDate: i.startDate,
    dueDate: i.dueDate,
    createdBy: email(i.createdById),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    completedAt: i.completedAt,
    archivedAt: i.archivedAt,
    deletedAt: i.deletedAt,
  };
}
