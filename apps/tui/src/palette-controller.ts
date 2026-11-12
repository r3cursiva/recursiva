// What the palette (/ or Ctrl+K) offers and what its keys do (PLNR-380): the root's commands, issues, views and places,
// and the pages that pick one value. Painted by palette.ts; acts through the run's App (app.ts).
import { MY_WORK } from "@rsva/terminal/issues";
import { plain } from "@rsva/terminal/text";
import { localToday, ORDER_BY_OPTIONS, parseQuery, resolveDateExpr, withOrder } from "@rsva/query";
import { assignable, cycleStatus, isClosedGroup, PRIORITIES, type Issue, type RelationType } from "@rsva/schema/models";
import { cycleEnd, datePresets } from "@rsva/display/date-presets";
import { plural, toggled } from "@rsva/schema/util";
import { subIssuesLeft } from "@rsva/display/move";
import type { App } from "./app.ts";
import { stateMark } from "./home-view.ts";
import { cursorKey } from "./keys.ts";
import { ordered, search, type Entry, type PaletteView } from "./palette.ts";
import { edited } from "./terminal.ts";
import { THEMES } from "./theme.ts";
import { contextOf, START_ORDER, START_QUERY } from "./view.ts";

/** A page of the palette: what it picks and, for an issue's field, which issue. */
export type Page =
  | { kind: "workspace" | "project" | "view" | "theme" | "order" }
  | { kind: IssuePage; issue: string }
  /** The issues it is blocked by, blocks or is related to: picking one links or unlinks it (PLNR-439). */
  | { kind: "relate"; issue: string; type: Relating }
  /** After the project, when the issue has sub-issues: whether they go too (PLNR-448). */
  | { kind: "move-subs"; issue: string; to: string };

/** The pages of one issue: its fields, and `.`, its menu of everything that acts on it (PLNR-439). */
export type IssuePage = "state" | "priority" | "assignees" | "labels" | "cycle" | "due" | "start" | "parent" | "move" | "actions";
type Relating = Extract<RelationType, "blockedBy" | "blocks" | "related">;
const RELATING: Record<Relating, string> = { blockedBy: "Blocked by", blocks: "Blocks", related: "Related to" };

const PAGE: Record<Page["kind"], { name: string; section: string }> = {
  workspace: { name: "Workspace", section: "WORKSPACES" },
  project: { name: "Project", section: "PROJECTS" },
  view: { name: "View", section: "VIEWS" },
  // Its values name their own section: DARK, LIGHT.
  theme: { name: "Theme", section: "" },
  order: { name: "Order", section: "ORDER WITHIN A STATE" },
  state: { name: "State", section: "STATES" },
  priority: { name: "Priority", section: "PRIORITIES" },
  assignees: { name: "Assignees", section: "PEOPLE" },
  move: { name: "Move to project", section: "PROJECTS" },
  labels: { name: "Labels", section: "LABELS" },
  cycle: { name: "Cycle", section: "CYCLES" },
  due: { name: "Due date", section: "DUE" },
  start: { name: "Start date", section: "START" },
  parent: { name: "Parent", section: "ISSUES" },
  relate: { name: "Relation", section: "ISSUES" },
  actions: { name: "Actions", section: "ACTIONS" },
  "move-subs": { name: "Sub-issues", section: "SUB-ISSUES" },
};

export interface Palette {
  query: string;
  at: number;
  /** Null on the root: every command, issue, view and place. */
  page: Page | null;
}

/** `preview`: a theme's id, shown while the cursor is on it; `stay`: picking it keeps the page open (a list of ticks). */
type Command = Entry & { run(): void; preview?: string; stay?: boolean };
/** Issues the palette shows at most: the count says how many it found. */
const PALETTE_ISSUES = 6;

/** The palette on `page`, its cursor on the value in use. */
export function showPage(app: App, page: Page): void {
  app.ui.palette = { query: "", at: 0, page };
  app.ui.palette.at = Math.max(0, paletteFound(app).shown.findIndex((e) => e.checked));
}
const openPage = (app: App, page: Page) => () => showPage(app, page);

/**
 * Everything that acts on one issue, each with its key: the root's commands for the issue under the cursor and its
 * menu (`.`), the web's "…" in one key. The rare ones (cycle, dates, parent, relations, archive) have no key of their own.
 */
function issueCommands(app: App, item: Issue, section: string, menu: boolean): Command[] {
  const { store } = app;
  const key = store.issueKey(item);
  const page = (kind: IssuePage) => openPage(app, { kind, issue: item.id });
  const relate = (type: Relating) => openPage(app, { kind: "relate", issue: item.id, type });
  // In the menu the chip names the issue: each line says only what it does. In the root, where every issue's commands
  // could be, it says whose.
  const c = (short: string, long: string, run: () => void, shortcut?: string): Command => ({ section, label: menu ? short : long, run, ...(shortcut ? { shortcut } : {}) });
  return [
    c("State…", `Change the state of ${key}…`, page("state"), "s"),
    c("Priority…", `Change the priority of ${key}…`, page("priority"), "p"),
    c("Assignees…", `Change the assignees of ${key}…`, page("assignees"), "a"),
    c("Labels…", `Change the labels of ${key}…`, page("labels"), "l"),
    c("Cycle…", `Set the cycle of ${key}…`, page("cycle")),
    c("Due date…", `Set the due date of ${key}…`, page("due")),
    c("Start date…", `Set the start date of ${key}…`, page("start")),
    c("Parent…", `Set the parent of ${key}…`, page("parent")),
    ...(Object.keys(RELATING) as Relating[]).map((type) => c(`${RELATING[type]}…`, `${RELATING[type]}… (${key})`, relate(type))),
    ...(item.number > 0 && !item.deletedAt ? [c("Move to another project…", `Move ${key} to another project…`, page("move"), "m")] : []),
    c("Reply…", `Reply to ${key}…`, () => app.reply(item), "r"),
    c("Sub-issue…", `Create a sub-issue of ${key}…`, () => app.newIssue(true), "C"),
    c("Dispatch to an agent…", `Dispatch ${key} to an agent…`, () => app.dispatch(item), "d"),
    c("Copy the link", `Copy the link to ${key}`, () => app.copy(item, "link"), "y"),
    c("Copy the key", `Copy the key ${key}`, () => app.copy(item, "key"), "Y"),
    c("Open in the browser", `Open ${key} in the browser`, () => app.browse(item), "o"),
    c("Edit the description", `Edit the description of ${key}`, () => app.editDescription(item), "e"),
    ...(item.archivedAt || item.deletedAt
      ? [c("Restore", `Restore ${key}`, () => app.restore(item))]
      : [
          ...(isClosedGroup(store.states.get(item.stateId)?.group) ? [c("Archive", `Archive ${key}`, () => app.archive(item))] : []),
          c("Delete…", `Delete ${key}…`, () => app.remove(item), "D"),
        ]),
  ];
}

/** A workspace's slug after its name, unless it only repeats it ("arsen arsen"). */
const slugOf = (w: { name: string; slug: string }) => (w.slug === w.name.toLowerCase() ? {} : { detail: w.slug });

/** Everything the palette's root can find, each with what it does. */
function rootEntries(app: App): Command[] {
  const { store } = app;
  const item = app.target();
  const elsewhere = app.workspaces().filter((w) => w.slug !== app.workspace);
  const setQuery = (q: string) => () => app.setQuery(q);
  const commands: Command[] = [
    ...(item ? issueCommands(app, item, "COMMANDS", false) : []),
    { section: "COMMANDS", label: "Undo the last change", shortcut: "u", run: () => app.undo() },
    { section: "COMMANDS", label: "Create an issue…", shortcut: "c", run: () => app.newIssue(false) },
    { section: "COMMANDS", label: `Dispatch queue: ${app.queueSource()}`, shortcut: "g q", run: () => app.startQueue() },
    {
      section: "COMMANDS",
      label: "Filter with a query…",
      shortcut: "f",
      run: () => {
        app.stopReading();
        app.openQuery();
      },
    },
    { section: "COMMANDS", label: "Go to project…", run: openPage(app, { kind: "project" }) },
    { section: "COMMANDS", label: "Open view…", run: openPage(app, { kind: "view" }) },
    ...(elsewhere.length ? [{ section: "COMMANDS" as const, label: "Change workspace…", run: openPage(app, { kind: "workspace" }) }] : []),
    { section: "COMMANDS", label: "Order issues by…", run: openPage(app, { kind: "order" }) },
    { section: "COMMANDS", label: "Change theme…", run: openPage(app, { kind: "theme" }) },
    { section: "COMMANDS", label: "Quit", shortcut: "q", run: () => app.quit() },
  ];
  const issues: Command[] = [...store.issues.values()]
    .filter((i) => !i.deletedAt && !i.archivedAt)
    .map((i) => {
      const st = store.states.get(i.stateId);
      return {
        section: "ISSUES",
        label: plain(i.title),
        issue: { key: store.issueKey(i), mark: st ? stateMark(store, st) : { name: "", glyph: "○", tone: "status-todo" } },
        shortcut: "↵",
        run: () => app.openIssue(i.id),
      };
    });
  const views: Command[] = store.views.list.map((v) => ({ section: "VIEWS", label: plain(v.name), detail: plain(v.query), run: setQuery(v.query || START_QUERY) }));
  const places: Command[] = [
    { section: "GO TO", label: "Open issues", run: setQuery(START_QUERY) },
    { section: "GO TO", label: "My issues", run: setQuery(MY_WORK) },
    ...store.projectList().map((p): Command => ({ section: "GO TO", label: `Project ${plain(p.key)} · ${plain(p.name)}`, project: p.key, run: setQuery(`project:${p.key}`) })),
    // Another workspace: this run ends and the next opens there, from its own copy (main.ts).
    ...elsewhere.map((w): Command => ({ section: "GO TO", label: `Workspace ${plain(w.name)}`, ...slugOf(w), run: () => app.switchTo(w.slug) })),
  ];
  return [...commands, ...issues, ...views, ...places];
}

/** A page's values, the one in use checked, each with what picking it does. */
function pageEntries(app: App, page: Page): Command[] {
  const { store } = app;
  const section = PAGE[page.kind].section;
  const q = app.query();
  const setQuery = (to: string) => () => app.setQuery(to);
  if (page.kind === "workspace") {
    const all = app.workspaces();
    const list = all.length ? all : [{ slug: app.workspace, name: store.workspace?.name ?? app.workspace }];
    return list.map((w) => ({ section, label: plain(w.name), ...slugOf(w), checked: w.slug === app.workspace, run: () => app.switchTo(w.slug) }));
  }
  if (page.kind === "project")
    return store.projectList().map((p) => ({ section, label: `${plain(p.key)} · ${plain(p.name)}`, checked: q === `project:${p.key}`, run: setQuery(`project:${p.key}`) }));
  if (page.kind === "view")
    return [
      { name: "Open issues", query: START_QUERY },
      { name: "My issues", query: MY_WORK },
      ...store.views.list.map((v) => ({ name: plain(v.name), query: v.query || START_QUERY })),
    ].map((v) => ({ section, label: v.name, detail: plain(v.query), checked: q === v.query, run: setQuery(v.query) }));
  if (page.kind === "order") {
    // The page writes `order:` into the query (PLNR-401), as Go to project writes `project:`; the start order takes it
    // out. The list keeps the issue under the cursor: only the rows around it move.
    const now = parseQuery(q, contextOf(store)).order ?? START_ORDER;
    return ORDER_BY_OPTIONS.map((o) => ({
      section,
      label: o.label,
      checked: o.value === now,
      run: () => app.changeQuery(withOrder(q, o.value === START_ORDER ? null : o.value)),
    }));
  }
  if (page.kind === "theme")
    // Each is shown while the cursor is on it; Enter keeps it and remembers it for the next start, Esc puts back the one picked.
    return THEMES.map((t) => ({ section: t.dark ? "DARK" : "LIGHT", label: t.name, detail: t.note, checked: t.id === app.theme(), preview: t.id, run: () => app.pickTheme(t.id) }));
  const issue = "issue" in page && store.issues.get(page.issue);
  if (!issue) return [];
  if (page.kind === "actions") return issueCommands(app, issue, section, true);
  if (page.kind === "labels")
    // A tick on or off, the page kept open for the next, as the web's label picker.
    return store.labelsOf(issue.projectId).map((l) => {
      const has = issue.labelIds.includes(l.id);
      return {
        section,
        label: plain(l.name),
        checked: has,
        stay: true,
        run: () => app.change(issue, { labelIds: toggled(issue.labelIds, l.id) }, `${has ? "−" : "+"} ${plain(l.name)}`),
      };
    });
  const today = localToday();
  if (page.kind === "cycle") {
    // The cycles still to finish, and the issue's own whatever its state, as the web's cycle picker offers.
    const cycles = store.cyclesOf(issue.projectId).filter((c) => c.id === issue.cycleId || (cycleStatus(c, today) !== "completed" && !c.completedAt));
    return [
      { section, label: "No cycle", checked: !issue.cycleId, run: () => issue.cycleId && app.change(issue, { cycleId: null }, "out of its cycle") },
      ...cycles.map((c): Command => ({ section, label: `C${c.number}${c.name ? ` · ${plain(c.name)}` : ""}`, detail: [c.startDate, c.endDate].filter(Boolean).join(" – "), checked: c.id === issue.cycleId, run: () => c.id !== issue.cycleId && app.change(issue, { cycleId: c.id }, `→ C${c.number}`) })),
    ];
  }
  if (page.kind === "due" || page.kind === "start") {
    const field = page.kind === "due" ? "dueDate" : "startDate";
    const what = page.kind === "due" ? "due" : "starts";
    const set = (day: string | null) => () => issue[field] !== day && app.change(issue, { [field]: day }, day ? `${what} ${day}` : `no ${page.kind} date`);
    // The web's quick dates (Today, Fri, Next week, End of cycle for a due date); a typed date or word (2026-11-20,
    // tomorrow) is offered first. Weeks start on Monday, the account's default: the TUI does not read the setting yet.
    const end = page.kind === "due" ? cycleEnd(issue.cycleId ? store.cycles.get(issue.cycleId) : undefined, store.cyclesOf(issue.projectId), today) : null;
    const typed = app.ui.palette?.query.trim() ?? "";
    const r = typed ? resolveDateExpr(typed, today) : null;
    const day = r && "range" in r && r.range.from && r.range.from === r.range.to ? r.range.from : null;
    return [
      ...(day ? [{ section, label: typed, detail: day, run: set(day) }] : []),
      ...datePresets(today, 1, end).map((p): Command => ({ section, label: p.label, detail: p.day, checked: issue[field] === p.day, run: set(p.day) })),
      { section, label: `No ${page.kind} date`, ...(issue[field] ? { detail: issue[field] } : {}), checked: !issue[field], run: set(null) },
    ];
  }
  if (page.kind === "parent" || page.kind === "relate") {
    const type = page.kind === "relate" ? page.type : null;
    const rel = store.relationsOf(issue.id);
    const linked = type ? new Set(rel[type].map((x) => x.id)) : new Set(issue.parentId ? [issue.parentId] : []);
    const others = [...store.issues.values()].filter((x) => x.id !== issue.id && !x.deletedAt && !x.archivedAt);
    const entry = (x: Issue): Command => {
      const st = store.states.get(x.stateId);
      const has = linked.has(x.id);
      const k = store.issueKey(x);
      const run = !type
        ? () => !has && app.change(issue, { parentId: x.id }, `under ${k}`)
        : () => (has ? store.removeRelation(issue.id, x.id) : store.addRelation(issue.id, type, x.id));
      return { section, label: plain(x.title), issue: { key: k, mark: st ? stateMark(store, st) : { name: "", glyph: "○", tone: "status-todo" } }, checked: has, run };
    };
    return [
      ...(page.kind === "parent" ? [{ section, label: "No parent", checked: !issue.parentId, run: () => issue.parentId && app.change(issue, { parentId: null }, "no parent") } as Command] : []),
      // The linked ones first, so the page opens on them; then every other issue, found by typing its key or title.
      ...others.filter((x) => linked.has(x.id)).map(entry),
      ...others.filter((x) => !linked.has(x.id)).map(entry),
    ];
  }
  if (page.kind === "move") {
    const subs = subIssuesLeft((id) => store.subIssuesOf(id), [issue.id]).length;
    return store
      .projectList()
      .filter((p) => p.id !== issue.projectId)
      .map((p) => ({ section, label: `${plain(p.key)} · ${plain(p.name)}`, run: subs ? openPage(app, { kind: "move-subs", issue: issue.id, to: p.id }) : () => app.moveIssue(issue, p.id, false) }));
  }
  if (page.kind === "move-subs") {
    const n = subIssuesLeft((id) => store.subIssuesOf(id), [issue.id]).length;
    return [
      { section, label: `Move with ${plural(n, "sub-issue")}`, run: () => app.moveIssue(issue, page.to, true) },
      { section, label: "Move without sub-issues", run: () => app.moveIssue(issue, page.to, false) },
    ];
  }
  if (page.kind === "state")
    return store.statesOf(issue.projectId).map((st) => ({ section, label: st.name, mark: stateMark(store, st), checked: st.id === issue.stateId, run: () => app.setState(issue, st) }));
  if (page.kind === "priority")
    return PRIORITIES.map(({ code: p, name }) => ({
      section,
      label: name,
      priority: p,
      checked: issue.priority === p,
      run: () => {
        if (issue.priority !== p) app.change(issue, { priority: p }, `→ ${name}`);
      },
    }));
  // Picking a person adds them, or takes them off when they are on it already, as the web's page does.
  return assignable(store.users.values()).map((u) => {
    const has = issue.assigneeIds.includes(u.id);
    return {
      section,
      label: plain(u.name),
      detail: u.email,
      checked: has,
      run: () => {
        app.change(issue, { assigneeIds: toggled(issue.assigneeIds, u.id) }, `${has ? "−" : "+"} ${plain(u.name)}`);
      },
    };
  });
}

/** What the palette's query finds; issues are many, so the list keeps the first few and the count says the rest. */
function paletteFound(app: App): { shown: Command[]; count: number } {
  const page = app.ui.palette?.page;
  const all = search(page ? pageEntries(app, page) : rootEntries(app), app.ui.palette?.query ?? "") as Command[];
  let issues = 0;
  const shown = ordered(all).filter((e) => e.section !== "ISSUES" || issues++ < PALETTE_ISSUES) as Command[];
  return { shown, count: all.length };
}

/** The palette as painted: what is typed, what it found, the cursor and the page's chip (what it picks and whose). */
export function paletteView(app: App, p: Palette): PaletteView {
  const found = paletteFound(app);
  const issue = p.page && "issue" in p.page ? app.store.issues.get(p.page.issue) : undefined;
  const name = p.page?.kind === "relate" ? RELATING[p.page.type] : p.page ? PAGE[p.page.kind].name : "";
  const scope = p.page ? { ...(issue ? { key: app.store.issueKey(issue) } : {}), name } : undefined;
  return { query: p.query, entries: found.shown, at: p.at, found: found.count, ...(scope ? { scope } : {}) };
}

export function paletteKey(app: App, p: Palette, key: string): void {
  const { shown } = paletteFound(app);
  const at = cursorKey(p.at, key, shown.length);
  // Esc, and Backspace in an empty field, go from a page back to all commands; Ctrl+K closes from anywhere.
  if (p.page && (key === "esc" || (key === "backspace" && !p.query))) Object.assign(p, { query: "", at: 0, page: null });
  else if (key === "esc" || key === "ctrl-k") app.ui.palette = null;
  else if (at !== null) p.at = at;
  else if (key === "enter") {
    const e = shown[p.at];
    // A tick of a list keeps the page; any other closes it, and a command that opens a page opens the palette on it.
    if (!e?.stay) app.ui.palette = null;
    e?.run();
  } else {
    const query = edited(p.query, key);
    if (query === null) return;
    p.query = query;
    p.at = 0;
  }
  // The theme page shows the theme under the cursor; anywhere else the screen has the one picked.
  const open = app.ui.palette;
  const on = open?.page?.kind === "theme" ? paletteFound(app).shown[open.at]?.preview : undefined;
  app.showTheme(on ?? app.theme());
}
