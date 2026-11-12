import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PRIORITIES, priorityName, priorityTitle } from "@rsva/schema/models";
import { PRIORITY_KEYWORDS, PRIORITY_ORDER, runQuery, type Filter, type IssueGroup, type OrderBy } from "../src/index.ts";
import { ctx, display, issue, L, projectMap, S, U } from "./fixture.ts";

const ids = (gs: IssueGroup[]) => gs.map((g) => [g.key, g.issues.map((i) => i.number)]);
const nums = (gs: IssueGroup[]) => gs.flatMap((g) => g.issues.map((i) => i.number));
const flat = (f: Filter, issues = ISSUES) => nums(runQuery(issues, f, display({ groupBy: "none" }), ctx()));

const ISSUES = [
  issue(1, { title: "Fix Caddy config", stateId: S.backlog.id, priority: 1, labelIds: [L.bug.id, L.security.id], assigneeIds: [U.alex.id] }),
  issue(2, { title: "Dark mode", stateId: S.todo.id, priority: 2, labelIds: [L.bug.id], assigneeIds: [U.bot.id], dueDate: "2026-10-20" }),
  issue(3, { title: "Backup to NAS1", stateId: S.progress.id, priority: 3, assigneeIds: [U.alex.id, U.bot.id], dueDate: "2026-11-05", startDate: "2026-10-01" }),
  issue(4, { title: "Review the audit", stateId: S.review.id, priority: 0, dueDate: "2026-10-27", createdById: U.bot.id }),
  issue(5, { title: "Sub-task of 3", stateId: S.done.id, priority: 4, parentId: "x", labelIds: [L.security.id], createdById: null }),
  issue(6, { title: "Dropped", stateId: S.cancelled.id, priority: 2, labelIds: ["deleted-label"], assigneeIds: ["gone-user"] }),
];

describe("filters", () => {
  test("no filter lets everything through in manual order", () => {
    assert.deepEqual(flat({}), [1, 2, 3, 4, 5, 6]);
  });
  test("state and state group", () => {
    assert.deepEqual(flat({ state: [S.todo.id, S.done.id] }), [2, 5]);
    assert.deepEqual(flat({ stateGroup: ["started"] }), [3, 4]);
    assert.deepEqual(flat({ stateGroup: ["started"], state: [S.review.id] }), [4], "AND across keys");
  });
  test("priority, including none", () => {
    assert.deepEqual(flat({ priority: [1, 2] }), [1, 2, 6]);
    assert.deepEqual(flat({ priority: [0] }), [4]);
  });
  test("assignee: ids, me, none; unknown ids count as nobody", () => {
    assert.deepEqual(flat({ assignee: [U.bot.id] }), [2, 3]);
    assert.deepEqual(flat({ assignee: ["me"] }), [1, 3]);
    assert.deepEqual(flat({ assignee: ["none"] }), [4, 5]);
    assert.deepEqual(flat({ assignee: ["none", "me"] }), [1, 3, 4, 5], "OR within a key");
    assert.deepEqual(nums(runQuery(ISSUES, { assignee: ["me"] }, display({ groupBy: "none" }), ctx({ me: null }))), [], "me without a user");
  });
  test("label: ids and none", () => {
    assert.deepEqual(flat({ label: [L.security.id] }), [1, 5]);
    assert.deepEqual(flat({ label: [L.security.id, L.bug.id] }), [1, 2, 5]);
    assert.deepEqual(flat({ label: ["none"] }), [3, 4]);
  });
  test("created by", () => {
    assert.deepEqual(flat({ createdBy: [U.bot.id] }), [4]);
    assert.deepEqual(flat({ createdBy: ["me"] }), [1, 2, 3, 6]);
  });
  test("start and due dates: inclusive, open ends, no date never matches", () => {
    assert.deepEqual(flat({ dueDate: { from: "2026-10-20", to: "2026-10-27" } }), [2, 4]);
    assert.deepEqual(flat({ dueDate: { to: "2026-10-26" } }), [2]);
    assert.deepEqual(flat({ dueDate: { from: "2026-10-27" } }), [3, 4]);
    assert.deepEqual(flat({ startDate: { from: "2026-09-01" } }), [3]);
  });
  test("none: issues without the date (RSVA-13)", () => {
    assert.deepEqual(flat({ dueDate: { none: true } }), [1, 5, 6]);
    assert.deepEqual(flat({ startDate: { none: true } }), [1, 2, 4, 5, 6]);
  });
  test("this-week re-resolves from the context's first day", () => {
    // today is Tuesday 2026-10-27 (fixture); due 2026-10-20 is last Tuesday, 2026-11-05 next Thursday.
    const run = (weekStart: number) => nums(runQuery(ISSUES, { dueDate: { preset: "next-week" } }, display({ groupBy: "none" }), ctx({ weekStart })));
    assert.deepEqual(run(1), [3], "2026-11-02..2026-11-08");
    assert.deepEqual(run(4), [], "weeks from Thursday: 2026-10-29..2026-11-04");
  });
  test("relative presets re-resolve against today", () => {
    // Stale from/to from another day: the preset wins.
    assert.deepEqual(flat({ dueDate: { preset: "<today", to: "2020-01-01" } }), [2]);
    assert.deepEqual(flat({ dueDate: { preset: "today" } }), [4]);
    assert.deepEqual(flat({ dueDate: { preset: "next-2-weeks" } }), [3, 4]);
  });
  test("created and updated: local days over both timestamp formats", () => {
    const rows = [
      issue(1, { createdAt: "2026-10-26 23:59:59.000+00" }),
      issue(2, { createdAt: "2026-10-27T00:00:00.000Z" }),
      issue(3, { createdAt: "2026-10-27 23:59:59.999+00" }),
      issue(4, { createdAt: "2026-10-28T00:00:00.000Z" }),
    ];
    // The day is local: [local midnight of the 27th, local midnight of the 28th), whatever the zone of the runner.
    const lo = new Date(2026, 9, 27).getTime();
    const hi = new Date(2026, 9, 28).getTime();
    const at = (ts: string) => Date.parse(ts.replace(" ", "T").replace(/\+00$/, "Z"));
    const expected = rows.filter((r) => at(r.createdAt) >= lo && at(r.createdAt) < hi).map((r) => r.number);
    assert.deepEqual(flat({ createdAt: { from: "2026-10-27", to: "2026-10-27" } }, rows), expected);
    if (new Date(2026, 9, 27).getTimezoneOffset() === 0) assert.deepEqual(expected, [2, 3]);
    // In the person's zone (the server passes the Profile's): Sofia is UTC+2 after 2026-10-25, whatever the runner's zone.
    const sofia = (f: Filter) => nums(runQuery(rows, f, display({ groupBy: "none" }), ctx({ timeZone: "Europe/Sofia" })));
    assert.deepEqual(sofia({ createdAt: { from: "2026-10-27", to: "2026-10-27" } }), [1, 2], "[2026-10-26 22:00Z, 2026-10-27 22:00Z)");
    assert.deepEqual(sofia({ createdAt: { from: "2026-10-28" } }), [3, 4]);
    assert.deepEqual(flat({ updatedAt: { from: "2026-10-05" } }, ISSUES).length, ISSUES.filter((i) => i.number % 27 >= 4).length);
  });
  test("closed: the day it was completed on; an issue never closed is in no range, and is what none finds (RSVA-576)", () => {
    const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();
    const rows = [issue(1, { completedAt: noon("2026-10-21") }), issue(2, { completedAt: noon("2026-10-22") }), issue(3, { completedAt: null })];
    assert.deepEqual(flat({ completedAt: { from: "2026-10-21", to: "2026-10-21" } }, rows), [1]);
    assert.deepEqual(flat({ completedAt: { from: "2026-10-22" } }, rows), [2]);
    assert.deepEqual(flat({ completedAt: { to: "2026-10-22" } }, rows), [1, 2]);
    assert.deepEqual(flat({ completedAt: { none: true } }, rows), [3]);
  });
  test("text: words AND, case-insensitive, phrases, issue keys", () => {
    assert.deepEqual(flat({ text: "caddy" }), [1]);
    assert.deepEqual(flat({ text: "FIX config" }), [1]);
    assert.deepEqual(flat({ text: "fix dark" }), []);
    assert.deepEqual(flat({ text: '"dark mode"' }), [2]);
    assert.deepEqual(flat({ text: "plnr-3" }), [3]);
    assert.deepEqual(flat({ text: "(" }), [], "regexp characters are literal");
  });
});

describe("display", () => {
  test("show sub-issues off hides issues with a parent", () => {
    assert.deepEqual(nums(runQuery(ISSUES, {}, display({ groupBy: "none", showSubIssues: false }), ctx())), [1, 2, 3, 4, 6]);
  });

  test("group by state: Plane's group order, empty groups on demand", () => {
    const g = runQuery(ISSUES.slice(0, 3), {}, display({ groupBy: "state" }), ctx());
    assert.deepEqual(ids(g), [
      [`state:${S.backlog.id}`, [1]],
      [`state:${S.todo.id}`, [2]],
      [`state:${S.progress.id}`, [3]],
    ]);
    const all = runQuery(ISSUES.slice(0, 3), {}, display({ groupBy: "state", showEmptyGroups: true }), ctx());
    assert.deepEqual(all.map((x) => x.name), ["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"]);
    assert.deepEqual(all[3]!.issues, []);
    assert.deepEqual(all[0]!.ref, { state: S.backlog });
  });

  test("group by state group and priority", () => {
    const sg = runQuery(ISSUES, {}, display({ groupBy: "stateGroup", showEmptyGroups: true }), ctx());
    assert.deepEqual(ids(sg), [
      ["stateGroup:backlog", [1]],
      ["stateGroup:unstarted", [2]],
      ["stateGroup:started", [3, 4]],
      ["stateGroup:completed", [5]],
      ["stateGroup:cancelled", [6]],
    ]);
    const pr = runQuery(ISSUES, {}, display({ groupBy: "priority" }), ctx());
    assert.deepEqual(ids(pr), [
      ["priority:1", [1]],
      ["priority:2", [2, 6]],
      ["priority:3", [3]],
      ["priority:4", [5]],
      ["priority:0", [4]],
    ]);
    assert.deepEqual(pr.map((x) => x.name), ["Urgent", "High", "Medium", "Low", "No priority"]);
  });

  test("group by assignee: an issue with two assignees is in both; unknown ids go to No assignees", () => {
    const g = runQuery(ISSUES, {}, display({ groupBy: "assignee", showEmptyGroups: true }), ctx());
    assert.deepEqual(ids(g), [
      [`assignee:${U.alex.id}`, [1, 3]],
      [`assignee:${U.bot.id}`, [2, 3]],
      [`assignee:${U.zoe.id}`, []],
      ["assignee:none", [4, 5, 6]],
    ]);
    assert.equal(g.at(-1)!.name, "No assignees");
    assert.equal(g.at(-1)!.ref, null);
  });

  test("group by label: by position, both groups for two labels, No labels last", () => {
    const g = runQuery(ISSUES, {}, display({ groupBy: "label" }), ctx());
    assert.deepEqual(ids(g), [
      [`label:${L.security.id}`, [1, 5]],
      [`label:${L.bug.id}`, [1, 2]],
      ["label:none", [3, 4, 6]],
    ]);
    const empty = runQuery(ISSUES, {}, display({ groupBy: "label", showEmptyGroups: true }), ctx());
    assert.deepEqual(empty.map((x) => x.name), ["security", "bug", "needs owner", "No labels"]);
  });

  test("group by created by; none; empty project", () => {
    const g = runQuery(ISSUES, {}, display({ groupBy: "createdBy" }), ctx());
    assert.deepEqual(ids(g), [
      [`createdBy:${U.alex.id}`, [1, 2, 3, 6]],
      [`createdBy:${U.bot.id}`, [4]],
      ["createdBy:none", [5]],
    ]);
    assert.deepEqual(ids(runQuery(ISSUES, {}, display({ groupBy: "none" }), ctx())), [["all", [1, 2, 3, 4, 5, 6]]]);
    assert.deepEqual(ids(runQuery([], {}, display({ groupBy: "none", showEmptyGroups: true }), ctx())), [["all", []]]);
    assert.deepEqual(runQuery([], {}, display({ groupBy: "priority" }), ctx()), []);
  });

  test("group keys are stable across runs and data changes", () => {
    const a = runQuery(ISSUES, {}, display({ groupBy: "label" }), ctx()).map((g) => g.key);
    const b = runQuery([...ISSUES].reverse(), { priority: [1, 2, 3, 4] }, display({ groupBy: "label" }), ctx()).map((g) => g.key);
    assert.deepEqual(b.filter((k) => a.includes(k)), b);
  });

  test("sub-groups for the board", () => {
    const g = runQuery(ISSUES, {}, display({ groupBy: "stateGroup", subGroupBy: "priority" }), ctx());
    const started = g.find((x) => x.key === "stateGroup:started")!;
    assert.deepEqual(ids(started.subGroups!), [
      ["priority:3", [3]],
      ["priority:0", [4]],
    ]);
    assert.equal(runQuery(ISSUES, {}, display({ subGroupBy: null }), ctx())[0]!.subGroups, undefined);
  });
});

describe("order", () => {
  const rows = [
    issue(1, { sortOrder: "b", priority: 3, dueDate: null, startDate: "2026-10-03", createdAt: "2026-10-01 10:00:00+00", updatedAt: "2026-10-09T00:00:00.000Z" }),
    issue(2, { sortOrder: "B", priority: 0, dueDate: "2026-10-10", startDate: null, createdAt: "2026-10-03T10:00:00.000Z", updatedAt: "2026-10-02 00:00:00+00" }),
    issue(3, { sortOrder: "a", priority: 1, dueDate: "2026-10-05", startDate: "2026-10-01", createdAt: "2026-10-02 10:00:00.5+00", updatedAt: "2026-10-05 00:00:00+00" }),
    issue(4, { sortOrder: "a0", priority: 3, dueDate: null, startDate: null, createdAt: "2026-10-02 10:00:00+00", updatedAt: "2026-10-01 00:00:00+00" }),
  ];
  const order = (orderBy: OrderBy) =>
    nums(runQuery(rows, {}, display({ groupBy: "none", orderBy }), ctx()));

  test("manual compares code units, not locale: uppercase before lowercase", () => {
    assert.deepEqual(order("manual"), [2, 3, 4, 1]);
  });
  test("created and updated: newest first, across timestamp formats", () => {
    // 3 and 4 differ below a second: equal to us, so manual order decides.
    assert.deepEqual(order("createdAt"), [2, 3, 4, 1]);
    assert.deepEqual(order("updatedAt"), [1, 3, 2, 4]);
  });
  test("dates ascending with nulls last; ties in manual order", () => {
    assert.deepEqual(order("dueDate"), [3, 2, 4, 1]);
    assert.deepEqual(order("startDate"), [3, 1, 2, 4]);
  });
  test("priority urgent → none, ties in manual order", () => {
    assert.deepEqual(order("priority"), [3, 4, 1, 2]);
  });
  test("groups keep the order", () => {
    const g = runQuery(rows, {}, display({ groupBy: "priority", orderBy: "dueDate" }), ctx());
    assert.deepEqual(ids(g), [
      ["priority:1", [3]],
      ["priority:3", [4, 1]],
      ["priority:0", [2]],
    ]);
  });
  test("the input array is not mutated", () => {
    const copy = [...rows];
    runQuery(rows, {}, display({ orderBy: "priority" }), ctx());
    assert.deepEqual(rows, copy);
  });
});

describe("views across projects (PLNR-74)", () => {
  const Q = "00000000-0000-4000-8000-000000000002";
  const other = { ...S.review, id: "00000000-0000-4000-8000-000000000903", projectId: Q, position: 1 };
  const projects = projectMap([
    { id: "00000000-0000-4000-8000-000000000001", key: "PLNR", name: "Planner" },
    { id: Q, key: "INFRA", name: "Infrastructure" },
  ]);
  const wide = () => ctx({ states: new Map([...Object.values(S), other].map((s) => [s.id, s])), projects });
  const across = [
    issue(1, { stateId: S.review.id, delegateId: U.bot.id }),
    issue(2, { projectId: Q, stateId: other.id }),
    issue(3, { stateId: S.todo.id, delegateId: U.zoe.id }),
  ];

  test("delegate: any, none, a person; project", () => {
    const run = (f: Filter) => nums(runQuery(across, f, display({ groupBy: "none" }), wide()));
    assert.deepEqual(run({ delegate: ["any"] }), [1, 3]);
    assert.deepEqual(run({ delegate: ["none"] }), [2]);
    assert.deepEqual(run({ delegate: [U.zoe.id, "none"] }), [2, 3]);
    assert.deepEqual(run({ project: [Q] }), [2]);
  });

  test("states that share a name are one group across projects, under the first in order", () => {
    const g = runQuery(across, {}, display({ groupBy: "state" }), wide());
    assert.deepEqual(ids(g), [
      [`state:${S.todo.id}`, [3]],
      [`state:${other.id}`, [1, 2]],
    ]);
  });

  test("group by project, and by agent with No agent last", () => {
    assert.deepEqual(ids(runQuery(across, {}, display({ groupBy: "project" }), wide())), [
      [`project:${Q}`, [2]],
      ["project:00000000-0000-4000-8000-000000000001", [1, 3]],
    ]);
    const g = runQuery(across, {}, display({ groupBy: "delegate", showEmptyGroups: true }), wide());
    assert.deepEqual(ids(g), [
      [`delegate:${U.bot.id}`, [1]],
      [`delegate:${U.zoe.id}`, [3]],
      ["delegate:none", [2]],
    ]);
    assert.equal(g[1]!.name, "Zoe Quinn");
  });
});

describe("is not (PLNR-74)", () => {
  test("an issue with any negated value is left out; issues without the field pass", () => {
    assert.deepEqual(flat({ not: { label: [L.bug.id] } }), [3, 4, 5, 6]);
    assert.deepEqual(flat({ not: { state: [S.done.id, S.cancelled.id] }, assignee: [U.alex.id] }), [1, 3]);
    assert.deepEqual(flat({ not: { assignee: ["none"] } }), [1, 2, 3, 6]);
  });
});

test("the priorities, once (PRIORITIES of @rsva/schema): the database's code, the query's word, the name people read", () => {
  assert.deepEqual(
    PRIORITIES.map((p) => [p.code, p.keyword, p.name]),
    [
      [1, "urgent", "Urgent"],
      [2, "high", "High"],
      [3, "medium", "Medium"],
      [4, "low", "Low"],
      [0, "none", "No priority"],
    ],
  );
  assert.deepEqual(PRIORITY_ORDER, [1, 2, 3, 4, 0]);
  assert.deepEqual(PRIORITY_KEYWORDS, { 0: "none", 1: "urgent", 2: "high", 3: "medium", 4: "low" });
  assert.equal(priorityName(7), "No priority", "a code the database does not hold");
  assert.deepEqual([priorityTitle(2), priorityTitle(0)], ["Priority: High", "No priority"]);
});
