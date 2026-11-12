// My work (PLNR-41): the groups and their order are @rsva/protocol's (my-work.ts), shared with the bot's /my; here
// is what only the screen needs: the scope, the row's actions and the words.
import type { WorkItem } from "@rsva/protocol/my-work";
import type { Issue, IssuePatch, StateGroup, WorkflowState } from "@rsva/schema/models";
import { compactAge, formatDate } from "@rsva/display/time";
import { daysBetween } from "@rsva/schema/days";

export { ASK_LABELS, asksViewer, canTriage, collect, GROUPS, isIdle, forTriage, proposedLabels, reviewAsk, sortGroup, toTriage, waitsOnReview, type GroupId, type WorkItem, type WorkSource } from "@rsva/protocol/my-work";

// ── Scope: every workspace, one, or one project ────────────────────────────────────────────────────────────

/** "all", "ws:<slug>" or "p:<slug>/<project id>". */
export type Scope = string;

export function inScope(scope: Scope, x: Pick<WorkItem, "ws" | "issue">): boolean {
  if (scope === "all") return true;
  if (scope.startsWith("ws:")) return x.ws === scope.slice(3);
  return scope === `p:${x.ws}/${x.issue.projectId}`;
}

// ── Actions ───────────────────────────────────────────────────────────────────────────────────────────────

type ActionId = "review" | "accept" | "decline" | "reply" | "start" | "todo" | "later" | "drop";

export interface WorkAction {
  id: ActionId;
  label: string;
  /** The key that runs it on the selected row. */
  key: string;
  primary: boolean;
  /** The edit, for every action but review, reply and later: they open the issue or only read the assignment. */
  patch?: IssuePatch;
}

const firstOf = (states: readonly WorkflowState[], group: StateGroup) => states.find((s) => s.group === group);

/**
 * What the row offers: a review its opening (the decision is made on the issue, where the work shows: RSVA-597), a
 * proposal accept (into Todo, to the viewer when nobody has it) or decline, a new assignment in Backlog its start, Todo,
 * Later (read, nothing else changes) or unassign, a mention or a reply its answer, an issue
 * not started (up next or later) its start. An action whose state the project lacks is left out.
 */
export function actionsFor(x: WorkItem, states: readonly WorkflowState[], me: string, proposedIds: ReadonlySet<string>): WorkAction[] {
  const started = states.filter((s) => s.group === "started");
  const out: WorkAction[] = [];
  const add = (id: ActionId, label: string, key: string, primary: boolean, state?: WorkflowState, patch: IssuePatch = {}) => {
    if (id === "reply" || id === "review" || id === "later") out.push({ id, label, key, primary });
    else if (state) out.push({ id, label, key, primary, patch: { stateId: state.id, ...patch } });
  };
  if (x.ask === "review") {
    add("review", "Review", "↵", true);
  } else if (x.ask === "proposed") {
    const accept: IssuePatch = { labelIds: x.issue.labelIds.filter((id) => !proposedIds.has(id)) };
    if (!x.issue.assigneeIds.length) accept.assigneeIds = [me];
    add("accept", "Accept", "A", true, firstOf(states, "unstarted"), accept);
    add("decline", "Decline", "D", false, firstOf(states, "cancelled"));
  } else if (x.ask === "decide") {
    // A new assignment in Backlog (the owner, 2026-11-11): take it now, plan it, put it aside, or give it back.
    add("start", "Start", "S", false, started[0]);
    add("todo", "Todo", "T", true, firstOf(states, "unstarted"));
    add("later", "Later", "L", false);
    out.push({ id: "drop", label: "Unassign", key: "U", primary: false, patch: { assigneeIds: x.issue.assigneeIds.filter((id) => id !== me) } });
  } else if (x.ask === "mention" || x.ask === "reply") {
    add("reply", "Reply", "R", true);
  } else if (x.group === "next" || x.group === "later") {
    add("start", "Start", "S", false, started[0]);
  }
  return out;
}

/** The fields a patch changes, as they are now: applying it undoes the patch. */
export function before(issue: Issue, patch: IssuePatch): IssuePatch {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, issue[k as keyof Issue]])) as IssuePatch;
}

/** What a row's action needs of an engine: the issue's key, a state's name and the edit. */
interface Edits {
  issueKey(issue: Issue): string;
  states: { get(id: string): { name: string } | undefined };
  updateIssue(id: string, patch: IssuePatch): void;
}

/**
 * Makes a row's action (all but review and reply) and says what it did: "RSVA-1 accepted, now in Todo". The undo puts
 * the changed fields back.
 */
export function applyAction(e: Edits, x: WorkItem, a: WorkAction): { text: string; undo: () => void } {
  const patch = a.patch!;
  const key = e.issueKey(x.issue);
  const prev = before(x.issue, patch);
  const state = patch.stateId ? e.states.get(patch.stateId)?.name : undefined;
  e.updateIssue(x.issue.id, patch);
  const text = { accept: `${key} accepted, now in ${state}`, decline: `${key} declined`, start: `${key} → ${state}`, todo: `${key} → ${state}`, drop: `${key} unassigned`, review: "", reply: "", later: "" }[a.id];
  return { text, undo: () => e.updateIssue(x.issue.id, prev) };
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────

/** "20m", "5h", "3d"; never "now": the rows say "waiting 1m", "replied 1m ago". */
export const age = (ms: number): string => compactAge(Math.max(ms, 60_000));

const weekday = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** "Due today", "Due Fri", "Due Nov 12", "2d overdue"; `today` is the local day as YYYY-MM-DD. */
export function dueText(due: string | null, today: string): { text: string; over: boolean; soon: boolean } | null {
  if (!due) return null;
  const d = daysBetween(today, due);
  if (d < 0) return { text: `${-d}d overdue`, over: true, soon: false };
  if (d === 0) return { text: "Due today", over: false, soon: true };
  if (d === 1) return { text: "Due tomorrow", over: false, soon: true };
  if (d < 7) return { text: `Due ${weekday.format(dayMs(due))}`, over: false, soon: d <= 2 };
  return { text: `Due ${formatDate(due)}`, over: false, soon: false };
}

/** A past local day: "Mon" within the week, "Oct 21" before. */
export const shortDay = (day: string, today: string): string => (daysBetween(day, today) < 7 ? weekday.format(dayMs(day)) : formatDate(day));
