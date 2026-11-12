// `rsva tui` (PLNR-306): the copy in the process, as a browser tab holds it, kept on disk between starts
// (~/Library/Caches/rsva). The TUI lives as long as the person looks at it, so it keeps the engine (packages/sync) and its
// socket itself: reads and edits are local and at once, others' changes arrive as they are made. The screens are the
// design canvas's TUI artboards (home.ts), painted into a grid of cells and written as the rows that changed.
//
// The run's state and its moves are one object, App (PLNR-424): the screens' keys (keys.ts) and the palette
// (palette-controller.ts) act through it. On the way out it prints what it measured (stats.ts).
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import type { Client } from "@rsva/terminal/client";
import { editorArgv, pagerOf, scratchFile } from "@rsva/terminal/programs";
import type { DocNode } from "@rsva/editor/doc";
import { fromMarkdown, toMarkdown } from "@rsva/editor/markdown";
import type { WorkspaceListItem } from "@rsva/protocol";
import { ORDER_WORDS } from "@rsva/query";
import { cleanUrl, COMMENT_MAX, isClosedGroup, type Issue, type IssueUpdate } from "@rsva/schema/models";
import type { DocJSON, Disks, SyncEngine } from "@rsva/sync";
import { errorText, plural } from "@rsva/schema/util";
import { plain } from "@rsva/terminal/text";
import { subIssuesLeft } from "@rsva/display/move";
import { watchAgents } from "./agents.ts";
import { copyText, exec } from "./commands.ts";
import { loadConfig } from "./dispatch.ts";
import { draftCard, draftOf, HOW, lineContext, type Creating, type Draft } from "./create.ts";
import { Flow } from "./flow.ts";
import { Grid, GridScreen } from "./grid.ts";
import { cardAnchor, paintHome, scrollTop, layout, type HomeView } from "./home.ts";
import type { Seg } from "./widgets.ts";
import { activityOf, cardOf, detailsOf, rowsOf, stateMark, type AgentOn } from "./home-view.ts";
import { issueAnchor, paintIssue, type IssueView } from "./issue.ts";
import { changed, cursorKey, helpOf, hintsOf, ISSUE_KEYS, LIST_KEYS, press, type Held } from "./keys.ts";
import { dimBehind, paintConfirm, paintCreate, paintHelp, paintStatePicker, shown, type Picker } from "./panels.ts";
import { paletteKey, paletteView, showPage, type IssuePage, type Palette } from "./palette-controller.ts";
import { paintPalette } from "./palette.ts";
import { QUEUE_HELP } from "./queue.ts";
import { edited, editField, isText, keyReader, screenOf } from "./terminal.ts";
import { imagesOn, Pictures, serverImages, type Placement } from "./images.ts";
import { themeColours } from "./theme.ts";
import { completionsOf, paintQuery, type QueryView } from "./query.ts";
import { remember, remembered } from "./state.ts";
import { bodyOf, complete, mentionAt } from "./reply.ts";
import { Stats } from "./stats.ts";
import { beforeOf, Undo } from "./undo.ts";
import { contextOf, cursorOn, listOf, queryName, START_QUERY, type Item, type Left } from "./view.ts";

export interface TuiHost {
  env: Record<string, string | undefined>;
  disk: Disks | null;
  /** Where the TUI keeps what it remembers between starts (state.ts); null keeps nothing. */
  state: string | null;
  open?(url: string): Promise<boolean>;
  /** When this run began (performance.now()), for its first frame and data; unset, the process's start. */
  since?: number;
  /** The workspaces the credential opens, for the palette's switch (PLNR-323); asked after the first frame. */
  workspaces?(): Promise<WorkspaceListItem[]>;
}

/** How a run ended: what it measured, and the workspace chosen in the palette to open next. */
export interface TuiEnd {
  report: string;
  next?: string;
}

/** How long the cursor rests on an issue before its description and comments are asked for. */
const FEED_DELAY_MS = 150;

const LIST_HELP = helpOf(LIST_KEYS);
/** The keys line while a reply is written (TuiIssueComments). */
const REPLY_KEYS: HomeView["keys"] = [
  ["↵", "send"],
  ["⇧↵", "new line"],
  ["⌃E", "editor"],
  ["Esc", "leave the reply"],
];
const ISSUE_HELP = helpOf(ISSUE_KEYS);

interface Ui {
  selected: number;
  top: number;
  picker: Picker | null;
  /** The palette (/ or Ctrl+K): what is typed in it, the chosen entry and the page it is on; null when it is closed. */
  palette: Palette | null;
  /** The query being typed after f, null when none is; `completion` is the completion picked. */
  input: string | null;
  completion: number;
  message: Seg[];
  /** The ? sheet of the screen under it. */
  help: boolean;
  /** Below 120 columns, whether `i` opened the issue screen's properties above its text; kept from issue to issue. */
  properties: boolean;
  /** The line of a new issue being typed (`c`, `C`), null when none is. */
  create: Creating | null;
  /** A comment being written on the issue screen (`r`), its cursor at `at`; `mention` is the person picked for the `@` being typed. */
  reply: { issueId: string; text: string; at: number; mention: number } | null;
  /** The issue `D` asked to move to the trash, waiting for a yes (RSVA-456); null when nothing is asked. */
  confirm: { issueId: string } | null;
}

/** The issue screen: which issue, what it was opened from, the first body line shown and a page's lines. */
interface Reading {
  id: string;
  from: "list" | "queue";
  top: number;
  page: number;
  /** Where each heading of what scrolls starts, as the last frame laid it out: Tab and Shift+Tab go there. */
  heads?: number[];
}

/** What the screens' keys and the palette act on: the run's state and its moves. */
export interface App {
  readonly store: SyncEngine;
  readonly ui: Ui;
  /** The workspace this run is on. */
  readonly workspace: string;
  /** The workspaces the credential opens, once the server has said which; empty until then. */
  workspaces(): WorkspaceListItem[];
  /** The list as the query leaves it. */
  items(): Item[];
  query(): string;
  /** The list on query `q` from its top, out of the issue screen. */
  setQuery(q: string): void;
  /** The query changed in place: the cursor keeps its issue (an order). */
  changeQuery(q: string): void;
  /** Back to the start query, unless the list is on it. */
  leaveQuery(): void;
  /** The query field, on the query in use. */
  openQuery(): void;
  /** What the queue goes through, named as the head names the list. */
  queueSource(): string;
  startQueue(): void;
  /** The list's rows on screen now. */
  listRows(): number;
  /** The list's cursor on row `at` (kept within the list), scrolled to and its issue followed. */
  selectRow(at: number): void;
  reading(): Reading | null;
  read(id: string, from: Reading["from"]): void;
  /** An issue chosen in the palette, opened with the cursor on it: in this list if it is there, else in its project's. */
  openIssue(id: string): void;
  stopReading(): void;
  /** The issue screen on the next (1) or the previous (-1) issue of the list. */
  step(by: 1 | -1): void;
  /** The issue the keys act on: the issue screen's, else the cursor's. */
  target(): Issue | undefined;
  pickState(issue: Issue): void;
  setState(issue: Issue, st: { id: string; name: string }): void;
  /** To another project (PLNR-448), its sub-issues too when `withSubIssues`. */
  moveIssue(issue: Issue, projectId: string, withSubIssues: boolean): void;
  /** Every write of the list and the issue screen: the change, its line in the status, and its place for `u`. */
  change(issue: Issue, patch: IssueUpdate, what: string): void;
  /** Puts back the last change made here, the fields changed since left alone. */
  undo(): void;
  /** Asks, then moves the issue to the project's trash: its creator or an admin (RSVA-456). */
  remove(issue: Issue): void;
  /** A completed or cancelled issue out of the lists. */
  archive(issue: Issue): void;
  /** Out of the archive or the trash. */
  restore(issue: Issue): void;
  dispatch(issue: Issue): void;
  browse(issue: Issue): void;
  /** The issue's link (y) or its key (Y, the web's ⌘.) to the clipboard. */
  copy(issue: Issue, what: "link" | "key"): void;
  editDescription(issue: Issue): void;
  openPalette(): void;
  /** A page of the issue in the palette: a field (p, a, l), the project to move it to (m), its menu (.). */
  page(issue: Issue, kind: IssuePage): void;
  /** The line of a new issue: in the project of the issue the keys act on; under it with `sub`. */
  newIssue(sub: boolean): void;
  /** A comment on the issue, written under its activity: its draft back if one was left. */
  reply(issue: Issue): void;
  /** The theme picked; showTheme paints another while the palette's theme page tries it. */
  theme(): string;
  pickTheme(id: string): void;
  showTheme(id: string): void;
  /** This run ends and the next opens on workspace `slug`; its own, nothing. */
  switchTo(slug: string): void;
  quit(): void;
}

export async function runTui(api: Client, host: TuiHost): Promise<TuiEnd> {
  // The first run counts from the process's start, as before; a switched-to workspace from the switch.
  const began = host.since ?? 0;
  const { authorizedTransport, createSyncStore } = await import("@rsva/sync");
  const { autorun, observable, reaction, runInAction } = await import("mobx");
  // Node's WebSocket (undici) takes headers: the credential goes as it goes over HTTP, never in the URL.
  const authorization = await api.authorization();
  const link = authorizedTransport(authorization, WebSocket);
  const screenSeq = screenOf(host.env);
  // The issue screen's images (images.ts), in a terminal that draws them: only this server's files, fetched with this
  // run's credential, as the sync engine's requests are.
  const pictures = imagesOn(host.env)
    ? new Pictures(
        serverImages(api.origin, authorization),
        () => frame("remote", performance.now()),
      )
    : null;
  const ui: Ui = { selected: 0, top: 0, picker: null, palette: null, input: null, completion: 0, message: [], help: false, properties: false, create: null, reply: null, confirm: null };
  const say = (text: string, bad = false) => (ui.message = [[text, { fg: bad ? "error" : "ink-2" }]]);
  const store = createSyncStore({
    workspace: api.workspace,
    baseUrl: api.origin,
    disk: host.disk,
    WebSocket: link.WebSocket,
    fetch: link.fetch,
    reload: () => say("the server was updated: restart rsva tui", true),
  });

  const config = await loadConfig();
  const stats = new Stats(began);
  const log = host.env.RSVA_TUI_LOG;
  // The theme: PLNR_THEME if set, else the one last picked in the palette, else Graphite.
  /** The theme picked; the screen shows another only while the palette's theme page tries it. */
  let theme = host.env.PLNR_THEME ?? remembered(host.state).theme ?? "graphite";
  const screen = new GridScreen(process.stdout, themeColours(theme));
  const show = (id: string) => {
    const colours = themeColours(id);
    if (screen.theme === colours) return;
    screen.theme = colours;
    screen.invalidate();
  };
  // The query this workspace was left on; the start query the first time.
  const query = observable.box(remembered(host.state).queries[api.workspace] ?? START_QUERY);
  remember(host.state, (r) => (r.workspace = api.workspace));
  /** The workspaces the palette offers, this one among them, once the server has said which (host.workspaces). */
  let workspaces: WorkspaceListItem[] = [];
  /** The workspace chosen in the palette: the run ends and the next one opens there. */
  let next: string | undefined;
  /** The query being typed, while it parses: the list narrows on every key (TuiQuery). */
  const draft = observable.box<string | null>(null);
  /** The list's length when the query field opened: the field says how many of them its draft leaves. */
  let before = 0;
  /** The issue screen, null on the list; observed, so that its issue's description and comments draw frames. */
  const reading = observable.box<Reading | null>(null, { deep: false });
  const agents = observable.box<ReadonlyMap<string, AgentOn>>(new Map());
  let items: Item[] = [];
  /** Each listed issue's state when the list was made: the rows change in place, so the list keeps what it saw. */
  let states: string[] = [];
  /** The issue under the cursor that a change of state took off its place, and its neighbours there (cursorOn). */
  let left: Left | null = null;
  /** A chord begun on the list or the issue screen (g q, g g). */
  const held: Held = { chord: "" };
  let session = "—";
  void exec("rex", ["session", "inspect", host.env.REX_SESSION ?? "", "--json"])
    .then((out) => (session = (JSON.parse(out) as { label?: string }).label ?? "—"))
    .catch(() => undefined);

  // Keep the cursor on the same issue when the list changes under it, or on its place when its state moved it (cursorOn).
  /** An issue chosen in the palette that the list will hold once its query changes. */
  let pendingSelect: string | null = null;
  const select = (prev: Item[], next: Item[]) => {
    const wanted = pendingSelect && next.some((i) => i.issue.id === pendingSelect) ? pendingSelect : null;
    if (wanted) pendingSelect = null;
    const on = wanted ? { at: next.findIndex((i) => i.issue.id === wanted), left: null } : cursorOn(prev, states, ui.selected, next, (id) => store.issues.get(id)?.stateId);
    if (on.left) left = on.left;
    ui.selected = on.at >= 0 ? on.at : Math.max(0, Math.min(ui.selected, next.length - 1));
    states = next.map((i) => i.issue.stateId);
  };

  const target = (): Issue | undefined => {
    const r = reading.get();
    return r ? store.issues.get(r.id) : items[ui.selected]?.issue;
  };

  const listRows = () => layout(process.stdout.rows, process.stdout.columns).list[1];
  /** The list scrolled to show the cursor. */
  const showCursor = () => (ui.top = scrollTop({ groups: view().groups, selected: ui.selected, top: ui.top }, listRows()));

  // The selected issue's description and comments: asked for once the cursor rests on it, then live like the rest.
  let feedTimer: ReturnType<typeof setTimeout> | undefined;
  const follow = (id: string | undefined) => {
    clearTimeout(feedTimer);
    if (id) feedTimer = setTimeout(() => store.feed(id), FEED_DELAY_MS);
  };

  const selectRow = (at: number) => {
    ui.selected = Math.max(0, Math.min(at, items.length - 1));
    showCursor();
    follow(items[ui.selected]?.issue.id);
  };

  const read = (id: string, from: Reading["from"]) => {
    left = null;
    runInAction(() => reading.set({ id, from, top: 0, page: 1 }));
  };

  /** Back from the issue screen: to the list with the cursor on that issue, or to the queue. */
  const stopReading = () => {
    const r = reading.get();
    if (!r) return;
    const at = items.findIndex((i) => i.issue.id === r.id);
    // An issue that left its place (a dispatch, a state set here): the cursor is already where it was.
    if (r.from === "list" && at >= 0 && left?.id !== r.id) ui.selected = at;
    if (r.from === "list") showCursor();
    left = null;
    runInAction(() => reading.set(null));
  };

  /**
   * The issues before and after `id` in the list, which [ and ] (← and →) open: its neighbours, or, once a change of its
   * state took it off its place, the ones it had there. An issue gone from the list steps from the cursor.
   */
  const around = (id: string): [Item | undefined, Item | undefined] => {
    const find = (x: string | undefined) => (x ? items.find((i) => i.issue.id === x) : undefined);
    if (left?.id === id) return [find(left.prev), find(left.next)];
    const at = items.findIndex((i) => i.issue.id === id);
    const from = at >= 0 ? at : ui.selected;
    return [items[from - 1], items[from + 1]];
  };

  const setQuery = (q: string) => {
    stopReading();
    ui.selected = 0;
    ui.top = 0;
    runInAction(() => query.set(q));
  };

  /** What the queue goes through, named as the head names the list. */
  const queueSource = () => (queryName(query.get()) === "Query" ? query.get() : queryName(query.get()));

  /** A promise's end draws a frame: what it changed (a message, a mark) shows. */
  const later = (p: Promise<unknown>) => void p.finally(() => frame("remote", performance.now()));
  /** The address in the browser; where nothing opens it, the address in the status line to copy. */
  const browser = (url: string) => later(host.open?.(url).then((ok) => (ui.message = ok ? [] : [[url, { fg: "ink-2" }]])) ?? Promise.resolve());

  /** Ends the TUI: Ctrl+C, q anywhere but in a field, Quit in the palette. */
  let quit = () => {};
  /** Replies left with Esc, by issue: `r` brings the draft back while the TUI runs. */
  const drafts = new Map<string, string>();
  /** What this run changed, for `u`. */
  const undo = new Undo();
  /** An issue leaving the lists (the trash, the archive): its screen closes, back to the list where it was. */
  const leave = (issue: Issue) => reading.get()?.id === issue.id && stopReading();

  const app: App = {
    store,
    ui,
    workspace: api.workspace,
    workspaces: () => workspaces,
    items: () => items,
    query: () => query.get(),
    setQuery,
    changeQuery: (q) => runInAction(() => query.set(q)),
    leaveQuery: () => query.get() !== START_QUERY && runInAction(() => query.set(START_QUERY)),
    openQuery() {
      before = items.length;
      ui.input = `${query.get()} `;
      ui.completion = 0;
    },
    queueSource,
    startQueue() {
      stopReading();
      flow.startQueue(
        items.map((i) => i.issue.id),
        queueSource(),
      );
    },
    listRows,
    selectRow,
    reading: () => reading.get(),
    read,
    openIssue(id) {
      const at = items.findIndex((x) => x.issue.id === id);
      if (at >= 0) ui.selected = at;
      else {
        const issue = store.issues.get(id);
        pendingSelect = id;
        setQuery(`project:${(issue && store.projects.get(issue.projectId)?.key) ?? ""}`);
      }
      read(id, "list");
    },
    stopReading,
    step(by) {
      const r = reading.get();
      // The cursor moves with it.
      const to = r && around(r.id)[by > 0 ? 1 : 0];
      if (!to) return;
      ui.selected = items.indexOf(to);
      showCursor();
      read(to.issue.id, "list");
    },
    target,
    pickState(issue) {
      const list = store.statesOf(issue.projectId).map((st) => ({ id: st.id, ...stateMark(store, st) }));
      ui.picker = { states: list, current: issue.stateId, filter: "", at: Math.max(0, list.findIndex((st) => st.id === issue.stateId)) };
    },
    setState(issue, st) {
      if (st.id !== issue.stateId) app.change(issue, { stateId: st.id }, `→ ${st.name}`);
    },
    change(issue, patch, what) {
      const key = store.issueKey(issue);
      undo.record({ id: issue.id, before: beforeOf(issue, patch), after: patch, said: `${key} ${what}` });
      store.updateIssue(issue.id, patch);
      ui.message = [...changed(key, what), [" · u undo", { fg: "ink-3" }]];
    },
    undo() {
      const back = undo.take((id) => store.issues.get(id));
      if (!back) return void say("nothing changed here to undo");
      if (!Object.keys(back.patch).length) return void say(`${back.change.said}: changed since, left as it is`);
      store.updateIssue(back.change.id, back.patch);
      ui.message = [
        ["↺", { fg: "ink-3" }],
        [` undone: ${back.change.said}`, { fg: "ink-2" }],
      ];
    },
    remove(issue) {
      if (!store.mayDelete(issue)) return void say(`${store.issueKey(issue)}: only its creator or an admin deletes it`, true);
      ui.confirm = { issueId: issue.id };
    },
    archive(issue) {
      if (!isClosedGroup(store.states.get(issue.stateId)?.group)) return void say(`${store.issueKey(issue)}: only a completed or cancelled issue is archived`, true);
      leave(issue);
      app.change(issue, { archivedAt: new Date().toISOString() }, "archived");
    },
    restore(issue) {
      if (issue.deletedAt && !store.mayDelete(issue)) return void say(`${store.issueKey(issue)}: only its creator or an admin restores it`, true);
      app.change(issue, { archivedAt: null, ...(issue.deletedAt ? { deletedAt: null } : {}) }, "restored");
    },
    moveIssue(issue, projectId, withSubIssues) {
      const from = store.issueKey(issue);
      const ids = [issue.id, ...(withSubIssues ? subIssuesLeft((id) => store.subIssuesOf(id), [issue.id]).map((i) => i.id) : [])];
      const n = store.moveIssues(ids, projectId);
      const to = store.projects.get(projectId);
      if (n && to) ui.message = changed(from, `→ ${plain(to.key)}${n > 1 ? ` with ${plural(n - 1, "sub-issue")}` : ""}`);
    },
    dispatch(issue) {
      // From the queue's issue screen, as d on the card: back to the queue, which marks the card when it launches.
      const fromQueue = reading.get()?.from === "queue";
      if (fromQueue) stopReading();
      later(flow.startDispatch(issue.id, fromQueue ? "queue" : "list"));
    },
    browse(issue) {
      browser(api.browse(store.issueKey(issue)));
    },
    copy(issue, what) {
      const k = store.issueKey(issue);
      later(
        copyText(exec, what === "key" ? k : api.browse(k)).then(
          () => say(`${k} ${what} copied`),
          (e: unknown) => say(`${k}: not copied: ${errorText(e).split("\n")[0]}`, true),
        ),
      );
    },
    editDescription,
    page(issue, kind) {
      // A new issue has no number yet and one in the trash stays where it is: nowhere to move them (PLNR-448).
      if (kind === "move" && (issue.number === 0 || issue.deletedAt)) return;
      held.chord = "";
      showPage(app, { kind, issue: issue.id });
    },
    reply(issue) {
      if (reading.get()?.id !== issue.id) read(issue.id, "list");
      // At the end, where the newest comments are and the reply goes.
      reading.get()!.top = Number.MAX_SAFE_INTEGER;
      const text = drafts.get(issue.id) ?? "";
      ui.reply = { issueId: issue.id, text, at: text.length, mention: 0 };
    },
    newIssue(sub) {
      const on = target();
      if (sub && !on) return;
      // A panel over the screen it is opened on (RSVA-463): the issue screen stays, Esc comes back to it.
      ui.create = { text: "", projectId: on?.projectId ?? store.projectList()[0]?.id ?? null, parentId: sub ? on!.id : null, description: "", completion: 0 };
    },
    openPalette() {
      // A chord begun before it is dropped, so that the key after it is not taken as its end.
      held.chord = "";
      ui.palette = { query: "", at: 0, page: null };
    },
    theme: () => theme,
    pickTheme(id) {
      theme = id;
      show(id);
      remember(host.state, (r) => (r.theme = id));
    },
    showTheme: show,
    switchTo(slug) {
      if (slug === api.workspace) return;
      next = slug;
      quit();
    },
    quit: () => quit(),
  };

  /** The frame for this moment: the copy, the agents, the cursor, what is being typed. */
  /** An issue's card and properties: the properties computed once, the card said from them. */
  const withDetails = (issue: Issue, now: number) => {
    const details = detailsOf(store, issue, now);
    return { card: cardOf(store, issue, now, details), details };
  };
  const view = (): HomeView => {
    const now = Date.now();
    const q = query.get();
    const issue = items[ui.selected]?.issue;
    const list = [...agents.get().values()];
    const creating = ui.create;
    const draft = creating && store.status === "ready" ? draftOf(store, creating) : null;
    const modeKeys: HomeView["keys"] | null = creating
      ? [
          ["Tab", "complete"],
          ["↵", "create"],
          ["⌃E", "description"],
          ["Esc", "cancel"],
        ]
      : ui.input !== null
        ? [
            ["Tab", "complete"],
            ["↑/↓", "suggestion"],
            ["↵", "apply"],
            ["⌃U", "clear"],
            ["Esc", "cancel"],
          ]
        : ui.picker
          ? [
              ["j/k", "move"],
              [`1–${ui.picker.states.length}`, "pick"],
              ["↵", "set"],
              ["Esc", "back"],
            ]
          : null;
    const picked = target();
    const current = ui.picker && picked ? ui.picker.states.find((st) => st.id === picked.stateId) : undefined;
    const typing = typingNow();
    const message: Seg[] = draft
      ? createMessage(draft, !!typing)
      : ui.reply
        ? replyMessage(ui.reply)
        : current && picked
      ? [[`${store.issueKey(picked)} is ${current.name}`, { fg: "ink-2" }]]
      : typing
        ? [["narrowing as you type · ", { fg: "ink-3" }], ...typing.values.flatMap((v, i): Seg[] => [...(i ? [[" or ", { fg: "ink-3" }] as Seg] : []), [`${typing.key}:${v.text}`, { fg: "ink-2" }]])]
        : (flow.progress() ?? ui.message);
    return {
      head: {
        view: queryName(q),
        workspace: store.me?.kind === "agent" ? `${store.workspace?.name ?? api.workspace} · as ${store.me.email}` : (store.workspace?.name ?? api.workspace),
        count: items.length,
        query: q,
        running: list.filter((a) => a.state === "running").length,
        waiting: list.filter((a) => a.state === "waits").length,
      },
      groups: store.status === "ready" ? rowsOf(store, items, agents.get(), now) : [],
      selected: ui.selected,
      top: ui.top,
      listFocus: ui.input === null && !creating,
      ...(issue ? withDetails(issue, now) : { card: null, details: null }),
      status: { connection: store.connection, message, brief: message.map(([t]) => t).join(""), session, time: new Date(now).toTimeString().slice(0, 5) },
      keys: modeKeys ?? hintsOf(LIST_KEYS, false, app),
      keysNarrow: modeKeys ?? hintsOf(LIST_KEYS, true, app),
    };
  };

  const neighbours = (id: string) => {
    const [prev, next] = around(id).map((i) => (i ? store.issueKey(i.issue) : undefined));
    return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
  };
  /** The issue screen's view; null when its issue is gone (deleted, or out of the copy). */
  const readingView = (r: Reading, status: HomeView["status"], keys?: HomeView["keys"]): IssueView | null => {
    const issue = store.issues.get(r.id);
    if (!issue) return null;
    const now = Date.now();
    const at = items.findIndex((i) => i.issue.id === r.id);
    return {
      source: r.from === "queue" ? "Queue" : queueSource(),
      place: r.from === "list" && at >= 0 ? { at: at + 1, of: items.length, ...neighbours(r.id) } : null,
      ...withDetails(issue, now),
      properties: ui.properties,
      activity: activityOf(store, issue, now),
      top: r.top,
      status,
      keys: keys ?? (ui.reply ? REPLY_KEYS : hintsOf(ISSUE_KEYS, process.stdout.columns < 120, app)),
      ...(ui.reply?.issueId === r.id ? { reply: { text: ui.reply.text, at: ui.reply.at } } : {}),
      ...(pictures ? { picture: (src: string, room: number) => pictures.size(src, room) } : {}),
    };
  };

  /** The word being typed and its completions, from the parser, each with how many issues it would leave. */
  function typingNow(): QueryView["typing"] {
    if (store.status !== "ready") return null;
    const mark = (key: string, value: string) => {
      if (!/^-?state$/.test(key)) return null;
      const st = [...store.states.values()].find((x) => x.name.toLowerCase() === value.toLowerCase());
      return st ? stateMark(store, st) : null;
    };
    // A new issue's line counts nothing: it is not a query of the list.
    if (ui.create) return completionsOf(ui.create.text, lineContext(store, ui.create).ctx, null, mark, ui.create.completion);
    if (ui.input === null) return null;
    return completionsOf(ui.input, contextOf(store), (q) => listOf(store, q).items.length, mark, ui.completion);
  }

  /** The status line while a new issue is typed: why it cannot be created yet, else what Enter creates. */
  function createMessage(d: Draft, typing: boolean): Seg[] {
    if (typing) return [];
    if (d.error) return [[d.error, { fg: "error" }]];
    const where = d.projectId ? store.projects.get(d.projectId)?.key : undefined;
    if (!d.title) return [[HOW, { fg: "ink-3" }]];
    return where ? [["↵ creates it in ", { fg: "ink-3" }], [where, { fg: "ink-2" }]] : [];
  }

  /** The line of a new issue, drawn as the query's: + before it, where it goes at the right. */
  function createView(c: Creating): QueryView {
    const d = draftOf(store, c);
    const parent = c.parentId ? store.issues.get(c.parentId) : undefined;
    const where = d.projectId ? store.projects.get(d.projectId)?.key : undefined;
    const right = parent ? `sub-issue of ${store.issueKey(parent)}` : where ? `new in ${where}` : "new issue";
    return { draft: c.text, right, sign: "+", typing: typingNow(), also: [] };
  }

  /** The query line and its panel: the draft, the count, the completions, other keys to try. */
  function queryView(): QueryView {
    const typing = typingNow();
    // Projects keep labels of the same name: each name once.
    const labels = [...new Set([...store.labels.values()].map((l) => l.name))].slice(0, 8);
    const cycles = [...store.cycles.values()].sort((a, b) => b.number - a.number).map((c) => `C${c.number}`).slice(0, 3);
    const people = [...store.users.values()].map((u) => u.email);
    const also: QueryView["also"] = [
      ["label", labels],
      ["priority", ["urgent", "high", "medium", "low"]],
      ["cycle", [...cycles, "none"]],
      ["assignee", ["me", ...people]],
      // Not a filter: the order within a state (PLNR-401).
      ["order", Object.values(ORDER_WORDS)],
    ];
    return { draft: ui.input ?? "", right: `${items.length} of ${before}`, typing, also: typing ? also.filter(([k]) => k !== typing.key) : also };
  }

  // The queue and the dispatch (flow.ts): the screen is theirs while they run.
  /** Leaves the screen for a program that needs the terminal (the editor, the pager), then comes back to it. */
  const away = (run: () => void) => {
    process.stdin.setRawMode?.(false);
    process.stdout.write(`${pictures?.clear() ?? ""}${screenSeq.off}`);
    run();
    process.stdout.write(screenSeq.on);
    process.stdin.setRawMode?.(true);
    screen.invalidate();
    frame("remote", performance.now());
  };
  /** A text in the person's editor, leaving the screen while it runs; `name` says what it is in the file's name. */
  const edit = (text: string, name: string): string => {
    const file = scratchFile(name, text, host.env);
    away(() => spawnSync(...editorArgv(host.env, file), { stdio: "inherit" }));
    const out = readFileSync(file, "utf8").replace(/\n$/, "");
    unlinkSync(file);
    return out;
  };
  const flow = new Flow({
    store,
    exec,
    config,
    say: (message) => (ui.message = message),
    redraw: () => frame("remote", performance.now()),
    open: (url) => void host.open?.(url),
    browse: (key) => api.browse(key),
    edit: async (text) => edit(text, "context"),
    read: (id) => read(id, "queue"),
    page(text) {
      // The screen is the TUI's: a text printed without a pager would be gone the moment it came back, so none is less here.
      const pager = pagerOf(host.env) ?? pagerOf({ ...host.env, RSVA_PAGER: "less" })!;
      away(() => spawnSync("sh", ["-c", pager.command], { input: text, stdio: ["pipe", "inherit", "inherit"], env: pager.env }));
    },
  });

  /** A panel the person opened (the palette, the picker, the ? sheet) goes as Esc takes it, on a click anywhere outside it. */
  const outside = (g: Grid) => g.zone(0, 0, g.w, g.h, ["esc"]);
  let drawing = Promise.resolve();
  const frame = (why: "key" | "remote" | "start", since: number) => {
    drawing = drawing.then(async () => {
      const size = { columns: process.stdout.columns, rows: process.stdout.rows };
      const v = view();
      const r = reading.get();
      const rv = r && readingView(r, v.status);
      // The issue went (deleted, archived elsewhere): back to where it was opened from.
      if (r && !rv) runInAction(() => reading.set(null));
      const launching = !!flow.dispatching && !flow.dispatching.hidden;
      if (launching || (flow.active && !rv)) {
        // The queue or a dispatch has the screen; a dispatch's panel floats over the list or the issue as they are now.
        // Its steps take keys of their own: no "? all keys".
        const grid = flow.paint(
          size,
          (status, keys) => {
            const under = r && readingView(r, status, keys);
            if (!under) return paintHome({ ...v, status, keys, keysNarrow: keys }, size, "").grid;
            const g = new Grid(size.columns, size.rows);
            paintIssue(g, under, "");
            return g;
          },
          v.status,
        );
        if (ui.help && !launching) {
          dimBehind(grid);
          outside(grid);
          paintHelp(grid, "queue", QUEUE_HELP);
        }
        // A panel floats over the screen: no image over it.
        const bytes = await screen.draw(grid, pictures ? () => pictures.clear() : undefined);
        if (why === "key") stats.frame(why, performance.now() - since, bytes);
        return;
      }
      let grid: Grid;
      let inView: Placement[] = [];
      if (r && rv) {
        grid = new Grid(size.columns, size.rows);
        // ? is a letter of the reply and of a new issue's line: the keys line does not offer it.
        const shown = paintIssue(grid, { ...rv, keys: ui.picker || ui.create ? v.keys : rv.keys }, ui.reply || ui.create ? "" : undefined);
        r.top = shown.top;
        r.page = shown.page;
        r.heads = shown.heads;
        inView = shown.pictures;
      } else {
        // ? is a letter of a new issue's line: the keys line does not offer it.
        const home = paintHome(v, size, ui.input !== null ? "query syntax" : ui.create ? "" : undefined);
        grid = home.grid;
        ui.top = home.top;
      }
      if (ui.input !== null) paintQuery(grid, queryView());
      else if (ui.create) paintCreate(grid, createView(ui.create), store.status === "ready" ? draftCard(store, ui.create, draftOf(store, ui.create), Date.now()) : null);
      const picked = target();
      if (ui.picker && picked) {
        dimBehind(grid);
        outside(grid);
        paintStatePicker(grid, ui.picker, store.issueKey(picked), rv ? issueAnchor(size, rv.card.title) : cardAnchor(size));
      }
      const asked = ui.confirm && store.issues.get(ui.confirm.issueId);
      if (asked) {
        dimBehind(grid);
        outside(grid);
        const lines: Seg[] = [
          [asked.title, { fg: "ink" }],
          ["It goes to the project's trash; u brings it back.", { fg: "ink-3" }],
        ];
        paintConfirm(grid, `Delete ${store.issueKey(asked)}?`, lines, "delete");
      }
      if (ui.help) {
        dimBehind(grid);
        outside(grid);
        paintHelp(grid, rv ? "issue" : "list", rv ? ISSUE_HELP : LIST_HELP);
      }
      if (ui.palette) {
        dimBehind(grid);
        outside(grid);
        paintPalette(grid, paletteView(app, ui.palette));
      }
      // Images are drawn over the cells: under a panel (the query, a picker, the help, the palette) they go.
      const over = ui.input !== null || !!ui.create || !!(ui.picker && picked) || !!asked || ui.help || !!ui.palette;
      const bytes = await screen.draw(grid, pictures ? (changed) => pictures.frame(over ? [] : inView, changed) : undefined);
      const ms = performance.now() - since;
      stats.frame(why, ms, bytes);
      if (log) appendFileSync(log, `${JSON.stringify({ at: Date.now(), why, ms: Number(ms.toFixed(2)), bytes, lastSyncId: store.lastSyncId, ...size })}\n`);
    }).catch((e: unknown) => {
      // A frame that throws is said in the status line; the frames after it still draw.
      ui.message = [[`drawing failed: ${errorText(e).split("\n")[0]}`, { fg: "error" }]];
    });
  };

  const stopAgents = watchAgents({
    store,
    config,
    set: (map) => runInAction(() => agents.set(map)),
    size: () => agents.get().size,
    say(message) {
      ui.message = message;
      frame("remote", performance.now());
    },
  });

  process.stdout.write(screenSeq.on);
  frame("start", 0);
  // Any change the view reads (the issues, the connection, a refusal, the query, the agents) draws a frame; several in
  // one tick draw one.
  let pending = false;
  // The query is remembered between starts: the next one opens where this one was left.
  const keepQuery = reaction(
    () => query.get(),
    (q) => remember(host.state, (r) => (r.queries[api.workspace] = q)),
  );
  const stop = autorun(() => {
    const listed = store.status === "ready" ? listOf(store, draft.get() ?? query.get()) : { items: [], error: null };
    if (listed.error) say(listed.error, true);
    const rejected = store.lastRejection;
    if (rejected) say(`refused: ${rejected.message}`, true);
    const prev = items;
    items = listed.items;
    select(prev, items);
    agents.get();
    // Read here so that a description, a state or a person changing draws a frame.
    const issue = items[ui.selected]?.issue;
    if (issue) cardOf(store, issue, Date.now());
    const r = reading.get();
    const shown = r && store.issues.get(r.id);
    if (shown) {
      cardOf(store, shown, Date.now());
      activityOf(store, shown, Date.now());
    }
    store.connection;
    if (store.status === "ready") stats.loaded();
    if (pending) return;
    pending = true;
    const since = performance.now();
    setImmediate(() => {
      pending = false;
      follow(items[ui.selected]?.issue.id);
      frame("remote", since);
    });
  });
  void store.start();
  // A failure leaves the palette without other workspaces: the one open still works.
  host.workspaces?.().then(
    (list) => (workspaces = list),
    () => undefined,
  );

  const onResize = () => {
    screen.invalidate();
    frame("remote", performance.now());
  };
  process.stdout.on("resize", onResize);

  /** Whether the keys are letters of a field (the query, a picker's filter, the palette, a dispatch's context) or an answer to a question. */
  const typed = () => {
    const d = flow.dispatching;
    return ui.input !== null || !!ui.create || !!ui.reply || !!ui.picker || !!ui.palette || !!ui.confirm || (!!d && !d.hidden && d.step === "context");
  };

  await new Promise<void>((done) => {
    const keysOf = keyReader();
    const onKey = (data: Buffer) => {
      const since = performance.now();
      // A click is the keys of what it lands on, as the frame on screen marks them (Grid.zone); on nothing, none. While
      // a field takes the typing, a click on a property's line (s, p) behind it is no letter typed (RSVA-479).
      const keys = keysOf(data.toString()).flatMap((key) => {
        const click = /^click:(\d+):(\d+)$/.exec(key);
        return click ? screen.keysAt(Number(click[1]), Number(click[2])).filter((k) => !typed() || !isText(k)) : [key];
      });
      for (const key of keys) {
        // q quits from every screen; in a field it is a letter, after g it is the queue.
        if (key === "ctrl-c" || (key === "q" && !typed() && !held.chord)) return quit();
        handle(key);
      }
      frame("key", since);
    };
    quit = () => {
      process.stdin.off("data", onKey);
      done();
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });

  /** A key: to the panel open over the screen (the ? sheet, the queue, the palette, the query, the picker), else the screen's table. */
  function handle(key: string): void {
    const r = reading.get();
    const launching = !!flow.dispatching && !flow.dispatching.hidden;
    if (ui.confirm) return confirmKey(ui.confirm, key);
    if (ui.help) {
      if (key === "?" || key === "esc") ui.help = false;
      return;
    }
    // ? is a letter in a field; the launch's steps have every key in their line.
    if (key === "?" && !launching && !typed()) {
      ui.help = true;
      return;
    }
    // The issue screen over the queue takes the keys until it is closed; a dispatch begun from it takes them first.
    if ((launching || !r) && flow.key(key)) return;
    if (ui.palette) return paletteKey(app, ui.palette, key);
    // Ctrl+K opens the palette from anywhere, a field too; / only where it is not a letter typed (the screens' tables).
    if (key === "ctrl-k") return app.openPalette();
    if (ui.create) return createKey(ui.create, key);
    if (ui.reply) return replyKey(ui.reply, key);
    if (ui.input !== null) return queryKey(ui.input, key);
    if (ui.picker) return pickerKey(ui.picker, key);
    // A click on a link or a pull request opens it in the browser; on an issue's key, that issue (RSVA-479).
    const link = /^open:(.+)$/s.exec(key);
    const to = /^issue:(.+)$/.exec(key);
    if (link || to) {
      held.chord = "";
      // Only http and https: an address in someone's text could name another app's scheme or a file.
      if (link) {
        const url = cleanUrl(link[1]!);
        if (url) browser(url);
        else say(`not a web address: ${plain(link[1]!)}`, true);
        return;
      }
      // Its screen over where this one came from, the list's query left as it is.
      const issue = store.issueByKey(to![1]!);
      if (issue) read(issue.id, r?.from ?? "list");
      else say(`${plain(to![1]!)} is not in this workspace`, true);
      return;
    }
    // A click on a row selects it; on the selected row, opens it.
    const row = !r && /^row:(\d+)$/.exec(key);
    if (row && items[Number(row[1])]) {
      held.chord = "";
      const at = Number(row[1]);
      if (at === ui.selected) read(items[at]!.issue.id, "list");
      else selectRow(at);
      return;
    }
    press(r ? ISSUE_KEYS : LIST_KEYS, app, key, held);
  }

  /**
   * The reply's keys: ↵ sends, ⇧↵ (⌥↵) a new line, Tab completes the `@` being typed before the cursor, ⌃E the editor,
   * Esc leaves it with its draft; the rest are the field's, at the cursor (RSVA-465).
   */
  function replyKey(p: NonNullable<Ui["reply"]>, key: string): void {
    const at = mentionAt(p.text.slice(0, p.at), store.users.values());
    const moved = at ? cursorKey(p.mention, key, at.people.length) : null;
    if (key === "esc") {
      if (p.text.trim()) drafts.set(p.issueId, p.text);
      else drafts.delete(p.issueId);
      ui.reply = null;
    } else if (moved !== null) p.mention = moved;
    else if (at && key === "tab") {
      Object.assign(p, complete(p, at, at.people[Math.min(p.mention, at.people.length - 1)]!));
      p.mention = 0;
    } else if (key === "enter") send(p);
    else if (key === "ctrl-e") {
      p.text = edit(p.text, "comment").slice(0, COMMENT_MAX);
      p.at = p.text.length;
    } else {
      const f = editField(p, key, true, COMMENT_MAX);
      if (f === null) return;
      if (f.text !== p.text) p.mention = 0;
      Object.assign(p, f);
    }
  }

  /** The comment on its issue, through the engine at once; the screen goes to its end, where it shows. */
  function send(p: NonNullable<Ui["reply"]>): void {
    const issue = store.issues.get(p.issueId);
    const body = bodyOf(p.text, store.users.values());
    if (!issue || !body) return void say("write the comment first", true);
    store.addComment(issue.id, body);
    drafts.delete(issue.id);
    ui.reply = null;
    const r = reading.get();
    if (r) r.top = Number.MAX_SAFE_INTEGER;
    ui.message = changed(store.issueKey(issue), "comment sent");
  }

  /** The status line while a reply is written: the people the `@` being typed may be, the picked one lit. */
  function replyMessage(p: NonNullable<Ui["reply"]>): Seg[] {
    const at = mentionAt(p.text.slice(0, p.at), store.users.values());
    if (!at) return ui.message;
    const picked = Math.min(p.mention, at.people.length - 1);
    return [
      ["Tab mentions ", { fg: "ink-3" }],
      ...at.people.flatMap((u, i): Seg[] => [...(i ? [["  ", {}] as Seg] : []), [`@${u.email}`, i === picked ? { fg: "accent-text", at: "B" } : { fg: "ink-2" }]]),
    ];
  }

  /** A new issue's line: completions as the query's, Enter creates, ⌃E the description in $EDITOR, Esc keeps nothing. */
  function createKey(c: Creating, key: string): void {
    const typing = typingNow();
    const at = cursorKey(c.completion, key, typing?.values.length ?? 1);
    if (key === "esc") ui.create = null;
    else if (at !== null) c.completion = at;
    else if ((key === "tab" || key === "enter") && typing) {
      c.text = `${c.text.slice(0, typing.start)}${typing.values[typing.at]!.text} `;
      c.completion = 0;
    } else if (key === "enter") createFrom(c);
    else if (key === "ctrl-e") c.description = edit(c.description, "description");
    else {
      const text = edited(c.text, key);
      if (text === null) return;
      c.text = text;
      c.completion = 0;
    }
  }

  /** The issue the line describes, created through the engine at once; the cursor goes to it when the list shows it. */
  function createFrom(c: Creating): void {
    const d = draftOf(store, c);
    if (d.error) return void say(d.error, true);
    if (!d.title) return void say("type a title first", true);
    const { projectId, set } = d;
    if (!projectId || !set.stateId) return void say("the project has no states", true);
    const doc = c.description.trim() ? (fromMarkdown(c.description) as DocJSON) : null;
    const issue = store.createIssue(projectId, { ...set, stateId: set.stateId, title: d.title }, doc);
    ui.create = null;
    // Undone, a new issue goes to the trash: its creator may put it there.
    undo.record({ id: issue.id, before: { deletedAt: new Date().toISOString() }, after: { deletedAt: null }, said: `created "${d.title}"` });
    const where = store.projects.get(projectId)?.key ?? "";
    const shown = listOf(store, query.get()).items.some((i) => i.issue.id === issue.id);
    if (shown) pendingSelect = issue.id;
    ui.message = [
      ["✓", { fg: "success" }],
      [` created in ${where}: ${d.title}${shown ? "" : " · this list does not show it"}`, { fg: "ink-2" }],
      [" · u undo", { fg: "ink-3" }],
    ];
  }

  /** The query field's keys: completions, apply, cancel, the text. */
  function queryKey(input: string, key: string): void {
    const typing = typingNow();
    const set = (text: string) => {
      ui.input = text;
      ui.completion = 0;
      // The list follows the draft while it parses; a word still being typed keeps the last list that did.
      if (!listOf(store, text).error) runInAction(() => draft.set(text));
    };
    const at = cursorKey(ui.completion, key, typing?.values.length ?? 1);
    if (key === "esc") {
      ui.input = null;
      runInAction(() => draft.set(null));
    } else if (at !== null) ui.completion = at;
    else if ((key === "tab" || key === "enter") && typing) {
      const v = typing.values[typing.at]!;
      set(`${input.slice(0, typing.start)}${v.text} `);
    } else if (key === "enter") {
      const q = input.trim() || START_QUERY;
      ui.input = null;
      ui.message = [];
      ui.selected = 0;
      ui.top = 0;
      runInAction(() => {
        draft.set(null);
        query.set(q);
      });
    } else {
      const text = edited(input, key);
      if (text !== null) set(text);
    }
  }

  /** The question before the trash: y or ↵ moves the issue there, Esc or n leaves it; another key is no answer. */
  function confirmKey(c: NonNullable<Ui["confirm"]>, key: string): void {
    if (key === "esc" || key === "n") ui.confirm = null;
    else if (key === "y" || key === "enter") {
      ui.confirm = null;
      const issue = store.issues.get(c.issueId);
      if (!issue || issue.deletedAt) return;
      leave(issue);
      app.change(issue, { deletedAt: new Date().toISOString() }, "moved to the trash");
    }
  }

  /** The state picker's keys: j and k move while nothing is typed, then they are letters of the filter; arrows always move. */
  function pickerKey(p: Picker, key: string): void {
    const list = shown(p);
    const at = cursorKey(p.at, key, list.length, !p.filter);
    if (at !== null) p.at = at;
    else if (/^[1-9]$/.test(key) && !p.filter) p.at = Math.max(0, list.findIndex((x) => x.n === Number(key)));
    else if (key === "esc") ui.picker = null;
    else if (key === "enter") {
      const issue = target();
      const st = list[p.at]?.st;
      ui.picker = null;
      if (issue && st) app.setState(issue, st);
    } else {
      const filter = edited(p.filter, key);
      if (filter === null) return;
      p.filter = filter;
      p.at = 0;
    }
  }

  /**
   * The description in the person's editor, as `rsva edit`: saved through the engine when it changed, refused when the
   * copy is behind, so that it does not go over newer text; a save the server refuses (the text moved on) says so.
   */
  function editDescription(issue: Issue): void {
    const k = store.issueKey(issue);
    const feed = store.feed(issue.id);
    const doc = store.description(issue.id);
    if (doc === undefined || feed.status === "loading") return void say(`${k}: the description is still loading`);
    if (feed.behind) return void say(`${k}: the copy is behind the server, try again in a moment`, true);
    const before = doc.doc ? toMarkdown(doc.doc as DocNode) : "";
    const after = edit(before, "description");
    if (after.trim() === before.trim()) return void say(`${k}: the description did not change`);
    store.updateDescription(issue.id, fromMarkdown(after) as DocJSON, doc.tx ?? null);
    say(`${k}: description saved`);
  }

  // A launch on its way finishes first: its writes to the planner (In Progress, the delegate) need the store.
  if (flow.dispatching?.running) {
    ui.message = [["waiting for the launch to finish…", { fg: "ink-2" }]];
    frame("key", performance.now());
    await flow.settled();
  }
  stop();
  keepQuery();
  stopAgents();
  clearTimeout(feedTimer);
  await drawing;
  process.stdout.off("resize", onResize);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  process.stdout.write(`${pictures?.free() ?? ""}${screenSeq.off}`);
  await store.persist();
  store.dispose();

  const report = stats.report();
  return next ? { report, next } : { report };
}
