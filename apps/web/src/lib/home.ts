// A project's home (RSVA-508, ADR 0053): which home the viewer sees, what its widgets show, and Customize's draft. A
// home is a saved view with the layout "home" (@rsva/protocol/home), a project's own or the default of every project
// of the workspace (RSVA-577): the project's if it has one, else the default, else the built-in template. Customize edits a copy;
// Done writes it, Cancel drops it.
import { mayManage } from "@rsva/policy";
import { mayEditView, uuidv7, type SavedView } from "@rsva/protocol";
import {
  DEFAULT_TEMPLATE,
  HOME_WIDGETS_MAX,
  homeAt,
  homeWidgets,
  isDefaultHome,
  isQueryKind,
  newWidget,
  pickHome,
  presetWidget,
  templateWidgets,
  type HomeKind,
  type HomeLists,
  type HomePreset,
  type HomeScope,
  type HomeTemplate,
  type HomeWidget,
} from "@rsva/protocol/home";
import { DEFAULT_DISPLAY, parseQuery, runQueryRows, type QueryError } from "@rsva/query";
import type { Issue, Project } from "@rsva/schema/models";
import { makeAutoObservable } from "mobx";
import { store } from "../store.ts";
import { listIssues, projectView, queryContext, setActiveTab } from "../view-state.ts";
import { paths, router } from "../router.ts";
import { movedBefore, shortId, steppedBy, withChange } from "./draft-list.ts";
import { viewProjects } from "./views.ts";

// ── Which home ─────────────────────────────────────────────────────────────────────────────────────────────

/** The saved homes a project may show: its own and the workspace's defaults (RSVA-577). */
const homeLists = (projectId: string): HomeLists<SavedView> => ({
  project: store.views.homes.filter((v) => viewProjects(v).includes(projectId)),
  all: store.views.homes.filter(isDefaultHome),
});

/** The saved home at one place: the project's own or the workspace's default. */
export const savedHome = (projectId: string, scope: HomeScope): SavedView | undefined => homeAt(homeLists(projectId), scope);

/** What a project shows: the widgets, and the saved home they are from. No `at`: the built-in template. */
export function shownHome(projectId: string): { widgets: HomeWidget[]; at: { view: SavedView; scope: HomeScope } | undefined } {
  const at = pickHome(homeLists(projectId));
  return { widgets: at ? homeWidgets(at.view.display) : templateWidgets(DEFAULT_TEMPLATE), at };
}

/**
 * The viewer may write the home at this place. A project's: its owner or an admin, and while there is none any member
 * may make it. The default is every project's first page: an admin's.
 */
export function mayEditHome(projectId: string, scope: HomeScope): boolean {
  const me = store.me?.id;
  if (!me || !store.role || store.role === "guest") return false;
  if (scope === "all") return mayManage(store.role);
  const home = savedHome(projectId, "project");
  return !home || mayEditView(home, me, store.role);
}

/** The workspace's projects that are not archived: the ones a default home is for. */
const liveProjects = (): Project[] => [...store.projects.values()].filter((p) => !p.archivedAt);

// ── What a query widget shows ──────────────────────────────────────────────────────────────────────────────

export interface QueryResult {
  rows: Issue[];
  errors: QueryError[];
}

/** The project's issues a widget's query finds, in its `order:`, else the latest change first. */
export function runWidget(projectId: string, query: string): QueryResult {
  const ctx = queryContext(projectId);
  const parsed = parseQuery(query, ctx);
  const display = { ...DEFAULT_DISPLAY, orderBy: parsed.order ?? "updatedAt" };
  return { rows: runQueryRows(listIssues(projectId), parsed.filter, display, ctx), errors: parsed.errors };
}

/** What is wrong with a query in the project: the widget settings' query line shows it as you type. */
export const queryErrors = (projectId: string, query: string): QueryError[] => parseQuery(query, queryContext(projectId)).errors;

/**
 * The projects a query does not read in, of all that are live: a label or a state by name is each project's own,
 * so a default home's widget may work here and say "no such label" there.
 */
export function queryReach(query: string): { failing: Project[]; of: number } {
  const live = liveProjects();
  return { failing: live.filter((p) => queryErrors(p.id, query).length > 0), of: live.length };
}

/** Shows a widget's issues as the project's list: All issues with the query, not saved, so it can be saved as a view. */
export function openAsList(ws: string, project: Project, query: string): void {
  setActiveTab(project.id, null);
  projectView(project.id).setQuery(query);
  router.push(paths.issues(ws, project.key));
}

// ── Customize ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Customize's draft: one project's home being edited; nothing reaches the server before a save. Save writes the
 * project's home; the default of every project changes only by Save as default (RSVA-577: a switch that wrote where the
 * widgets came from let an edit in one project change them all).
 */
class HomeEditor {
  projectId: string | null = null;
  widgets: HomeWidget[] = [];
  /** Where the widgets came from when Customize opened: the project's home, the default, or the built-in one (null). */
  from: HomeScope | null = null;
  /** The widget whose settings are open. */
  selected: string | null = null;
  /** The widget just added: it plays its entrance once. */
  fresh: string | null = null;
  template: HomeTemplate | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  editing(projectId: string): boolean {
    return this.projectId === projectId;
  }

  /** Opens Customize on what the project shows, the settings of `select` open. */
  start(projectId: string, select: string | null = null): void {
    const shown = shownHome(projectId);
    this.projectId = projectId;
    this.widgets = shown.widgets;
    this.from = shown.at?.scope ?? null;
    this.selected = select;
    this.fresh = null;
    this.template = shown.at ? null : DEFAULT_TEMPLATE;
  }

  cancel(): void {
    this.projectId = null;
    this.selected = null;
  }

  /**
   * Writes the draft: to the project's home (Save) or to the default of every project (Save as default). The latter
   * drops the project's home, so the project follows the default again.
   */
  save(project: Project, scope: HomeScope = "project"): void {
    if (this.projectId !== project.id || !mayEditHome(project.id, scope)) return;
    // A completion leaves a space after the word it wrote: the stored query goes without it.
    const display = { widgets: this.widgets.map((w) => ({ ...w, query: w.query.trim() })) };
    const existing = savedHome(project.id, scope);
    if (existing) store.views.save(existing.id, { display });
    else {
      const query = scope === "all" ? "" : `project:${project.key}`;
      store.views.save(uuidv7(), { name: "Home", icon: "stack", query, display, layout: "home", shared: true, tab: false, position: 0 });
    }
    const own = scope === "all" ? savedHome(project.id, "project") : undefined;
    if (own && mayEditHome(project.id, "project")) store.views.remove(own.id);
    this.cancel();
  }

  select(id: string | null): void {
    this.selected = id;
  }

  /** A widget of `kind`; one with a query is added to have it set, so its settings open. */
  add(kind: HomeKind): void {
    const w = newWidget(shortId(), kind, isQueryKind(kind) ? { query: kind === "chart" ? "-group:cancelled" : "-group:completed -group:cancelled" } : {});
    if (this.put(w) && isQueryKind(kind)) this.selected = w.id;
  }

  /** A ready query (RSVA-523): it comes set, so the settings stay closed. */
  addPreset(p: HomePreset): void {
    this.put(presetWidget(shortId(), p));
  }

  private put(w: HomeWidget): boolean {
    if (this.widgets.length >= HOME_WIDGETS_MAX) return false;
    this.widgets = [...this.widgets, w];
    this.fresh = w.id;
    this.template = null;
    return true;
  }

  remove(id: string): void {
    this.widgets = this.widgets.filter((w) => w.id !== id);
    if (this.selected === id) this.selected = null;
    this.template = null;
  }

  update(id: string, set: Partial<Omit<HomeWidget, "id">>): void {
    this.widgets = withChange(this.widgets, id, set);
    this.template = null;
  }

  /** Puts `id` right before `next` (undefined: last). */
  move(id: string, next: string | undefined): void {
    this.widgets = [...movedBefore(this.widgets, id, next)];
    this.template = null;
  }

  /** One place earlier (-1) or later (+1): the keyboard's and the phone's way to move a widget. */
  step(id: string, by: -1 | 1): void {
    this.widgets = [...steppedBy(this.widgets, id, by)];
  }

  useTemplate(t: HomeTemplate): void {
    this.widgets = templateWidgets(t);
    this.selected = null;
    this.fresh = null;
    this.template = t;
  }
}

export const homeEditor = new HomeEditor();

/** The widgets on screen: the draft while Customize is open on this project, else the home the viewer sees. */
export const homeWidgetsShown = (projectId: string): HomeWidget[] => (homeEditor.editing(projectId) ? homeEditor.widgets : shownHome(projectId).widgets);
