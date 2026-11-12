// A frame as a grid of terminal cells, as the design canvas draws the TUI: each cell a character, a foreground and a
// background token, and bold (B), dim (D) or underline (U). Screens paint into a Grid; the terminal gets only the rows
// that changed since the last frame, each as runs of one style in 24-bit colour, inside one synchronized write.
//
// A wide character (East Asian, emoji) takes its cell and the next, which holds "": the canvas draws it so, and a cut
// never splits one (docs: the TUI notes artboard, "Long and wide text").
import { plain } from "@rsva/terminal/text";
import { graphemes, graphemeWidth, widthOf } from "@rsva/terminal/width";
import { hintKeys } from "./terminal.ts";
import type { Theme, Token } from "./theme.ts";

/** A token, or a colour of the data itself: a label's own colour, as the web shows it. */
export type Colour = Token | `#${string}`;

export interface Cell {
  ch: string;
  fg: Colour;
  bg: Colour;
  /** Some of "B", "D", "U", in that order. */
  at: string;
}

export interface Pen {
  fg: Colour;
  /** The cell's background as it is when not given. */
  bg?: Colour | undefined;
  at?: string;
  /** The key a click on the text presses (RSVA-479): `open:<url>` a link, `issue:<KEY>` an issue, or a key's name. */
  click?: string | undefined;
}

/** Where a click stands for keys (PLNR-383): a rectangle of cells and the keys it presses, by name; none blocks the ones under it. */
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
  keys: string[];
}

export class Grid {
  readonly w: number;
  readonly h: number;
  readonly cells: Cell[];
  /** In the order painted: the last one over a cell is the one a click there finds, as the last painted is the one seen. */
  zones: Zone[] = [];

  constructor(w: number, h: number, bg: Token = "ground") {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: w * h }, () => ({ ch: " ", fg: "ink", bg, at: "" }));
  }

  at(x: number, y: number): Cell {
    return this.cells[y * this.w + x]!;
  }

  /** A click on the rectangle presses `keys`; a panel marks itself with none, so that what is behind it takes no click. */
  zone(x: number, y: number, w: number, h: number, keys: string[]): void {
    if (w > 0 && h > 0) this.zones.push({ x, y, w, h, keys });
  }

  /** A key hint painted from x to `end` on row y: a click on it presses its keys ("↵" enter, "g q" g then q). */
  hint(x: number, end: number, y: number, hint: string): void {
    this.zone(x, y, end - x, 1, hintKeys(hint));
  }

  /** The keys a click on the cell presses: the last zone painted over it; none where nothing is. */
  keysAt(x: number, y: number): string[] {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i]!;
      if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.keys;
    }
    return [];
  }

  /** A background over a rectangle, its characters blanked. */
  fill(x: number, y: number, w: number, h: number, bg: Colour): void {
    for (let r = y; r < Math.min(this.h, y + h); r++)
      for (let c = Math.max(0, x); c < Math.min(this.w, x + w); c++) Object.assign(this.at(c, r), { ch: " ", fg: "ink", bg, at: "" });
  }

  /**
   * Text from (x, y), stopping before `end` (the row's end by default): what does not fit is cut with "…", and a wide
   * character that would cross the edge leaves its cell blank. Returns the column after the text.
   */
  text(x: number, y: number, s: string, pen: Pen, end = this.w): number {
    if (y < 0 || y >= this.h) return x;
    // The last guard before the terminal: a control character in someone's text cannot move the cursor or set the
    // clipboard. The screens clean what they show already (view.ts); this catches what slips past.
    // Tabs and line breaks too: one inside a cell would move the cursor to another row.
    const parts = graphemes(plain(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
    const widths = parts.map(graphemeWidth);
    const total = widths.reduce((n, w) => n + w, 0);
    const room = end - x;
    const cut = total > room;
    let col = x;
    for (const [i, g] of parts.entries()) {
      const w = widths[i]!;
      if (w === 0) continue;
      if (col + w > (cut ? end - 1 : end)) break;
      this.put(col, y, g, pen);
      if (w === 2) this.put(col + 1, y, "", pen);
      col += w;
    }
    if (cut && col < end) {
      // A leftover cell before the ellipsis stays blank, so the ellipsis sits at the edge.
      while (col < end - 1) this.put(col++, y, " ", pen);
      this.put(col++, y, "…", pen);
    }
    if (pen.click) this.zone(x, y, col - x, 1, [pen.click]);
    return col;
  }

  /** Text that ends at `end` (exclusive): right-aligned. Returns where it starts. */
  textRight(end: number, y: number, s: string, pen: Pen): number {
    const x = end - widthOf(s);
    this.text(x, y, s, pen, end);
    return x;
  }

  /** A run of one character, `n` cells. */
  run(x: number, y: number, ch: string, n: number, pen: Pen): number {
    for (let i = 0; i < n; i++) this.put(x + i, y, ch, pen);
    return x + Math.max(0, n);
  }

  private put(x: number, y: number, ch: string, pen: Pen): void {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    const c = this.at(x, y);
    c.ch = ch;
    c.fg = pen.fg;
    if (pen.bg) c.bg = pen.bg;
    c.at = pen.at ?? "";
  }
}

const colour = (c: Colour, theme: Theme) => (c.startsWith("#") ? c : theme[c as Token]);
const rgb = (hex: string) => `${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;
const ATTR: Record<string, string> = { B: "1", D: "2", I: "3", U: "4", S: "9" };

/** A row as runs of one style: SGR with 24-bit colour, reset at the end. */
function rowAnsi(g: Grid, y: number, theme: Theme): string {
  let out = "";
  let last = "";
  for (let x = 0; x < g.w; x++) {
    const c = g.at(x, y);
    if (c.ch === "") continue;
    const sgr = `\x1b[0;${[...c.at].map((a) => ATTR[a]).join(";")}${c.at ? ";" : ""}38;2;${rgb(colour(c.fg, theme))};48;2;${rgb(colour(c.bg, theme))}m`;
    if (sgr !== last) out += last = sgr;
    out += c.ch;
  }
  return `${out}\x1b[0m`;
}

const rowKey = (g: Grid, y: number) => {
  let k = "";
  for (let x = 0; x < g.w; x++) {
    const c = g.at(x, y);
    k += `${c.ch}\u0000${c.fg}\u0000${c.bg}\u0000${c.at}\u0001`;
  }
  return k;
};

export interface Output {
  write(data: string, done?: () => void): boolean;
}

/** The terminal's screen: writes the rows of a grid that changed since the last one, in one synchronized write. */
export class GridScreen {
  private shown: string[] = [];
  /** The frame last drawn: a click lands on what it shows. */
  private last: Grid | null = null;
  private readonly out: Output;
  theme: Theme;

  constructor(out: Output, theme: Theme) {
    this.out = out;
    this.theme = theme;
  }

  /** The keys a click on cell (x, y) of the screen presses, as the frame last drawn marks them. */
  keysAt(x: number, y: number): string[] {
    return this.last?.keysAt(x, y) ?? [];
  }

  /** Forget what is on the screen: the next frame is drawn whole (a resize, a new theme). */
  invalidate(): void {
    this.shown = [];
  }

  /**
   * Writes the rows that changed; `after` adds what goes over them in the same write (images.ts), told which rows were
   * written again.
   */
  draw(g: Grid, after?: (changed: ReadonlySet<number>) => string): Promise<number> {
    this.last = g;
    let out = "";
    const keys: string[] = [];
    const changed = new Set<number>();
    for (let y = 0; y < g.h; y++) {
      const k = rowKey(g, y);
      keys.push(k);
      if (k !== this.shown[y]) {
        out += `\x1b[${y + 1};1H${rowAnsi(g, y, this.theme)}`;
        changed.add(y);
      }
    }
    this.shown = keys;
    if (after) out += after(changed);
    if (!out) return Promise.resolve(0);
    const frame = `\x1b[?2026h${out}\x1b[?2026l`;
    return new Promise((resolve) => this.out.write(frame, () => resolve(Buffer.byteLength(frame))));
  }
}
