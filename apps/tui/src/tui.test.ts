import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issue, L, S, U } from "../../../packages/query/test/fixture.ts";
import { fileDisks } from "./disk.ts";
import { Grid, GridScreen } from "./grid.ts";
import { layoutDescription, READING_LOOK } from "./description.ts";
import { paintHome, type HomeView } from "./home.ts";
import { activityOf, cardOf, rowsOf, similarField, type HomeSource } from "./home-view.ts";
import { paintIssue, type ActivityRow, type CommentView, type IssueDetails, type IssueView } from "./issue.ts";
import { MY_WORK } from "@rsva/terminal/issues";
import { avatarTone, initials } from "@rsva/display/avatar";
import { checksName } from "@rsva/display/github";
import { clockTime, dayLabel } from "@rsva/display/time";
import { fitCells, imagesOn, Pictures, pngSize } from "./images.ts";
import { paintConfirm, paintStatePicker } from "./panels.ts";
import { fieldLines, fieldText } from "./widgets.ts";
import { edited, editField, hintKeys, keyOf, keyReader, screenOf, type Field } from "./terminal.ts";
import { remember, remembered } from "./state.ts";
import { contrast } from "@rsva/display/theme-css";
import { READS, themeColours, THEMES } from "./theme.ts";
import { cursorOn, listOf, START_QUERY, type Source } from "./view.ts";

const E = String.fromCharCode(27);
const P = "00000000-0000-4000-8000-000000000001";

/** The query fixture's workspace as the engine's store shows it. */
function source(issues: ReturnType<typeof issue>[], description?: string): Source {
  return {
    me: U.alex,
    issues: new Map(issues.map((i) => [i.id, i])),
    states: new Map(Object.values(S).map((s) => [s.id, s])),
    labels: new Map(),
    users: new Map(Object.values(U).map((u) => [u.id, u])),
    cycles: new Map(),
    projects: new Map([[P, { id: P, key: "PLNR", name: "Planner" } as never]]),
    issueKey: (i) => `PLNR-${i.number}`,
    issueByKey: (key) => issues.find((i) => `PLNR-${i.number}` === key),
    isBlocked: () => false,
    isBlocking: () => false,
    hasLink: () => false,
    relationsOf: () => ({ blockedBy: [], blocks: [], related: [], duplicateOf: null, duplicates: [] }),
    attachmentsOf: () => [],
    description: () => (description ? ({ doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: description }] }] } } as never) : undefined),
  } as Source;
}

test("the list: a query's issues, what moves first (started, then Todo, then the backlog), newest change first within a state", () => {
  const mine = { assigneeIds: [U.alex.id] };
  const s = source([
    issue(1, { ...mine, stateId: S.progress.id, updatedAt: "2026-11-01 10:00:00+00" }),
    issue(2, { ...mine, stateId: S.backlog.id }),
    issue(3, { ...mine, stateId: S.progress.id, updatedAt: "2026-11-03 10:00:00+00" }),
    issue(4, { ...mine, stateId: S.done.id }),
    issue(5, { assigneeIds: [U.zoe.id], stateId: S.progress.id }),
    issue(6, { ...mine, stateId: S.todo.id, deletedAt: "2026-11-02 10:00:00+00" }),
    issue(7, { assigneeIds: [U.zoe.id], stateId: S.todo.id }),
  ]);
  const keys = (q: string) => listOf(s, q).items.map((i) => [i.row.key, i.row.state]);
  assert.deepEqual(keys(MY_WORK), [
    ["PLNR-3", "In Progress"],
    ["PLNR-1", "In Progress"],
    ["PLNR-2", "Backlog"],
  ]);
  assert.deepEqual(
    keys(START_QUERY).map(([k]) => k),
    ["PLNR-3", "PLNR-1", "PLNR-5", "PLNR-7", "PLNR-2"],
    "the start: every open issue, anyone's, closed and deleted ones left out",
  );
  const bad = listOf(s, "colour:red");
  assert.deepEqual(bad.items, []);
  assert.ok(bad.error);
});

test("the order within a state is the query's order: (PLNR-401); the groups keep theirs", () => {
  const s = source([
    issue(1, { stateId: S.progress.id, priority: 3, updatedAt: "2026-11-03 10:00:00+00", dueDate: null }),
    issue(2, { stateId: S.progress.id, priority: 1, updatedAt: "2026-11-01 10:00:00+00", dueDate: "2026-11-20" }),
    issue(3, { stateId: S.progress.id, priority: 0, updatedAt: "2026-11-02 10:00:00+00", dueDate: "2026-11-10" }),
    issue(4, { stateId: S.todo.id, priority: 1 }),
  ]);
  const keys = (order = "") => listOf(s, `${START_QUERY} ${order}`).items.map((i) => i.row.key);
  assert.deepEqual(keys(), ["PLNR-1", "PLNR-3", "PLNR-2", "PLNR-4"], "no order: the newest change first");
  assert.deepEqual(keys("order:priority"), ["PLNR-2", "PLNR-1", "PLNR-3", "PLNR-4"], "urgent first, none last, Todo still after In Progress");
  assert.deepEqual(keys("sort:due"), ["PLNR-3", "PLNR-2", "PLNR-1", "PLNR-4"], "the earliest due first, no date last");
  assert.ok(listOf(s, "order:colour").error, "an order the language does not have is the query's error");
});

test("the cursor stays on its issue as the list moves, and on its place when the issue's state takes it to another group", () => {
  const s = source([issue(1, { stateId: S.progress.id }), issue(2), issue(3), issue(4), issue(5)]);
  const keys = (items: { row: { key: string } }[]) => items.map((i) => i.row.key);
  const list = () => listOf(s, START_QUERY).items;
  const prev = list();
  const was = prev.map((i) => i.issue.stateId);
  assert.deepEqual(keys(prev), ["PLNR-1", "PLNR-5", "PLNR-4", "PLNR-3", "PLNR-2"]);
  const stateOf = (id: string) => s.issues.get(id)?.stateId;
  const on = (at: number, next = list()) => {
    const c = cursorOn(prev, was, at, next, stateOf);
    return { on: next[c.at]?.row.key, left: c.left && [c.left.prev, c.left.next].map((id) => (id ? `PLNR-${s.issues.get(id)!.number}` : undefined)) };
  };
  assert.deepEqual(on(2), { on: "PLNR-4", left: null }, "nothing changed: on its issue");
  // A newer change moves PLNR-3 to the top of Todo: the cursor goes with it.
  s.issues.get(prev[3]!.issue.id)!.updatedAt = "2026-11-06 12:00:00.000+00";
  assert.deepEqual(keys(list()), ["PLNR-1", "PLNR-3", "PLNR-5", "PLNR-4", "PLNR-2"]);
  assert.deepEqual(on(3), { on: "PLNR-3", left: null }, "moved within its group: the cursor goes with it");
  // Dispatched: PLNR-4 goes to In Progress, the cursor stays where it was, on the issue that came after it.
  s.issues.get(prev[2]!.issue.id)!.stateId = S.progress.id;
  assert.equal(keys(list())[0], "PLNR-4");
  assert.deepEqual(on(2), { on: "PLNR-3", left: ["PLNR-5", "PLNR-3"] }, "its state changed: the place kept, its old neighbours remembered");
  // The last one: no issue after it, the cursor goes to the one before.
  s.issues.get(prev[4]!.issue.id)!.stateId = S.progress.id;
  assert.deepEqual(on(4), { on: "PLNR-3", left: ["PLNR-3", undefined] });
});

test("a proposal's card lists up to three similar open issues, the proposal itself and closed ones left out (PLNR-295)", () => {
  const proposal = issue(1, { title: "Redirect after login goes to the wrong page", stateId: S.backlog.id });
  const s = source([
    proposal,
    issue(2, { title: "Redirect after login goes to a wrong page" }),
    issue(3, { title: "Login redirect goes to the wrong page", stateId: S.progress.id }),
    issue(4, { title: "Redirect after login goes to the wrong page", stateId: S.done.id }),
    issue(5, { title: "Redirect after sign-in goes to the wrong page" }),
    issue(6, { title: `Redirect after login ${E}]0;owned${String.fromCharCode(7)}goes to the wrong page, again` }),
    issue(7, { title: "Redirect after login goes to the wrong page", deletedAt: "2026-11-02 10:00:00+00" }),
    issue(8, { title: "Quartz clock drifts by a minute" }),
  ]);
  const field = similarField(s, proposal)!;
  assert.equal(field.label, "similar");
  assert.equal(field.lines.length, 3, "three at most");
  const text = field.lines.map((l) => l.map(([t]) => t).join(""));
  assert.match(text[0]!, /^PLNR-2  Redirect after login goes to a wrong page$/, "the best first");
  assert.ok(text.every((t) => !/PLNR-[1478] /.test(t)), "not itself, not a closed or deleted issue, not another subject");
  assert.ok(text.every((t) => !t.includes(E)), "the server's text reaches a cell cleaned");
  assert.equal(similarField(s, issue(8, { title: "Quartz clock drifts by a minute" })), null, "nothing similar: no field");
});

const status = { connection: "online" as const, message: [], brief: "", session: "plnr", time: "14:32" };

test("the home view from the copy: groups by state with their colours, the card's fields, agents on rows", () => {
  const i = issue(7, { assigneeIds: [U.alex.id], stateId: S.progress.id, priority: 2 });
  const s = { ...source([i], "Read the logs first."), statesOf: () => Object.values(S), githubOf: () => [] } as unknown as HomeSource & Source;
  const items = listOf(s, START_QUERY).items;
  const groups = rowsOf(s, items, new Map([["PLNR-7", { state: "running", model: "opus", startedAt: "2026-11-05T10:00:00Z" } as const]]), Date.parse("2026-11-05T10:04:00Z"));
  assert.deepEqual(groups[0]!.state, { name: "In Progress", glyph: "◐", tone: "status-progress" });
  assert.deepEqual(groups[0]!.rows[0]!.agent, { state: "running", text: "opus 4m", short: "4m" });
  const card = cardOf(s, i, Date.now());
  assert.deepEqual([card.key, card.priority, card.description], ["PLNR-7", 2, "Read the logs first.\n"]);
  assert.deepEqual(card.fields.find((f) => f.label === "assignees")!.lines, [[[U.alex.email, { fg: "ink" }]]]);
  // PLNR-398: an empty field is left out, the delegate's stays with how to dispatch; a project named by its key, once.
  const text = (c: typeof card, label: string) => c.fields.find((f) => f.label === label)?.lines.map((l) => l.map(([t]) => t).join(""));
  const alone = cardOf({ ...s, projects: new Map([[P, { id: P, key: "PLNR", name: "PLNR" } as never]]) } as HomeSource, { ...i, assigneeIds: [] }, Date.now());
  assert.equal(text(alone, "assignees"), undefined);
  assert.deepEqual(text(alone, "delegate"), ["—   d dispatches to an agent"]);
  assert.deepEqual([text(alone, "project"), text(card, "project")], [["PLNR"], ["PLNR  Planner"]]);
});

test("text from the server cannot drive the terminal: no control character reaches a cell", () => {
  const evil = `Title${E}]52;c;cHduZWQ=${String.fromCharCode(7)}${E}[2J${E}[H\u009b31m\tend\r\nPLNR-1 Fake row`;
  const i = issue(9, { assigneeIds: [U.alex.id], stateId: S.todo.id, title: evil });
  const s = { ...source([i], `Body${E}]0;owned${String.fromCharCode(7)}`), statesOf: () => Object.values(S), githubOf: () => [] } as unknown as HomeSource & Source;
  const items = listOf(s, START_QUERY).items;
  const v: HomeView = {
    head: { view: "My issues", workspace: `ws${E}[2J`, count: 1, query: START_QUERY, running: 0, waiting: 0 },
    groups: rowsOf(s, items, new Map(), Date.now()),
    selected: 0,
    top: 0,
    card: cardOf(s, i, Date.now()),
    status: { ...status, message: [[`refused${E}]52;c;eA==${String.fromCharCode(7)}`, { fg: "error" }]] },
    keys: [],
    keysNarrow: [],
  };
  const { grid } = paintHome(v, { columns: 120, rows: 36 });
  const bad = grid.cells.filter((c) => /[\u0000-\u001f\u007f-\u009f]/.test(c.ch));
  assert.deepEqual(bad, []);
});

test("the screen writes only the rows that changed, in 24-bit colour, in one synchronized write", async () => {
  const writes: string[] = [];
  const screen = new GridScreen({ write: (d, done) => (writes.push(d), done?.(), true) }, themeColours("graphite"));
  const g = new Grid(4, 2);
  g.text(0, 0, "ab", { fg: "ink" });
  assert.ok((await screen.draw(g)) > 0);
  assert.equal(await screen.draw(g), 0, "nothing changed: nothing written");
  g.text(0, 1, "c", { fg: "accent", at: "B" });
  await screen.draw(g);
  assert.match(writes.at(-1)!, new RegExp(`^${E}\\[\\?2026h${E}\\[2;1H${E}\\[0;1;38;2;217;70;28;48;2;22;22;21mc`));
  assert.ok(!writes.at(-1)!.includes(`${E}[1;1H`), "the first row is not written again");
});

test("a picker with more states than the screen has rows stays on the screen, the chosen state in view", () => {
  const g = new Grid(80, 12);
  const states = Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: `State ${i}`, glyph: "○", tone: "status-todo" as const }));
  paintStatePicker(g, { states, current: "0", filter: "", at: 30 }, "PLNR-1", { x: 3, y: 5 });
  assert.ok(g.cells.some((c, n) => c.ch === "▌" && g.cells.slice(n, n + 20).map((x) => x.ch).join("").includes("State 30")));
  assert.equal(g.cells.length, 80 * 12);
});

test("a field shows the text as typed: spaces kept, a trailing one too; lines broken at the field's end", () => {
  assert.deepEqual(fieldLines("домен  будет rsva.dev, ", 40), ["домен  будет rsva.dev, "]);
  assert.deepEqual(fieldLines("one two three", 8), ["one two ", "three"]);
  assert.deepEqual(fieldLines("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(fieldLines("a\n\nb", 10), ["a", "", "b"]);
});

test("a field's moves as Rex sends them (RSVA-465): ⌥ and Ctrl with an arrow by words, ⌘ with one to an end; ⌘ with a letter is never typed", () => {
  const seqs = [`${E}[1;3D`, `${E}[1;3C`, `${E}[1;5D`, `${E}[1;9D`, `${E}[1;9C`, `${E}[1;9A`, `${E}[1;9B`, `${E}[1;2H`, `${E}[127;3u`, `${E}[127;9u`, `${E}b`, `${E}f`, `${E}\x7f`, `${E}[107;9u`, `${E}[97;2u`];
  const names = ["alt-left", "alt-right", "ctrl-left", "super-left", "super-right", "super-up", "super-down", "shift-home", "alt-backspace", "super-backspace", "alt-left", "alt-right", "alt-backspace", "super-k", "A"];
  assert.deepEqual(seqs.map(keyOf), names);
});

test("a field of lines edits at its cursor (RSVA-465): moves by characters, words, lines and to the ends; deletes and types there", () => {
  const run = (f: Field, ...keys: string[]) => keys.reduce((x, k) => editField(x, k, true, 40) ?? x, f);
  const f = { text: "one two\nthree four", at: 18 };
  assert.deepEqual(run(f, "left", "left", "X"), { text: "one two\nthree foXur", at: 17 });
  assert.deepEqual(run(f, "alt-left", "alt-left", "backspace"), { text: "one twothree four", at: 7 });
  assert.deepEqual(run(f, "home").at, 8, "Home: the start of the line, not of the text");
  assert.deepEqual(run(f, "super-up").at, 0);
  assert.deepEqual(run({ ...f, at: 13 }, "up").at, 5, "↑ keeps the column");
  assert.deepEqual(run({ ...f, at: 3 }, "down", "end").at, 18);
  assert.deepEqual(run({ ...f, at: 3 }, "shift-enter"), { text: "one\n two\nthree four", at: 4 });
  assert.deepEqual(run({ ...f, at: 3 }, "delete", "alt-right", "super-backspace"), { text: "\nthree four", at: 0 });
  assert.deepEqual(run({ text: "ab😀c", at: 4 }, "left", "delete"), { text: "abc", at: 2 }, "an emoji is one character");
  assert.deepEqual(run({ text: "x".repeat(38), at: 0 }, `${E}[200~abcdef`).text.length, 40, "past the field's most nothing goes in");
  assert.equal(editField(f, "tab", true), null);
  // A one-line field keeps its cursor at the end: moves are not its keys there.
  assert.equal(edited("plnr", "alt-backspace"), "");
});

test("a field draws its cursor where it is: the character under it in the field's colour on ink; lines scroll to keep it in view", () => {
  const g = new Grid(12, 2);
  fieldText(g, 0, 0, 10, 2, "abc", 1, "", "panel", 12);
  assert.deepEqual([g.cells[1]!.ch, g.cells[1]!.bg, g.cells[1]!.fg], ["b", "ink", "panel"]);
  const h = new Grid(12, 2);
  fieldText(h, 0, 0, 10, 2, "one\ntwo\nthree\nfour", 0, "", "panel", 12);
  assert.equal(h.cells.slice(0, 3).map((c) => c.ch).join(""), "one", "the cursor on the first line shows it");
  const k = new Grid(12, 2);
  fieldText(k, 0, 0, 10, 2, "one\ntwo\nthree\nfour", 18, "", "panel", 12);
  assert.equal(k.cells.slice(12, 16).map((c) => c.ch).join(""), "four", "at the end the last lines show");
});

test("a cut keeps a wide character whole and ends with an ellipsis at the edge", () => {
  const g = new Grid(6, 1);
  g.text(0, 0, "ab通知cd", { fg: "ink" }, 6);
  assert.deepEqual(g.cells.map((c) => c.ch), ["a", "b", "通", "", " ", "…"]);
});

test("keys of the kitty protocol: Shift+Enter, Esc, Ctrl with a letter; Alt+Enter without it", () => {
  assert.deepEqual([`${E}[13u`, `${E}[13;2u`, `${E}[13;3u`, `${E}[13;5u`, `${E}[27u`, `${E}[99;5u`, `${E}[107;5u`, `${E}\r`].map(keyOf), ["enter", "shift-enter", "alt-enter", "ctrl-enter", "esc", "ctrl-c", "ctrl-k", "alt-enter"]);
});

test("in Rex the screen says it is recursiva and clears that when it leaves; elsewhere nothing is said (PLNR-452)", () => {
  const rex = screenOf({ TERM_PROGRAM: "rex" });
  assert.ok(rex.on.endsWith(`${E}]7501;state=idle:app=recursiva${E}\\`));
  assert.ok(rex.off.startsWith(`${E}]7501;state=clear${E}\\`));
  const other = screenOf({ TERM_PROGRAM: "ghostty" });
  assert.ok(!other.on.includes("7501") && !other.off.includes("7501"));
  assert.equal(rex.on.replace(`${E}]7501;state=idle:app=recursiva${E}\\`, ""), other.on);
});

test("keys by name", () => {
  assert.deepEqual([`${E}[A`, `${E}[B`, `${E}[5~`, `${E}[6~`, "\r", E, "\x7f", String.fromCharCode(3), "j", " "].map(keyOf), ["up", "down", "pageup", "pagedown", "enter", "esc", "backspace", "ctrl-c", "j", " "]);
});

test("a read with several keys in it is each of them: a held arrow, Ctrl+K and a letter, a typist", () => {
  const keysOf = keyReader();
  assert.deepEqual(keysOf(`${E}[B${E}[B${E}[B`), ["down", "down", "down"]);
  assert.deepEqual(keysOf(`jjk`), ["j", "j", "k"]);
  assert.deepEqual(keysOf(`${E}[107;5ua\t${E}`), ["ctrl-k", "a", "tab", "esc"]);
  assert.deepEqual(keysOf(`${E}OA${E}[5~${E}\rй😀`), ["up", "pageup", "alt-enter", "й", "😀"]);
});

test("the mouse (PLNR-383): a left press is a click on its cell from 0, the wheel ↑ and ↓; a release, another button, the old encoding nothing", () => {
  const keysOf = keyReader();
  assert.deepEqual(keysOf(`${E}[<0;12;5M${E}[<0;12;5m`), ["click:11:4"], "the release is no key");
  assert.deepEqual(keysOf(`${E}[<64;3;3M${E}[<65;3;3M${E}[<69;3;3M`), ["up", "down", "down"], "Shift with the wheel is still the wheel");
  assert.deepEqual(keysOf(`${E}[<2;1;1M${E}[<1;1;1M${E}[<16;4;2M`), ["click:3:1"], "the right and the middle buttons: nothing; Ctrl with the left: a click");
  assert.deepEqual(keysOf(`${E}[M !!j`), ["j"], "the old encoding's three bytes are not typed");
  assert.equal(edited("plnr", "click:1:1"), null);
  assert.equal(edited("plnr", "at:3"), null);
  assert.deepEqual(["↵", "Esc", "s", "g q", "⌃K", "→", "?", "j/k", "↑↓", "1–7", "q  ⌃C"].map(hintKeys), [["enter"], ["esc"], ["s"], ["g", "q"], ["ctrl-k"], ["right"], ["?"], [], [], [], []]);
});

test("a field takes characters, Backspace and Ctrl+U; a key's name is never typed into it", () => {
  for (const key of ["tab", "left", "right", "home", "pageup", "shift-enter", "ctrl-k", "ctrl-e", "alt-enter", `${E}[Z`, `${E}[15~`]) assert.equal(edited("plnr", key), null, key);
  assert.equal(edited("plnr", "x"), "plnrx");
  assert.equal(edited("plnr", "T"), "plnrT");
  assert.equal(edited("ok😀", "backspace"), "ok");
  assert.equal(edited("plnr", "ctrl-u"), "");
});

test("a paste is one key, its text, across reads; its Enters and keys' names are text, never keys", () => {
  const keysOf = keyReader();
  const paste = `${E}[200~one\r\r${E}[Bq\ttwo${E}[201~`;
  assert.deepEqual(keysOf(`j${paste}k`), ["j", `${E}[200~one\r\r${E}[Bq\ttwo`, "k"]);
  // Split anywhere, the closing bytes too: the keys after it are keys again.
  assert.deepEqual([`${E}[200~ab`, `c${E}[20`, `1~${E}[A`].flatMap(keysOf), [`${E}[200~abc`, "up"]);
  const key = keysOf(paste)[0]!;
  // Only the control bytes go: an arrow's bytes in a paste leave their letters.
  assert.equal(edited("", key, true), "one\n\n[Bq two");
  assert.equal(edited("x ", key), "x one  [Bq two");
  // C1 controls and the marks that reorder text go as well, as from the server's text.
  assert.equal(edited("", `${E}[200~a\u009b2Jb\u202ec\u2066d`), "a2Jbcd");
});

test("the disk: what goes in comes back with its Maps, files 0600 in folders 0700, a later feed is kept, remove takes all", async () => {
  const root = await mkdtemp(join(tmpdir(), "plnr-disk-"));
  try {
    const disks = fileDisks(root);
    const d = await disks.open("rsva:atlas");
    assert.equal(await d.loadSnapshot(), undefined);
    await d.saveSnapshot({ s: 5, m: new Map([["a", 1]]) });
    assert.deepEqual(await d.loadSnapshot(), { s: 5, m: new Map([["a", 1]]) });
    await d.putTx("t1", { id: "t1" });
    await d.putTx("t2", { id: "t2" });
    await d.delTx("t1");
    await d.delTx("missing");
    assert.deepEqual(await d.pendingTxs(), [{ id: "t2" }]);
    const feed = (id: string, s: number) => ({ id, s }) as never;
    await d.putFeeds([feed("i1", 10), feed("i2", 3)]);
    await d.putFeeds([feed("i1", 4)]);
    assert.equal((await d.getFeed("i1"))?.s, 10, "an older answer does not overwrite a later copy");
    await d.putFeeds([feed("i2", 6)], true);
    assert.deepEqual([(await d.getFeed("i1")) ?? null, (await d.getFeed("i2"))?.s], [null, 6], "replace drops the feeds the answer has not");
    await d.delFeeds(["i2"]);
    assert.equal(await d.getFeed("i2"), undefined);
    const dir = join(root, "rsva%3Aatlas");
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "snapshot.bin"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ["feeds", "snapshot.bin", "tx"], "no temporary file left");
    await disks.remove("rsva:atlas");
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


/** A painted row's characters, without the trailing blanks. */
const row = (g: Grid, y: number) => Array.from({ length: g.w }, (_, x) => g.at(x, y).ch).join("").trimEnd();

/** An issue screen of PLNR-7: forty lines of description, two comments on two days, the second with a reply. */
function reading(top = 0): IssueView {
  const i = issue(7, { assigneeIds: [U.alex.id], stateId: S.progress.id, priority: 2, title: "Read the logs before the release" });
  const text = Array.from({ length: 40 }, (_, n) => `Line ${n + 1} of the description.`).join("\n\n");
  const s = { ...source([i], "x"), statesOf: () => Object.values(S), githubOf: () => [] } as unknown as HomeSource & Source;
  const card = { ...cardOf(s, i, Date.now()), description: text };
  const by = (n: string, more: Partial<CommentView> = {}): CommentView => ({ author: n, name: n, initials: n.slice(0, 2).toUpperCase(), tone: "sage", agent: false, at: "2026-11-06T07:44:00.000Z", time: "14:44", edited: false, via: null, deleted: false, body: `${n} says hello`, reactions: [], ...more });
  const agent = by("bot", { agent: true, reactions: [{ emoji: "+1", count: 1 }] });
  const rows: ActivityRow[] = [
    { kind: "day", label: "Wed, Oct 28" },
    { kind: "thread", thread: { ...by("ann", { at: "2026-10-28T05:01:00.000Z", time: "12:01" }), replies: [] } },
    { kind: "day", label: "Today" },
    { kind: "thread", thread: { ...by("bob"), replies: [agent] } },
  ];
  return { source: "Open issues", place: { at: 3, of: 41 }, card, activity: { status: "ready", comments: 3, older: false, rows }, top, status, keys: [
      ["↑↓", "scroll"],
      ["j/k ←→", "next"],
      ["Tab", "heading"],
      ["s", "state"],
      ["d", "dispatch"],
      ["Esc", "back"],
    ] };
}

test("the issue screen at 80×24, as TuiIssue80: the head, the key, the title, its chips, the properties folded into a line, the text with its scrollbar", () => {
  const g = new Grid(80, 24);
  const { top, page } = paintIssue(g, reading());
  assert.equal(top, 0);
  assert.match(row(g, 0), /recursiva {2}Open issues › PLNR-7 +3 of 41$/);
  assert.match(row(g, 2), /^ {3}PLNR-7$/);
  assert.match(row(g, 3), /^ {2}Read the logs before the release$/);
  assert.match(row(g, 5), /^ {3}◐ In Progress {3}▂▄▆ High/);
  assert.match(row(g, 6), new RegExp(`^ {2}i all properties · ${U.alex.email}`));
  assert.match(row(g, 8), /^ {2}Line 1 of the description\. +┃$/, "the text, its scrollbar's thumb at the top");
  assert.match(row(g, 21), /│$/, "the scrollbar's track below the thumb");
  assert.match(row(g, 23), /^ ↑↓ scroll {2}j\/k ←→ next {2}Tab heading {2}s state {2}d dispatch {2}Esc back +\? keys$/);
  assert.equal(page, 22 - 8);
});

test("from 120 columns the properties sit in a panel on the right, as TuiIssue: state, priority, cycle and its progress, people, labels, project, parent, relations, pull request, links", () => {
  const v = reading();
  const details: IssueDetails = {
    project: { key: "PLNR", name: "Recursiva", tile: ["#ffffff", "#7a5c34"] },
    parent: { key: "PLNR-290", title: "Views: saved, shared and docked" },
    assignees: [{ email: "a@acme.test", initials: "AV", tone: "slate" }],
    delegate: { email: "bot@example.com", agent: true },
    cycle: { name: "C7", dates: "Nov 3 – 16", done: 9, total: 14 },
    relations: [{ kind: "blocks", key: "PLNR-307", mark: { name: "Todo", glyph: "○", tone: "status-todo" } }],
    pulls: [{ number: 412, title: "Dock the view panel", state: "draft", checks: "pass", failing: 0, url: "https://github.com/r3cursiva/recursiva/pull/412" }],
    links: [{ site: "Figma", title: "View panel", url: "https://www.figma.com/file/view-panel" }],
    children: [],
    created: { day: "Oct 28", by: "a@acme.test" },
    updated: "2m ago",
  };
  const g = new Grid(120, 36);
  paintIssue(g, { ...v, place: { at: 2, of: 7, prev: "PLNR-306", next: "PLNR-304" }, details });
  const rows = [...Array(g.h).keys()].map((y) => row(g, y));
  assert.match(rows[0]!, /\[ PLNR-306 {4}2 of 7 {4}PLNR-304 \]$/, "the issues [ and ] go to");
  assert.match(rows[2]!, /^ {3}PLNR {2}PLNR-7 {2}in PLNR-290 Views: saved, shared and docked +│ PROPERTIES +e edit$/);
  assert.deepEqual([g.at(3, 2).bg, g.at(3, 2).fg], ["#7a5c34", "#ffffff"], "the project's tile");
  const at = (t: string) => rows.findIndex((r) => r.includes(t));
  for (const [label, value] of [["State", "◐ In Progress"], ["Priority", "▂▄▆ High"], ["Cycle", "C7 Nov 3 – 16"], ["Assignee", "AV a@acme.test"], ["Delegate", "◈ bot@example.com"], ["Project", "PLNR  Recursiva"], ["Parent", "PLNR-290"], ["blocks", "○ PLNR-307"], ["Created", "Oct 28 · a@acme.test"], ["Updated", "2m ago"]] as const)
    assert.match(rows[at(`│ ${label}`)]!, new RegExp(`│ ${label} +${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), label);
  assert.match(rows[at("Cycle") + 1]!, /│ {12}█{6}█{4} 9\/14$/, "the cycle's progress");
  assert.ok(at("RELATIONS") > at("Parent") && at("PULL REQUEST") > at("RELATIONS") && at("LINKS") > at("PULL REQUEST"));
  assert.match(rows[at("│ #412")]!, /│ #412 Dock the view panel$/);
  assert.match(rows[at("│ #412") + 1]!, /│ {2}draft {3}✓ Passing$/);
  assert.equal(g.at(84, 10).ch, "│", "the panel's rule");
  assert.ok(!rows[5]!.includes("│ assignees"), "no fields above the text when the panel shows them");
  const tall = new Grid(160, 60);
  paintIssue(tall, { ...v, details });
  const lines = [...Array(tall.h).keys()].map((y) => row(tall, y));
  const state = lines.findIndex((r) => r.includes("│ State"));
  assert.match(lines[state + 1]!, /│ Priority/, "one property a line, no blank line between them, however tall the window");
});

test("a click (RSVA-479): a pull request or a link opens its address, an issue's key the issue, a property its picker", () => {
  const v = reading();
  const kid = { key: "PLNR-11", title: "Child 11", mark: { name: "Todo", glyph: "○", tone: "status-todo" as const }, done: false, who: null, when: "Oct 30" };
  const details: IssueDetails = {
    project: { key: "PLNR", name: "Recursiva", tile: ["#ffffff", "#7a5c34"] },
    parent: { key: "PLNR-290", title: "Views" },
    assignees: [{ email: "a@acme.test", initials: "AV", tone: "slate" }],
    delegate: null,
    cycle: null,
    relations: [{ kind: "blocks", key: "PLNR-307", mark: { name: "Todo", glyph: "○", tone: "status-todo" } }],
    pulls: [{ number: 412, title: "Dock the view panel", state: "draft", checks: "pass", failing: 0, url: "https://github.com/r3cursiva/recursiva/pull/412" }],
    links: [{ site: "Figma", title: "View panel", url: "https://www.figma.com/file/view-panel" }],
    children: [kid],
    created: { day: "Oct 28", by: null },
    updated: "now",
  };
  const card = { ...v.card, description: "See [the spec](https://example.com/spec) and PLNR-5." };
  const g = new Grid(120, 40);
  paintIssue(g, { ...v, card, activity: { status: "ready", comments: 0, older: false, rows: [] }, details });
  const rows = [...Array(g.h).keys()].map((y) => row(g, y));
  // On the text's last cell: a panel's line starts after its rule.
  const click = (text: string) => {
    const y = rows.findIndex((r) => r.includes(text));
    assert.ok(y >= 0, text);
    return g.keysAt(rows[y]!.indexOf(text) + text.length - 1, y);
  };
  const pr = ["open:https://github.com/r3cursiva/recursiva/pull/412"];
  assert.deepEqual(click("#412"), pr);
  assert.deepEqual(click("draft"), pr, "its second line too");
  assert.deepEqual(click("Figma"), ["open:https://www.figma.com/file/view-panel"]);
  assert.deepEqual(click("the spec"), ["open:https://example.com/spec"], "a link in the text");
  assert.deepEqual(click("and PLNR-5"), ["issue:PLNR-5"], "an issue's key in the text");
  assert.deepEqual(click("Child 11"), ["issue:PLNR-11"], "a sub-issue's row");
  assert.deepEqual(click("○ PLNR-307"), ["issue:PLNR-307"], "a relation");
  assert.deepEqual(click("in PLNR-290"), ["issue:PLNR-290"], "the parent over the title");
  assert.deepEqual(click("Open issues"), ["esc"], "where it was opened from");
  for (const [label, key] of [["│ State", "s"], ["│ Priority", "p"], ["│ Assignee", "a"], ["│ Delegate", "d"], ["│ Project", "m"]] as const) assert.deepEqual(click(label), [key], label);
  assert.deepEqual(click("◐ In Progress"), ["s"], "the state's chip");
  assert.deepEqual(click("Created"), [], "a line with nothing to do takes no click");
});

test("the panel's pull request says one failing check in the singular, the same words as the web", () => {
  const pull = (failing: number): IssueDetails["pulls"][number] => ({ number: 412, title: "Dock the view panel", state: "open", checks: "fail", failing, url: "https://github.com/r3cursiva/recursiva/pull/412" });
  const panel = (failing: number) => {
    const g = new Grid(120, 36);
    paintIssue(g, { ...reading(), details: { project: null, parent: null, assignees: [], delegate: null, cycle: null, relations: [], pulls: [pull(failing)], links: [], children: [], created: { day: "Oct 28", by: null }, updated: "now" } });
    return [...Array(g.h).keys()].map((y) => row(g, y)).join("\n");
  };
  assert.match(panel(1), /✗ 1 failing/);
  assert.match(panel(3), /✗ 3 failing/);
  assert.deepEqual(checksName("fail", 1), { full: "1 check failing", short: "1 failing" });
});

test("the issue screen at any size from 60×12 to 212×50: nothing crosses into the panel or past the window, the panel only from 120 columns, its end said when cut", () => {
  const v = reading();
  const details: IssueDetails = {
    project: { key: "PLNR", name: "Recursiva", tile: ["#ffffff", "#7a5c34"] },
    parent: { key: "PLNR-290", title: "Views: saved, shared and docked with a long title that does not fit" },
    assignees: [{ email: "a@acme.test", initials: "AV", tone: "slate" }, { email: "someone.with.a.long.address@example.com", initials: "SL", tone: "sand" }],
    delegate: { email: "bot@example.com", agent: true },
    cycle: { name: "C7", dates: "Nov 3 – 16", done: 3, total: 14 },
    relations: Array.from({ length: 6 }, (_, n) => ({ kind: "related", key: `PLNR-${300 + n}`, mark: { name: "Todo", glyph: "○", tone: "status-todo" as const } })),
    pulls: [{ number: 412, title: "Dock the view panel beside the list on every wide screen we have", state: "open", checks: "fail", failing: 2, url: "https://github.com/r3cursiva/recursiva/pull/412" }],
    links: [{ site: "Figma", title: "View panel", url: "https://www.figma.com/file/view-panel" }],
    children: [],
    created: { day: "Oct 28", by: "a@acme.test" },
    updated: "2m ago",
  };
  const long = { ...v, source: "label:feature state:open assignee:me a query long enough to reach the place", place: { at: 12, of: 340, prev: "PLNR-1000", next: "PLNR-1002" }, details };
  for (const w of [60, 80, 100, 119, 120, 121, 160, 212])
    for (const h of [12, 16, 24, 36, 50]) {
      const g = new Grid(w, h);
      const { page } = paintIssue(g, long);
      const at = `${w}×${h}`;
      assert.ok(page >= 1, at);
      assert.match(row(g, h - 1), /keys$/, `${at}: the keys line`);
      assert.match(row(g, 0), /PLNR-7/, `${at}: the key stays in the head`);
      if (w >= 120) {
        const rule = w - (w >= 160 ? 46 : 36);
        for (let y = 2; y < h - 2; y++) {
          assert.equal(g.at(rule, y).ch, "│", `${at}: the panel's rule at ${y}`);
          assert.equal(g.at(rule - 1, y).ch, " ", `${at}: nothing touches the rule at ${y}`);
        }
        const rows = [...Array(h).keys()].map((y) => row(g, y));
        if (h <= 24) assert.ok(rows.some((r) => /… \d+ more lines?: i opens them all$/.test(r)), `${at}: a cut panel says so`);
      } else assert.ok(![...Array(h).keys()].some((y) => row(g, y).includes("PROPERTIES")), `${at}: no panel`);
    }
});

test("the issue screen is one feed: the sub-issues with their bar and rows, headings for Tab, and Tab said only where there is somewhere to go", () => {
  const v = reading();
  const kid = (n: number, done: boolean): IssueDetails["children"][number] => ({ key: `PLNR-${n}`, title: `Child ${n}`, mark: done ? { name: "Done", glyph: "●", tone: "status-done" } : { name: "Todo", glyph: "○", tone: "status-todo" }, done, who: done ? { initials: "AV", tone: "slate" } : "agent", when: "Oct 30" });
  const details = { project: null, parent: null, assignees: [], delegate: null, cycle: null, relations: [], pulls: [], links: [], children: [kid(11, true), kid(12, false)], created: { day: "Oct 28", by: null }, updated: "now" } satisfies IssueDetails;
  const short: IssueView = { ...v, card: { ...v.card, description: "Short." }, activity: { status: "ready", comments: 0, older: false, rows: [] }, details };
  const g = new Grid(80, 30);
  const { heads } = paintIssue(g, short);
  const rows = [...Array(30).keys()].map((y) => row(g, y));
  assert.ok(!rows.some((r) => /1 Description/.test(r)), "no tabs");
  assert.match(rows[8]!, /^ {2}Short\.$/, "the text right under the title area");
  assert.match(rows.find((r) => r.includes("SUB-ISSUES"))!, /SUB-ISSUES {2}1 of 2 ─+ █{5}█{5} *$/);
  assert.match(rows.find((r) => r.includes("PLNR-11"))!, /^ {3}● PLNR-11 +Child 11 +AV {3}Oct 30/);
  assert.match(rows.find((r) => r.includes("PLNR-12"))!, /^ {3}○ PLNR-12 +Child 12 +◈ {4}Oct 30/);
  assert.equal(heads.length, 2, "the sub-issues' and the activity's headings");
  assert.ok(!rows[29]!.includes("Tab"), "it all fits: no Tab in the keys line");
  const long = paintIssue(new Grid(80, 24), { ...short, card: { ...short.card, description: Array.from({ length: 40 }, (_, n) => `Line ${n}.`).join("\n\n") } });
  assert.ok(long.heads[0]! > 40);
});

test("the issue screen scrolls to its end: the conversation, days marked, the name in the person's colour, the time at the right and faint, a reply indented", () => {
  const g = new Grid(80, 24);
  const { top } = paintIssue(g, reading(Number.MAX_SAFE_INTEGER));
  assert.ok(top > 0);
  const rows = [...Array(g.h).keys()].map((y) => row(g, y));
  const at = (t: string) => rows.findIndex((r) => r.includes(t));
  assert.match(rows[at("Today")]!, /^ {2}── Today ─+ +[│┃]$/, "a day's mark");
  assert.equal(rows[at("Today") + 1]!.trim(), "│", "a blank line under it");
  assert.match(rows[at("  ann ")]!, /^ {2}AN {2}ann +12:01 [│┃]$/, "the avatar, the name, the time at the right");
  assert.match(rows[at("ann says hello")]!, /^ {6}ann says hello/, "the text under the name");
  assert.match(rows[at("bot agent")]!, /^ {9}◈ {2}bot agent +14:44 [│┃]$/, "a reply indented under its comment's text");
  assert.match(rows[at("bot says hello")]!, /^ {12}bot says hello/);
  assert.match(rows[at("+1 1")]!, /^ {13}\+1 1/, "its reactions under it");
  const y = at("  ann ");
  assert.deepEqual([g.at(2, y).bg, g.at(2, y).at, g.at(6, y).at, g.at(6, y).fg, g.at(6, y + 1).fg, g.at(rows[y]!.indexOf("12:01"), y).fg], ["avatar-sage", "B", "B", "lb-moss", "ink-2", "faint"]);
  const a = at("bot agent");
  assert.deepEqual([g.at(9, a).fg, g.at(9, a).bg, g.at(12, a).fg], ["status-done", "tint-done", "status-done"]);
  assert.equal(g.at(78, 21).ch, "┃", "the scrollbar's thumb at the bottom");
});

test("a person's comments within ten minutes read under one head, each with its time at the right; an event or a reply between starts a new head", () => {
  const v = reading();
  const cm = (at: string, time: string, body: string): CommentView => ({ author: "u-ann", name: "ann", initials: "AN", tone: "sage", agent: false, at, time, edited: false, via: null, deleted: false, body, reactions: [] });
  const rows: ActivityRow[] = [
    { kind: "day", label: "Today" },
    { kind: "thread", thread: { ...cm("2026-11-06T07:00:00Z", "14:00", "first"), replies: [] } },
    { kind: "thread", thread: { ...cm("2026-11-06T07:05:00Z", "14:05", "second"), replies: [] } },
    { kind: "event", mark: ["·", { fg: "faint" }], who: "ann", text: [["added label", { fg: "ink-3" }]], when: "14:06" },
    { kind: "thread", thread: { ...cm("2026-11-06T07:07:00Z", "14:07", "third"), replies: [] } },
    { kind: "thread", thread: { ...cm("2026-11-06T07:30:00Z", "14:30", "later"), replies: [] } },
  ];
  const g = new Grid(80, 30);
  paintIssue(g, { ...v, card: { ...v.card, description: "Short." }, activity: { status: "ready", comments: 4, older: false, rows } });
  const lines = [...Array(30).keys()].map((y) => row(g, y));
  const heads = lines.filter((r) => /^ {2}AN {2}ann/.test(r)).length;
  assert.equal(heads, 3, "first and second under one head; the third after an event; the last after half an hour");
  const third = lines.findIndex((r) => r.includes("third"));
  assert.match(lines[third + 1]!, /^ {2}AN {2}ann +14:30$/, "the next head right under a comment's text, no blank line");
  assert.equal(lines[lines.findIndex((r) => r.includes("added label")) + 1]!, "", "a blank line between history and a comment");
  assert.match(lines.find((r) => r.includes("second"))!, /^ {6}second +14:05$/, "a grouped comment's time on its first line");
  assert.match(lines.find((r) => r.includes("added label"))!, /^ {3}· ann added label +14:06$/, "an event: its mark, who, what, the time at the right");
});

test("the issue screen reads Markdown as the artboards: ink-2 text, links underlined in ink, keys in ink-3, bold mentions, emphasis, quotes, done items quieter", () => {
  const v = reading();
  const g = new Grid(100, 24);
  paintIssue(g, { ...v, card: { ...v.card, description: "## Why\nSee [@ann](mention:u1), PLNR-9 and <https://e.com/x>, **bold** _it_.\n\n> said once\n\n- [x] shipped" } });
  const rows = [...Array(g.h).keys()].map((y) => row(g, y));
  const y = rows.findIndex((r) => r.includes("See @ann"));
  assert.match(rows[y]!, /See @ann, PLNR-9 and https:\/\/e\.com\/x, bold it\./);
  const cell = (t: string, yy = y) => g.at(rows[yy]!.indexOf(t), yy);
  assert.deepEqual([cell("See").fg, cell("@ann").fg, cell("@ann").at, cell("PLNR-9").fg, cell("https").fg, cell("https").at, cell("bold").at, cell("it.").at], ["ink-2", "ink", "B", "ink-3", "ink", "U", "B", "I"]);
  const h = rows.findIndex((r) => r.includes("## Why"));
  assert.deepEqual([cell("##", h).fg, cell("Why", h).fg, cell("Why", h).at], ["faint", "ink", "B"]);
  assert.ok(rows.some((r) => /^ {2}│ said once/.test(r)), "a quote under its bar");
  const d = rows.findIndex((r) => r.includes("shipped"));
  assert.equal(cell("shipped", d).fg, "ink-3", "a done item reads quieter");
});

test("code on the issue screen: numbered lines on the code ground; a diff's added and removed lines on their own grounds", () => {
  const code = layoutDescription("```ts\nconst a = 1;\nconst b = 2;\n```\n\n```diff\n@@ -1 +1 @@\n-old\n+new\n same\n```", 40, READING_LOOK);
  const text = (l: (typeof code)[number]) => l.segs.map(([t]) => t).join("");
  assert.deepEqual(code.map(text), ["  1  const a = 1;", "  2  const b = 2;", "", "   @@ -1 +1 @@", " − old", " + new", "    same"]);
  assert.deepEqual(code.map((l) => l.ground ?? null), ["code", "code", null, "code", "del-bg", "add-bg", "code"]);
  assert.deepEqual([code[0]!.segs[0]![1].fg, code[4]!.segs[0]![1].fg, code[5]!.segs[0]![1].fg], ["faint", "error", "success"]);
  // The card keeps its code as the TuiHome artboard has it.
  assert.deepEqual(layoutDescription("```\nx\n```", 40).map(text), [" x"]);
});

test("under 120 columns `i` opens the properties above the text; on a dispatch's steps the keys line has no ?", () => {
  const g = new Grid(80, 24);
  const v = reading();
  paintIssue(g, { ...v, properties: true }, "");
  assert.match(row(g, 6), /^ {2}i hide properties/);
  assert.match(row(g, 8), new RegExp(`^ {2}assignees +${U.alex.email}`));
  assert.ok(!row(g, 23).includes("?"));
});

/** PLNR-7's activity: created on Oct 28, moved, a comment; today a label, a run of state changes, a comment, a move by someone gone. */
function activityStore(hasOlder = false) {
  const i = issue(7, { createdById: U.zoe.id, createdAt: "2026-10-28T09:00:00.000Z" });
  let id = 0;
  const h = (at: string, by: string | null, d: Record<string, unknown>, p: Record<string, unknown>) => ({ id: ++id, a: "U" as const, by, at, d, p });
  const c = (cid: string, at: string, body: string, more = {}) => ({ id: cid, authorId: U.zoe.id, body, createdAt: at, editedAt: null, deletedAt: null, ...more });
  const history = [
    h("2026-10-28T09:05:00.000Z", U.alex.id, { stateId: S.todo.id }, { stateId: S.backlog.id }),
    h("2026-11-06T08:00:00.000Z", U.alex.id, { labelIds: [L.bug.id] }, { labelIds: [] }),
    h("2026-11-06T08:30:00.000Z", U.alex.id, { stateId: S.progress.id }, { stateId: S.todo.id }),
    h("2026-11-06T08:31:00.000Z", U.alex.id, { stateId: S.review.id }, { stateId: S.progress.id }),
    h("2026-11-06T08:33:00.000Z", U.alex.id, { stateId: S.done.id }, { stateId: S.review.id }),
    h("2026-11-06T09:30:00.000Z", "gone", { stateId: "removed" }, { stateId: S.done.id }),
  ];
  const threads = [
    { comment: c("a", "2026-10-28T10:00:00.000Z", "gone", { deletedAt: "2026-11-06" }), replies: [c("b", "2026-11-06T07:44:00.000Z", `hi${E}[2J`, { editedAt: "2026-11-06T07:50:00.000Z" })] },
    { comment: c("d", "2026-11-06T09:00:00.000Z", "done, thanks"), replies: [] },
  ];
  const feed = { status: "ready", history, threads, hasOlder, reactions: (cid: string) => (cid === "b" ? [{ emoji: "👍", userIds: ["x", "y"], mine: false }] : []) };
  const s = { ...source([i]), labels: new Map([[L.bug.id, L.bug]]), statesOf: () => Object.values(S), githubOf: () => [], feed: () => feed } as unknown as Parameters<typeof activityOf>[0];
  return { s, i };
}

const NOW = Date.parse("2026-11-06T12:00:00Z");
const words = (r: ActivityRow) => (r.kind === "day" ? `[${r.label}]` : r.kind === "thread" ? `thread ${r.thread.body || "(deleted)"}` : `${r.mark[0]} ${r.who ?? ""} ${r.text.map(([t]) => t).join("")} · ${r.when}`);

test("an issue's activity is the web's: history and threads in time order, the web's words with people by name, day marks, a run of state changes folded", () => {
  const { s, i } = activityStore();
  const a = activityOf(s, i, NOW);
  assert.deepEqual([a.status, a.comments, a.older], ["ready", 2, false], "a deleted comment kept for its reply is not counted");
  assert.deepEqual(a.rows.map(words), [
    `[${dayLabel("2026-10-28T09:00:00.000Z", NOW)}]`,
    `· ${U.zoe.name} created the issue · ${clockTime("2026-10-28T09:00:00.000Z")}`,
    `○ ${U.alex.name} moved from ◌ Backlog to ○ Todo · ${clockTime("2026-10-28T09:05:00.000Z")}`,
    "thread (deleted)",
    "[Today]",
    `· ${U.alex.name} added label ▪ bug · ${clockTime("2026-11-06T08:00:00.000Z")}`,
    `● ${U.alex.name} changed the state 3 times in 3 min: ○ Todo → ● Done · ${clockTime("2026-11-06T08:33:00.000Z")}`,
    "thread done, thanks",
    `· someone moved from ● Done to a removed state · ${clockTime("2026-11-06T09:30:00.000Z")}`,
  ]);
  const ev = (n: number) => a.rows[n] as Extract<ActivityRow, { kind: "event" }>;
  assert.deepEqual(ev(2).mark, ["○", { fg: "status-todo" }], "a state change's mark: the new state's glyph in its tone");
  const pen = (n: number, t: string) => ev(n).text.find(([x]) => x === t)?.[1].fg;
  assert.deepEqual([pen(2, "moved from "), pen(2, "◌ "), pen(2, "Backlog"), pen(5, "▪"), pen(5, " bug"), pen(6, "3 times")], ["ink-3", "status-backlog", "ink-2", L.bug.color, "ink-2", "ink-2"]);
  const thread = a.rows[3] as Extract<ActivityRow, { kind: "thread" }>;
  const view = { author: U.zoe.id, name: U.zoe.name, initials: initials(U.zoe.name), tone: avatarTone(U.zoe.name), agent: false };
  assert.deepEqual(thread.thread, {
    ...view, at: "2026-10-28T10:00:00.000Z", time: clockTime("2026-10-28T10:00:00.000Z"), edited: false, via: null, deleted: true, body: "", reactions: [],
    replies: [{ ...view, at: "2026-11-06T07:44:00.000Z", time: clockTime("2026-11-06T07:44:00.000Z"), edited: true, via: null, deleted: false, body: "hi[2J", reactions: [{ emoji: "👍", count: 2 }] }],
  }, "a comment: cleaned, by name with the web's avatar, its time, a deleted one kept for its replies");
});

test("the issue's creation shows only once the first page is in, as on the web", () => {
  const { s, i } = activityStore(true);
  const a = activityOf(s, i, NOW);
  assert.equal(a.older, true);
  assert.ok(!a.rows.some((r) => r.kind === "event" && r.text.some(([t]) => t === "created the issue")));
  assert.match(words(a.rows[1]!), /moved from ◌ Backlog to ○ Todo/);
});

test("the issue screen draws the activity: its heading for Tab, day marks, a quiet line for each change between the comments, the time cut last", () => {
  const { s, i } = activityStore();
  const v: IssueView = { ...reading(), card: { ...reading().card, description: "Short." }, activity: activityOf(s, i, NOW) };
  const g = new Grid(80, 40);
  const { heads } = paintIssue(g, v);
  const rows = [...Array(g.h).keys()].map((y) => row(g, y));
  const at = (t: string) => rows.findIndex((r) => r.includes(t));
  assert.equal(heads.length, 1, "the activity's heading is Tab's");
  assert.match(rows[at("ACTIVITY")]!, /^ {2}ACTIVITY {2}2 comments ─+$/);
  assert.match(rows[at("Today ")]!, /^ {2}── Today ─+$/);
  assert.match(rows[at("added label")]!, new RegExp(`^ {3}· ${U.alex.name} added label ▪ bug +${clockTime("2026-11-06T08:00:00.000Z")}$`));
  const fold = at("changed the state");
  assert.match(rows[fold]!, new RegExp(`^ {3}● ${U.alex.name} changed the state 3 times in 3 min: ○ Todo → ● Done +${clockTime("2026-11-06T08:33:00.000Z")}$`));
  assert.ok(at("hi[2J") < at("added label") && fold < at("done, thanks"), "the changes between the two comments");
  assert.deepEqual([g.at(3, fold).ch, g.at(3, fold).fg, g.at(5, fold).fg], ["●", "status-done", "ink-2"], "the mark in the state's tone, the actor in ink-2");
  assert.equal(rows[at("done, thanks") - 2], "", "a blank between a line of history and a thread");
  const narrow = new Grid(60, 40);
  paintIssue(narrow, v);
  const cut = [...Array(narrow.h).keys()].map((y) => row(narrow, y)).find((r) => r.includes("changed the state"))!;
  assert.ok(cut.length <= 58 && cut.endsWith(clockTime("2026-11-06T08:33:00.000Z")) && cut.includes("…"), "a long line is cut before its time, which stays whole at the right");
});

test("a description wraps its items under their text, on the card too (PLNR-397)", () => {
  const md = "- one two three four five six";
  const text = (l: { segs: [string, unknown][] }) => l.segs.map(([t]) => t).join("");
  const full = layoutDescription(md, 14);
  assert.deepEqual(full.map(text), ["• one two", "  three four", "  five six"]);
  assert.ok(full.every((l) => l.segs.every(([, pen]) => pen.fg)), "every piece has a colour: the screen cannot write one without");
  assert.deepEqual(layoutDescription("aaaa bbbb cccc", 9).map(text), ["aaaa bbbb", "cccc"], "a line as wide as the room, without its space, is not cut");
});

test("what the TUI remembers: the workspace last open, each workspace's own query, the theme; an unreadable file is a first start", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsva-tui-state-"));
  const file = join(dir, "tui.json");
  assert.deepEqual(remembered(file), { queries: {} });
  remember(file, (r) => ((r.workspace = "arsen"), (r.queries.arsen = "project:PLNR")));
  remember(file, (r) => ((r.workspace = "acme"), (r.queries.acme = "assignee:me")));
  assert.deepEqual(remembered(file), { workspace: "acme", queries: { arsen: "project:PLNR", acme: "assignee:me" } });
  // The theme picked in the palette (PLNR-380) is kept beside them.
  remember(file, (r) => (r.theme = "ledger"));
  assert.equal(remembered(file).theme, "ledger");
  writeFileSync(file, "{not json");
  assert.deepEqual(remembered(file), { queries: {} });
  assert.deepEqual(remembered(null), { queries: {} });
  rmSync(dir, { recursive: true });
});

/** The head of a PNG `w` × `h`: all images.ts reads of one that needs no `sips`. */
const pngHead = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

test("images: a line of its own is an image with its caption; in running text, and where none is drawn, the caption, never '!' and a link", () => {
  const lines = layoutDescription("before\n\n![shot.png](/files/acme/abc)\n\nsee ![x](/files/acme/d) and [a link](https://e.com)\n\n![](https://elsewhere/x.png)", 60);
  assert.deepEqual(lines[2], { segs: [["▣ shot.png", { fg: "ink-3" }]], image: { src: "/files/acme/abc" } });
  const text = (n: number) => lines[n]!.segs.map(([t]) => t).join("");
  assert.equal(text(4), "see ▣ x and a link");
  // Not a file of the workspace: as the editor has it, not an image.
  assert.ok(!lines.some((l) => l.image?.src.startsWith("https")));
  assert.equal(imagesOn({ TERM_PROGRAM: "rex" }), true);
  assert.equal(imagesOn({ TERM_PROGRAM: "rex", TMUX: "/tmp/x" }), false);
  assert.equal(imagesOn({ TERM_PROGRAM: "Apple_Terminal" }), false);
  assert.equal(imagesOn({ TERM_PROGRAM: "Apple_Terminal", RSVA_TUI_IMAGES: "1" }), true);
});

test("images: as wide as they are up to the room, at most 24 rows, a tall one narrowed to keep its shape", () => {
  assert.deepEqual(fitCells(110, 110, 74), { cols: 14, rows: 7 });
  assert.deepEqual(fitCells(1542, 400, 74), { cols: 74, rows: 10 });
  assert.deepEqual(fitCells(1542, 1328, 74), { cols: 56, rows: 24 });
  assert.deepEqual(pngSize(pngHead(300, 200)), { w: 300, h: 200 });
  assert.equal(pngSize(new Uint8Array(30)), null);
});

test("images: sent once in chunks, placed where they are, cropped when the scroll cuts them, placed again over rows written again, gone under a panel", async () => {
  let ready = () => {};
  const loaded = new Promise<void>((r) => (ready = r));
  const big = new Uint8Array(6000);
  big.set(pngHead(160, 64));
  const p = new Pictures(async () => big, () => ready());
  assert.equal(p.size("/files/acme/a", 74), null, "loading: the caption");
  await loaded;
  assert.deepEqual(p.size("/files/acme/a", 74), { cols: 20, rows: 4 });
  const at = { src: "/files/acme/a", x: 5, y: 10, cols: 20, rows: 4, skip: 0, shown: 4 };
  const first = p.frame([at]);
  // 6000 bytes are 8000 in base64: two chunks, the first with the image's keys and m=1.
  assert.match(first, /^\x1b_Ga=t,f=100,t=d,i=1,q=2,m=1;[^\x1b]{4096}\x1b\\\x1b_Gm=0;[^\x1b]+\x1b\\/);
  assert.ok(first.endsWith("\x1b[11;6H\x1b_Ga=p,i=1,p=1,c=20,r=4,C=1,q=2\x1b\\"));
  assert.equal(p.frame([at]), "", "nothing moved");
  assert.equal(p.frame([at], new Set([12])), "\x1b[11;6H\x1b_Ga=p,i=1,p=1,c=20,r=4,C=1,q=2\x1b\\", "a row under it was written again");
  // Scrolled one row: its first row is above the view.
  assert.equal(p.frame([{ ...at, y: 9, skip: 1, shown: 3 }]), "\x1b[10;6H\x1b_Ga=p,i=1,p=1,c=20,r=3,x=0,y=16,w=160,h=48,C=1,q=2\x1b\\");
  assert.equal(p.frame([]), "\x1b_Ga=d,d=i,i=1,p=1,q=2\x1b\\");
  assert.equal(p.free(), "\x1b_Ga=d,d=I,i=1,q=2\x1b\\");
});

test("the issue screen keeps an image's rows and says where it is; scrolled, the rows above are cut from it", () => {
  const v = reading();
  const withImage: IssueView = { ...v, card: { ...v.card, description: `Intro.\n\n![shot](/files/acme/a)\n\nAfter.${"\n\nmore".repeat(30)}` }, picture: () => ({ cols: 20, rows: 6 }) };
  const g = new Grid(80, 24);
  const { pictures } = paintIssue(g, withImage);
  assert.equal(pictures.length, 1);
  const [p] = pictures;
  assert.deepEqual({ ...p, y: 0 }, { src: "/files/acme/a", x: 2, y: 0, cols: 20, rows: 6, skip: 0, shown: 6 });
  assert.equal(row(g, p!.y - 2).includes("Intro."), true);
  assert.equal(row(g, p!.y + 6).includes("After."), false, "a blank line between blocks");
  assert.ok(row(g, p!.y + 7).includes("After."));
  for (let y = p!.y; y < p!.y + 6; y++) assert.match(row(g, y), /^ +[│┃]$/, "the image's rows are blank under it");
  const scrolled = paintIssue(new Grid(80, 24), { ...withImage, top: p!.y - 8 + 2 });
  assert.deepEqual(scrolled.pictures.map((x) => [x.skip, x.shown, x.y]), [[2, 4, 8]]);
  // Not drawn here: its caption.
  const plain = new Grid(80, 24);
  paintIssue(plain, { ...withImage, picture: () => null });
  assert.ok([...Array(plain.h).keys()].some((y) => row(plain, y).includes("▣ shot")));
});

test("escapes are the characters themselves and start no markup; nothing a text holds becomes a control character", () => {
  const text = (md: string) => layoutDescription(md, 80, READING_LOOK).flatMap((l) => l.segs);
  const segs = text("\\*not italic\\* and **a\\*b** and `\\*`");
  assert.equal(segs.map(([t]) => t).join(""), "*not italic* and a*b and \\*");
  assert.ok(segs.every(([, p]) => p.at !== "I"));
  assert.deepEqual(segs.find(([t]) => t === "a*b")?.[1].at, "B");
  // A character of the private use area stays itself: never mapped onto ESC or any other control.
  for (const md of ["x[2J", "**[2J**", "\\", "[](https://e.com)"])
    assert.ok(!/[\x00-\x1f\x7f]/.test(text(md).map(([t]) => t).join("")), JSON.stringify(md));
});

test("Home and End in every form terminals send them, PgUp and PgDn as before: fn with the arrows on a Mac", () => {
  for (const seq of [`${E}[H`, `${E}OH`, `${E}[1~`, `${E}[7~`]) assert.equal(keyOf(seq), "home", JSON.stringify(seq));
  for (const seq of [`${E}[F`, `${E}OF`, `${E}[4~`, `${E}[8~`]) assert.equal(keyOf(seq), "end", JSON.stringify(seq));
  assert.deepEqual([keyOf(`${E}[5~`), keyOf(`${E}[6~`)], ["pageup", "pagedown"]);
  assert.deepEqual(keyReader()(`${E}[6~${E}[F${E}[H`), ["pagedown", "end", "home"]);
});

test("the web's sixteen themes (PLNR-381): every token a colour, the web's own where it has one, chips, diffs and notices readable", () => {
  assert.equal(THEMES.length, 16);
  assert.equal(themeColours("graphite"), themeColours("no such theme"));
  // Mocha's ground and signal as themes.css has them.
  assert.equal(themeColours("mocha").ground, "#1e1e2e");
  assert.equal(themeColours("mocha").accent, readFileSync(new URL("../../../packages/display/src/themes.css", import.meta.url), "utf8").match(/\[data-theme="mocha"\] \{[\s\S]*?--ql-signal: (#[0-9a-f]{6});/)?.[1]);
  const fails: string[] = [];
  for (const { id } of THEMES) {
    const t = themeColours(id);
    for (const [token, value] of Object.entries(t)) if (!/^#[0-9a-f]{6}$/.test(value)) fails.push(`${id}: ${token} is ${value}`);
    const pairs: [string, string, number][] = [
      ...(["approved", "backlog", "canceled", "done", "progress", "review", "todo"] as const).flatMap((st): [string, string, number][] => [
        [`status-${st}`, `tint-${st}`, READS.glyph],
        ["ink-2", `tint-${st}`, READS.text],
      ]),
      ["ink-2", "add-bg", READS.text],
      ["ink-2", "del-bg", READS.text],
      ["success", "success-bg", READS.text],
      ["warning", "warning-bg", READS.text],
    ];
    for (const [f, b, least] of pairs) {
      const c = contrast(t[f as keyof typeof t], t[b as keyof typeof t]);
      if (c < least) fails.push(`${id}: ${f} on ${b} ${c.toFixed(2)} < ${least}`);
    }
  }
  assert.deepEqual(fails, []);
});

test("the question before the trash (RSVA-456): the question in the border, the issue under it, y and Esc in the bottom border and clickable", () => {
  const g = new Grid(80, 20);
  paintConfirm(g, "Delete RSVA-1?", [["A title", { fg: "ink" }], ["It goes to the project's trash; u brings it back.", { fg: "ink-3" }]], "delete");
  const row = (y: number) => g.cells.slice(y * 80, y * 80 + 80).map((c) => c.ch).join("");
  const rows = Array.from({ length: 20 }, (_, y) => row(y));
  const top = rows.findIndex((r) => r.includes("Delete RSVA-1?"));
  assert.ok(top > 0, "the question is in the top border");
  assert.match(rows[top + 2]!, /A title/);
  assert.match(rows[top + 3]!, /u brings it back/);
  const bottom = rows[top + 5]!;
  assert.match(bottom, /y delete {2}Esc cancel/);
  assert.deepEqual(g.keysAt(bottom.indexOf("y delete"), top + 5), ["y"]);
});
