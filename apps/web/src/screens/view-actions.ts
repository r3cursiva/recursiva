// What the View panel, a tab's menu and the keys do to saved views (PLNR-74): create, save or revert a list's edits,
// move a tab, delete. In the lazy edit chunk: none of it is needed before someone uses them.
import { pinRef, uuidv7, type SavedView } from "@rsva/protocol";
import { cleanName, type Project } from "@rsva/schema/models";
import { mayEdit, projectTabs, viewProjects } from "../lib/views.ts";
import { paths, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { setActiveTab, viewState, type ProjectView } from "../view-state.ts";
import { notice } from "./notice.ts";
import { viewPanel } from "./view-panel-state.ts";

/** Puts a list's edits (and, from the panel, the view's settings) into its view; All issues becomes a new view. */
export function saveList(list: ProjectView, project: Project | null): void {
  const saved = list.saved;
  if (!saved) return viewPanel.create(list, project);
  if (!mayEdit(saved)) return viewPanel.create(list, project, saved);
  const meta = viewPanel.mode === "edit" && viewPanel.list === list ? viewPanel.meta : null;
  const name = meta ? cleanName(meta.name) || saved.name : saved.name;
  const before = { query: saved.query, display: saved.display, name: saved.name, icon: saved.icon, shared: saved.shared, tab: saved.tab };
  store.views.save(saved.id, { ...list.fields, ...(meta ? { ...meta, name } : {}) });
  if (viewPanel.list === list) viewPanel.close();
  notice.show(`${name} saved${saved.shared || meta?.shared ? ": everyone sees the change" : ""}`, () => store.views.save(saved.id, before));
  // Saved out of this project (its Project filter no longer names it): show the view on its own page.
  const now = store.views.get(saved.id);
  if (project && now && !(now.tab && viewProjects(now).includes(project.id))) router.push(paths.view(currentWs(), saved.id));
}

/** Back to the saved view (or All issues to every issue), with Undo bringing the edits back. */
export function revertList(list: ProjectView): void {
  const { filter, display } = list;
  list.revert();
  if (viewPanel.mode === "edit" && viewPanel.list === list && list.saved) viewPanel.edit(list, viewPanel.project);
  notice.show(list.saved ? "Edits reverted" : "Filters cleared", () => {
    list.setFilter(filter);
    list.setDisplay(display);
  });
}

/** Display back to the saved view's or the default (Reset in the Display popover), with Undo as Revert has. */
export function resetDisplay(list: ProjectView): void {
  const { display } = list;
  list.resetDisplay();
  notice.show("Display reset", () => list.setDisplay(display));
}

/** Creates the panel's new view and shows it: as a tab here if it is one, else on its own page. */
export function createFromPanel(): boolean {
  const draft = viewPanel.list;
  const name = cleanName(viewPanel.meta.name);
  if (!draft || !name) return false;
  const id = uuidv7();
  const position = Math.max(0, ...store.views.list.map((v) => v.position)) + 1;
  store.views.save(id, { ...draft.fields, ...viewPanel.meta, name, position, layout: "list" });
  const view = store.views.get(id)!;
  const project = viewPanel.project;
  const from = viewPanel.from;
  const pin = viewPanel.pin;
  viewPanel.close();
  if (pin) store.views.pin(pinRef("view", id), true);
  // The new view's state starts as the draft was, so nothing on screen jumps.
  const state = viewState(id);
  state.load(view);
  state.setLayout(draft.layout);
  // All issues gave the view its filters and display: both go back to every issue as it shows by default.
  if (from && !from.saved) {
    from.revert();
    from.resetDisplay();
  }
  const here = project && view.tab && viewProjects(view).includes(project.id);
  if (here) setActiveTab(project.id, id);
  else router.push(paths.view(currentWs(), id));
  notice.show(here ? `${name} added as a tab` : pin ? `${name} is in your sidebar` : `${name} created: it is on the Views page`, () => deleteView(view, true));
  return true;
}

/** One step left (-1) or right (+1) among a project's tabs: between the neighbours, so only this view changes. */
export function moveTab(view: SavedView, projectId: string, by: -1 | 1): void {
  if (!mayEdit(view)) return;
  const list = projectTabs(projectId);
  const at = list.findIndex((v) => v.id === view.id);
  const next = list[at + by];
  if (at < 0 || !next) return;
  const beyond = list[at + 2 * by];
  const position = beyond ? (next.position + beyond.position) / 2 : next.position + by;
  store.views.save(view.id, { position: position === next.position ? next.position + by * 1e-6 : position });
}

/** Deletes it with Undo (none for the undo of a create); its tab falls back to All issues. */
export function deleteView(view: SavedView, quiet = false): void {
  // First: the panel leaves showing the view, which is still there.
  if (viewPanel.list?.viewId === view.id) viewPanel.close();
  store.views.remove(view.id);
  if (quiet) return;
  const { id: _, ownerId: __, createdAt: ___, updatedAt: ____, ...fields } = view;
  notice.show(`${view.name} deleted`, () => store.views.save(view.id, fields));
}
