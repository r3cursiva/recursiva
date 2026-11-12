// Floating panels over a screen, as the design canvas draws them (TuiStatePicker, the component sheet): a panel
// (widgets.ts) with the screen behind it redrawn faint (a terminal has no shadows). The status line and the keys stay as
// they are.
import { widthOf } from "@rsva/terminal/width";
import type { Grid } from "./grid.ts";
import { paintCardPanel, type Card } from "./home.ts";
import type { IssueDetails } from "./issue.ts";
import { paintQuery, type QueryView } from "./query.ts";
import { centre, inputLine, listRow, panel, scrollWindow, type Seg, type StateMark } from "./widgets.ts";

/** Grounds that stay behind a panel; any other (the cursor row, a key cap, the urgent tile) goes back to the screen's. */
const KEPT = new Set(["ground", "sidebar", "panel", "code"]);

/** Everything above the status line goes faint, and takes no click: the status line and the keys stay as they are. */
export function dimBehind(g: Grid): void {
  g.zone(0, 0, g.w, g.h - 2, []);
  for (let i = 0; i < g.w * (g.h - 2); i++) {
    const c = g.cells[i]!;
    c.fg = "faint";
    c.at = c.at.replace(/[BD]/g, "");
    if (!KEPT.has(c.bg)) c.bg = "ground";
  }
}

export interface Picker {
  /** The issue's project's states, in the project's order. */
  states: (StateMark & { id: string })[];
  /** The issue's state now. */
  current: string;
  /** What is typed to narrow the list. */
  filter: string;
  /** Index into `shown(picker)`. */
  at: number;
}

/** The states the filter leaves, with their numbers in the whole list (the number keys jump by them). */
export function shown(p: Picker): { st: Picker["states"][number]; n: number }[] {
  const f = p.filter.trim().toLowerCase();
  return p.states.map((st, i) => ({ st, n: i + 1 })).filter(({ st }) => !f || st.name.toLowerCase().includes(f));
}

/**
 * The state picker over the card (TuiStatePicker): a filter field, the states numbered, the cursor's row lit, the
 * issue's state marked "current ✓". At `anchor`, the card's first free row; where it does not fit, as high as it does.
 */
export function paintStatePicker(g: Grid, p: Picker, key: string, anchor: { x: number; y: number }): void {
  const list = shown(p);
  const w = Math.min(36, g.w - anchor.x - 1);
  // A project may have more states than the screen has rows: the panel stops above the status line, the list scrolls.
  const room = Math.max(1, Math.min(Math.max(list.length, 1), g.h - 2 - 6));
  const h = room + 5;
  const x = anchor.x;
  const y = Math.max(1, Math.min(anchor.y, g.h - 2 - h));
  panel(g, x, y, w, h, {
    title: `State · ${key}`,
    keys: [
      ["↵", "set"],
      [`1–${p.states.length}`, "jump"],
      ["Esc", "back"],
    ],
  });
  const ix = x + 1;
  const end = x + w - 1;
  // The filter as the artboard has it: no cursor, the sign not bold.
  inputLine(g, ix + 1, y + 1, end, { bold: false, cursor: false, text: [[p.filter, { fg: "ink", bg: "panel" }]], placeholder: p.filter ? undefined : ["type to filter", { fg: "faint", bg: "panel" }] });
  g.run(ix, y + 2, "─", end - ix, { fg: "rule", bg: "panel" });
  const first = scrollWindow(p.at, list.length, room);
  list.slice(first, first + room).forEach(({ st, n }, k) => {
    const r = y + 3 + k;
    const on = first + k === p.at;
    const bg = listRow(g, ix, r, end - ix, on, [`at:${first + k}`, "enter"], "panel");
    g.text(ix + 2, r, String(n), { fg: "ink-3", bg });
    const gx = g.text(ix + 2 + String(n).length + 1, r, st.glyph, { fg: st.tone, bg });
    const mark = st.id === p.current ? "current ✓" : "";
    g.text(gx + 1, r, st.name, { fg: "ink", bg, at: on ? "B" : "" }, end - 1 - (mark ? widthOf(mark) + 1 : 0));
    if (mark) g.textRight(end - 1, r, mark, { fg: "ink-3", bg });
  });
  if (!list.length) g.text(ix + 2, y + 3, "no state matches", { fg: "faint", bg: "panel" }, end);
}

/** The ? sheet: every key of the screen under it, in a panel at the middle; what does not fit the height is left out. */
export function paintHelp(g: Grid, screen: string, keys: [string, string][]): void {
  const keyW = Math.max(...keys.map(([k]) => widthOf(k)));
  const w = Math.min(g.w - 4, Math.max(40, 6 + keyW + 2 + Math.max(...keys.map(([, d]) => widthOf(d)))));
  const rows = Math.max(1, Math.min(keys.length, g.h - 2 - 4));
  const h = rows + 4;
  const { x, y } = centre(g, w, h);
  panel(g, x, y, w, h, {
    title: `Keys · ${screen}`,
    keys: [
      ["?", "close"],
      ["Esc", "close"],
    ],
  });
  keys.slice(0, rows).forEach(([k, d], i) => {
    const r = y + 2 + i;
    g.text(x + 3, r, k, { fg: "ink-2", bg: "panel", at: "B" });
    g.text(x + 3 + keyW + 2, r, d, { fg: "ink", bg: "panel" }, x + w - 2);
  });
}

/**
 * A question before a step that is easy to take by mistake (RSVA-456): the question in the panel's name, what it is
 * about under it, `y` (or ↵) to go on and Esc (or n) not to. At the middle of the screen, as the ? sheet.
 */
export function paintConfirm(g: Grid, question: string, lines: Seg[], yes: string): void {
  const w = Math.min(g.w - 4, Math.max(44, widthOf(question) + 8, ...lines.map(([t]) => widthOf(t) + 6)));
  const h = lines.length + 4;
  const { x, y } = centre(g, w, h);
  panel(g, x, y, w, h, {
    title: question,
    keys: [
      ["y", yes],
      ["Esc", "cancel"],
    ],
  });
  lines.forEach(([t, pen], i) => g.text(x + 3, y + 2 + i, t, { ...pen, bg: "panel" }, x + w - 3));
}

/**
 * A new issue (RSVA-463): its line and the card of the issue it makes, in one panel over the screen it was opened on,
 * dimmed, as the palette floats; under the head, so that the completions have room below. The line had the head's row
 * over the list, which stayed bright: the keys went to the line while the list looked live. Without a card (no project
 * yet) the panel holds the line alone.
 */
export function paintCreate(g: Grid, line: QueryView, made: { card: Card; details: IssueDetails } | null): void {
  dimBehind(g);
  const top = 2;
  const h = made ? paintCardPanel(g, made.card, made.details, top, 2) : 4;
  if (!made) panel(g, 1, top, g.w - 2, h, { title: "New issue" });
  // The cell at each side of it blank: the list's cursor bar behind it would stand at its edge.
  for (const x of [0, g.w - 1]) g.fill(x, top, 1, h, "ground");
  paintQuery(g, line, { x: 2, y: top + 1, w: g.w - 4 });
  // The rule under the line meets the card's border.
  if (made) for (const [x, ch] of [[1, "├"], [g.w - 2, "┤"]] as const) g.text(x, top + 2, ch, { fg: "rule-strong" });
}
