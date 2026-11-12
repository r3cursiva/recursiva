// What the TUI shows, read off the copy: the issues of a query and the selected issue's card. The query is the language
// of the app's / field and of `rsva issues`, run here by the same package (packages/query) on the local copy; the
// rows are the agent API's shape (issueView), the card is read off the store (home-view.ts). Everything in them was
// written by someone else and goes to a terminal: it is cleaned here (`clean`), as the CLI cleans the server's answer,
// before any colour goes around it.
import { byState, MY_WORK, type IssueRow } from "@rsva/terminal/issues";
import { clean } from "@rsva/terminal/text";
import { DEFAULT_DISPLAY, issueView, parseQuery, runQueryRows, type OrderBy, type QueryContext } from "@rsva/query";
import { isLiveIssue, type Issue } from "@rsva/schema/models";
import type { SyncStore } from "@rsva/sync";

export type Source = Pick<SyncStore, "me" | "issues" | "states" | "labels" | "users" | "cycles" | "projects" | "issueKey" | "issueByKey" | "isBlocked" | "isBlocking" | "hasLink">;

/**
 * The list on the first start: every open issue of the workspace, as linear-dispatch opens on "all open tickets": the
 * TUI hands out work across the workspace, not only the owner's (owner's decision 2026-11-05). Later starts open on the
 * last query.
 */
export const START_QUERY = "-group:completed,cancelled";

/** What the head calls a query: the two the TUI has names for, else "Query". */
export const queryName = (q: string) => (q === START_QUERY ? "Open issues" : q === MY_WORK ? "My issues" : "Query");

/**
 * Groups in the TUI's order: what moves first, the started states latest first (Approved, In Review, In Progress), then
 * Todo, then the backlog, then the closed. The web keeps the app's order, backlog first; here hundreds of backlog
 * issues would push down what waits on the owner or an agent (owner's decision 2026-11-05).
 */
const GROUP_RANK: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, completed: 3, cancelled: 4 };

/** An issue as the CLI's renderers take it, with the issue it came from. */
export interface Item {
  row: IssueRow;
  issue: Issue;
}

const parentKey = (s: Source) => (id: string) => {
  const p = s.issues.get(id);
  return p ? s.issueKey(p) : null;
};

// The store's maps are getters: named one by one, as a spread would drop them.
const view = (s: Source, i: Issue) => issueView({ states: s.states, labels: s.labels, cycles: s.cycles, users: s.users, issueKey: (x) => s.issueKey(x) }, i, parentKey(s));

/** The order within a state of a query without `order:`: the newest change first, as the agent API orders them. */
export const START_ORDER: OrderBy = "updatedAt";

/** Deleted issues are out of the index; archived ones stay, as the web's. */
const notDeleted = (i: Issue | undefined) => (i && !i.deletedAt ? i : undefined);

/** The query's names and the copy's issues: `parent:PLNR-12`, `is:blocked` and a new issue's parent find them, as in the web. */
export const contextOf = (s: Source): QueryContext => ({
  states: s.states,
  labels: s.labels,
  users: s.users,
  cycles: s.cycles,
  projects: s.projects,
  me: s.me?.id ?? null,
  issueKey: (i) => s.issueKey(i),
  issues: {
    get: (id) => notDeleted(s.issues.get(id)),
    byKey: (key) => notDeleted(s.issueByKey(key)),
    isBlocked: (i) => s.isBlocked(i),
    isBlocking: (i) => s.isBlocking(i),
    hasLink: (i) => s.hasLink(i),
  },
});

/**
 * The issues of a query, in the order the screen shows them: by state as in the app, then within a state in the order
 * the query names with `order:` (PLNR-401: the web's orders, the same sortIssues), else START_ORDER. The cursor moves in this order. A query the parser refuses
 * gives its errors.
 */
export function listOf(s: Source, query: string): { items: Item[]; error: string | null } {
  const ctx = contextOf(s);
  const { filter, errors, order = START_ORDER } = parseQuery(query, ctx);
  if (errors.length) return { items: [], error: errors.map((e) => e.message).join("; ") };
  const live = [...s.issues.values()].filter(isLiveIssue);
  const items: Item[] = runQueryRows(live, filter, { ...DEFAULT_DISPLAY, orderBy: order }, ctx).map((issue) => ({ row: clean({ ...view(s, issue), state: s.states.get(issue.stateId)?.name ?? "?" }), issue }));
  const byRow = new Map(items.map((i) => [i.row, i]));
  // A state's place among its own project's states of its group: positions of different projects do not compare.
  const place = (stateId: string) => {
    const st = s.states.get(stateId);
    if (!st) return 0;
    const same = [...s.states.values()].filter((x) => x.projectId === st.projectId && x.group === st.group).sort((a, b) => a.position - b.position);
    return same.findIndex((x) => x.id === st.id);
  };
  const rank = (group: IssueRow[]) => {
    const id = byRow.get(group[0]!)!.issue.stateId;
    return [GROUP_RANK[s.states.get(id)?.group ?? ""] ?? 5, -place(id)] as const;
  };
  const groups = byState(items.map((i) => i.row)).sort((a, b) => {
    const [ga, pa] = rank(a);
    const [gb, pb] = rank(b);
    return ga - gb || pa - pb;
  });
  return { items: groups.flat().map((row) => byRow.get(row)!), error: null };
}

/** Where an issue stood in the list before a change of its state took it to another group: the issues around it then. */
export interface Left {
  id: string;
  prev: string | undefined;
  next: string | undefined;
}

/**
 * The cursor on a list that changed under it. It stays on its issue while the list moves around it, except when the
 * issue's own state changed: the issue goes to its new group and the cursor keeps the place, on the issue that came
 * after it (before it, at the end). A dispatch moves its issue to In Progress at the top; → goes on down the list from
 * where it was, not from there (owner's decision 2026-11-06). `was`: the state of each of `prev`'s issues when `prev` was
 * made, as rows change in place. `at` is -1 when the issue and the ones around it are gone.
 */
export function cursorOn(prev: readonly Item[], was: readonly string[], selected: number, next: readonly Item[], stateOf: (id: string) => string | undefined): { at: number; left: Left | null } {
  const id = prev[selected]?.issue.id;
  const indexOf = (x: string | undefined) => (x ? next.findIndex((i) => i.issue.id === x) : -1);
  const at = indexOf(id);
  const state = id ? stateOf(id) : undefined;
  if (!id || state === undefined || was[selected] === undefined || state === was[selected]) return { at, left: null };
  const left = { id, prev: prev[selected - 1]?.issue.id, next: prev[selected + 1]?.issue.id };
  return { at: [indexOf(left.next), indexOf(left.prev)].find((i) => i >= 0) ?? -1, left };
}
