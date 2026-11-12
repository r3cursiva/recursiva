// Whether the View panel is open, and on what (PLNR-74): the one place a view is made and changed. Editing works on the
// list itself (its filters and display change the list behind the panel at once); a new view works on a copy of the
// list it starts from, shown in that list's place until it is created or cancelled. The view's own settings (name,
// icon, tab, who sees it) wait here for Save. The panel itself is in the lazy edit chunk (overlays.tsx).
//
// Closing has to play the panel's way out, but nothing else may wait for it. Compared: a `closing` flag beside the
// fields (each `list` and `mode` check would have to learn it); a view transition (holds the press that closed the panel
// from the list under it, and a row's transition cuts it off); a DOM copy left behind (scroll and screen readers by
// hand). Chosen: close() is as it was, and `leaving` keeps what the panel drew, for the panel alone.
import type { SavedView, ViewIcon } from "@rsva/protocol";
import type { Project } from "@rsva/schema/models";
import { makeAutoObservable, observableRef } from "mobx";
import { currentList } from "../lib/views.ts";
import { draftState, type ProjectView } from "../view-state.ts";

interface ViewMeta {
  name: string;
  icon: ViewIcon;
  shared: boolean;
  tab: boolean;
}

/** The panel as close() left it. */
type Leaving = Pick<ViewPanel, "mode" | "list" | "from" | "project" | "meta" | "pin" | "saved">;

const metaOf = (v: SavedView): ViewMeta => ({ name: v.name, icon: v.icon, shared: v.shared, tab: v.tab });

class ViewPanel {
  mode: "edit" | "new" | null = null;
  /** What the panel changes: the list being edited, or the new view's draft. */
  list: ProjectView | null = null;
  /** A new view: the list it starts from, which its draft stands in for. */
  from: ProjectView | null = null;
  /** The project the list shows in; null on a view's own page. */
  project: Project | null = null;
  meta: ViewMeta = { name: "", icon: "stack", shared: false, tab: true };
  /** A new view goes to the viewer's sidebar (an existing one's pin changes at once: it is the viewer's own). */
  pin = false;
  /** Open with the cursor in the query (`/`). */
  focusQuery = false;
  /** On screen for the way out only (view-panel.tsx): for everything else the panel is closed already. */
  leaving: Leaving | null = null;
  /** The panel's key: one opened during another's way out is a new panel, with its own way in and focus. */
  run = 0;

  constructor() {
    makeAutoObservable(this, { list: observableRef, from: observableRef, project: observableRef, leaving: observableRef });
  }

  get open(): boolean {
    return this.mode !== null;
  }

  get saved(): SavedView | null {
    return this.list?.saved ?? null;
  }

  /** The panel on a list: its saved view's settings, or All issues' (its edits are temporary). */
  edit(list: ProjectView, project: Project | null, focusQuery = false): void {
    this.cutLeaving();
    this.mode = "edit";
    this.list = list;
    this.from = null;
    this.project = project;
    this.focusQuery = focusQuery;
    if (list.saved) this.meta = metaOf(list.saved);
  }

  /** A new view from a list as it is now; in a project, narrowed to it unless the list names projects already. */
  create(from: ProjectView, project: Project | null, copy?: SavedView): void {
    const names = from.filter.project?.length || copy;
    this.cutLeaving();
    this.mode = "new";
    this.from = from;
    this.list = draftState(from, project && !names ? `project:${project.key}` : "");
    this.project = project;
    this.focusQuery = false;
    this.meta = copy ? { ...metaOf(copy), name: `${copy.name} copy`, shared: false } : { name: "", icon: "stack", shared: false, tab: !!project };
    this.pin = !project;
  }

  setPin(pin: boolean): void {
    this.pin = pin;
  }

  setMeta(patch: Partial<ViewMeta>): void {
    this.meta = { ...this.meta, ...patch };
  }

  close(): void {
    if (!this.open) return;
    const { mode, list, from, project, meta, pin, saved } = this;
    this.leaving = { mode, list, from, project, meta, pin, saved };
    this.mode = null;
    this.list = null;
    this.from = null;
  }

  /** The way out has played. */
  left(): void {
    this.leaving = null;
  }

  private cutLeaving(): void {
    if (!this.leaving) return;
    this.leaving = null;
    this.run++;
  }

  /** The list a screen shows in place of `list`: the draft while a new view is made from it. */
  shown(list: ProjectView): ProjectView {
    return this.mode === "new" && this.from === list ? this.list! : list;
  }
}

export const viewPanel = new ViewPanel();

/** What a project's list shows now: its current tab, or the new view's draft made from it while the panel is open. */
export const shownList = (projectId: string): ProjectView => viewPanel.shown(currentList(projectId));
