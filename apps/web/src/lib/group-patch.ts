// What a group of the list or the board means for an issue's fields: the values a new issue gets when it is created in
// the group (quick add), and the change that moves an issue from one group to another (drag and drop). Pure functions
// over the runQuery contract (packages/query), so the list, the board and their tests share them.
import type { GroupBy, IssueGroup } from "@rsva/query";
import { defaultState, type Issue, type IssuePatch, type WorkflowState } from "@rsva/schema/models";

/** A group as a drop target or a quick-add place: what it is grouped by and the object it stands for. */
export type GroupTarget = Pick<IssueGroup, "groupBy" | "ref">;

/** Grouping that a drop can change. Author is history, an issue does not change project by a drop; "none" has nothing to change. */
export function canMoveBetween(groupBy: GroupBy): boolean {
  return groupBy !== "createdBy" && groupBy !== "project";
}

/**
 * Fields of an issue created in this group: Plane's quick add in a "High" group creates a high-priority issue, in a
 * person's group an issue assigned to them. `states` are the project's states by position (for state-group grouping).
 */
export function groupDefaults(t: GroupTarget, states: readonly WorkflowState[]): IssuePatch {
  const r = t.ref;
  switch (t.groupBy) {
    case "state":
      return r && "state" in r ? { stateId: r.state.id } : {};
    case "stateGroup": {
      const s = r && "stateGroup" in r ? states.find((x) => x.group === r.stateGroup) : undefined;
      return s ? { stateId: s.id } : {};
    }
    case "priority":
      return r && "priority" in r ? { priority: r.priority } : {};
    case "assignee":
      return r && "user" in r ? { assigneeIds: [r.user.id] } : {};
    case "label":
      return r && "label" in r ? { labelIds: [r.label.id] } : {};
    case "delegate":
      return r && "user" in r ? { delegateId: r.user.id } : {};
    // A completed cycle takes no new issues (the server refuses): one created in its group gets no cycle.
    case "cycle":
      return r && "cycle" in r && !r.cycle.completedAt ? { cycleId: r.cycle.id } : {};
    case "parent":
      return r && "parent" in r ? { parentId: r.parent.id } : {};
    default:
      return {};
  }
}

/**
 * The change that moves `issue` from group `from` to group `to` of the same grouping. For many-valued fields the
 * issue leaves the source group's value and joins the target's, keeping its other values, as in Plane: a card dragged
 * from Anna to Boris stays assigned to Vera. Dropping on the "No assignee"/"No labels" group clears the field.
 * Returns null when this grouping cannot be changed by a drop.
 */
export function movePatch(issue: Issue, from: GroupTarget, to: GroupTarget, states: readonly WorkflowState[]): IssuePatch | null {
  if (!canMoveBetween(to.groupBy)) return sameRef(from, to) ? {} : null;
  if (sameRef(from, to)) return {};
  const f = from.ref;
  const r = to.ref;
  switch (to.groupBy) {
    case "state":
    case "priority":
      return groupDefaults(to, states);
    case "stateGroup": {
      const current = states.find((s) => s.id === issue.stateId);
      if (r && "stateGroup" in r && current?.group === r.stateGroup) return {};
      return groupDefaults(to, states);
    }
    case "assignee": {
      if (!r) return { assigneeIds: [] };
      if (!("user" in r)) return {};
      const left = f && "user" in f ? issue.assigneeIds.filter((id) => id !== f.user.id) : issue.assigneeIds;
      return { assigneeIds: left.includes(r.user.id) ? left : [...left, r.user.id] };
    }
    case "delegate":
      return r && "user" in r ? { delegateId: r.user.id } : { delegateId: null };
    case "cycle":
      if (r && "cycle" in r && r.cycle.completedAt) return null;
      return r && "cycle" in r ? { cycleId: r.cycle.id } : { cycleId: null };
    // Deeper loops are the server's to refuse (checkParent): the pool does not hold the whole tree in a group.
    case "parent":
      if (r && "parent" in r && r.parent.id === issue.id) return null;
      return r && "parent" in r ? { parentId: r.parent.id } : { parentId: null };
    case "label": {
      if (!r) return { labelIds: [] };
      if (!("label" in r)) return {};
      const left = f && "label" in f ? issue.labelIds.filter((id) => id !== f.label.id) : issue.labelIds;
      return { labelIds: left.includes(r.label.id) ? left : [...left, r.label.id] };
    }
    default:
      return {};
  }
}

/** True when both targets stand for the same group value. */
function sameRef(a: GroupTarget, b: GroupTarget): boolean {
  return refKey(a) === refKey(b);
}

function refKey(t: GroupTarget): string {
  const r = t.ref;
  if (!r) return `${t.groupBy}:none`;
  if ("state" in r) return `state:${r.state.id}`;
  if ("stateGroup" in r) return `stateGroup:${r.stateGroup}`;
  if ("priority" in r) return `priority:${r.priority}`;
  if ("user" in r) return `user:${r.user.id}`;
  if ("project" in r) return `project:${r.project.id}`;
  if ("cycle" in r) return `cycle:${r.cycle.id}`;
  if ("parent" in r) return `parent:${r.parent.id}`;
  return `label:${r.label.id}`;
}

/** Fields of an issue created in a column and, on a sub-grouped board, a swimlane: the values of each, and a state. */
export function presetFor(targets: readonly GroupTarget[], states: readonly WorkflowState[]): IssuePatch {
  const preset: IssuePatch = Object.assign({}, ...targets.map((t) => groupDefaults(t, states)));
  const stateId = preset.stateId ?? defaultState(states)?.id;
  if (stateId) preset.stateId = stateId;
  return preset;
}
