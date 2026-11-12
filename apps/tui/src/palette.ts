// The command palette (/ or Ctrl+K, the artboard TuiPalette), as the web's: one field that finds commands, issues,
// saved views and places to go, each with its key at the right. `>` keeps commands only, `#` issues only. Projects
// are in GO TO: choosing one lists its issues. A typed key goes first, in TOP HIT, as in the web's (PLNR-437).
//
// A command that picks a value (a workspace, a project, a view, an issue's state, priority or assignees, the theme) opens
// a page of the palette, as the web's does (PLNR-380): a chip before the field says what and whose, the list holds that
// page's values with the current one checked, Esc goes back to all commands.
import { widthOf } from "@rsva/terminal/width";
import type { Grid, Pen } from "./grid.ts";
import { centre, GAP, hints, inputLine, listRow, panel, priority, scrollWindow, type Priority, type Seg, type StateMark } from "./widgets.ts";
import { plural } from "@rsva/schema/util";
import { buildIndex, byKey, queryOf, rank } from "@rsva/display/search";

/** The root's sections in their order; a page names its own one section. */
type Section = "TOP HIT" | "COMMANDS" | "ISSUES" | "VIEWS" | "GO TO" | (string & {});
const ORDER: Section[] = ["TOP HIT", "COMMANDS", "ISSUES", "VIEWS", "GO TO"];

export interface Entry {
  section: Section;
  /** What it is called; an issue's title. */
  label: string;
  /** Said after the label, quieter: an agent's run, a view's query, a session's name. */
  detail?: string;
  /** An issue's key and state. */
  issue?: { key: string; mark: StateMark };
  /** A project's key: typing it puts the project in TOP HIT. */
  project?: string;
  /** A glyph before the label: a state's on the state page. */
  mark?: Pick<StateMark, "glyph" | "tone">;
  /** A priority's bars before the label, on the priority page. */
  priority?: Priority;
  /** The value in use, on a page: ✓ at the right. */
  checked?: boolean;
  /** Its key on the screen it acts on: d, g q; ↵ for an issue. */
  shortcut?: string;
  /** The part of the label the query found, to underline. */
  match?: [start: number, end: number];
}

export interface PaletteView {
  query: string;
  entries: Entry[];
  /** Index of the chosen entry. */
  at: number;
  /** How many the query found, said at the bottom right. */
  found: number;
  /** A page's chip before the field: what it picks and, for an issue's field, whose. Absent on the root. */
  scope?: { key?: string; name: string };
}

const P = "panel" as const;

/** The entries in their sections' order, with each one's line in the list (headers and blank rows between). */
function lines(entries: Entry[]): ({ header: Section } | { entry: Entry; index: number } | null)[] {
  const out: ({ header: Section } | { entry: Entry; index: number } | null)[] = [];
  let index = 0;
  for (const section of sections(entries)) {
    const list = entries.filter((e) => e.section === section);
    if (!list.length) continue;
    if (out.length) out.push(null);
    out.push({ header: section });
    for (const entry of list) out.push({ entry, index: index++ });
  }
  return out;
}

/** The sections there are, the root's in their order, then a page's. */
const sections = (entries: Entry[]): Section[] => [...new Set([...ORDER, ...entries.map((e) => e.section)])];

/** Entries in the order the palette shows them: the cursor moves in this order. */
export const ordered = (entries: Entry[]) => sections(entries).flatMap((s) => entries.filter((e) => e.section === s));

/** A label with the part the query found bold and underlined, the rest in `rest`. */
function marked(g: Grid, x: number, y: number, e: Entry, text: string, rest: Pen, end: number): number {
  const [a, b] = e.match ?? [0, 0];
  x = g.text(x, y, text.slice(0, a), rest, end);
  x = g.text(x, y, text.slice(a, b), { fg: "ink", bg: rest.bg, at: "BU" }, end);
  return g.text(x, y, text.slice(b), rest, end);
}

export function paintPalette(g: Grid, v: PaletteView): void {
  const w = Math.min(80, g.w - 4);
  const h = Math.min(24, g.h - 3);
  const { x } = centre(g, w, h);
  const y = Math.max(1, Math.min(4, g.h - 2 - h));
  // A border with no title: the field is the panel's head.
  panel(g, x, y, w, h, {});
  const ix = x + 3;
  const end = x + w - 2;
  // A page's chip before the field: the issue's key quiet, what the page picks bold, on the cursor row's ground.
  const chip = "row-selected";
  const scope: Seg[] = v.scope
    ? [
        [" ", { fg: "ink", bg: chip }],
        ...(v.scope.key ? [[`${v.scope.key} `, { fg: "ink-3", bg: chip }] as Seg] : []),
        [`${v.scope.name} `, { fg: "ink", bg: chip, at: "B" }],
        [" ", { fg: "ink", bg: P }],
      ]
    : [];
  inputLine(g, x + 2, y + 1, end - 1, {
    text: [...scope, [v.query, { fg: "ink", bg: P }]],
    placeholder: v.scope && !v.query ? [`Select ${v.scope.name.toLowerCase()}…`, { fg: "ink-3", bg: P }] : undefined,
  });
  g.run(x + 1, y + 2, "─", w - 2, { fg: "rule", bg: P });
  const all = lines(v.entries);
  const room = h - 7;
  const at = all.findIndex((l) => l && "entry" in l && l.index === v.at);
  const top = scrollWindow(at, all.length, room);
  all.slice(top, top + room).forEach((l, i) => {
    const r = y + 3 + i;
    if (!l) return;
    if ("header" in l) {
      g.text(ix, r, l.header, { fg: "ink-3", bg: P });
      return;
    }
    const e = l.entry;
    const on = l.index === v.at;
    const bg = listRow(g, x + 1, r, w - 2, on, [`at:${l.index}`, "enter"], P);
    const tail = e.checked ? "✓" : e.shortcut;
    const right = tail ? end - widthOf(tail) - 1 : end;
    if (e.issue) {
      g.text(ix, r, e.issue.key, { fg: "ink-3", bg }, ix + 10);
      const gx = g.text(ix + 10, r, e.issue.mark.glyph, { fg: e.issue.mark.tone, bg });
      // A title stops short of the ↵, as the artboard has it.
      marked(g, gx + 2, r, e, e.label, { fg: "ink-2", bg }, right - 5);
    } else {
      // A page's value after its glyph or bars: a state's, a priority's.
      let lead = ix;
      if (e.mark) lead = g.text(ix, r, e.mark.glyph, { fg: e.mark.tone, bg }) + 1;
      else if (e.priority !== undefined) lead = priority(g, ix, r, e.priority, bg) + 1;
      // A command the query found reads in ink; the rest of the list in ink-2.
      const lx = marked(g, lead, r, e, e.label, { fg: e.match || on ? "ink" : "ink-2", bg }, right - 1);
      if (e.detail) g.text(e.section === "VIEWS" ? lx + 2 : lx + (e.label.endsWith(" ") ? 0 : 1), r, e.detail, { fg: "ink-3", bg }, right - 1);
    }
    if (e.checked) g.textRight(end, r, "✓", { fg: "accent", bg, at: "B" });
    else if (e.shortcut) g.textRight(end, r, e.shortcut, { fg: "ink-2", bg, at: "B" });
  });
  g.run(x + 1, y + h - 3, "─", w - 2, { fg: "rule", bg: P });
  const keys: [string, string][] = v.scope
    ? [
        ["↑↓", "choose"],
        ["↵", "pick"],
        ["Esc", "all commands"],
        ["⌃K", "close"],
      ]
    : [
        ["↑↓", "choose"],
        ["↵", "run"],
        [">", "commands only"],
        ["#", "issues only"],
      ];
  hints(g, ix, y + h - 2, keys, { gap: GAP.row, bg: P });
  const n = v.found;
  g.textRight(end, y + h - 2, plural(n, "result"), { fg: "ink-3", bg: P });
}

/**
 * The entries a query finds, ranked as the web's palette ranks its issues (@rsva/ui lib/search): every word of the query
 * in the label or an issue's key, any case; an exact key, then a key it starts, then a label that starts with the query,
 * then one with a word that does, then the rest: "order" finds Order issues by… before a queue whose query says
 * order:due (PLNR-401). `>` keeps commands, `#` keeps issues. An empty query shows them all. The sort is stable, so each
 * kind keeps the entries' own order. `match` is where the label has the query, or its first word it has, to underline.
 */
export function search(entries: Entry[], query: string): Entry[] {
  const only = query.startsWith(">") ? "COMMANDS" : query.startsWith("#") ? "ISSUES" : null;
  const parsed = queryOf(query.replace(/^[>#]\s*/, ""));
  const { q, words } = parsed;
  const docs = buildIndex(
    entries.filter((e) => !only || e.section === only),
    (e) => e.issue?.key ?? "",
    (e) => e.label,
  );
  const found = docs.flatMap((d): [Entry, number][] => {
    const { match: _, ...plain } = d.item;
    if (!q) return [[plain, 0]];
    const r = rank(d, parsed);
    if (r < 0) return [];
    const hit = [q, ...words].find((w) => d.title.includes(w));
    const at = hit ? d.title.indexOf(hit) : -1;
    return [[at >= 0 ? { ...plain, match: [at, at + hit!.length] } : plain, r]];
  });
  return keyedFirst(
    found.sort((a, b) => a[1] - b[1]).map(([e]) => e),
    q,
  );
}

/**
 * A typed key in TOP HIT, out of its own section, as the web's palette has it: the issue whose key it is, the project
 * whose key it is and, from two letters, those whose key starts with it ("pl" → PLNR, PLANE).
 */
function keyedFirst(found: Entry[], q: string): Entry[] {
  const issues = buildIndex(
    found.filter((e) => e.issue),
    (e) => e.issue!.key,
    (e) => e.label,
  );
  const projects = buildIndex(
    found.filter((e) => e.project),
    (e) => e.project!,
    (e) => e.label,
  );
  const top = new Set([...byKey(issues, q, false), ...byKey(projects, q, q.length >= 2)]);
  if (!top.size) return found;
  return [...[...top].map((e): Entry => ({ ...e, section: "TOP HIT" })), ...found.filter((e) => !top.has(e))];
}
