// The queue (g q, the artboard TuiQueue): the issues of a list one card at a time, to decide on each: dispatch it to
// Claude (d), approve it (→, Todo), skip it (←) or cancel it (c). linear-dispatch's "swipe", with what the planner adds:
// an issue an agent proposed says so, and dispatching or approving it is the owner's approval.
import { isProposalLabel } from "@rsva/policy";
import { mark, paintKeys, paintStatus } from "./bars.ts";
import { layoutDescription } from "./description.ts";
import { widthOf } from "@rsva/terminal/width";
import type { Grid, Pen } from "./grid.ts";
import type { Field, HomeView } from "./home.ts";
import { DRAG, helpOf, hintsOf, QUIT, type Binding } from "./keys.ts";
import { centre, hints, labels, panel, segs, stateLine, type LabelMark, type Priority, type Seg, type StateMark } from "./widgets.ts";

interface QueueCard {
  key: string;
  title: string;
  state: StateMark;
  priority: Priority;
  project: { key: string; name: string };
  labels: LabelMark[];
  /** Who filed it and how long ago. */
  filed: { by: string; ago: string } | null;
  /** An agent filed it and the owner has not approved it yet: the `proposed` label. */
  proposed: boolean;
  description: string;
  fields: Field[];
}

export type Mark = "dispatched" | "skipped" | "now" | "next";

export interface QueueView {
  /** What the queue goes through: "Backlog and proposed", a view's name, the query. */
  source: string;
  marks: Mark[];
  /** The keys of the cards after this one. */
  next: string[];
  card: QueueCard | null;
  status: HomeView["status"];
  keys: HomeView["keys"];
}

const BORDER: Pen = { fg: "ink-3", bg: "panel" };
const P = "panel" as const;

function head(g: Grid, q: QueueView): void {
  let x = g.text(mark(g), 0, "  Queue", { fg: "ink", bg: "sidebar" });
  g.text(x, 0, `  ${q.source}`, { fg: "ink-3", bg: "sidebar" });
  const at = q.marks.indexOf("now") + 1;
  const done = q.marks.filter((m) => m === "dispatched").length;
  const skipped = q.marks.filter((m) => m === "skipped").length;
  const parts: Seg[] = [
    ["card ", { fg: "ink-3" }],
    [String(at), { fg: "ink", at: "B" }],
    [`/${q.marks.length}`, { fg: "ink-3" }],
    ["   ", { fg: "ink" }],
    ["✓", { fg: "success" }],
    [` ${done} dispatched`, { fg: "ink-2" }],
    ["   ", { fg: "ink" }],
    ["✗", { fg: "ink-3" }],
    [` ${skipped} skipped`, { fg: "ink-2" }],
  ];
  x = g.w - 1 - parts.reduce((n, [t]) => n + widthOf(t), 0);
  segs(
    g,
    x,
    0,
    parts.map(([t, p]): Seg => [t, { ...p, bg: "sidebar" }]),
    g.w - 1,
  );
}

/** The cards so far and to come: ✓ dispatched, ✗ skipped, ■ this one, · the rest; then the next keys. */
function progress(g: Grid, y: number, x: number, q: QueueView): void {
  const glyph: Record<Mark, [string, Pen]> = { dispatched: ["✓", { fg: "success" }], skipped: ["✗", { fg: "faint" }], now: ["■", { fg: "ink" }], next: ["·", { fg: "faint" }] };
  q.marks.forEach((m, i) => g.text(x + i * 2, y, ...glyph[m]));
  if (q.next.length) g.text(x + q.marks.length * 2 + 1, y, `next: ${q.next.slice(0, 3).join(", ")}${q.next.length > 3 ? " …" : ""}`, { fg: "ink-3" }, g.w - 2);
}

/** The card's frame: its key in the top border, who filed it at the right (the floating panel's frame). */
function frame(g: Grid, x: number, y: number, w: number, h: number, c: QueueCard): void {
  const right: [string, Pen][] = c.filed
    ? [
        ["filed by ", BORDER],
        [c.filed.by, { fg: "ink-2", bg: P }],
        [` ${c.filed.ago}`, BORDER],
      ]
    : [];
  panel(g, x, y, w, h, { title: c.key, right });
}

/** The card's state line: state, priority, project, labels; `proposed` in the signal colour. */
function meta(g: Grid, x: number, y: number, c: QueueCard, end: number): void {
  const dot: Seg = ["  ·  ", { fg: "faint", bg: P }];
  let mx = segs(g, x, y, [...stateLine(c.state, c.priority, dot, P, true), dot, [c.project.key, { fg: "ink-2", bg: P }], [` ${c.project.name}`, { fg: "ink-3", bg: P }]], end);
  if (!c.labels.length) return;
  mx = segs(g, mx, y, [dot], end);
  const proposed = c.labels.filter((l) => isProposalLabel(l.name));
  if (proposed.length) {
    mx = g.text(mx, y, "▪", { fg: "accent", bg: P });
    mx = g.text(mx, y, " proposed", { fg: "accent-text", bg: P }, end);
    if (proposed.length < c.labels.length) mx += 2;
  }
  labels(
    g,
    mx,
    y,
    c.labels.filter((l) => !isProposalLabel(l.name)),
    end,
    P,
  );
}

const ACTIONS: [string, string][] = [
  ["d", "dispatch to Claude"],
  ["→", "approve · Todo"],
  ["←", "skip"],
  ["c", "cancel"],
];

/** What the queue's keys do to the card in front (flow.ts). */
export interface QueueMoves {
  back(): void;
  read(): void;
  dispatch(): void;
  approve(): void;
  skip(): void;
  cancel(): void;
  browse(): void;
  undo(): void;
}

/** The queue's keys: what they do, under the card and in the ? sheet. */
export const QUEUE_KEYS: readonly Binding<QueueMoves>[] = [
  { keys: ["enter"], hint: ["↵", "read"], help: ["↵", "read the whole issue"], run: (m) => m.read() },
  { keys: ["d"], hint: ["d", "dispatch"], help: ["d", "dispatch to Claude; approves a proposed one"], run: (m) => m.dispatch() },
  { keys: ["right"], hint: ["→", "approve"], help: ["→", "approve: Todo, without an agent"], run: (m) => m.approve() },
  { keys: ["left"], hint: ["←", "skip"], help: ["←", "skip: nothing changes"], run: (m) => m.skip() },
  { keys: ["c"], hint: ["c", "cancel"], help: ["c", "cancel the issue"], run: (m) => m.cancel() },
  { keys: ["o"], hint: ["o", "browser"], help: ["o", "open in the browser"], run: (m) => m.browse() },
  { keys: ["u"], hint: ["u", "undo last"], help: ["u", "undo the last decision"], run: (m) => m.undo() },
  { keys: ["esc"], hint: ["Esc", "back"], help: ["Esc", "back to the list"], run: (m) => m.back() },
  DRAG,
  QUIT,
];

/** The keys line under the card. */
export const QUEUE_HINTS = hintsOf(QUEUE_KEYS);
/** Every key of the queue, for the ? sheet. */
export const QUEUE_HELP = helpOf(QUEUE_KEYS);

/** `allKeys` empty: no "? all keys" (a dispatch's steps over the queue). */
export function paintQueue(g: Grid, q: QueueView, allKeys = "all keys"): void {
  head(g, q);
  const w = Math.min(100, g.w - 20);
  const { x } = centre(g, w, 0);
  progress(g, 2, x + 2, q);
  const c = q.card;
  const top = 4;
  const bottom = g.h - 4;
  const h = bottom - top + 1;
  if (c) {
    frame(g, x, top, w, h, c);
    const ix = x + 3;
    const end = x + w - 3;
    g.text(ix, top + 2, c.title, { fg: "ink", bg: P, at: "B" }, end);
    meta(g, ix, top + 3, c, end);
    let y = top + 5;
    if (c.proposed) {
      segs(g, ix, y, [["◐", { fg: "accent", bg: P }], [" ", { fg: "ink", bg: P }], ["Proposed by an agent. ", { fg: "accent-text", bg: P, at: "B" }], ["It waits for you to approve it (→) or cancel it (c).", { fg: "ink-2", bg: P }]], end);
      y += 1;
    }
    g.run(ix, y, "─", end - ix, { fg: "rule", bg: P });
    // From the bottom: the actions, two blank rows, the fields under a soft rule.
    const actionsY = bottom - 2;
    const fieldsY = actionsY - 2 - c.fields.reduce((n, f) => n + f.lines.length, 0);
    const ruleY = fieldsY - 1;
    const desc = layoutDescription(c.description, Math.min(76, end - ix));
    // Without fields there is no soft rule: the description runs down to the actions.
    const descEnd = c.fields.length ? ruleY - 1 : actionsY - 1;
    desc.slice(0, Math.max(0, descEnd - (y + 2))).forEach((d, i) => {
      const dy = y + 2 + i;
      if (d.ground) g.fill(ix, dy, end - ix, 1, d.ground);
      segs(
        g,
        ix,
        dy,
        d.segs.map(([t, p]): Seg => [t, { ...p, bg: p.bg ?? P }]),
        end,
      );
    });
    if (c.fields.length) {
      g.run(ix, ruleY, "─", end - ix, { fg: "rule-soft", bg: P });
      let fy = fieldsY;
      for (const f of c.fields)
        f.lines.forEach((l, i) => {
          if (!i) g.text(ix, fy, f.label, { fg: "ink-3", bg: P }, ix + 14);
          segs(
            g,
            ix + 14,
            fy++,
            l.map(([t, p]): Seg => [t, { ...p, bg: P }]),
            end,
          );
        });
    }
    // An action that does not fit whole is left out, not cut: the keys line under the card has them all.
    hints(g, ix, actionsY, ACTIONS, { gap: 4, cap: true, does: { fg: "ink-2", bg: P }, end, fit: end });
    // The two ways out at the sides, as linear-dispatch's swipe has them.
    const mid = Math.floor((top + bottom) / 2) - 2;
    const left = Math.floor(x / 2);
    const right = x + w + Math.floor((g.w - x - w) / 2) - 1;
    g.text(left, mid, "←", { fg: "ink-3" });
    g.text(left - 2, mid + 2, "skip", { fg: "ink-3" });
    g.text(right, mid, "→", { fg: "ink-3" });
    g.text(right - 1, mid + 2, "Todo", { fg: "ink-3" });
  } else g.text(x + 2, top + 1, "Nothing left in the queue.", { fg: "ink-3" });
  paintStatus(g, g.h - 2, q.status);
  paintKeys(g, g.h - 1, q.keys, allKeys);
}
