// Typing a query after / (the artboard TuiQuery): the head becomes the query line with its cursor, the list behind
// narrows on every key, and under the word being typed a panel offers its values with how many issues each leaves,
// then other keys to try. The values come from the query parser's own completions (packages/query), as the web's
// query field gets them.
import { parseQuery, SHORT_FORMS, type QueryContext } from "@rsva/query";
import { widthOf } from "@rsva/terminal/width";
import type { Grid, Pen } from "./grid.ts";
import { inputLine, listRow, panel, scrollWindow, type Seg, type StateMark } from "./widgets.ts";

interface Completion {
  /** The value as it is shown: "In Progress". */
  label: string;
  /** What replaces the word being typed: `"In Progress"`. */
  text: string;
  mark: StateMark | null;
  /** How many issues the query leaves with this value; null where the line is not a query (a new issue's). */
  count: number | null;
}

export interface QueryView {
  /** The query as typed so far. */
  draft: string;
  /** At the right of the line: how many issues the draft leaves of how many the list had; for a new issue, where it goes. */
  right: string;
  /** The sign before the line: › for a query, + for a new issue. */
  sign?: string;
  /** The word being typed and what it can become; null when nothing is being completed. */
  typing: { key: string; start: number; end: number; values: Completion[]; at: number } | null;
  /** Other keys to try, each with a few of its values. */
  also: [key: string, values: string[]][];
}

const KEY: Pen = { fg: "ink-3", bg: "panel" };

/** Where the line is: the head's row across the screen, or a row inside a panel (a new issue's, RSVA-463). */
interface At {
  x: number;
  y: number;
  w: number;
}

/** The query line: `›` (as the palette's field: / is the palette's key), then each `key:` (or short form's sign) in ink-3 and its value in ink; the word being typed underlined; the cursor. */
function paintLine(g: Grid, q: QueryView, at: At): void {
  g.fill(at.x, at.y, at.w, 1, "panel");
  const right = q.right;
  const rightAt = at.x + at.w - 1 - widthOf(right);
  const typingFrom = q.typing ? q.typing.start : q.draft.length;
  const before = q.draft.slice(0, typingFrom);
  const text: Seg[] = [];
  for (const m of before.matchAll(/(-?[a-z]+:|[#@!+](?=\S))?(\S*)(\s*)/g)) {
    if (!m[0]) continue;
    if (m[1]) text.push([m[1], KEY]);
    text.push([`${m[2]}${m[3]}`, { fg: "ink", bg: "panel" }]);
  }
  text.push([q.draft.slice(typingFrom), { fg: "ink", bg: "panel", at: q.typing ? "U" : "" }]);
  inputLine(g, at.x + 1, at.y, rightAt - 2, { sign: q.sign, text });
  g.text(rightAt, at.y, right, KEY);
}

/**
 * The panel under the word being typed: its values, the cursor's lit, then other keys to try. It stops above the status
 * line: on a short screen the keys to try go first, then the values scroll (an order has six).
 */
function paintCompletions(g: Grid, q: QueryView, at: At): void {
  const t = q.typing;
  if (!t) return;
  const w = 40;
  // Its values under the word: they start three cells in, as the line's text does.
  const x = Math.max(0, Math.min(at.x + t.start, g.w - w - 1));
  const y = at.y + 1;
  const fits = Math.max(1, g.h - 2 - y - 3);
  const room = Math.min(t.values.length, fits);
  const also = q.also.slice(0, Math.max(0, fits - room - 2));
  const h = room + (also.length ? 2 + also.length : 0) + 3;
  panel(g, x, y, w, h, {
    title: [t.key, KEY],
    keys: [
      ["Tab", "complete"],
      ["↑↓", "pick"],
      ["↵", "apply"],
    ],
  });
  const end = x + w - 1;
  const typed = q.draft.slice(t.start, t.end).replace(/^"/, "").toLowerCase();
  const first = scrollWindow(t.at, t.values.length, room);
  t.values.slice(first, first + room).forEach((v, k) => {
    const i = first + k;
    const r = y + 1 + k;
    const bg = listRow(g, x + 1, r, end - x - 1, i === t.at, [`at:${i}`, "tab"], "panel");
    let vx = x + 3;
    if (v.mark) {
      vx = g.text(vx, r, v.mark.glyph, { fg: v.mark.tone, bg });
      vx += 1;
    }
    // The part already typed, bold and underlined; the rest as it is.
    const n = v.label.toLowerCase().startsWith(typed) ? typed.length : 0;
    vx = g.text(vx, r, v.label.slice(0, n), { fg: "ink", bg, at: "BU" }, end - 6);
    g.text(vx, r, v.label.slice(n), { fg: "ink", bg }, end - 6);
    if (v.count !== null) g.textRight(end - 1, r, String(v.count), { fg: "ink-3", bg });
  });
  if (!also.length) return;
  const ay = y + 1 + room + 1;
  g.text(x + 3, ay, "also", { fg: "faint", bg: "panel" });
  also.forEach(([key, values], i) => {
    const kx = g.text(x + 3, ay + 1 + i, `${key}:`, KEY);
    g.text(kx + 1, ay + 1 + i, values.join("  "), { fg: "ink-2", bg: "panel" }, end - 1);
  });
}

/** The line with a rule under it and the completions below: on the head's row, or `at` a row inside a panel. */
export function paintQuery(g: Grid, q: QueryView, at: At = { x: 0, y: 0, w: g.w }): void {
  paintLine(g, q, at);
  g.run(at.x, at.y + 1, "─", at.w, { fg: "rule" });
  paintCompletions(g, q, at);
}

/**
 * The word being typed and its completions: the parser's error at the end of the draft, as the web reads it. `count`
 * says how many issues each would leave; null for a line that is not a query.
 */
export function completionsOf(
  draft: string,
  ctx: QueryContext,
  count: ((query: string) => number) | null,
  mark: (key: string, value: string) => StateMark | null,
  at: number,
): QueryView["typing"] {
  const { errors } = parseQuery(draft, ctx);
  const e = errors.find((x) => x.end === draft.length && x.suggestions.length);
  if (!e) return null;
  const sign = SHORT_FORMS[draft[e.start - 1] as keyof typeof SHORT_FORMS];
  const key = sign ?? /(-?[a-z]+):[^:]*$/.exec(draft.slice(0, e.start + 1))?.[1] ?? "key";
  const values = e.suggestions.map((text) => {
    const label = text.replace(/^"|"$/g, "");
    return { label, text, mark: mark(key, label), count: count ? count(`${draft.slice(0, e.start)}${text}`) : null };
  });
  return { key: key.replace(/^-/, ""), start: e.start, end: e.end, values, at: Math.min(at, values.length - 1) };
}
