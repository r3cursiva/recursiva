// The Activity screen (RSVA-643): the workspace's latest across every project, newest day first. A day's name and what
// it got done, then a row an issue's day: the time, its mark, the key, the title, what happened, who; under an open
// issue that waits on open ones, on which. The head, the status line and the keys line are every screen's (bars.ts).
// `activity-view.ts` makes the view from the copy; this paints it.
import { widthOf } from "@rsva/terminal/width";
import { mark, paintKeys, paintStatus, paintStatusNarrow, type Status } from "./bars.ts";
import { Grid } from "./grid.ts";
import type { ActivityItem, ActivityView } from "./activity-view.ts";
import { listRow, segs, type Seg } from "./widgets.ts";

export interface ActivityScreen extends ActivityView {
  /** The cursor, counting every day's rows in order. */
  selected: number;
  /** The first line on the screen. */
  top: number;
  /** The status line; `status` is the history's. */
  statusLine: Status;
  keys: [key: string, does: string][];
}

/** The screen's lines: a day's head, its rows, an open issue's wait under its row, a blank line between days. */
type Line = { kind: "day"; label: string; totals: string } | { kind: "row"; item: ActivityItem; index: number } | { kind: "wait"; item: ActivityItem; index: number } | { kind: "blank" };

function activityLines(days: ActivityView["days"]): Line[] {
  const out: Line[] = [];
  let index = 0;
  days.forEach((d, n) => {
    if (n) out.push({ kind: "blank" });
    out.push({ kind: "day", label: d.label, totals: d.totals });
    for (const item of d.items) {
      out.push({ kind: "row", item, index });
      if (item.waiting) out.push({ kind: "wait", item, index });
      index++;
    }
  });
  return out;
}

/** The first line to show so that the cursor's row and its wait are on screen, with its day's head when that fits. */
function activityTop(v: Pick<ActivityScreen, "days" | "selected" | "top">, height: number): number {
  const lines = activityLines(v.days);
  const at = lines.findIndex((l) => l.kind === "row" && l.index === v.selected);
  if (at < 0) return 0;
  const end = lines[at + 1]?.kind === "wait" ? at + 1 : at;
  let top = Math.min(v.top, at);
  if (end >= top + height) top = end - height + 1;
  if (at > 0 && lines[at - 1]!.kind === "day" && at - 1 < top) top = at - 1;
  return Math.max(0, top);
}

/** Below this many columns the screen leaves out who did it. */
const WIDE = 100;

type Columns = { when: number; mark: number; key: number; title: number; what: number; whatEnd: number; who: number; whoW: number };

const segsWidth = (list: Seg[]) => list.reduce((n, [t]) => n + widthOf(t), 0);
const most = (items: ActivityItem[], of: (i: ActivityItem) => number) => items.reduce((n, i) => Math.max(n, of(i)), 0);

/**
 * Where a row's columns start: the time, the mark, the key, the title, what happened, who. The columns fit what the rows
 * hold, as a table's: on a wide screen a title is not cut while what happened is short, and who stands next to it, not
 * at the far edge; when the room runs out the title gives way first, down to about half of it.
 */
function columns(w: number, items: ActivityItem[]): Columns {
  const title = 22;
  const whoW = w >= WIDE ? Math.min(24, most(items, (i) => widthOf(i.who))) : 0;
  const end = w - 2 - (whoW ? whoW + 2 : 0);
  const room = end - title - 2;
  const titleNeed = most(items, (i) => widthOf(i.title));
  const whatNeed = most(items, (i) => segsWidth(i.what));
  const titleW = titleNeed + whatNeed <= room ? titleNeed : Math.max(16, Math.min(titleNeed, room - Math.min(whatNeed, Math.ceil(room * 0.45))));
  const what = title + titleW + 2;
  const whatEnd = Math.min(end, what + whatNeed);
  return { when: 2, mark: 8, key: 10, title, what, whatEnd, who: whatEnd + 2, whoW };
}

function paintRow(g: Grid, y: number, c: Columns, item: ActivityItem, index: number, on: boolean): void {
  // A click selects the row, a click on the selected row opens it (app.ts), as the list's.
  const bg = listRow(g, 0, y, g.w, on, [`act:${index}`]);
  g.text(c.when, y, item.when, { fg: "ink-3", bg });
  g.text(c.mark, y, item.mark[0], { ...item.mark[1], bg });
  g.text(c.key, y, item.key, { fg: on ? "ink" : "ink-3", bg }, c.title - 1);
  g.text(c.title, y, item.title, { fg: "ink", bg }, c.what - 2);
  segs(g, c.what, y, item.what.map(([t, pen]): Seg => [t, { ...pen, bg }]), c.whatEnd);
  if (c.whoW) g.text(c.who, y, item.who, { fg: "ink-3", bg }, c.who + c.whoW);
}

/** The line under the last row: what is still coming, or where the history begins. */
function endLine(v: ActivityView): Seg | null {
  if (v.status === "loading") return ["Loading the activity …", { fg: "ink-3" }];
  if (v.status === "error") return ["The activity did not load; it will try again.", { fg: "warning" }];
  if (v.loadingOlder) return ["Loading earlier days …", { fg: "ink-3" }];
  if (v.older) return ["↓ earlier days load at the end", { fg: "faint" }];
  return v.days.length ? ["The beginning of the history.", { fg: "faint" }] : ["Nothing has happened in this workspace yet.", { fg: "ink-3" }];
}

function paintHead(g: Grid, v: ActivityScreen): void {
  const bg = "sidebar" as const;
  const x = g.text(mark(g), 0, "  Activity", { fg: "ink", bg });
  g.text(x, 0, `  ${v.workspace} · every project`, { fg: "ink-3", bg });
  const live = v.status === "ready" ? "● live" : v.status === "error" ? "○ behind" : "◐ loading";
  g.text(g.w - 1 - widthOf(live), 0, live, { fg: v.status === "ready" ? "ink-2" : "warning", bg });
}

/** Paints the screen; returns the first line shown, which the app keeps for the next frame. */
export function paintActivity(v: ActivityScreen, size: { columns: number; rows: number }, allKeys = "all keys"): { grid: Grid; top: number } {
  const g = new Grid(size.columns, size.rows);
  paintHead(g, v);
  const from = 2;
  const height = Math.max(1, size.rows - 2 - from - 1);
  const lines = activityLines(v.days);
  const top = activityTop(v, height);
  const shown = lines.slice(top, top + height);
  const c = columns(g.w, v.days.flatMap((d) => d.items));
  shown.forEach((l, i) => {
    const y = from + i;
    if (l.kind === "day") {
      let x = g.text(2, y, l.label, { fg: "ink", at: "B" });
      if (l.totals) x = g.text(x + 2, y, l.totals, { fg: "ink-3" });
      g.run(x + 2, y, "─", g.w - 2 - x - 2, { fg: "rule-strong" });
    } else if (l.kind === "row") paintRow(g, y, c, l.item, l.index, l.index === v.selected);
    else if (l.kind === "wait") segs(g, c.title, y, l.item.waiting!, g.w - 2);
  });
  const end = endLine(v);
  if (end && top + height > lines.length) g.text(2, from + lines.length - top + (lines.length ? 1 : 0), end[0], end[1], g.w - 2);
  if (size.columns < 120) paintStatusNarrow(g, size.rows - 2, v.statusLine);
  else paintStatus(g, size.rows - 2, v.statusLine);
  paintKeys(g, size.rows - 1, v.keys, allKeys);
  return { grid: g, top };
}
