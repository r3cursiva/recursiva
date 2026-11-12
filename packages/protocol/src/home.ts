// A project's home (RSVA-508, ADR 0053): a grid of widgets, after the Quire FramedHome artboards. A home is a saved view
// with the layout "home" (views.ts): its `project:` query names the project, `shared` says whether everyone in it opens
// this home or only its owner, and `display.widgets` holds the widgets. So it travels, is kept and is checked as the
// views are, with no table, frame or permission of its own.
//
// A widget that shows issues carries one line of the query language, the same that `rsva`, the API and Telegram take.
// The others read what the project already has: its cycle, what waits on the viewer, its history.
// What the server keeps is not trusted to be a home: `homeWidgets` reads whatever is there into widgets, dropping what
// it does not know, so an older or newer client's home still opens.

// ── Where a home applies (RSVA-577) ───────────────────────────────────────────────────────────────────────

/** A home applies to one project (its `project:` query) or to every project of the workspace: the default home. */
export type HomeScope = "project" | "all";

/**
 * The workspace's default home: a home whose query names no project, so it has nothing but white space. Every project
 * without a home of its own shows it. The test is on the text, so the server applies it without the query's parser.
 */
export const isDefaultHome = (v: { layout: string; query: string }): boolean => v.layout === "home" && v.query.trim() === "";

type HomeView = { layout: string; query: string; shared: boolean };

/** The homes a project may show: `project`, those whose query names it, and `all`, the workspace's defaults. Oldest first. */
export interface HomeLists<V extends HomeView> {
  project: readonly V[];
  all: readonly V[];
}

/**
 * The saved home at one place. A home is everyone's (RSVA-577): one a person kept for themselves before is not read, so
 * a project shows the same page to all.
 */
export const homeAt = <V extends HomeView>(lists: HomeLists<V>, scope: HomeScope): V | undefined => lists[scope].find((v) => v.shared);

/** The saved home a project shows: its own, else the default; undefined: the built-in template. */
export function pickHome<V extends HomeView>(lists: HomeLists<V>): { view: V; scope: HomeScope } | undefined {
  for (const scope of ["project", "all"] as const) {
    const view = homeAt(lists, scope);
    if (view) return { view, scope };
  }
  return undefined;
}

/**
 * The widgets there are, in the library's order. Figures and Structure came with RSVA-570, Pull requests with RSVA-572
 * (RSVA-519), Closed, 12 months with RSVA-576: in the library only, no template has it, as it looks back and the home
 * a project opens with is what to act on. Brief, Links, Milestones and Status update wait for their data (RSVA-518…522).
 */
export const HOME_KINDS = ["list", "count", "chart", "figures", "structure", "cycle", "wait", "pulls", "year", "activity"] as const;
export type HomeKind = (typeof HOME_KINDS)[number];

/** The kinds that show the issues of a query, and how each shows them. */
export const QUERY_KINDS = ["list", "count", "chart"] as const satisfies readonly HomeKind[];
export type QueryKind = (typeof QUERY_KINDS)[number];
export const isQueryKind = (k: HomeKind): k is QueryKind => (QUERY_KINDS as readonly string[]).includes(k);

/** A widget's width in twelfths of the grid: ¼, ⅓, ½, ⅔ and the whole row. */
export const HOME_WIDTHS = [3, 4, 6, 8, 12] as const;
export type HomeWidth = (typeof HOME_WIDTHS)[number];

/** How many issues a list shows before "N more"; 0 shows them all. */
export const HOME_ROWS = [5, 10, 0] as const;
export type HomeRows = (typeof HOME_ROWS)[number];

/** What a chart puts side by side. */
export const CHART_BY = ["state", "priority", "assignee"] as const;
export type ChartBy = (typeof CHART_BY)[number];

export interface HomeWidget {
  /** Stable within its home: the key a list renders by and the settings panel opens. */
  id: string;
  kind: HomeKind;
  /** Empty: the kind's own name. */
  title: string;
  /** For a list, a count or a chart: the issues it shows, within the project. */
  query: string;
  width: HomeWidth;
  rows: HomeRows;
  by: ChartBy;
}

/** Most widgets a home holds, and the most bytes its display takes as JSON (a view's is VIEW_DISPLAY_MAX). */
export const HOME_WIDGETS_MAX = 24;
export const HOME_TITLE_MAX = 80;

/** The kind's name: a widget's title when it has none of its own, and its line in the library. */
export const KIND_NAMES: Record<HomeKind, string> = {
  list: "Issues",
  count: "Count",
  chart: "Chart",
  cycle: "Cycle",
  wait: "Waiting on you",
  activity: "Activity",
  figures: "Figures",
  structure: "Structure",
  pulls: "Pull requests",
  year: "Closed, 12 months",
};

const DEFAULT_WIDTH: Record<HomeKind, HomeWidth> = { list: 6, count: 3, chart: 6, cycle: 4, wait: 6, activity: 6, figures: 12, structure: 8, pulls: 6, year: 8 };

const pick = <T>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** A new widget of `kind` with its defaults; `id` is the caller's (a short random one). */
export function newWidget(id: string, kind: HomeKind, set: Partial<Omit<HomeWidget, "id" | "kind">> = {}): HomeWidget {
  return { id, kind, title: "", query: "", width: DEFAULT_WIDTH[kind], rows: 5, by: "state", ...set };
}

/** A home's widgets as stored, read back: unknown kinds and fields dropped, the rest filled in, ids made unique. */
export function homeWidgets(display: Record<string, unknown> | undefined): HomeWidget[] {
  const raw = Array.isArray(display?.["widgets"]) ? (display["widgets"] as unknown[]) : [];
  const seen = new Set<string>();
  const out: HomeWidget[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const w = r as Record<string, unknown>;
    if (!(HOME_KINDS as readonly unknown[]).includes(w["kind"])) continue;
    const kind = w["kind"] as HomeKind;
    let id = text(w["id"], 40) || `w${out.length}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    out.push({
      id,
      kind,
      title: text(w["title"], HOME_TITLE_MAX),
      query: text(w["query"], 2000),
      width: pick(HOME_WIDTHS, w["width"], DEFAULT_WIDTH[kind]),
      rows: pick(HOME_ROWS, w["rows"], 5),
      by: pick(CHART_BY, w["by"], "state"),
    });
    if (out.length === HOME_WIDGETS_MAX) break;
  }
  return out;
}

/** The widget's title as shown. */
export const widgetTitle = (w: Pick<HomeWidget, "kind" | "title" | "by">): string =>
  w.title || (w.kind === "chart" ? `By ${w.by === "state" ? "status" : w.by}` : KIND_NAMES[w.kind]);

// ── Templates ──────────────────────────────────────────────────────────────────────────────────────────────

/** Open: neither done nor cancelled, in any project's workflow. */
const OPEN = "-group:completed -group:cancelled";

export const HOME_TEMPLATES = ["engineering", "agents", "launch"] as const;
export type HomeTemplate = (typeof HOME_TEMPLATES)[number];
export const TEMPLATE_NAMES: Record<HomeTemplate, string> = { engineering: "Engineering", agents: "Agent ops", launch: "Launch" };

type Spec = [HomeKind, Partial<Omit<HomeWidget, "id" | "kind">>?];
const SPECS: Record<HomeTemplate, Spec[]> = {
  // The page reads without Customize (RSVA-570): where the project stands, what it is made of, what waits on the viewer.
  engineering: [
    ["figures"],
    ["structure"],
    ["wait", { width: 4 }],
    ["cycle", { width: 6 }],
    ["pulls"],
    ["list", { title: "Next up for me", query: `assignee:me ${OPEN} order:priority` }],
    ["chart", { query: "-group:cancelled" }],
    ["activity", { width: 12 }],
  ],
  agents: [
    ["wait"],
    ["list", { title: "With agents now", query: `agent:any ${OPEN} order:priority` }],
    ["count", { title: "With agents", query: `agent:any ${OPEN}` }],
    ["count", { title: "Agents started", query: "agent:any group:started" }],
    ["count", { title: "Proposed", query: "label:proposed group:backlog" }],
    ["count", { title: "Done by agents", query: "agent:any group:completed" }],
    ["activity", { width: 12 }],
  ],
  launch: [
    ["chart", { title: "Launch issues by status", query: "-group:cancelled" }],
    ["cycle", { width: 6 }],
    ["count", { title: "Urgent, open", query: `priority:urgent ${OPEN}` }],
    ["count", { title: "Open bugs", query: `label:bug ${OPEN}` }],
    ["count", { title: "In progress", query: "group:started" }],
    ["count", { title: "Done", query: "group:completed" }],
    ["list", { title: "Open, most urgent first", query: `${OPEN} order:priority`, width: 12, rows: 10 }],
  ],
};

// ── Ready queries ──────────────────────────────────────────────────────────────────────────────────────────

/** A widget the library adds with its query written (RSVA-523): what people look for most, without the query language. */
export interface HomePreset {
  id: string;
  name: string;
  /** What it finds, the library's second line. */
  line: string;
  kind: QueryKind;
  query: string;
}

export const HOME_PRESETS: readonly HomePreset[] = [
  { id: "overdue", name: "Overdue", line: "Open issues past their due date", kind: "list", query: `due:<today ${OPEN} order:due` },
  { id: "week", name: "Due this week", line: "Open issues due this week", kind: "list", query: `due:this-week ${OPEN} order:due` },
  { id: "blocked", name: "Blocked", line: "Waiting on another open issue", kind: "list", query: `is:blocked ${OPEN}` },
  { id: "unassigned", name: "Unassigned", line: "Open issues nobody has taken", kind: "list", query: `assignee:none ${OPEN} order:priority` },
  { id: "mine", name: "Mine, open", line: "Yours, most urgent first; each viewer sees their own", kind: "list", query: `assignee:me ${OPEN} order:priority` },
  { id: "urgent", name: "Urgent", line: "Urgent and still open", kind: "count", query: `priority:urgent ${OPEN}` },
  { id: "done", name: "Done this week", line: "Finished in the last seven days", kind: "count", query: "group:completed updated:last-7-days" },
  { id: "proposed", name: "Proposed", line: "Proposals waiting for triage", kind: "list", query: "label:proposed group:backlog" },
];

/** The widget a ready query adds. */
export const presetWidget = (id: string, p: HomePreset): HomeWidget => newWidget(id, p.kind, { title: p.name, query: p.query });

/** A template's widgets, with ids `t0`, `t1`… */
export const templateWidgets = (t: HomeTemplate): HomeWidget[] => SPECS[t].map(([kind, set], i) => newWidget(`t${i}`, kind, set));

/** The home a project shows before anyone has saved one for it or for the workspace: the built-in one. */
export const DEFAULT_TEMPLATE: HomeTemplate = "engineering";
