// The home screen, as the design canvas draws it (TuiHome, 120×36; the TUI notes artboard for the cells): the head
// line, the list grouped by state, the selected issue's card, the status line and the keys. `paintHome` takes a view
// (what to show, already worded) and paints it into a Grid; `home-view.ts` makes the view from the copy. The test holds
// the painted grid against the artboard, cell by cell.
import { plural } from "@rsva/schema/util";
import { mark, paintKeys, paintStatus, paintStatusNarrow, type Status } from "./bars.ts";
import { layoutDescription, MEASURE } from "./description.ts";
import { widthOf } from "@rsva/terminal/width";
import { Grid } from "./grid.ts";
import type { IssueDetails } from "./issue.ts";
import { briefLine, paintProperties, panelWidth } from "./properties.ts";
import type { Token } from "./theme.ts";
import { box, labels, listRow, priority, segs, stateLine, type LabelMark, type Priority, type Seg, type StateMark } from "./widgets.ts";

/** `text` for 120 columns ("opus 4m"), `short` for 80 ("4m", "waits"). */
export type AgentMark = { state: "running" | "waits" | "idle" | "done" | "failed"; text: string; short: string };

export interface Row {
  key: string;
  priority: Priority;
  cycle: string | null;
  title: string;
  labels: LabelMark[];
  agent: AgentMark | null;
}

export interface Group {
  state: StateMark;
  rows: Row[];
}

/** One field of the card: a label and the lines of its value. */
export interface Field {
  label: string;
  lines: Seg[][];
}

export interface Card {
  key: string;
  title: string;
  state: StateMark;
  priority: Priority;
  cycle: { name: string; dates: string } | null;
  updated: string | null;
  fields: Field[];
  /** The description as Markdown: `layoutDescription` lays it out for the card's column. */
  description: string;
  /** The keys in its top border, when not an issue's (o, e, y; ↵ open folded): a new issue's ↵ create. */
  actions?: [string, string][];
  /** The card folded at 80 columns: one line of who and what is linked. */
  brief: { labels: LabelMark[]; assignee: string | null; pr: { number: number; state: string; checks: "pass" | "fail" | "run" | null } | null; parent: string | null; relations: number };
}

export interface HomeView {
  head: { view: string; workspace: string; count: number; query: string; running: number; waiting: number };
  groups: Group[];
  /** Index of the selected row, counting every group's rows in order. */
  selected: number;
  /** First list row on the screen (the list's own lines: headers, rows, blanks). */
  top: number;
  /** Whether the keys go to the list: the cursor's bar is the signal colour then, ink-3 while a query is typed. */
  listFocus?: boolean;
  card: Card | null;
  /** The card's properties panel (PLNR-398): what the issue screen's panel shows. Without it the description is alone. */
  details?: IssueDetails | null;
  status: Status;
  keys: [key: string, does: string][];
  /** The keys at 80 columns: fewer; ? lists the rest. */
  keysNarrow: [key: string, does: string][];
}

const AGENT: Record<AgentMark["state"], [glyph: string, glyphTone: Token, textTone: Token]> = {
  running: ["●", "ink", "ink-2"],
  waits: ["◐", "accent", "accent-text"],
  idle: ["○", "ink-3", "ink-3"],
  done: ["✓", "success", "ink-2"],
  failed: ["✕", "error", "error"],
};

function agent(g: Grid, x: number, y: number, a: AgentMark, end: number, bg?: Token): void {
  const [glyph, tone, text] = AGENT[a.state];
  g.text(x, y, glyph, { fg: tone, bg });
  g.text(x + 1, y, ` ${a.text}`, { fg: text, bg }, end);
}

/** A query: `key:` in ink-3, its value in ink-2. */
function query(g: Grid, x: number, y: number, q: string, end: number, bg: Token): number {
  for (const [n, term] of q.split(" ").entries()) {
    const sep = n ? " " : "";
    const m = /^(-?[a-z]+:)(.*)$/.exec(term);
    if (m) {
      x = g.text(x, y, `${sep}${m[1]}`, { fg: "ink-3", bg }, end);
      x = g.text(x, y, m[2]!, { fg: "ink-2", bg }, end);
    } else x = g.text(x, y, `${sep}${term}`, { fg: "ink-2", bg }, end);
  }
  return x;
}

/** The head's "/ query" from x, ending before `end`: a click on it edits the query, as f does (RSVA-479). */
function headQuery(g: Grid, x: number, q: string, end: number, bg: Token): void {
  query(g, g.text(x, 0, "/", { fg: "faint", bg }) + 2, 0, q, end, bg);
  g.zone(x, 0, end - x, 1, ["f"]);
}

// ── The screen ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a list row's columns start at 120 cells, as TuiHome has them: key, priority 3, cycle, title 50, labels 26, agent. */
const COL = { key: 2, priority: 12, cycle: 17, title: 22, labels: 74, agent: 102, end: 118 } as const;

/**
 * The columns in a window `w` cells wide: as TuiHome's at 120; past it the title takes the rest and the labels and the
 * agent move right with it, so a wide window is not left empty on the right (PLNR-331).
 */
function columns(w: number) {
  const more = Math.max(0, w - 120);
  return { ...COL, titleWidth: 50 + more, labels: COL.labels + more, agent: COL.agent + more, end: COL.end + more };
}

/** The list's lines: a header per group, its rows, a blank line between groups. */
type Line = { kind: "header"; group: Group } | { kind: "row"; row: Row; index: number } | { kind: "blank" };

function listLines(groups: Group[]): Line[] {
  const out: Line[] = [];
  let index = 0;
  groups.forEach((group, n) => {
    if (n) out.push({ kind: "blank" });
    out.push({ kind: "header", group });
    for (const row of group.rows) out.push({ kind: "row", row, index: index++ });
  });
  return out;
}

/** The first list line to show so that the selected row is on screen, with its header when it fits. */
export function scrollTop(view: Pick<HomeView, "groups" | "selected" | "top">, height: number): number {
  const lines = listLines(view.groups);
  const at = lines.findIndex((l) => l.kind === "row" && l.index === view.selected);
  if (at < 0) return 0;
  let top = Math.min(view.top, at);
  if (at >= top + height) top = at - height + 1;
  if (at > 0 && lines[at - 1]!.kind === "header" && at - 1 < top) top = at - 1;
  return top;
}

/** The start of a row at any width: the cursor row's ground and bar, the key, the priority. Returns the row's ground. */
function rowStart(g: Grid, y: number, row: Row, index: number, selected: boolean, focus = true): Token | undefined {
  // A click selects the row, a click on the selected row opens it (app.ts).
  const bg = listRow(g, 0, y, g.w, selected, [`row:${index}`], undefined, focus ? "accent" : "ink-3");
  g.text(COL.key, y, row.key, { fg: selected ? "ink" : "ink-3", bg }, COL.priority - 1);
  priority(g, COL.priority, y, row.priority, bg);
  return bg;
}

function paintRow(g: Grid, y: number, row: Row, index: number, selected: boolean, focus?: boolean): void {
  const bg = rowStart(g, y, row, index, selected, focus);
  const col = columns(g.w);
  if (row.cycle) g.text(col.cycle, y, row.cycle, { fg: "ink-3", bg }, col.title - 2);
  else g.text(col.cycle, y, "—", { fg: "faint", bg });
  g.text(col.title, y, row.title, { fg: "ink", bg }, col.title + col.titleWidth);
  labels(g, col.labels, y, row.labels, col.agent - 2, bg);
  if (row.agent) agent(g, col.agent, y, row.agent, col.end, bg);
}

function paintList(g: Grid, view: HomeView, from: number, height: number, paint: typeof paintRow, end: number): number {
  const lines = listLines(view.groups);
  const top = scrollTop(view, height);
  lines.slice(top, top + height).forEach((l, i) => {
    const y = from + i;
    if (l.kind === "header") {
      const { state } = l.group;
      let x = g.text(2, y, state.glyph, { fg: state.tone });
      x = g.text(x + 1, y, state.name, { fg: "ink", at: "B" });
      x = g.text(x + 2, y, String(l.group.rows.length), { fg: "ink-3" });
      g.run(x + 2, y, "─", end - x - 2, { fg: "rule-strong" });
    } else if (l.kind === "row") {
      paint(g, y, l.row, l.index, l.index === view.selected, view.listFocus ?? true);
    }
  });
  return top;
}

const DOT: Seg = ["  ·  ", { fg: "faint" }];

/**
 * A resting panel across the screen, `h` rows from `top`: the key in its top border, its actions at the border's right,
 * and in the bottom one how many lines are left below, ending at `end`: under what it counts, not under a panel beside it.
 */
function cardBox(g: Grid, top: number, h: number, key: string, actions: [string, string][], more = 0, end = g.w - 2): void {
  const note = more ? { text: ` ↓ ${plural(more, "more line")} `, pen: { fg: "ink-3" }, end } as const : undefined;
  box(g, 1, top, g.w - 2, h, { pen: { fg: "rule-strong" }, title: [key, { fg: "ink-3" }], actions, note });
}

/** The card's line of state: the state, the priority, the cycle with its dates, when it was updated. */
function cardMeta(g: Grid, x: number, y: number, card: Card, end: number): void {
  let mx = segs(g, x, y, stateLine(card.state, card.priority, DOT), end);
  if (card.cycle) mx = segs(g, mx, y, [DOT, [card.cycle.name, { fg: "ink-2" }], [` ${card.cycle.dates}`, { fg: "ink-3" }]], end);
  if (card.updated) segs(g, mx, y, [DOT, [card.updated, { fg: "ink-3" }]], end);
}

/** What the card's top border offers, as the issue screen's does: the keys work on the list and on that screen. */
const CARD_ACTIONS: [string, string][] = [
  ["o", "browser"],
  ["e", "edit"],
  ["y", "copy link"],
];

/**
 * The card: a resting panel with the key in its border; the title, a line of state and the description on the left, the
 * issue screen's properties panel on the right (PLNR-398: the fields were on the left and the description on the right,
 * the other way round from the issue screen). The description keeps the issue screen's measure.
 */
function paintCard(g: Grid, card: Card, details: IssueDetails | null | undefined, top: number, height: number, lead = 0): void {
  const left = 1;
  const right = g.w - 2;
  const bottom = top + height - 1;
  const x = left + 2;
  const rule = details ? right - panelWidth(g.w) : right;
  const end = rule - 2;
  const room = Math.min(end - x, MEASURE);
  // What is in the border: under its top, `lead` rows are left to the caller (a new issue's line).
  const c = top + lead;
  // The bottom border, with how much of the description is left below.
  const desc = layoutDescription(card.description, room);
  const rows = bottom - (c + 4);
  cardBox(g, top, height, card.key, card.actions ?? CARD_ACTIONS, Math.max(0, desc.length - rows), details ? rule : right);
  // Title and the state line.
  g.text(x, c + 1, card.title, { fg: "ink", at: "B" }, end);
  cardMeta(g, x, c + 2, card, end);
  desc.slice(0, rows).forEach((d, i) => {
    const y = c + 4 + i;
    if (d.ground) g.fill(x, y, room, 1, d.ground);
    segs(g, x, y, d.segs, x + room);
  });
  // The panel beside it, from the title down, as on the issue screen; e edit is in the card's border already.
  if (details) paintProperties(g, card, details, { rule, from: c + 1, bottom, end: right - 1 }, false, "↵ opens the issue");
}

function paintHead(g: Grid, h: HomeView["head"]): void {
  const bg: Token = "sidebar";
  let x = g.text(mark(g), 0, `  ${h.view}`, { fg: "ink", bg });
  x = g.text(x, 0, `  ${h.workspace} · ${plural(h.count, "issue")}`, { fg: "ink-3", bg });
  // The agents at the right; the query takes what is left, cut before it touches them.
  const waiting = h.waiting ? ` ${h.waiting} waits for you` : "";
  const running = h.running ? ` ${h.running} running` : "";
  let rx = g.w - 1 - (waiting ? 1 + widthOf(waiting) : 0) - (running && waiting ? 3 : 0) - (running ? 1 + widthOf(running) : 0);
  const agentsAt = rx;
  if (running) {
    rx = g.text(rx, 0, "●", { fg: "ink", bg });
    rx = g.text(rx, 0, running, { fg: "ink-2", bg });
    if (waiting) rx += 3;
  }
  if (waiting) {
    rx = g.text(rx, 0, "◐", { fg: "accent", bg });
    g.text(rx, 0, waiting, { fg: "accent-text", bg });
  }
  headQuery(g, x + 3, h.query, agentsAt - 2, bg);
}


/** Below 120 columns or 30 rows the screen is the narrow one (TuiHome80): fewer columns, the card folded. */
const isNarrow = (columns: number, rows: number) => columns < 120 || rows < 30;

/** Rows of the screen at this size (the notes artboard): the card keeps 17 rows until 50, then grows with the list. */
export function layout(rows: number, columns = 120): { list: [from: number, height: number]; card: [top: number, height: number] | null } {
  const status = rows - 2;
  if (rows < 20) return { list: [2, status - 2], card: null };
  // Narrow (TuiHome80): the card folds to five rows right under the list, one blank row before the status.
  if (isNarrow(columns, rows)) return { list: [2, status - 8], card: [status - 6, 5] };
  const card = rows >= 50 ? Math.floor((rows - 4) * 0.47) : 17;
  return { list: [2, status - card - 3], card: [status - card, card] };
}

// ── 80 columns (TuiHome80) ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a row's columns start at 80 after the key and the priority (as at 120): title 51, agent as a glyph and a word.
 * The agent stays 10 cells from the right edge and the title takes what is left before it, so a window between 80 and
 * 119 cells does not cut titles with room to spare.
 */
const NARROW = { title: 17, agentFromRight: 10 } as const;

function paintRowNarrow(g: Grid, y: number, row: Row, index: number, selected: boolean, focus?: boolean): void {
  const bg = rowStart(g, y, row, index, selected, focus);
  const agentAt = g.w - NARROW.agentFromRight;
  g.text(NARROW.title, y, row.title, { fg: "ink", bg }, agentAt - 2);
  if (row.agent) {
    const [glyph, tone, text] = AGENT[row.agent.state];
    g.text(agentAt, y, glyph, { fg: tone, bg });
    g.text(agentAt + 2, y, row.agent.short, { fg: text, bg }, g.w - 2);
  }
}

function paintHeadNarrow(g: Grid, h: HomeView["head"]): void {
  const bg: Token = "sidebar";
  let x = g.text(mark(g), 0, `  ${h.view} · ${h.count}`, { fg: "ink", bg });
  // The agents as counts at the right.
  const parts: [string, Token, string, Token][] = [];
  if (h.running) parts.push(["●", "ink", String(h.running), "ink-2"]);
  if (h.waiting) parts.push(["◐", "accent", String(h.waiting), "accent-text"]);
  const used = parts.reduce((n, [, , c], i) => n + (i ? 2 : 0) + 2 + c.length, 0);
  let rx = g.w - 1 - used;
  const agentsAt = rx;
  parts.forEach(([glyph, tone, count, countTone], i) => {
    if (i) rx += 2;
    rx = g.text(rx, 0, glyph, { fg: tone, bg });
    rx = g.text(rx + 1, 0, count, { fg: countTone, bg });
  });
  headQuery(g, x + 3, h.query, agentsAt - 2, bg);
}

/** The card folded: the title, a line of state, priority, cycle and labels, a line of who and what is linked. */
function paintCardFolded(g: Grid, card: Card, top: number, lead = 0): void {
  cardBox(g, top, 5 + lead, card.key, card.actions ?? [["↵", "open"]]);
  const c = top + lead;
  const inner = { x: 3, end: g.w - 3 };
  g.text(inner.x, c + 1, card.title, { fg: "ink", at: "B" }, inner.end);
  const dot: Seg = [" · ", { fg: "faint" }];
  const y2 = c + 2;
  let mx = segs(g, inner.x, y2, stateLine(card.state, card.priority, dot), inner.end);
  if (card.cycle) mx = segs(g, mx, y2, [dot, [card.cycle.name, { fg: "ink-2" }]], inner.end);
  if (card.brief.labels.length) {
    mx = segs(g, mx, y2, [dot], inner.end);
    labels(g, mx, y2, card.brief.labels, inner.end);
  }
  segs(g, inner.x, c + 3, briefLine(card), inner.end);
}

/**
 * The card as a panel over the screen from `top` (RSVA-463: a new issue's), `lead` rows free under its top border for
 * what the caller puts there: the list's card at this size, folded where the list's is. Returns its height.
 */
export function paintCardPanel(g: Grid, card: Card, details: IssueDetails | null, top: number, lead: number): number {
  const wide = !isNarrow(g.w, g.h) && layout(g.h, g.w).card;
  const h = (wide ? wide[1] : 5) + lead;
  // Its ground is a panel's, and what is behind it takes no click.
  g.fill(1, top, g.w - 2, h, "panel");
  g.zone(1, top, g.w - 2, h, []);
  if (wide) paintCard(g, card, details, top, h, lead);
  else paintCardFolded(g, card, top, lead);
  return h;
}

/** Where a panel over the card starts: inside the card, under its title and state line (TuiStatePicker). */
export function cardAnchor(size: { columns: number; rows: number }): { x: number; y: number } {
  const card = layout(size.rows, size.columns).card;
  return { x: 3, y: card ? card[0] + 3 : 2 };
}

export function paintHome(view: HomeView, size: { columns: number; rows: number }, allKeys?: string): { grid: Grid; top: number } {
  const g = new Grid(size.columns, size.rows);
  const narrow = isNarrow(size.columns, size.rows);
  const l = layout(size.rows, size.columns);
  if (narrow) paintHeadNarrow(g, view.head);
  else paintHead(g, view.head);
  const top = paintList(g, view, ...l.list, narrow ? paintRowNarrow : paintRow, narrow ? g.w - 2 : columns(g.w).end);
  if (view.card && l.card) {
    if (narrow) paintCardFolded(g, view.card, l.card[0]);
    else paintCard(g, view.card, view.details, ...l.card);
  }
  if (narrow) paintStatusNarrow(g, size.rows - 2, view.status);
  else paintStatus(g, size.rows - 2, view.status);
  paintKeys(g, size.rows - 1, narrow ? view.keysNarrow : view.keys, allKeys ?? (narrow ? "keys" : "all keys"));
  return { grid: g, top };
}
