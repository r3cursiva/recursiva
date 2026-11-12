// The dispatch's two steps on screen (the artboards TuiContext and TuiDispatch): first what the owner adds that the
// issue does not say, then the agent, the model and the effort, with where the work goes and what comes after. Both
// float over the screen they were opened from, which goes faint. dispatch.ts does the work; this only draws it.
import { widthOf } from "@rsva/terminal/width";
import type { Grid, Pen } from "./grid.ts";
import { box, centre, fieldText, GAP, hints, labels, panel, segs, stateLine, wrapText, type LabelMark, type Priority, type Seg, type StateMark } from "./widgets.ts";

const P = "panel" as const;
const LABEL: Pen = { fg: "ink-3", bg: P };

/** Key hints in a row inside a panel, three cells apart. */
const row = (g: Grid, x: number, y: number, keys: [string, string][], end: number) => hints(g, x, y, keys, { gap: GAP.row, bg: P, end });

export interface ContextView {
  key: string;
  title: string;
  /** What is typed so far, and where the cursor is in it (a character offset). */
  text: string;
  cursor: number;
  max: number;
}

/** Step 1 of 2: a text field in the signal colour, its placeholder saying what helps, the count of characters left. */
export function paintContext(g: Grid, c: ContextView): void {
  const w = Math.min(84, g.w - 4);
  const h = 18;
  const { x, y } = centre(g, w, h);
  panel(g, x, y, w, h, {
    title: `Dispatch ${c.key}`,
    right: [
      ["1", { fg: "ink", at: "B" }],
      [" of 2 · context", { fg: "ink-3" }],
    ],
  });
  const ix = x + 3;
  const end = x + w - 3;
  g.text(ix, y + 2, c.title, { fg: "ink-2", bg: P }, end);
  const t = g.text(ix, y + 4, "Extra context for the agent", { fg: "ink", bg: P, at: "B" });
  g.text(t + 1, y + 4, "(optional)", LABEL);
  g.text(ix, y + 5, "The agent already gets the issue, its comments, relations and links.", LABEL, end);
  // The field: a box in the signal colour on the screen's ground, the cursor a cell of ink.
  const fx = ix;
  const fw = end - ix;
  const fy = y + 6;
  const rows = 6;
  g.fill(fx, fy, fw, rows + 2, "ground");
  box(g, fx, fy, fw, rows + 2, { pen: { fg: "accent", bg: "ground" }, note: { text: ` ${c.text.length} / ${c.max} `, pen: { fg: "ink-3", bg: "ground" }, end: fx + fw - 2 } });
  fieldText(g, fx + 2, fy + 1, fw - 5, rows, c.text, c.cursor, "Anything the issue doesn't say: approach, files to look at, constraints, acceptance criteria…", "ground", fx + fw - 2);
  row(
    g,
    ix,
    y + h - 3,
    [
      // Enter goes on and Shift+Enter is a new line, as in the web's fields (owner's decision 2026-11-05; the artboard has
      // ⌃↵ and ↵).
      ["↵", "next: model and effort"],
      ["⇧↵", "new line"],
      ["⌃E", "open in $EDITOR"],
      ["Esc", "back"],
    ],
    end,
  );
}

export interface DispatchPanelView {
  key: string;
  title: string;
  state: StateMark;
  priority: Priority;
  labels: LabelMark[];
  session: string;
  models: { name: string; on: boolean }[];
  efforts: { name: string; on: boolean }[];
  /** off, then the models; `off` marks the one that cannot be chosen: the curator's own. */
  executors: { name: string; on: boolean; off?: boolean }[];
  executorEffort: string;
  /** Which of the three choices has the keys: 0 model, 1 effort, 2 executor. */
  field: number;
  repo: string;
  branch: string;
  base: string;
  context: string;
}

/** A row of options, the chosen one in inverse: ` opus `; one that cannot be chosen faint. Returns where it ends. */
function options(g: Grid, x: number, y: number, list: { name: string; on: boolean; off?: boolean }[], end: number): number {
  for (const o of list) {
    x = g.text(x, y, ` ${o.name} `, o.on ? { fg: "inverse-ink", bg: "inverse", at: "B" } : o.off ? { fg: "faint", bg: P } : { fg: "ink-2", bg: P }, end);
    x += 1;
  }
  return x;
}

/** Step 2 of 2: who works on it and how hard, where the work goes, what comes after, the context; Launch. */
export function paintDispatchPanel(g: Grid, d: DispatchPanelView): void {
  const w = Math.min(96, g.w - 4);
  // 24 rows as the artboard has it; on a shorter screen the context gives up lines first, down to one.
  const h = Math.max(21, Math.min(24, g.h - 3));
  const { x, y } = centre(g, w, h);
  panel(g, x, y, w, h, {
    title: `Dispatch ${d.key}`,
    right: [
      ["2", { fg: "ink", at: "B" }],
      [" of 2", { fg: "ink-3" }],
    ],
  });
  const ix = x + 3;
  const end = x + w - 3;
  const vx = ix + 16;
  const badge = " auto mode ";
  g.text(end - 1 - widthOf(badge), y + 1, badge, { fg: "success", bg: "success-bg", at: "B" });
  g.text(ix, y + 1, d.title, { fg: "ink", bg: P, at: "B" }, end - 2 - widthOf(badge));
  const dot: Seg = ["  ·  ", { fg: "faint", bg: P }];
  const mx = segs(g, ix, y + 2, stateLine(d.state, d.priority, dot, P, true), end);
  if (d.labels.length) labels(g, segs(g, mx, y + 2, [dot], end), y + 2, d.labels, end, P);
  g.run(x + 1, y + 3, "─", w - 2, { fg: "rule", bg: P });
  const field = (row: number, label: string, focus: boolean) => {
    if (focus) g.text(x + 1, row, "▌", { fg: "accent", bg: P });
    g.text(ix, row, label, focus ? { fg: "ink", bg: P, at: "B" } : LABEL);
  };
  field(y + 5, "Rex session", false);
  g.text(vx, y + 5, d.session, { fg: "ink", bg: P }, end);
  // The artboard TuiDispatch has an Agent row here, Claude or site-dev; dispatch starts Claude only (PLNR-394), so the
  // choices move up a row and the executor (PLNR-388) takes the artboard's Effort row: the rule and the rows below stay
  // where the artboard has them. With an executor, Claude's model and effort are the curator's.
  const executor = d.executors.find((e) => e.on && e.name !== "off");
  field(y + 6, executor ? "Curator" : "Model", d.field === 0);
  options(g, vx - 1, y + 6, d.models, end);
  field(y + 7, "Effort", d.field === 1);
  options(g, vx - 1, y + 7, d.efforts, end);
  field(y + 8, "Executor", d.field === 2);
  const ex = options(g, vx - 1, y + 8, d.executors, end);
  if (executor) g.text(ex + 1, y + 8, `effort ${d.executorEffort} · Claude reviews its diff`, LABEL, end);
  g.run(ix, y + 9, "─", end - ix, { fg: "rule-soft", bg: P });
  field(y + 10, "Workspace", false);
  segs(g, vx, y + 10, [["own clone", { fg: "ink", bg: P }], [" · isolated, parallel-safe", LABEL]], end);
  field(y + 11, "Repository", false);
  g.text(vx, y + 11, d.repo, { fg: "ink", bg: P }, end);
  field(y + 12, "Branch", false);
  segs(g, vx, y + 12, [[`${d.branch} `, { fg: "ink", bg: P }], [` from ${d.base}`, LABEL]], end);
  field(y + 13, "Then", false);
  segs(g, vx, y + 13, [["draft PR ", { fg: "ink", bg: P }], ["→", LABEL], [" ", { fg: "ink", bg: P }], ["◐", { fg: "status-review", bg: P }], [" In Review", { fg: "ink", bg: P }]], end);
  g.run(ix, y + 14, "─", end - ix, { fg: "rule-soft", bg: P });
  field(y + 15, "Context", false);
  const lines = d.context ? wrapText(d.context, end - vx).slice(0, Math.max(1, Math.min(3, h - 21))) : [];
  lines.forEach((l, i) => g.text(vx, y + 15 + i, l, { fg: "ink-2", bg: P }, end));
  if (!lines.length) g.text(vx, y + 15, "none", { fg: "faint", bg: P });
  const ey = y + 15 + Math.max(1, lines.length);
  row(g, vx, ey, [["e", "edit"]], end);
  g.run(x + 1, y + h - 4, "─", w - 2, { fg: "rule", bg: P });
  const what = executor ? `Starts Claude with a ${executor.name} executor in a Rex session` : "Starts Claude in a new Rex session";
  g.text(ix, y + h - 3, `${what}; the issue moves to In Progress, delegated to Claude.`, LABEL, end);
  const bx = g.text(ix, y + h - 2, " ↵ Launch ", { fg: "inverse-ink", bg: "inverse", at: "B" });
  row(
    g,
    bx + 3,
    y + h - 2,
    [
      ["Tab", "next field"],
      ["h/l", "choose"],
      ["Esc", "back to context"],
    ],
    end,
  );
}

export type LaunchStep = { text: string; state: "done" | "running" | "pending" | "failed" | "skipped"; ms?: number };

export interface LaunchView {
  key: string;
  title: string;
  /** Who and where: "Claude · opus · high · ~/code/project". */
  who: string;
  steps: LaunchStep[];
  /** A frame of the spinner, for the running step and the border. */
  spinner: string;
  /** While running: the command being run. After a failure: what failed and why, and what was undone. */
  command: string | null;
  error: { title: string; detail: string; why: string } | null;
  undone: { text: string; ms: number }[];
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * The launch's log (TuiLaunch, TuiLaunchFailed): each step as it goes, and after a failure what to do next. A launch
 * that goes through closes itself, its result in the status line (owner's decision 2026-11-06): no TuiLaunchDone.
 */
export function paintLaunch(g: Grid, l: LaunchView): void {
  const failed = l.steps.findIndex((s) => s.state === "failed");
  const running = l.steps.findIndex((s) => s.state === "running");
  const w = Math.min(96, g.w - 4);
  const { x, y: panelY } = centre(g, w, 24);
  const tail = failed >= 0 ? 1 + 3 + 1 + 1 + l.undone.length + 2 : 6;
  const h = 5 + l.steps.length + tail + 2;
  // Where the dispatch panel was, as long as the log fits above the status line.
  const y = Math.max(1, Math.min(panelY, g.h - 2 - h));
  const right: [string, Pen][] =
    failed >= 0
      ? [[`✗ stopped at ${failed + 1} of ${l.steps.length}`, { fg: "error" }]]
      : [
          [l.spinner, { fg: "ink" }],
          [` ${running + 1} of ${l.steps.length}`, { fg: "ink-3" }],
        ];
  panel(g, x, y, w, h, { title: `Launch ${l.key}`, right });
  const ix = x + 3;
  const end = x + w - 3;
  const textEnd = end - 16;
  g.text(ix, y + 1, l.title, { fg: "ink-2", bg: P }, end);
  g.text(ix, y + 2, l.who, LABEL, end);
  g.run(x + 1, y + 3, "─", w - 2, { fg: "rule", bg: P });
  l.steps.forEach((s, i) => {
    const r = y + 5 + i;
    const [glyph, mark, text, time]: [string, Pen, Pen, Pen] =
      s.state === "done"
        ? ["✓", { fg: "success", bg: P }, { fg: "ink", bg: P }, LABEL]
        : s.state === "running"
          ? [l.spinner, { fg: "ink", bg: P, at: "B" }, { fg: "ink", bg: P, at: "B" }, { fg: "ink-2", bg: P }]
          : s.state === "failed"
            ? ["✗", { fg: "error", bg: P, at: "B" }, { fg: "error", bg: P, at: "B" }, { fg: "error", bg: P }]
            : s.state === "skipped"
              ? ["–", { fg: "faint", bg: P }, { fg: "faint", bg: P }, { fg: "faint", bg: P }]
              : ["·", { fg: "faint", bg: P }, LABEL, LABEL];
    g.text(ix, r, glyph, mark);
    g.text(ix + 2, r, s.text, text, textEnd);
    if (s.state === "skipped") g.textRight(end, r, "skipped", time);
    else if (s.ms !== undefined) g.textRight(end, r, secs(s.ms), time);
  });
  let r = y + 5 + l.steps.length + 1;
  if (failed >= 0) {
    g.fill(ix, r, end - ix, 3, "error-bg");
    if (l.error) {
      g.text(ix + 1, r, l.error.title, { fg: "error", bg: "error-bg", at: "B" }, end);
      g.text(ix + 1, r + 1, l.error.detail, { fg: "ink", bg: "error-bg" }, end);
      g.text(ix + 1, r + 2, l.error.why, { fg: "ink-2", bg: "error-bg" }, end);
    }
    r += 4;
    g.text(ix, r++, "Rolled back", { fg: "ink", bg: P, at: "B" });
    for (const u of l.undone) {
      g.text(ix, r, "↺", { fg: "ink-2", bg: P });
      g.text(ix + 2, r, u.text, { fg: "ink-2", bg: P }, textEnd);
      g.textRight(end, r++, secs(u.ms), LABEL);
    }
  } else {
    g.run(ix, r++, "─", end - ix, { fg: "rule-soft", bg: P });
    g.text(ix, r++, l.command ?? "", LABEL, end);
    r++;
    g.text(ix, r++, "You can close this; the launch goes on and its result lands in the status line.", LABEL, end);
  }
  const keys: [string, string][] =
    failed >= 0
      ? [
          ["r", "retry"],
          ["e", "edit and retry"],
          ["l", "full log"],
          ["y", "copy error"],
          ["Esc", "back"],
        ]
      : [
          ["Esc", "hide"],
          ["l", "full log"],
        ];
  row(g, ix, y + h - 2, keys, end);
}
