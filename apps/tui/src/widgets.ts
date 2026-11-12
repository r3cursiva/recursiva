// The pieces every screen is drawn with (RSVA-458): an issue's marks (state, priority, labels), key hints, a box with
// its name in the top border and its keys or a note in the bottom one, a list's cursor row and how it scrolls, a panel
// in the middle of the screen, a one-line input, a field's typed text, and words wrapped to a width. Screens compose
// these; none draws its own copy.
import { priorityName, URGENT, type Priority } from "@rsva/schema/models";
import { widthOf } from "@rsva/terminal/width";
import type { Colour, Grid, Pen } from "./grid.ts";
import type { Token } from "./theme.ts";

export type { Priority };

/** Text in one pen: a run of a line. */
export type Seg = [text: string, pen: Pen];

/** A state as the CLI draws it: the glyph by group, the colour by the state's place in the app's six. */
export interface StateMark {
  name: string;
  glyph: string;
  tone: Token;
}

export interface LabelMark {
  name: string;
  swatch: Colour;
}

// ── Text ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Segments from x, cut at `end`. Returns where they stop. */
export function segs(g: Grid, x: number, y: number, list: Seg[], end: number): number {
  for (const [text, pen] of list) x = g.text(x, y, text, pen, end);
  return x;
}

/** Segments cut to `room` cells, the last one ending in "…" when anything went. */
export function cutSegs(list: Seg[], room: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const [t, pen] of list) {
    const w = widthOf(t);
    if (used + w <= room) {
      out.push([t, pen]);
      used += w;
      continue;
    }
    let part = "";
    for (const ch of t) {
      if (used + widthOf(part + ch) > room - 1) break;
      part += ch;
    }
    out.push([`${part}…`, pen]);
    break;
  }
  return out;
}

/** A chip: its text with a cell of its ground on each side. */
export const chip = (text: string, pen: Pen): Seg => [` ${text} `, pen];

/** Segments a click on presses `key` (RSVA-479): `open:<url>`, `issue:<KEY>` or a key's name. */
export const clicking = (list: Seg[], key: string): Seg[] => list.map(([t, pen]) => [t, { ...pen, click: key }]);

/** Words of segments, each word keeping its pen, so a line can break between them. */
const words = (list: Seg[]): Seg[] => list.flatMap(([t, pen]) => t.split(/(?<= )/).map((w): Seg => [w, pen]));

/** Lines of `room` cells, broken between words; a word wider than the room is cut with "…" by Grid.text. */
export function wrap(list: Seg[], room: number): Seg[][] {
  const out: Seg[][] = [[]];
  let used = 0;
  // A line's last space goes: a line exactly as wide as the room would be one cell wider, and cut.
  const trim = (line: Seg[]) => {
    const last = line.at(-1);
    if (last) line[line.length - 1] = [last[0].trimEnd(), last[1]];
  };
  for (const w of words(list)) {
    const n = widthOf(w[0].trimEnd());
    if (used + n > room && used > 0) {
      trim(out.at(-1)!);
      out.push([]);
      used = 0;
    }
    out.at(-1)!.push(w);
    used += widthOf(w[0]);
  }
  trim(out.at(-1)!);
  return out;
}

/** Plain text wrapped to `room` cells, one string a line: each line break kept, runs of spaces read as one. */
export const wrapText = (text: string, room: number): string[] =>
  text.split("\n").flatMap((para) => wrap([[para.split(/\s+/).filter(Boolean).join(" "), { fg: "ink" }]], room).map((l) => l.map(([t]) => t).join("")));

/**
 * Typed text as it was typed, for a field: every space kept (a trailing one too, where the cursor goes next), lines
 * broken only where the field ends, at the last space that fits when there is one.
 */
export const fieldLines = (text: string, room: number): string[] => wrapField(text, room).map((l) => l.text);

/** fieldLines with where each line starts in the text, which places the cursor. */
function wrapField(text: string, room: number): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (let line of text.split("\n")) {
    while (widthOf(line) > room) {
      let cut = 0;
      let used = 0;
      for (const ch of line) {
        const w = widthOf(ch);
        if (used + w > room) break;
        used += w;
        cut += ch.length;
      }
      const space = line.lastIndexOf(" ", cut);
      const at = space > 0 ? space + 1 : cut;
      out.push({ text: line.slice(0, at), start });
      start += at;
      line = line.slice(at);
    }
    out.push({ text: line, start });
    start += line.length + 1;
  }
  return out;
}

const cursor = (g: Grid, x: number, y: number) => g.text(x, y, " ", { fg: "ink", bg: "ink" });

/**
 * A field's text from (x, y), `rows` lines of it with the cursor at `at` (RSVA-465): the cursor a cell of ink, the
 * character under it in the field's colour. The lines shown end with the text's own while the cursor is among them, else
 * begin with the cursor's. Empty, the cursor and the placeholder at a reading measure. The dispatch's context and the
 * issue screen's reply.
 */
export function fieldText(g: Grid, x: number, y: number, room: number, rows: number, text: string, at: number, placeholder: string, bg: Colour, end: number): void {
  if (!text) {
    cursor(g, x, y);
    wrapText(placeholder, Math.min(room, 60)).forEach((l, i) => g.text(x + (i ? 0 : 1), y + i, l, { fg: "faint", bg }, end));
    return;
  }
  const lines = wrapField(text, room);
  const line = lines.findLastIndex((l) => l.start <= at);
  const top = Math.max(0, Math.min(lines.length - rows, line));
  lines.slice(top, top + rows).forEach((l, i) => g.text(x, y + i, l.text, { fg: "ink", bg }, end));
  const { text: l, start } = lines[line]!;
  const cx = x + widthOf(l.slice(0, at - start));
  const under = Array.from(l.slice(at - start))[0];
  if (under) g.text(cx, y + line - top, under, { fg: bg, bg: "ink" });
  else cursor(g, cx, y + line - top);
}

/**
 * A line to type in: the sign (› a query or a filter, + a new issue) in the signal colour, the text two cells after it,
 * cut at `end`, and the cursor after the text; then the placeholder, given while nothing is typed: one cell past the
 * cursor, or where the text goes without one. Returns where the text ends.
 */
export function inputLine(
  g: Grid,
  x: number,
  y: number,
  end: number,
  line: { sign?: string | undefined; bold?: boolean; text: Seg[]; cursor?: boolean; placeholder?: Seg | undefined },
): number {
  const bg = "panel";
  g.text(x, y, line.sign ?? "›", { fg: "accent", bg, at: line.bold === false ? "" : "B" });
  const tx = segs(g, x + 2, y, line.text, end);
  const caret = line.cursor !== false && tx <= end;
  if (caret) cursor(g, tx, y);
  if (line.placeholder) g.text(caret ? tx + 2 : tx, y, line.placeholder[0], line.placeholder[1], end);
  return tx;
}

// ── An issue's marks ──────────────────────────────────────────────────────────────────────────────────────────────

/** Three cells: bars ▂▄▆ lit by level, ··· for none, a signal tile for urgent. */
export function prioritySegs(p: Priority, bg?: Token): Seg[] {
  if (p === 0) return [["···", { fg: "faint", bg }]];
  if (p === URGENT) return [[" ! ", { fg: "accent-ink", bg: "accent", at: "B" }]];
  const lit = 5 - p;
  const bars = "▂▄▆";
  return [
    [bars.slice(0, lit), { fg: "ink-2", bg }],
    [bars.slice(lit), { fg: "faint", bg }],
  ];
}

export const priority = (g: Grid, x: number, y: number, p: Priority, bg?: Token): number => segs(g, x, y, prioritySegs(p, bg), g.w);

/**
 * A card's line of state: the state, then the priority's bars and name after `dot`. Without a priority the line stops at
 * the state, unless `none` asks for "No priority" (the queue and dispatch, which ask for one).
 */
export function stateLine(state: StateMark, p: Priority, dot: Seg, bg?: Token, none = false): Seg[] {
  const line: Seg[] = [
    [state.glyph, { fg: state.tone, bg }],
    [` ${state.name}`, { fg: "ink-2", bg }],
  ];
  if (p || none) line.push(dot, ...prioritySegs(p, bg), [` ${priorityName(p)}`, { fg: "ink-2", bg }]);
  return line;
}

/** Label tags: ▪ in the swatch, the name; two cells apart; what does not fit is +N. */
export function labels(g: Grid, x: number, y: number, list: readonly LabelMark[], end: number, bg?: Token): number {
  let col = x;
  for (const [i, l] of list.entries()) {
    const rest = list.length - i - 1;
    const need = 2 + widthOf(l.name) + (rest ? 2 + 2 + String(rest).length : 0);
    if (col + need > end && i > 0) return g.text(col + 2, y, `+${list.length - i}`, { fg: "ink-3", bg }, end);
    if (i) col += 2;
    col = g.text(col, y, "▪", { fg: l.swatch, bg });
    col = g.text(col, y, ` ${l.name}`, { fg: "ink-2", bg }, end);
  }
  return col;
}

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cells between two hints, as the artboards have them: two in a border and on the keys line, three in a row of hints
 * inside a panel.
 */
export const GAP = { line: 2, row: 3 } as const;

/**
 * Key hints from (x, y): the key bold in ink-2, what it does in ink-3 (or `does`), `gap` blank cells apart, each a click
 * on its key. A `cap` key is a tile in inverse ink, as the queue's actions. With `fit`, the hints stop at the first one
 * that would end past it; `end` cuts what one does. Returns where the last one ends.
 */
export function hints(
  g: Grid,
  x: number,
  y: number,
  keys: readonly (readonly [key: string, does: string])[],
  o: { gap: number; bg?: Colour | undefined; end?: number; fit?: number; cap?: boolean; does?: Pen },
): number {
  const keyPen: Pen = o.cap ? { fg: "inverse-ink", bg: "inverse", at: "B" } : { fg: "ink-2", bg: o.bg, at: "B" };
  const doesPen: Pen = o.does ?? { fg: "ink-3", bg: o.bg };
  for (const [i, [k, d]] of keys.entries()) {
    const key = o.cap ? ` ${k} ` : k;
    if (o.fit !== undefined && (i ? x + o.gap : x) + widthOf(key) + 1 + widthOf(d) > o.fit) break;
    // The gap is blank: in a border it parts the rule.
    if (i) x = g.text(x, y, " ".repeat(o.gap), doesPen);
    const from = x;
    x = g.text(from, y, key, keyPen);
    x = g.text(x, y, ` ${d}`, doesPen, o.end);
    g.hint(from, x, y, k);
  }
  return x;
}

// ── Boxes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Box {
  /** The border's pen. */
  pen: Pen;
  /** The ground inside: a box with one is a panel, and what is behind it takes no click through it. */
  fill?: Colour;
  /** Its name in the top border: "╭─ name ─…"; without one the border is a plain rule. */
  title?: Seg | undefined;
  /** At the top border's right: what it counts ("1 of 2 · context"), or keys (`actions`). */
  right?: Seg[];
  actions?: [string, string][];
  /** Its keys in the bottom border, from the left. */
  keys?: [string, string][];
  /** A note in the bottom border, ending at `end` (exclusive): how many lines are left, how many characters. */
  note?: { text: string; pen: Pen; end: number } | undefined;
}

/** A rounded box: its name and what it counts or its keys in the top border, its keys or a note in the bottom one. */
export function box(g: Grid, x: number, y: number, w: number, h: number, b: Box): void {
  const { pen } = b;
  const r = x + w - 1;
  if (b.fill) {
    g.fill(x, y, w, h, b.fill);
    g.zone(x, y, w, h, []);
  }
  // The top: the name at the left, then a rule to what is at the right.
  g.text(x, y, "╭", pen);
  g.run(x + 1, y, "─", w - 2, pen);
  g.text(r, y, "╮", pen);
  if (b.title) g.text(g.text(g.text(x + 1, y, "─ ", pen), y, ...b.title), y, " ", pen);
  const rightW = b.actions ? b.actions.reduce((n, [k, d], i) => n + (i ? GAP.line : 0) + widthOf(k) + 1 + widthOf(d), 0) : (b.right ?? []).reduce((n, [t]) => n + widthOf(t), 0);
  if (rightW) {
    const rx = g.text(r - 3 - rightW, y, " ", pen);
    const ex = b.actions ? hints(g, rx, y, b.actions, { gap: GAP.line, bg: pen.bg }) : segs(g, rx, y, b.right!, r);
    g.text(ex, y, " ", pen);
  }
  for (let row = y + 1; row < y + h - 1; row++) {
    g.text(x, row, "│", pen);
    g.text(r, row, "│", pen);
  }
  const by = y + h - 1;
  g.text(x, by, "╰", pen);
  g.run(x + 1, by, "─", w - 2, pen);
  g.text(r, by, "╯", pen);
  if (b.keys?.length) g.text(hints(g, g.text(x + 2, by, " ", pen), by, b.keys, { gap: GAP.line, bg: pen.bg, does: pen }), by, " ", pen);
  if (b.note) g.text(b.note.end - widthOf(b.note.text), by, b.note.text, b.note.pen);
}

const BORDER: Pen = { fg: "ink-3", bg: "panel" };

/**
 * A floating panel (TuiStatePicker, the component sheet): the panel's ground, a rounded ink-3 border, its name in bold
 * ink unless `title` says otherwise; it takes the clicks over its rectangle.
 */
export function panel(g: Grid, x: number, y: number, w: number, h: number, b: Omit<Box, "pen" | "fill" | "title"> & { title?: string | Seg }): void {
  const title: Seg | undefined = typeof b.title === "string" ? [b.title, { fg: "ink", bg: "panel", at: "B" }] : b.title;
  box(g, x, y, w, h, { ...b, pen: BORDER, fill: "panel", title });
}

/** Where a panel `w` × `h` stands in the middle of the screen, above the status line and never on the head. */
export const centre = (g: Grid, w: number, h: number) => ({ x: Math.floor((g.w - w) / 2), y: Math.max(1, Math.floor((g.h - 2 - h) / 2)) });

// ── Lists ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A list's row, `w` cells from x: the cursor's lit (its ground, a bar at the left in the signal colour, or `bar`),
 * a click on it presses `keys`. Returns the row's ground: the cursor's, or `ground`.
 */
export function listRow(g: Grid, x: number, y: number, w: number, on: boolean, keys: string[], ground?: Token, bar: Token = "accent"): Token | undefined {
  const bg: Token | undefined = on ? "row-selected" : ground;
  if (on) {
    g.fill(x, y, w, 1, "row-selected");
    g.text(x, y, "▌", { fg: bar, bg });
  }
  g.zone(x, y, w, 1, keys);
  return bg;
}

/** The first of `length` lines to show in `room` rows so that line `at` is on screen: at the bottom once it is past it. */
export const scrollWindow = (at: number, length: number, room: number) => Math.max(0, Math.min(at - room + 1, length - room));
