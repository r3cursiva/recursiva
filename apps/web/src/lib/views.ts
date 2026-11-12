// Saved views (PLNR-74) as the screens use them: which views are a project's tabs, how many issues each shows, where
// each opens, who may change it. A view is a query over the whole workspace; with `tab` it is a tab in each project
// its `project:` filter names. The views themselves are in the sync store.
import { mayEditView, type SavedView } from "@rsva/protocol";
import { parseQuery, runQueryRows } from "@rsva/query";
import { computed, type IComputedValue } from "mobx";
import { paths } from "../router.ts";
import { currentWs, perEngine, store } from "../store.ts";
import { activeTab, displayOf, listIssues, projectView, queryContext, viewState, WS_SCOPE, type ProjectView } from "../view-state.ts";

const parsed = perEngine(() => new Map<string, IComputedValue<ReturnType<typeof parseQuery>["filter"]>>());

/** A view's saved query as a filter over the workspace, cached per view. */
function savedFilter(id: string) {
  let c = parsed().get(id);
  if (!c) {
    c = computed(() => parseQuery(store.views.get(id)?.query ?? "", queryContext(WS_SCOPE)).filter, { keepAlive: true });
    parsed().set(id, c);
  }
  return c.get();
}

/** The projects a view's `project:` filter names ("is" only): the projects it can be a tab in. */
export const viewProjects = (view: SavedView): string[] => savedFilter(view.id).project ?? [];

/** The views that are tabs in a project, in tab order. */
export function projectTabs(projectId: string): SavedView[] {
  return store.views.list
    .filter((v) => v.tab && viewProjects(v).includes(projectId))
    .sort((a, b) => a.position - b.position || (a.createdAt < b.createdAt ? -1 : 1));
}

/** The state a project's list shows now: its active tab's view while that is still a tab here, or All issues. */
export function currentList(projectId: string): ProjectView {
  const id = activeTab(projectId);
  const view = id ? store.views.get(id) : undefined;
  return view && view.tab && viewProjects(view).includes(projectId) ? viewState(view.id) : projectView(projectId);
}

const counts = perEngine(() => new Map<string, IComputedValue<number>>());

/** How many issues a view shows as saved: in one project (its tab there), or across the workspace (null). */
export function viewCount(id: string, projectId: string | null = null): number {
  const key = `${id}@${projectId ?? "*"}`;
  let c = counts().get(key);
  if (!c) {
    c = computed(
      () => {
        const view = store.views.get(id);
        if (!view) return 0;
        return runQueryRows(listIssues(projectId), savedFilter(id), displayOf(view.display), queryContext(projectId ?? WS_SCOPE)).length;
      },
      { keepAlive: true },
    );
    counts().set(key, c);
  }
  return c.get();
}

/** A view's own page, across all its projects: where the sidebar and the views page open it. */
export const viewPath = (ws: string, view: Pick<SavedView, "id">): string => paths.view(ws, view.id);

/** A view's tab in a project. */
const tabPath = (ws: string, projectKey: string, view: Pick<SavedView, "id">): string => `${paths.issues(ws, projectKey)}?view=${view.id}`;

/** The address to share: its tab in `project`, else its own page. */
export const viewLink = (view: Pick<SavedView, "id">, project: { key: string } | null): string =>
  new URL(project ? tabPath(currentWs(), project.key, view) : viewPath(currentWs(), view), location.origin).href;

/** The viewer may change, move or delete it: its owner, or an admin for a shared one. */
export const mayEdit = (view: SavedView): boolean => !!store.me && mayEditView(view, store.me.id, store.role);
