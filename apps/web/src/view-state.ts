// Where the list states live (lib/list-state.ts has their rules): one per list, created on first use, kept per viewer
// in local storage, read against the store. A tab narrows a saved view to its project (`listIssues` below); the state
// does not change with the place.
//
// Persistence: each state is saved to localStorage under the viewer and its key, so a reload or another tab opens it as
// it was left, unsaved edits included. The filter is also mirrored into the URL as ?q= (query-url.ts).
import type { QueryContext } from "@rsva/query";
import type { Cycle, Issue } from "@rsva/schema/models";
import type { SyncStore } from "@rsva/sync";
import { computed, observable, when, type IComputedValue } from "mobx";
import { account } from "./account.ts";
import { ProjectView, WS_SCOPE, type ListBase, type ListSource } from "./lib/list-state.ts";
import { readLocal, writeLocal } from "./lib/local-storage.ts";
import { perEngine, store } from "./store.ts";
import { persistForViewer } from "./viewer-local.ts";

export { boardable, displayOf, draftState, WS_SCOPE, type Layout, type ProjectView } from "./lib/list-state.ts";

/** The saved views and query lookups of the workspace on screen, read when a state needs them. */
const source: ListSource = { view: (id) => store.views.get(id) ?? null, context: queryContext };

const states = new Map<string, ProjectView>();

function listState(key: string, scope: string, viewId: string | null, init?: (v: ProjectView) => void, base: ListBase | null = null): ProjectView {
  let v = states.get(key);
  if (!v) {
    const view = (v = new ProjectView(key, scope, viewId, source, base));
    states.set(key, view);
    // The viewer is known once the workspace data is (the header may ask for the view earlier, while loading).
    persistForViewer(
      (me) => `rsva:view:${me}:${key}`,
      (saved) => (saved ? view.restore(saved) : init?.(view)),
      () => ({ layout: view.layout, display: view.display, filter: view.filter }),
    );
  }
  return v;
}

/** A project's All issues, created on first use: restored from local storage, then saved on every change. */
export function projectView(projectId: string): ProjectView {
  return listState(projectId, projectId, null);
}

/**
 * A cycle's list (PLNR-63): its issues, by state; a new issue made in it joins the cycle. Its own filter and display,
 * kept like a project's. A completed cycle also lists the issues it moved on, whose chips then say where they went.
 */
export function cycleList(cycle: Cycle): ProjectView {
  const issues = () => {
    const c = store.cycles.get(cycle.id);
    const moved = (c?.summary?.open ?? []).map((id) => store.issues.get(id)).filter((i): i is Issue => !!i && !i.deletedAt && i.cycleId !== cycle.id);
    return moved.length ? [...store.issuesInCycle(cycle.id), ...moved] : store.issuesInCycle(cycle.id);
  };
  const closed = () => !!store.cycles.get(cycle.id)?.completedAt;
  return listState(`c:${cycle.id}`, cycle.projectId, null, undefined, { issues, targets: [{ groupBy: "cycle", ref: { cycle } }], closed });
}

/** A list of no project and no view, empty: what the Views page's New view starts from. */
export const blankList = (): ProjectView => new ProjectView("blank", WS_SCOPE, null, source);

/** A saved view's state: as the view was saved until the viewer edits it, then as they left it. */
export function viewState(viewId: string): ProjectView {
  return listState(`v:${viewId}`, WS_SCOPE, viewId, (v) => {
    when(
      () => store.views.status === "ready" && store.status === "ready",
      () => v.load(store.views.get(viewId) ?? null),
    );
  });
}

// ── The tab a project shows ─────────────────────────────────────────────────────────────────────────────────────

const tabs = observable.map<string, string | null>();

/** The view whose tab a project shows (null: All issues), as the viewer left it. */
export function activeTab(projectId: string): string | null {
  if (!tabs.has(projectId) && store.me) {
    const saved = readLocal(`rsva:tab:${store.me.id}:${projectId}`);
    return typeof saved === "string" ? saved : null;
  }
  return tabs.get(projectId) ?? null;
}

export function setActiveTab(projectId: string, viewId: string | null): void {
  tabs.set(projectId, viewId);
  if (store.me) writeLocal(`rsva:tab:${store.me.id}:${projectId}`, viewId);
}

// ── Query context and issues ────────────────────────────────────────────────────────────────────────────────────

const contexts = perEngine(() => new Map<string, IComputedValue<QueryContext>>());

const live = (i: Issue | undefined) => (i?.deletedAt ? undefined : i);

/**
 * Lookups runQuery and the query language need for a scope: a project's states and labels, or across the workspace
 * every project's (states of one name are one state there); the projects, everyone, the viewer.
 */
export function queryContext(scope: string): QueryContext {
  let c = contexts().get(scope);
  if (!c) {
    c = computed(() => contextOf(store, scope), { keepAlive: true });
    contexts().set(scope, c);
  }
  return c.get();
}

/** The same lookups over any engine: the one on screen, or another workspace's that My work holds open. */
function contextOf(e: SyncStore, scope: string): QueryContext {
  const ws = scope === WS_SCOPE;
  return {
    states: ws ? e.states : new Map(e.statesOf(scope).map((s) => [s.id, s])),
    labels: ws ? e.labels : new Map(e.labelsOf(scope).map((l) => [l.id, l])),
    cycles: ws ? e.cycles : new Map(e.cyclesOf(scope).map((c) => [c.id, c])),
    users: e.users,
    projects: new Map(e.projectList().map((p) => [p.id, p])),
    me: e.me?.id ?? null,
    issueKey: (i: Issue) => e.issueKey(i),
    weekStart: account.settings.weekStart,
    issues: {
      get: (id: string) => live(e.issues.get(id)),
      byKey: (key: string) => live(e.issueByKey(key)),
      isBlocked: (i: Issue) => e.isBlocked(i),
      isBlocking: (i: Issue) => e.isBlocking(i),
      hasLink: (i: Issue) => e.hasLink(i),
    },
  };
}

const everyIssue = perEngine(() => computed(() => store.projectList().flatMap((p) => store.issuesOf(p.id)), { keepAlive: true }));

/** The live issues a list runs over: one project's (a tab, All issues), or every active project's (a view's page). */
export function listIssues(projectId: string | null): Issue[] {
  return projectId ? store.issuesOf(projectId) : everyIssue().get();
}
