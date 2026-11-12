// What is the same at the top and the bottom of every screen: the head's band with the mark, the status line and the
// keys line. Moved out of home.ts (RSVA-458): the issue screen and the queue draw them too.
import { widthOf } from "@rsva/terminal/width";
import type { Grid } from "./grid.ts";
import type { Token } from "./theme.ts";
import { GAP, hints, segs, type Seg } from "./widgets.ts";

/** The status line: the connection, what just happened (`brief` at 80 columns), the Rex session, the time. */
export interface Status {
  connection: "online" | "connecting" | "offline";
  message: Seg[];
  session: string;
  time: string;
  /** The message at 80 columns. */
  brief: string;
}

/** The status line's band and the connection at its left: ● online, ◐ connecting, ○ offline. Returns where it ends. */
function connection(g: Grid, y: number, s: Status): number {
  const bg: Token = "sidebar";
  g.fill(0, y, g.w, 1, bg);
  const [mark, tone]: [string, Token] = s.connection === "online" ? ["●", "success"] : s.connection === "connecting" ? ["◐", "warning"] : ["○", "warning"];
  const x = g.text(1, y, mark, { fg: tone, bg });
  return g.text(x + 1, y, s.connection === "connecting" ? "connecting …" : s.connection, { fg: "ink-2", bg });
}

export function paintStatus(g: Grid, y: number, s: Status): void {
  const bg: Token = "sidebar";
  let x = connection(g, y, s);
  const rightW = widthOf(`rex ${s.session}  ${s.time}`);
  if (s.message.length) {
    x = g.text(x, y, "  ·  ", { fg: "faint", bg });
    segs(
      g,
      x,
      y,
      s.message.map(([t, p]): Seg => [t, { ...p, bg }]),
      g.w - 1 - rightW - 2,
    );
  }
  let rx = g.w - 1 - rightW;
  rx = g.text(rx, y, "rex ", { fg: "ink-3", bg });
  rx = g.text(rx, y, s.session, { fg: "ink-2", bg });
  g.text(rx, y, `  ${s.time}`, { fg: "ink-3", bg });
}

/**
 * Key hints: the key bold, what it does; two cells apart; those that do not fit go from the end; "? all keys" stays,
 * unless `allWord` is empty: where ? is not a key (a field, the launch's steps).
 */
export function paintKeys(g: Grid, y: number, keys: readonly [key: string, does: string][], allWord: string): void {
  const end = g.w - 1;
  const allAt = allWord ? end - widthOf(`? ${allWord}`) : end + 2;
  hints(g, 1, y, keys, { gap: GAP.line, fit: allAt - 2 });
  if (allWord) hints(g, allAt, y, [["?", allWord]], { gap: GAP.line });
}

/** The head's band and the mark: ■ recursiva. Returns where it ends. */
export function mark(g: Grid): number {
  g.fill(0, 0, g.w, 1, "sidebar");
  g.text(1, 0, "■", { fg: "accent", bg: "sidebar" });
  return g.text(3, 0, "recursiva", { fg: "ink", bg: "sidebar", at: "B" });
}

export function paintStatusNarrow(g: Grid, y: number, s: Status): void {
  const bg: Token = "sidebar";
  let x = connection(g, y, s);
  const timeAt = g.w - 1 - widthOf(s.time);
  if (s.brief) {
    x = g.text(x, y, "  ·  ", { fg: "faint", bg });
    g.text(x, y, s.brief, { fg: "ink-2", bg }, timeAt - 2);
  }
  g.text(timeAt, y, s.time, { fg: "ink-3", bg });
}
