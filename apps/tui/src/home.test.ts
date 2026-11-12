// The home screen against the design canvas's artboard TuiHome (120×36), cell by cell: the same content painted by
// paintHome must give the artboard's characters, foregrounds, backgrounds and attributes. The artboard's grid is
// test/mockups/home.json, made by test/mockups/grid.py from the canvas (https://claude.ai/artifact/PrQL4FuVkNgd5xEeJqsu9b).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertLinear } from "@rsva/test-kit";
import { layoutDescription, READING_LOOK } from "./description.ts";
import { cardAnchor, paintHome, type HomeView } from "./home.ts";
import { stateLine, type Seg } from "./widgets.ts";
import { dimBehind, paintCreate, paintStatePicker } from "./panels.ts";
import { paintQuery } from "./query.ts";
import { ordered, paintPalette, search } from "./palette.ts";
import { Grid } from "./grid.ts";
import { paintQueue, QUEUE_HINTS, type QueueView } from "./queue.ts";
import { paintContext, paintDispatchPanel, paintLaunch, type LaunchStep, type LaunchView } from "./dispatch-screens.ts";

type Run = [text: string, fg: string, bg: string, at: string];
/**
 * An artboard's runs. The artboards' head says PLNR; the owner renamed the product recursiva (ADR 0039, PLNR-310), so the
 * mark is read as recursiva and the gap after it, before the right-hand side, is that much shorter.
 */
function mockup(name: string): Run[][] {
  const rows = JSON.parse(readFileSync(new URL(`../test/mockups/${name}.json`, import.meta.url), "utf8")) as Run[][];
  const head = rows[0]!;
  // The mark: a run of its own, or "■ PLNR" inside one (a screen gone faint). Not a project key in a query.
  const at = head.findIndex(([text]) => text === "PLNR" || text.includes("■ PLNR"));
  if (at < 0) return rows;
  const shorter = (text: string, from: number) => {
    const gap = text.slice(from).search(/ {5,}/);
    return gap < 0 ? null : text.slice(0, from + gap) + text.slice(from + gap + "recursiva".length - "PLNR".length);
  };
  const [text, ...style] = head[at]!;
  const renamed = text === "PLNR" ? "recursiva" : text.replace("■ PLNR", "■ recursiva");
  const same = shorter(renamed, renamed.indexOf("recursiva") + "recursiva".length);
  head[at] = [same ?? renamed, ...style] as Run;
  // The gap is in a later run when the head's parts are runs of their own.
  for (let i = at + 1; same === null && i < head.length; i++) {
    const later = shorter(head[i]![0], 0);
    if (later !== null) {
      head[i] = [later, ...head[i]!.slice(1)] as Run;
      break;
    }
  }
  return rows;
}

/** A painted row's characters. */
const textOf = (g: Grid, y: number) => Array.from({ length: g.w }, (_, x) => g.at(x, y).ch).join("");

/** The artboard as cells: a run's text is one cell per character; U+E000 is the second cell of a wide one. */
const cellsOf = (rows: Run[][]) => rows.map((runs) => runs.flatMap(([text, fg, bg, at]) => [...text].map((ch) => ({ ch: ch === "\ue000" ? "" : ch, fg, bg, at }))));

/**
 * Where the painted grid differs from the artboard. A space's colour is invisible: only its background and underline
 * count. `skip` names rows where the owner decided against the artboard.
 */
/**
 * The card's inside at 120×36, under its top border down to its bottom one with the count of lines left. The artboards
 * have the fields on the left and the description on the right, cut at two lines a paragraph; the card has the
 * description whole on the left (PLNR-397) and the issue screen's properties panel on the right (PLNR-398). A panel drawn
 * over the card is still compared; `the home card: the description on the left…` checks the card itself.
 */
const CARD_TEXT = { x: 2, from: 18, to: 33 } as const;

function diff(g: Grid, rows: Run[][], skip: number[] = [], card = false): string[] {
  const want = cellsOf(rows);
  const out: string[] = [];
  for (let y = 0; y < g.h; y++)
    if (!skip.includes(y))
    for (let x = 0; x < g.w; x++) {
      const a = g.at(x, y);
      const b = want[y]?.[x] ?? { ch: "?", fg: "?", bg: "?", at: "" };
      if (card && x >= CARD_TEXT.x && x < g.w - 2 && y >= CARD_TEXT.from && y <= CARD_TEXT.to && a.bg !== "panel" && b.bg !== "panel") continue;
      const blank = a.ch === " " && b.ch === " ";
      const same = a.ch === b.ch && a.bg === b.bg && (blank ? a.at.includes("U") === b.at.includes("U") : a.fg === b.fg && a.at === b.at);
      if (!same) out.push(`${y}:${x} got ${JSON.stringify([a.ch, a.fg, a.bg, a.at])} want ${JSON.stringify([b.ch, b.fg, b.bg, b.at])}`);
    }
  return out;
}

const L = (name: string, swatch: string) => ({ name, swatch }) as HomeView["groups"][number]["rows"][number]["labels"][number];

/** The artboard's content: the owner's issues on 2026-11-05 and a card for PLNR-305. */
const VIEW: HomeView = {
  head: { view: "My issues", workspace: "atlas", count: 7, query: "assignee:me state:open", running: 2, waiting: 1 },
  groups: [
    {
      state: { name: "In Progress", glyph: "◐", tone: "status-progress" },
      rows: [{ key: "PLNR-306", priority: 2, cycle: "C7", title: "TUI with agent dispatch: pick an issue and an agent, a new Rex session works on it", labels: [L("feature", "lb-indigo"), L("tooling", "lb-olive")], agent: { state: "running", text: "opus 4m", short: "4m" } }],
    },
    {
      state: { name: "In Review", glyph: "◐", tone: "status-review" },
      rows: [
        { key: "PLNR-305", priority: 3, cycle: "C7", title: "View panel docks beside the list on wide screens", labels: [L("improvement", "lb-teal"), L("views", "lb-slate")], agent: null },
        { key: "PLNR-304", priority: 3, cycle: "C7", title: "Keyboard navigation: Tab between areas and a shortcut sheet", labels: [L("feature", "lb-indigo"), L("ui-kit", "lb-plum")], agent: { state: "waits", text: "waits for you", short: "waits" } },
      ],
    },
    {
      state: { name: "Todo", glyph: "○", tone: "status-todo" },
      rows: [{ key: "INFRA-247", priority: 1, cycle: "C7", title: "Session tokens outlive a password reset on other devices.", labels: [L("security", "lb-clay")], agent: { state: "failed", text: "failed 3m", short: "failed" } }],
    },
    {
      state: { name: "Backlog", glyph: "◌", tone: "status-backlog" },
      rows: [
        { key: "LAS-8", priority: 0, cycle: null, title: "Fix the open redirect in /app/checkout", labels: [L("claude", "lb-umber")], agent: null },
        { key: "PLNR-289", priority: 4, cycle: null, title: "Test: reply to a Telegram notification", labels: [L("chore", "lb-steel"), L("notifications", "lb-moss")], agent: null },
        { key: "PLNR-298", priority: 4, cycle: "C8", title: "Ответ на уведомление 通知への返信 не доходит 📵, если ответить из шторки", labels: [L("notifications", "lb-moss")], agent: null },
      ],
    },
  ],
  selected: 1,
  top: 0,
  details: {
    project: { key: "PLNR", name: "recursiva", tile: ["ink", "row-selected"] },
    parent: { key: "PLNR-290", title: "Views" },
    assignees: [{ email: "a@acme.io", initials: "A", tone: "sage" }],
    delegate: null,
    cycle: { name: "C7", dates: "Nov 3 – 16", done: 4, total: 9 },
    relations: [],
    pulls: [],
    links: [],
    children: [],
    created: { day: "Oct 28", by: "a@acme.io" },
    updated: "12m ago",
  },
  card: {
    key: "PLNR-305",
    title: "View panel docks beside the list on wide screens",
    state: { name: "In Review", glyph: "◐", tone: "status-review" },
    priority: 3,
    cycle: { name: "C7", dates: "Nov 3 – 16" },
    updated: "updated 12m ago by bot@acme.dev",
    fields: [
      { label: "labels", lines: [[["▪", { fg: "lb-teal" }], [" improvement  ", { fg: "ink-2" }], ["▪", { fg: "lb-slate" }], [" views", { fg: "ink-2" }]]] },
      { label: "assignees", lines: [[["a@acme.io", { fg: "ink" }]]] },
      { label: "delegate", lines: [[["—", { fg: "faint" }], ["   d dispatches to an agent", { fg: "ink-3" }]]] },
      { label: "parent", lines: [[["PLNR-290", { fg: "ink-3" }], ["  Views: saved, shared and docked", { fg: "ink" }]]] },
      { label: "relations", lines: [[["blocks ", { fg: "ink-3" }], ["PLNR-307", { fg: "ink-2" }], ["  related ", { fg: "ink-3" }], ["PLNR-304", { fg: "ink-2" }]]] },
      { label: "links", lines: [[["Figma", { fg: "ink", at: "U" }], ["  View panel, wide screens", { fg: "ink-3" }]]] },
      {
        label: "pull requests",
        lines: [
          [["#412", { fg: "ink-2" }], [" Dock the view panel", { fg: "ink" }], ["  draft", { fg: "ink-3" }]],
          [["✓", { fg: "success" }], [" checks 14/14  +214 −38", { fg: "ink-3" }]],
        ],
      },
      { label: "project", lines: [[["PLNR", { fg: "ink-2" }], ["  recursiva", { fg: "ink-3" }]]] },
      { label: "created", lines: [[["Oct 28", { fg: "ink-2" }], ["  by a@acme.io", { fg: "ink-3" }]]] },
    ],
    description: [
      "## Why",
      "On screens 1600 px and wider the view panel covers a third of the list. Docked beside it, both stay readable at once.",
      "",
      "## Done when",
      "- [x] At 1600 px and wider the panel docks right of the list",
      "- [x] The title column shrinks first, labels go last",
      "- [ ] Docked width is remembered per view",
      "- [ ] ⌘\\ switches between docked and floating",
      "",
      "```",
      "--view-panel-width: clamp(360px, 28vw, 520px);",
      "```",
      "See [the docked layout in Figma](https://figma.com/x) and PLNR-304.",
      ...Array.from({ length: 9 }, (_, i) => `- line ${i + 1}`),
    ].join("\n"),
    brief: { labels: [L("improvement", "lb-teal"), L("views", "lb-slate")], assignee: "a@acme.io", pr: { number: 412, state: "draft", checks: "pass" }, parent: "PLNR-290", relations: 2 },
  },
  status: { connection: "online", message: [["PLNR-304", { fg: "ink-3" }], [" → In Review by bot@acme.dev", { fg: "ink-2" }], ["  2m ago", { fg: "ink-3" }]], brief: "PLNR-304 → In Review", session: "plnr", time: "14:32" },
  keys: [
    ["j/k", "move"],
    ["/", "filter"],
    ["s", "state"],
    ["p", "priority"],
    ["a", "assignee"],
    ["l", "labels"],
    ["d", "dispatch"],
    ["g q", "queue"],
    ["g a", "agents"],
  ],
  keysNarrow: [
    ["j/k", "move"],
    ["/", "filter"],
    ["s", "state"],
    ["d", "dispatch"],
    ["⌘K", "all"],
  ],
};

test("the home screen is the artboard TuiHome, cell by cell", () => {
  const { grid } = paintHome(VIEW, { columns: 120, rows: 36 });
  const wrong = diff(grid, mockup("home"), [], true);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("the home card: the description on the left, whole, to the issue screen's measure; the issue screen's properties on the right (PLNR-397, PLNR-398)", () => {
  const { grid } = paintHome(VIEW, { columns: 120, rows: 36 });
  const text = (y: number) => Array.from({ length: 116 }, (_, i) => grid.at(2 + i, y).ch).join("").trimEnd();
  assert.deepEqual(Array.from({ length: 16 }, (_, i) => text(18 + i)), [
    " View panel docks beside the list on wide screens                               │ PROPERTIES",
    " ◐ In Review  ·  ▂▄▆ Medium  ·  C7 Nov 3 – 16  ·  updated 12m ago by bot@acme…  │",
    "                                                                                │ State      ◐ In Review",
    " ## Why                                                                         │ Priority   ▂▄▆ Medium",
    " On screens 1600 px and wider the view panel covers a third of the list.        │ Cycle      C7 Nov 3 – 16",
    " Docked beside it, both stay readable at once.                                  │            ██████████ 4/9",
    "                                                                                │ Assignee   A a@acme.io",
    " ## Done when                                                                   │ Delegate   —   d dispatches",
    " [✓] At 1600 px and wider the panel docks right of the list                     │ Labels     ▪ improvement",
    " [✓] The title column shrinks first, labels go last                             │            ▪ views",
    " [ ] Docked width is remembered per view                                        │ Project    PLNR  recursiva",
    " [ ] ⌘\\ switches between docked and floating                                    │ Parent     PLNR-290",
    "                                                                                │            Views",
    "  --view-panel-width: clamp(360px, 28vw, 520px);                                │",
    " See the docked layout in Figma and PLNR-304.                                   │ … 2 more lines: ↵ opens the issue",
    "──────────────────────────────────────────────────────────────── ↓ 9 more lines ────────────────────────────────────",
  ]);
});

test("wider than 120 columns the title takes the room, the labels and the agent move right with it, the group's rule runs on", () => {
  const { grid } = paintHome(VIEW, { columns: 200, rows: 36 });
  const y = [...Array(grid.h).keys()].find((r) => textOf(grid, r).includes("PLNR-306"))!;
  const row = textOf(grid, y);
  assert.ok(row.includes("TUI with agent dispatch: pick an issue and an agent, a new Rex session works on it"), "not cut at 50");
  assert.equal(row.indexOf("feature") - 2, 74 + 80, "the labels moved by the 80 extra columns");
  assert.ok(row.indexOf("opus 4m") >= 102 + 80);
  const header = [...Array(grid.h).keys()].find((r) => textOf(grid, r).includes("In Progress"))!;
  assert.equal(textOf(grid, header).trimEnd().length, 118 + 80);
});

test("at 80×24 the screen is the artboard TuiHome80: fewer columns, the card folded", () => {
  const { grid } = paintHome(VIEW, { columns: 80, rows: 24 });
  // Row 16, the card's top border: the artboard's "↵ unfold" is "↵ open", Enter opens the issue screen (owner's decision
  // 2026-11-06).
  const wrong = diff(grid, mockup("home80"), [16]);
  assert.match(textOf(grid, 16), /─ ↵ open ─╮ $/);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("between 80 and 120 columns the title takes the room before the agent, which stays 10 cells from the edge", () => {
  const at = (columns: number) => {
    const { grid } = paintHome(VIEW, { columns, rows: 24 });
    const y = [...Array(grid.h).keys()].find((r) => textOf(grid, r).includes("PLNR-306"))!;
    return textOf(grid, y);
  };
  const title = "TUI with agent dispatch: pick an issue and an agent, a new Rex session works on it";
  assert.ok(!at(80).includes(title.slice(0, 60)), "at 80 it is still cut at 51");
  assert.ok(at(109).includes(title.slice(0, 75)), "at 109 it runs to the agent");
  assert.equal(at(109).lastIndexOf("4m") - 2, 109 - 10, "the agent moved with the right edge");
});

const STATES = [
  { id: "b", name: "Backlog", glyph: "◌", tone: "status-backlog" },
  { id: "t", name: "Todo", glyph: "○", tone: "status-todo" },
  { id: "p", name: "In Progress", glyph: "◐", tone: "status-progress" },
  { id: "r", name: "In Review", glyph: "◐", tone: "status-review" },
  { id: "a", name: "Approved", glyph: "◐", tone: "status-approved" },
  { id: "d", name: "Done", glyph: "●", tone: "status-done" },
  { id: "c", name: "Canceled", glyph: "✕", tone: "status-canceled" },
] as const;

test("the state picker is the artboard TuiStatePicker: over the card, the screen behind it faint", () => {
  const size = { columns: 120, rows: 36 };
  const view: HomeView = {
    ...VIEW,
    status: { ...VIEW.status, message: [["PLNR-305 is In Review", { fg: "ink-2" }]] },
    keys: [
      ["j/k", "move"],
      ["1–7", "pick"],
      ["↵", "set"],
      ["Esc", "back"],
    ],
  };
  const { grid } = paintHome(view, size);
  dimBehind(grid);
  paintStatePicker(grid, { states: [...STATES], current: "r", filter: "", at: 3 }, "PLNR-305", cardAnchor(size));
  const wrong = diff(grid, mockup("state-picker"), [], true);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("typing a query is the artboard TuiQuery: the query line, its completions, the list narrowed behind", () => {
  const size = { columns: 120, rows: 36 };
  const view: HomeView = {
    ...VIEW,
    groups: VIEW.groups.slice(0, 2),
    listFocus: false,
    status: { ...VIEW.status, message: [["narrowing as you type · ", { fg: "ink-3" }], ['state:"In Progress"', { fg: "ink-2" }], [" or ", { fg: "ink-3" }], ['state:"In Review"', { fg: "ink-2" }]] },
    keys: [
      ["Tab", "complete"],
      ["↑/↓", "suggestion"],
      ["↵", "apply"],
      ["⌃U", "clear"],
      ["⌃S", "save as view"],
      ["Esc", "cancel"],
    ],
  };
  const { grid } = paintHome(view, size, "query syntax");
  paintQuery(grid, {
    draft: 'project:PLNR state:"In ',
    right: "3 of 7",
    typing: {
      key: "state",
      start: 19,
      end: 23,
      at: 0,
      values: [
        { label: "In Progress", text: '"In Progress"', mark: STATES[2], count: 1 },
        { label: "In Review", text: '"In Review"', mark: STATES[3], count: 2 },
      ],
    },
    also: [
      ["label", ["bug", "feature", "ui-kit", "views", "improvement"]],
      ["priority", ["urgent", "high", "medium", "low"]],
      ["cycle", ["C7", "C8", "none"]],
      ["assignee", ["me", "a@acme.io", "bot@acme.dev"]],
    ],
  });
  const wrong = diff(grid, mockup("query"), [], true);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("on a short screen the completions stop above the status line: the keys to try go first, then the values scroll (RSVA-458)", () => {
  const values = ["updated", "created", "priority", "due", "start", "manual"].map((label) => ({ label, text: label, mark: null, count: null }));
  const also: [string, string[]][] = [
    ["label", ["bug"]],
    ["cycle", ["C7"]],
  ];
  const paint = (rows: number, at: number) => {
    const g = new Grid(80, rows);
    paintQuery(g, { draft: "order:", right: "7 of 7", typing: { key: "order", start: 6, end: 6, values, at }, also });
    return Array.from({ length: rows }, (_, y) => Array.from({ length: g.w }, (_, x) => g.at(x, y).ch).join(""));
  };
  // Tall enough: six values, a blank, "also" and its two keys.
  const tall = paint(24, 0);
  assert.equal(tall.findIndex((r) => r.includes("╰")), 1 + 6 + 2 + 2 + 3 - 1);
  assert.ok(tall.some((r) => r.includes("also")));
  for (const [rows, at, first, last] of [
    [10, 0, "updated", "due"],
    [10, 5, "priority", "manual"],
    [7, 5, "manual", "manual"],
  ] as const) {
    const lines = paint(rows, at);
    const bottom = lines.findIndex((r) => r.includes("╰"));
    assert.ok(bottom > 0 && bottom <= rows - 3, `${rows} rows: the panel ends at ${bottom}`);
    assert.ok(!lines.some((r) => r.includes("also")), `${rows} rows: no room for the keys to try`);
    const shown = lines.slice(2, bottom).flatMap((r) => /[a-z]+/.exec(r) ?? []);
    assert.deepEqual([shown[0], shown.at(-1)], [first, last], `${rows} rows, the cursor on ${values[at]!.label}`);
  }
});

const QUEUE: QueueView = {
  source: "Backlog and proposed",
  marks: ["dispatched", "skipped", "skipped", "dispatched", "skipped", "skipped", "now", ...Array.from({ length: 10 }, () => "next" as const)],
  next: ["PLNR-289", "PLNR-298", "INFRA-252", "OSYS-20"],
  card: {
    key: "LAS-8",
    title: "Fix the open redirect in /app/checkout",
    state: STATES[0],
    priority: 0,
    project: { key: "LAS", name: "Lantern" },
    labels: [L("proposed", "accent"), L("claude", "lb-umber")],
    filed: { by: "bot@acme.dev", ago: "2h ago" },
    proposed: true,
    description: [
      "## What happens",
      "`/app/checkout` takes any URL in `?to=` and redirects to it after sign-in, so a link on acme.co.uk can send a signed-in user to any site.",
      "",
      "## Steps",
      "1. Open [acme.co.uk/app/checkout?to=https://example.org](https://acme.co.uk/app/checkout?to=https://example.org)",
      "2. Sign in. You land on example.org.",
      "",
      "## Proposed fix",
      "- Accept only same-origin paths that start with `/`, reject `//` and schemes",
      "- Fall back to `/` when the target is rejected",
      "- [ ] Test with an absolute URL, `//example.org` and `/%2F%2Fexample.org`",
    ].join("\n"),
    fields: [
      { label: "relations", lines: [[["related ", { fg: "ink-3" }], ["LAS-3  Sign-in keeps the ?to parameter", { fg: "ink-2" }]]] },
      { label: "found in", lines: [[["security sweep · session plnr-280-audit-redirects", { fg: "ink-2" }]]] },
    ],
  },
  status: { ...VIEW.status, message: [["✓", { fg: "success" }], [" PLNR-302 dispatched to Claude · opus", { fg: "ink-2" }], ["  1m ago", { fg: "ink-3" }]] },
  // The artboard's keys: "↵ read" (the issue screen, owner's decision 2026-11-06) came after it.
  keys: QUEUE_HINTS.filter(([k]) => k !== "↵"),
};

test("the queue is the artboard TuiQueue: one card at a time, the way out on each side", () => {
  const grid = new Grid(120, 36);
  paintQueue(grid, QUEUE);
  // Row 9, the proposal's line: the artboard says such an issue "stays out of every view until you approve it",
  // which no view does; the queue says it waits for the owner.
  const wrong = diff(grid, mockup("queue"), [9]);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("the queue's similar field (PLNR-295) joins the card's fields at the bottom: the rows above and under it stay the artboard's", () => {
  const similar = { label: "similar", lines: [[["LAS-3", { fg: "ink-2" }], ["  Sign-in keeps the ?to parameter", { fg: "ink-3" }]] as Seg[], [["LAS-5", { fg: "ink-2" }], ["  Open redirect on the checkout page", { fg: "ink-3" }]] as Seg[]] };
  const grid = new Grid(120, 36);
  paintQueue(grid, { ...QUEUE, card: { ...QUEUE.card!, fields: [...QUEUE.card!.fields, similar] } });
  // The fields grow upwards from the actions: two more lines move the soft rule up three rows (the label's line and its
  // second line, then the rule itself) and the description ends sooner; everything from the actions down is where it was.
  const changed = new Set(diff(grid, mockup("queue"), [9]).map((d) => Number(d.split(":")[0])));
  assert.deepEqual([...changed].filter((y) => y < 20 || y > 29), [], "the card above its description's tail and the actions below are the artboard's");
  const rows = Array.from({ length: 36 }, (_, y) => textOf(grid, y));
  const at = rows.findIndex((r) => r.includes("similar") && r.includes("LAS-3"));
  assert.ok(at > 20 && at < 30, `the field is at the bottom of the card, row ${at}`);
  assert.match(rows[at]!, /similar +LAS-3  Sign-in keeps the \?to parameter/);
  assert.match(rows[at + 1]!, /LAS-5  Open redirect on the checkout page/);
  assert.match(rows.join("\n"), /found in +security sweep/, "the artboard's own fields are still there");
});

test("the context step is the artboard TuiContext: a field over the queue gone faint", () => {
  const grid = new Grid(120, 36);
  paintQueue(grid, {
    ...QUEUE,
    status: { ...QUEUE.status, message: [["writing context for LAS-8", { fg: "ink-3" }]] },
    keys: [
      ["⌃↵", "next"],
      ["↵", "new line"],
      ["⌃E", "$EDITOR"],
      ["Esc", "back"],
    ],
  });
  dimBehind(grid);
  paintContext(grid, { key: "LAS-8", title: "Fix the open redirect in /app/checkout", text: "", cursor: 0, max: 4000 });
  // Row 23, the keys in the panel: Enter goes on and Shift+Enter is a new line, as in the web (owner's decision
  // 2026-11-05); the artboard has ⌃↵ and ↵. Row 9 is the queue's proposal line behind it (see the queue's test).
  const wrong = diff(grid, mockup("context"), [9, 23]);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("the dispatch step is the artboard TuiDispatch: model, effort, executor, where the work goes, Launch", () => {
  const size = { columns: 120, rows: 36 };
  const { grid } = paintHome(
    {
      ...VIEW,
      status: { ...VIEW.status, message: [["remembered: opus · high for PLNR", { fg: "ink-3" }]] },
      keys: [
        ["Tab", "field"],
        ["h/l", "choose"],
        ["↵", "launch"],
        ["Esc", "back"],
      ],
    },
    size,
  );
  dimBehind(grid);
  paintDispatchPanel(grid, {
    key: "PLNR-305",
    title: "View panel docks beside the list on wide screens",
    state: STATES[3],
    priority: 3,
    labels: [L("improvement", "lb-teal"), L("views", "lb-slate")],
    session: "plnr-305-view-panel-docks-beside-the-list",
    models: ["fable", "opus", "sonnet"].map((name) => ({ name, on: name === "opus" })),
    efforts: ["low", "medium", "high", "xhigh", "max"].map((name) => ({ name, on: name === "high" })),
    executors: ["off", "fable", "opus", "sonnet"].map((name) => ({ name, on: name === "off", off: name === "opus" })),
    executorEffort: "high",
    field: 0,
    repo: "~/code/project",
    branch: "plnr-305-view-panel-docks-beside-the-list",
    base: "origin/main",
    context: "Dock only at 1600 px and wider; below that keep the floating panel as it is. Start from src/views/ViewPanel.tsx and layout.css. Don't touch the board layout.",
  });
  // Rows 11-13, Model, Effort and Executor: the artboard has Agent (Claude or site-dev), Model and Effort; dispatch starts
  // Claude only (PLNR-394) and may give it a cheaper executor (PLNR-388), so the choices move up a row.
  // Row 15, Workspace: each agent gets its own clone, not a git worktree (security review of PR #203: a worktree's agent
  // writes the repository's shared .git).
  const wrong = diff(grid, mockup("dispatch"), [11, 12, 13, 15], true);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

const BRANCH = "plnr-305-view-panel-docks-beside-the-list";
const STEP_TEXTS = ["fetch origin", `create worktree .claude/worktrees/${BRANCH}`, "install dependencies", `Rex session ${BRANCH}`, "Claude started · opus · high · auto mode", "PLNR-305 → In Progress, delegated to Claude"];
const steps = (states: LaunchStep["state"][], ms: (number | undefined)[]): LaunchStep[] => STEP_TEXTS.map((text, i) => ({ text, state: states[i]!, ...(ms[i] !== undefined ? { ms: ms[i] } : {}) }));
const LAUNCH: Omit<LaunchView, "steps"> = {
  key: "PLNR-305",
  title: "View panel docks beside the list on wide screens",
  who: "Claude · opus · high · ~/code/project",
  spinner: "⠹",
  command: `rex new-session -d -s ${BRANCH} -c ~/code/project/.claude/worktrees/${BRANCH} claude --model opus`,
  error: null,
  undone: [],
};

/** The home screen gone faint under a panel, with the status and keys of the step. */
function under(message: Seg[], keys: HomeView["keys"]) {
  const { grid } = paintHome({ ...VIEW, status: { ...VIEW.status, message }, keys }, { columns: 120, rows: 36 });
  dimBehind(grid);
  return grid;
}

test("the launch log, running, is the artboard TuiLaunch", () => {
  const grid = under(
    [
      ["⠹", { fg: "ink" }],
      [" launching PLNR-305 · Rex session", { fg: "ink-2" }],
    ],
    [
      ["Esc", "hide"],
      ["l", "full log"],
    ],
  );
  paintLaunch(grid, { ...LAUNCH, steps: steps(["done", "done", "done", "running", "pending", "pending"], [800, 300, 11600, 100]) });
  const wrong = diff(grid, mockup("launch"), [], true);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("the launch log, failed and rolled back, is the artboard TuiLaunchFailed", () => {
  const grid = under(
    [["✗ Launch failed at install dependencies · rolled back", { fg: "error" }]],
    [
      ["r", "retry"],
      ["e", "edit"],
      ["l", "log"],
      ["Esc", "back"],
    ],
  );
  paintLaunch(grid, {
    ...LAUNCH,
    steps: steps(["done", "done", "failed", "skipped", "skipped", "skipped"], [800, 300, 24100]),
    error: { title: "pnpm install exited with 1", detail: "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@rsva%2fui-kit: Not Found - 404", why: "The lockfile names @rsva/ui-kit 0.9.2, which is not published yet." },
    undone: [
      { text: `worktree removed  .claude/worktrees/${BRANCH}`, ms: 200 },
      { text: `branch ${BRANCH} deleted`, ms: 0 },
      { text: "PLNR-305 state restored → In Review, not delegated", ms: 100 },
    ],
  });
  const wrong = diff(grid, mockup("launch-failed"), [], true);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("the palette is the artboard TuiPalette: commands, issues, views and places in one list", () => {
  const grid = under(
    [["commands and issues · fuzzy", { fg: "ink-3" }]],
    [
      ["↑/↓", "choose"],
      ["↵", "run"],
      ["Esc", "close"],
    ],
  );
  paintPalette(grid, {
    query: "disp",
    at: 0,
    found: 9,
    entries: [
      { section: "COMMANDS", label: "Dispatch PLNR-305 to an agent…", shortcut: "d", match: [0, 4] },
      { section: "COMMANDS", label: "Dispatch queue: Backlog and proposed", shortcut: "g q", match: [0, 4] },
      { section: "COMMANDS", label: "Show agents and their sessions", shortcut: "g a" },
      { section: "COMMANDS", label: "Stop an agent… ", detail: "PLNR-306 opus 4m", shortcut: "x" },
      { section: "ISSUES", label: "TUI with agent dispatch: pick an issue and an agent, a new Rex session works on it", issue: { key: "PLNR-306", mark: STATES[2] }, shortcut: "↵", match: [15, 19] },
      { section: "ISSUES", label: "Dispatch log: keep the last 50 launches", issue: { key: "PLNR-308", mark: STATES[1] }, shortcut: "↵" },
      { section: "ISSUES", label: "Mail dispatcher retries with backoff", issue: { key: "INFRA-231", mark: STATES[5] }, shortcut: "↵", match: [5, 9] },
      { section: "VIEWS", label: "Delegated to agents", detail: "delegate:any state:open", shortcut: "g v" },
      { section: "GO TO", label: "Rex session ", detail: "plnr-306-tui-with-agent-dispatch" },
      { section: "GO TO", label: "Settings › Agents and keys", shortcut: "g ," },
    ],
  });
  const wrong = diff(grid, mockup("palette"), [], true);
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} cells differ`);
});

test("the palette's search: a label that starts with the query first, then a word that does, then the rest (PLNR-401)", () => {
  const e = (label: string) => ({ section: "COMMANDS" as const, label });
  const found = search([e("Dispatch queue: project:PLNR order:due"), e("Reorder projects"), e("Order issues by…"), e("Quit")], "order");
  assert.deepEqual(found.map((x) => x.label), ["Order issues by…", "Dispatch queue: project:PLNR order:due", "Reorder projects"]);
  assert.deepEqual(found[1]!.match, [29, 34], "where it matched, as before");
});

test("the palette's search: every word of the query, in any order, as the web's (RSVA-430)", () => {
  const e = (label: string) => ({ section: "COMMANDS" as const, label });
  const found = search([e("Order issues by…"), e("Backup the postgres base"), e("Postgres only")], "postgres backup");
  assert.deepEqual(found.map((x) => x.label), ["Backup the postgres base"]);
  assert.deepEqual(found[0]!.match, [11, 19], "the first word the label has is underlined");
});

test("the palette's search: a typed key in TOP HIT, out of its section, as in the web (PLNR-437)", () => {
  const mark = STATES[1]!;
  const entries = [
    { section: "COMMANDS" as const, label: "PLNR cycles" },
    { section: "ISSUES" as const, label: "Toast on a phone", issue: { key: "PLNR-435", mark } },
    { section: "ISSUES" as const, label: "Palette keys", issue: { key: "PLNR-437", mark } },
    { section: "GO TO" as const, label: "Project PLANE · Plane fork", project: "PLANE" },
    { section: "GO TO" as const, label: "Project PLNR · recursiva", project: "PLNR" },
  ];
  const at = (q: string) => ordered(search(entries, q)).map((e) => `${e.section}: ${e.label}`);
  assert.deepEqual(at("plnr"), ["TOP HIT: Project PLNR · recursiva", "COMMANDS: PLNR cycles", "ISSUES: Toast on a phone", "ISSUES: Palette keys"]);
  assert.deepEqual(at("pl").slice(0, 2), ["TOP HIT: Project PLANE · Plane fork", "TOP HIT: Project PLNR · recursiva"]);
  assert.deepEqual(at("p")[0], "COMMANDS: PLNR cycles", "one letter: no top hit");
  assert.deepEqual(at("plnr-435"), ["TOP HIT: Toast on a phone"]);
  assert.deepEqual(search(entries, "plnr")[0]!.match, [8, 12], "the key is still underlined");
});

test("a page of the palette (PLNR-380): the chip says whose and what, the value in use checked, a priority's bars, Esc back", () => {
  const grid = new Grid(120, 36);
  paintPalette(grid, {
    query: "",
    at: 1,
    found: 3,
    scope: { key: "PLNR-305", name: "Priority" },
    entries: [
      { section: "PRIORITIES", label: "Urgent", priority: 1 },
      { section: "PRIORITIES", label: "High", priority: 2, checked: true },
      { section: "PRIORITIES", label: "No priority", priority: 0 },
    ],
  });
  const rows = Array.from({ length: 36 }, (_, y) => textOf(grid, y));
  const field = rows.find((r) => r.includes("›"))!;
  assert.match(field, /›  PLNR-305 Priority {4}Select priority…/);
  const chip = field.indexOf("PLNR-305");
  assert.equal(grid.at(chip, rows.indexOf(field)).bg, "row-selected");
  assert.equal(grid.at(chip + 9, rows.indexOf(field)).at, "B");
  assert.ok(rows.some((r) => r.includes("PRIORITIES")));
  const high = rows.findIndex((r) => r.includes("▂▄▆ High"));
  assert.ok(high > 0, "High after its bars");
  assert.match(rows[high]!, /High +✓ │/);
  assert.equal(grid.at(rows[high]!.indexOf("✓"), high).fg, "accent");
  assert.ok(rows.some((r) => r.includes(" !  Urgent")));
  assert.ok(rows.some((r) => r.includes("···  No priority") || r.includes("··· No priority")));
  assert.ok(rows.some((r) => r.includes("↵ pick") && r.includes("Esc all commands") && r.includes("3 results")));
});

test("the description: headings, a paragraph whole (PLNR-397: no longer two lines at most), tasks and code", () => {
  const lines = layoutDescription("## Why\nOne two three four five six seven eight nine ten.\n\n- [x] Done\n```\ncode\n```", 20).map((l) => l.segs.map(([t]) => t).join(""));
  assert.deepEqual(lines, ["## Why", "One two three four", "five six seven eight", "nine ten.", "", "[✓] Done", " code"]);
});

test("the description: a table as columns, the header over a rule, the widest column narrowed to fit", () => {
  const md = "| # | What | Risk |\n| --- | :--- | ---: |\n| 1 | Repo and app skeleton | 0 |\n| 2 | Voter list \\| import | 0 (code) |\n\nafter";
  const lines = (room: number) => layoutDescription(md, room).map((l) => l.segs.map(([t]) => t).join(""));
  assert.deepEqual(lines(60), [
    "# │ What                  │ Risk",
    "──┼───────────────────────┼─────────",
    "1 │ Repo and app skeleton │ 0",
    "2 │ Voter list | import   │ 0 (code)",
    "",
    "after",
  ]);
  assert.deepEqual(lines(30).slice(2, 4), ["1 │ Repo and app s… │ 0", "2 │ Voter list | i… │ 0 (code)"]);
});

test("the description: a | line without a delimiter row is text, a table at most 64 columns, laid out in linear time", () => {
  assert.deepEqual(layoutDescription("| not a table |\nmore", 40).map((l) => l.segs.map(([t]) => t).join("")), ["| not a table | more"]);
  const wide = layoutDescription(`|${"a|".repeat(500)}\n|${"-|".repeat(500)}`, 80);
  assert.equal(wide[0]!.segs.filter(([t]) => t === " │ ").length, 63);
  // Linear against itself (PLNR-190): the narrowing was a step per cell over every column.
  assertLinear("table rows", (n) => `|${"a|".repeat(64)}\n|${"-|".repeat(64)}\n` + `|${"x".repeat(200)}|\n`.repeat(n / 200), (md: string) => layoutDescription(md, 80), 200_000);
});

test("a comment's text is laid out in linear time (RSVA-621): a failed link or autolink is not retried from every opener in it", () => {
  // Each shape took 0.3 to 2.6 s at the comment limit (COMMENT_MAX, 64 KB) on every repaint of the issue screen.
  const shapes: Record<string, (n: number) => string> = {
    "[ then ]": (n) => "[".repeat(n / 2) + "]".repeat(n / 2),
    "[": (n) => "[".repeat(n),
    "![": (n) => "![".repeat(n / 2),
    "[`a": (n) => "[`a".repeat(n / 3),
    "<http://": (n) => "<http://".repeat(n / 8),
    "|- and spaces": (n) => `| a |\n|-${" ".repeat(n)}x`,
  };
  for (const [name, shape] of Object.entries(shapes)) {
    assertLinear(name, shape, (md: string) => layoutDescription(md, 80, READING_LOOK), 65_536);
    assertLinear(`${name} on the card`, shape, (md: string) => layoutDescription(md, 80), 65_536);
  }
});

test("a click is the keys of what it lands on (PLNR-383): a row, a key hint, the card's actions; a panel's rows over what is behind it", () => {
  const { grid } = paintHome(VIEW, { columns: 120, rows: 36 });
  const find = (text: string) => {
    const y = [...Array(grid.h).keys()].find((r) => textOf(grid, r).includes(text))!;
    return { x: textOf(grid, y).indexOf(text), y };
  };
  const row = find("PLNR-304");
  assert.deepEqual(grid.keysAt(row.x, row.y), ["row:2"], "the third row, wherever on it");
  assert.deepEqual(grid.keysAt(110, row.y), ["row:2"]);
  assert.deepEqual(grid.keysAt(2, find("In Review").y), [], "a group's header is not a row");
  const keys = grid.h - 1;
  const at = (text: string) => grid.keysAt(textOf(grid, keys).indexOf(text), keys);
  assert.deepEqual([at("filter"), at("state"), at("move"), at("all")], [["/"], ["s"], [], ["?"]], "j/k says how to move: nothing to press");
  const queue = textOf(grid, keys).indexOf("g q");
  assert.deepEqual(grid.keysAt(queue + 4, keys), ["g", "q"], "a chord: both keys, its words too");
  const edit = find("e edit");
  assert.deepEqual(grid.keysAt(edit.x + 2, edit.y), ["e"]);

  // The state picker over the screen: its rows pick, the dimmed list behind it takes nothing, the keys line stays.
  dimBehind(grid);
  paintStatePicker(grid, { states: [...STATES], current: "r", filter: "", at: 3 }, "PLNR-305", cardAnchor({ columns: 120, rows: 36 }));
  const done = find("● Done");
  assert.deepEqual(grid.keysAt(done.x, done.y), ["at:5", "enter"]);
  assert.deepEqual(grid.keysAt(row.x, row.y), [], "behind the panel");
  const esc = find("Esc back");
  assert.deepEqual(grid.keysAt(esc.x, esc.y), ["esc"], "the panel's own hints");
  assert.deepEqual(grid.keysAt(textOf(grid, keys).indexOf("state"), keys), ["s"]);
});

test("a new issue is a panel over the screen it was opened on, faint behind it: the line, the rule, the card (RSVA-463)", () => {
  const made = { card: { ...VIEW.card!, key: "New PLNR issue", title: "Fix the sign-in page", actions: [["↵", "create"]] as [string, string][] }, details: VIEW.details! };
  const line = { draft: "Fix the sign-in page !high", right: "new in PLNR", sign: "+", typing: null, also: [] };
  for (const size of [
    { columns: 120, rows: 36 },
    { columns: 80, rows: 24 },
  ]) {
    const { grid } = paintHome(VIEW, size, "");
    const row = [...Array(grid.h).keys()].find((r) => textOf(grid, r).includes("PLNR-304"))!;
    paintCreate(grid, line, made);
    const at = `${size.columns}×${size.rows}`;
    assert.match(textOf(grid, 2), /^ ╭─ New PLNR issue ─+ ↵ create ─╮ $/, at);
    assert.match(textOf(grid, 3), /^ │ \+ Fix the sign-in page !high .* new in PLNR │ $/, at);
    assert.match(textOf(grid, 4), /^ ├─+┤ $/, at);
    assert.match(textOf(grid, 5), /^ │ Fix the sign-in page /, at);
    assert.equal(grid.at(3, 3).bg, "panel", at);
    assert.ok([2, 3, 4, 5].every((y) => grid.at(0, y).ch === " "), `${at}: nothing behind at its edge`);
    // The list behind: faint, and a click on it does nothing.
    if (textOf(grid, row).includes("PLNR-304")) assert.equal(grid.at(textOf(grid, row).indexOf("PLNR-304"), row).fg, "faint", at);
    assert.deepEqual(grid.keysAt(5, row), [], at);
  }
});

test("a click on the palette runs the entry under it; a hint at its foot presses its key", () => {
  const grid = new Grid(120, 36);
  paintPalette(grid, {
    query: "",
    at: 0,
    found: 2,
    entries: [
      { section: "COMMANDS", label: "Filter with a query…", shortcut: "f" },
      { section: "COMMANDS", label: "Quit", shortcut: "q" },
    ],
  });
  const y = [...Array(grid.h).keys()].find((r) => textOf(grid, r).includes("Quit"))!;
  assert.deepEqual(grid.keysAt(textOf(grid, y).indexOf("Quit"), y), ["at:1", "enter"]);
  const foot = [...Array(grid.h).keys()].find((r) => textOf(grid, r).includes("↵ run"))!;
  assert.deepEqual(grid.keysAt(textOf(grid, foot).indexOf("↵ run") + 2, foot), ["enter"]);
  assert.deepEqual(grid.keysAt(textOf(grid, foot).indexOf("↑↓"), foot), []);
});

test("a card's line of state (stateLine): the state, then the priority's bars and name; none only where it is asked for", () => {
  const todo = { name: "Todo", glyph: "○", tone: "status-todo" } as const;
  const dot: Seg = [" · ", { fg: "faint" }];
  const text = (line: Seg[]) => line.map(([t]) => t).join("");
  assert.equal(text(stateLine(todo, 3, dot)), "○ Todo · ▂▄▆ Medium");
  assert.deepEqual(stateLine(todo, 3, dot).slice(3, 5), [["▂▄", { fg: "ink-2", bg: undefined }], ["▆", { fg: "faint", bg: undefined }]]);
  assert.equal(text(stateLine(todo, 0, dot)), "○ Todo");
  assert.equal(text(stateLine(todo, 0, dot, "row-selected", true)), "○ Todo · ··· No priority");
  const urgent = stateLine(todo, 1, dot, "row-selected");
  assert.equal(text(urgent), "○ Todo ·  !  Urgent");
  assert.deepEqual(urgent[3], [" ! ", { fg: "accent-ink", bg: "accent", at: "B" }], "urgent is the signal tile, as in the list");
  assert.ok(urgent.filter((x) => x !== urgent[3] && x !== dot).every(([, pen]) => pen.bg === "row-selected"), "the rest on the ground it is given");
});
