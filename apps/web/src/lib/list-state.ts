// A list's state and its rules: layout, display options and filter, and what Clear, Reset, Revert and Save do to them.
// Screens read it; the View panel and the tab row change it. Where the states live, are kept and come from is
// view-state.ts.
//
// CONTRACT (2026-10-27): the shape below is shared by the list, the board and the View panel. The query work adds
// persistence (per viewer, local) and URL sync; the layout work adds the board; neither changes the shape.
//
// Two kinds of list state (PLNR-74). A project's own list, "All issues" (keyed by the project id, its scope the
// project): changes there are temporary. A saved view's (keyed "v:<view id>", its scope the workspace): it starts as
// the view was saved and is "edited" while it differs; the edits are the viewer's until they save or revert them, and
// one view has one state wherever it shows, a tab in any of its projects or its own page.
//
// The layout is the viewer's alone (PLNR-78; owner's call, 2026-10-31): List or Board in the tab row is their choice on
// this device, kept for each list, and no part of a view. A list they have not switched shows as a list.
//
// The saved views and the query lookups come in as a ListSource rather than from the store (PLNR-346), so these rules
// run under node --test. Compared: stubbing store.ts with a loader hook or mock.module (the test then checks a stand-in
// module graph, and mock.module is behind a flag); making store.ts importable in Node (it opens sync engines and reads
// the router and the DOM on import). The source is two functions, and the store's is view-state.ts's.
import {
  DEFAULT_DISPLAY,
  DISPLAY_PROPERTY_OPTIONS,
  formatQuery,
  GROUP_BY_OPTIONS,
  isEmptyFilter,
  namesOrder,
  ORDER_BY_OPTIONS,
  parseQuery,
  type DisplayOptions,
  type Filter,
  type QueryContext,
  type QueryError,
} from "@rsva/query";
import type { SavedView, ViewFields } from "@rsva/protocol";
import type { Issue } from "@rsva/schema/models";
import { makeAutoObservable, observableRef } from "mobx";
import type { GroupTarget } from "./group-patch.ts";

export type Layout = "list" | "board";

export interface ListBase {
  issues: () => Issue[];
  targets: readonly GroupTarget[];
  /** Takes no new issues (a completed cycle): the list offers no adding. */
  closed: () => boolean;
}

/** What a list state reads from the workspace: its saved view, and the lookups its query text needs. */
export interface ListSource {
  /** The saved view of this id, while it still exists. */
  view(id: string): SavedView | null;
  /** The query lookups of a scope: a project id, or WS_SCOPE. */
  context(scope: string): QueryContext;
}

/** The scope of a saved view's state: every project of the workspace. Otherwise the scope is a project id. */
export const WS_SCOPE = "ws";

const blankDisplay = (): DisplayOptions => ({ ...DEFAULT_DISPLAY, properties: [...DEFAULT_DISPLAY.properties] });

export class ProjectView {
  /** The viewer's on this device (the tab row, V). */
  layout: Layout = "list";
  display: DisplayOptions = blankDisplay();
  filter: Filter = {};
  /** localStorage and collapsed-group key: the project id, or "v:<view id>". */
  readonly key: string;
  /** The project id, or WS_SCOPE for a saved view. */
  readonly scope: string;
  /** The saved view this state belongs to; null for a project's All issues and a new view's draft. */
  readonly viewId: string | null;
  readonly source: ListSource;
  /**
   * A list of a part of the project (a cycle's page, PLNR-63): the issues it runs over instead of the project's, and the
   * groups every new issue made in it also belongs to (its cycle), merged with the group it is added in.
   */
  readonly base: ListBase | null;

  constructor(key: string, scope: string, viewId: string | null, source: ListSource, base: ListBase | null = null) {
    this.key = key;
    this.scope = scope;
    this.viewId = viewId;
    this.source = source;
    this.base = base;
    makeAutoObservable(this, { display: observableRef, filter: observableRef, key: false, scope: false, viewId: false, source: false, base: false });
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
  }

  /** Replaces display options immutably, so computeds that read `display` see one change. */
  setDisplay(patch: Partial<DisplayOptions>): void {
    this.display = { ...this.display, ...patch };
  }

  setFilter(filter: Filter): void {
    this.filter = filter;
  }

  /**
   * The list as one line of the query language (PLNR-401): the filter, and `order:` when the order is not the default
   * (Manual). The query line and ?q= show it; saving keeps the order in the display, as before.
   */
  get query(): string {
    const order = this.display.orderBy;
    return formatQuery(this.filter, this.source.context(this.scope), order === DEFAULT_DISPLAY.orderBy ? undefined : order);
  }

  /**
   * Takes a line of the query language: its filter, and its order into the display. A line without `order:` is the
   * default order; one whose `order:` is still being typed (or wrong) keeps the order there is. Returns its errors.
   */
  setQuery(text: string): QueryError[] {
    const { filter, errors, order } = parseQuery(text, this.source.context(this.scope));
    this.filter = filter;
    const next = order ?? (namesOrder(text) ? this.display.orderBy : DEFAULT_DISPLAY.orderBy);
    if (next !== this.display.orderBy) this.setDisplay({ orderBy: next });
    return errors;
  }

  /** Takes these fields: the saved view's (revert), or a copy's (a new view starting from what is on screen). */
  load(fields: Pick<ViewFields, "query" | "display"> | null): void {
    this.filter = fields ? parseQuery(fields.query, this.source.context(this.scope)).filter : {};
    this.display = this.displayOf(fields);
  }

  /** A view's display; a query that names an order (an agent may write one, PLNR-401) wins over it, as on the API. */
  private displayOf(fields: Pick<ViewFields, "query" | "display"> | null | undefined): DisplayOptions {
    const d = displayOf(fields?.display);
    const order = fields?.query ? parseQuery(fields.query, this.source.context(this.scope)).order : undefined;
    return order ? { ...d, orderBy: order } : d;
  }

  /** Takes what local storage kept of this state; anything invalid in it is left as it is now. */
  restore(saved: unknown): void {
    if (typeof saved !== "object" || saved === null) return;
    const s = saved as { layout?: unknown; display?: Partial<Record<keyof DisplayOptions, unknown>>; filter?: unknown };
    // Before PLNR-78 `layout` was a saved view's edited layout too; as what the viewer last saw it is their choice.
    if (s.layout === "list" || s.layout === "board") this.layout = s.layout;
    this.display = displayOf(s.display);
    if (s.filter && typeof s.filter === "object" && !Array.isArray(s.filter)) this.filter = s.filter as Filter;
  }

  /**
   * Back to the saved view; All issues back to every issue, its display as it is (Clear: Display has its own Reset,
   * ADR 0045). The viewer's layout stays: it is no edit.
   */
  revert(): void {
    if (this.viewId) this.load(this.saved);
    else this.filter = {};
  }

  /** Display back to the saved view's, or All issues' default (Reset in the Display popover). */
  resetDisplay(): void {
    this.display = this.displayOf(this.saved);
  }

  /** The saved view this state belongs to, while it still exists. */
  get saved(): SavedView | null {
    return this.viewId ? this.source.view(this.viewId) : null;
  }

  /** What saving would store: the filter as query text and the display. */
  get fields(): Pick<ViewFields, "query" | "display"> {
    return { query: formatQuery(this.filter, this.source.context(this.scope)), display: { ...this.display } };
  }

  get filtered(): boolean {
    return !isEmptyFilter(this.filter);
  }

  /** Displayed otherwise than its saved view, or than by default for All issues. */
  get displayEdited(): boolean {
    return JSON.stringify(this.display) !== JSON.stringify(this.displayOf(this.saved));
  }

  /**
   * Differs from its saved view (Save puts the edits into it); for All issues, filtered or displayed otherwise than
   * by default (Save makes a new view of it). The viewer's layout does not count.
   */
  get edited(): boolean {
    if (!this.viewId) return this.filtered || this.displayEdited;
    const s = this.saved;
    if (!s) return false;
    const ctx = this.source.context(this.scope);
    return this.fields.query !== formatQuery(parseQuery(s.query, ctx).filter, ctx) || this.displayEdited;
  }
}

/** A new view being made in the View panel: a copy of a list as on screen, shown in its place while the panel is open. */
export function draftState(from: ProjectView, extra = ""): ProjectView {
  const d = new ProjectView(`draft:${from.key}`, WS_SCOPE, null, from.source);
  const f = from.fields;
  d.load({ ...f, query: [extra, f.query].filter(Boolean).join(" ") });
  d.setLayout(from.layout);
  return d;
}

/** Board columns are one project's states: in a project, or for a view whose Project filter names exactly one. */
export function boardable(list: ProjectView, project: { id: string } | null): boolean {
  return !!project || (list.scope === WS_SCOPE && list.filter.project?.length === 1);
}

// ── Stored display options ──────────────────────────────────────────────────────────────────────────────────────

const GROUPS = new Set<string>(GROUP_BY_OPTIONS.map((o) => o.value));
const ORDERS = new Set<string>(ORDER_BY_OPTIONS.map((o) => o.value));
const PROPS = new Set<string>(DISPLAY_PROPERTY_OPTIONS.map((o) => o.value));

/** Display options from storage or a saved view: what is valid of them over the defaults. */
export function displayOf(d: Partial<Record<keyof DisplayOptions, unknown>> | undefined): DisplayOptions {
  const next = blankDisplay();
  if (!d || typeof d !== "object") return next;
  if (typeof d.groupBy === "string" && GROUPS.has(d.groupBy)) next.groupBy = d.groupBy as DisplayOptions["groupBy"];
  if (d.subGroupBy === null || (typeof d.subGroupBy === "string" && GROUPS.has(d.subGroupBy))) next.subGroupBy = d.subGroupBy as DisplayOptions["subGroupBy"];
  if (typeof d.orderBy === "string" && ORDERS.has(d.orderBy)) next.orderBy = d.orderBy as DisplayOptions["orderBy"];
  if (typeof d.showEmptyGroups === "boolean") next.showEmptyGroups = d.showEmptyGroups;
  if (typeof d.showSubIssues === "boolean") next.showSubIssues = d.showSubIssues;
  if (Array.isArray(d.properties)) next.properties = d.properties.filter((p): p is DisplayOptions["properties"][number] => PROPS.has(p));
  return next;
}
