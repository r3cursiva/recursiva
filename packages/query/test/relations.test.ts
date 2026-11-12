// parent:, is: and has: over the other issues of the workspace, grouping by parent (PLNR-51, PLNR-173, RSVA-174).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Issue } from "@rsva/schema/models";
import { formatQuery, needsIssueIndex, parseQuery, runQuery, runQueryRows, type Filter, type IssueIndex } from "../src/index.ts";
import { ctx as baseCtx, display, issue, S } from "./fixture.ts";

/** An index over `rows` with the rule the pool and the API share: closed and deleted issues hold nobody up. */
function indexOf(rows: Issue[], linked: readonly Issue[] = []): IssueIndex {
  const open = (i: Issue) => !i.deletedAt && !i.archivedAt && i.stateId !== S.done.id;
  const byId = new Map(rows.filter((i) => !i.deletedAt).map((i) => [i.id, i]));
  return {
    get: (id) => byId.get(id),
    byKey: (key) => [...byId.values()].find((i) => `PLNR-${i.number}` === key),
    isBlocked: (i) => i.blockedByIds.some((id) => !!byId.get(id) && open(byId.get(id)!)),
    isBlocking: (i) => open(i) && rows.some((x) => open(x) && x.blockedByIds.includes(i.id)),
    hasLink: (i) => linked.some((x) => x.id === i.id),
  };
}

const epic = issue(1, { title: "Secrets", sortOrder: "b" });
const other = issue(2, { title: "Reboots", sortOrder: "a" });
const child = issue(3, { parentId: epic.id });
const childOfOther = issue(4, { parentId: other.id });
const free = issue(5);
const rows = [epic, other, child, childOfOther, free];
const ctx = baseCtx({ issues: indexOf(rows) });
const numbers = (list: Issue[], filter: Filter) => runQueryRows(list, filter, display(), ctx).map((i) => i.number).sort((a, b) => a - b);

describe("parent:", () => {
  test("a key takes its direct children; none and any are the words", () => {
    const p = parseQuery("parent:plnr-1", ctx);
    assert.deepEqual(p, { filter: { parent: [epic.id] }, errors: [] });
    assert.deepEqual(numbers(rows, p.filter), [3]);
    assert.deepEqual(numbers(rows, parseQuery("parent:none", ctx).filter), [1, 2, 5]);
    assert.deepEqual(numbers(rows, parseQuery("parent:any", ctx).filter), [3, 4]);
    assert.deepEqual(numbers(rows, parseQuery("parent:PLNR-1,PLNR-2", ctx).filter), [3, 4]);
  });

  test("not a parent, and not nested", () => {
    assert.deepEqual(numbers(rows, parseQuery("-parent:PLNR-1", ctx).filter), [1, 2, 4, 5]);
    const grand = issue(6, { parentId: child.id });
    assert.deepEqual(numbers([...rows, grand], { parent: [epic.id] }), [3]);
  });

  test("an unknown key is an error that keeps the rest of the query", () => {
    const { filter, errors } = parseQuery("parent:PLNR-99 priority:high", ctx);
    assert.equal(errors[0]!.message, 'No issue named "PLNR-99"');
    assert.deepEqual(filter, { priority: [2] });
    assert.equal(parseQuery("parent:PLNR-1", baseCtx()).errors.length, 1, "without an index a key names nothing");
  });

  test("written back as keys", () => {
    const f: Filter = { parent: [epic.id, "none"], not: { parent: [other.id] }, is: ["blocked"] };
    const text = formatQuery(f, ctx);
    assert.equal(text, "parent:PLNR-1,none -parent:PLNR-2 is:blocked");
    assert.deepEqual(parseQuery(text, ctx).filter, f);
  });

  test("hiding sub-issues does not empty a list that asks for them", () => {
    const hidden = display({ showSubIssues: false });
    assert.deepEqual(runQueryRows(rows, {}, hidden, ctx).map((i) => i.number).sort(), [1, 2, 5]);
    assert.equal(runQueryRows(rows, { parent: [epic.id] }, hidden, ctx).length, 1);
    assert.equal(runQueryRows(rows, {}, { ...hidden, groupBy: "parent" }, ctx).length, 5);
  });
});

describe("is:", () => {
  const blocker = issue(11);
  const waiting = issue(12, { blockedByIds: [blocker.id] });
  const doneBlocker = issue(13, { stateId: S.done.id });
  const free2 = issue(14, { blockedByIds: [doneBlocker.id] });
  const gone = issue(15, { deletedAt: "2026-10-20 10:00:00+00" });
  const orphan = issue(16, { blockedByIds: [gone.id] });
  const doneWaiter = issue(17, { stateId: S.done.id, blockedByIds: [issue(18).id] });
  const quiet = issue(18);
  const all = [blocker, waiting, doneBlocker, free2, gone, orphan, doneWaiter, quiet];
  const c = baseCtx({ issues: indexOf(all) });
  const run = (q: string, list = all) => {
    const p = parseQuery(q, c);
    assert.deepEqual(p.errors, []);
    return runQueryRows(list, p.filter, display(), c).map((i) => i.number).sort((a, b) => a - b);
  };

  test("blocked waits on a live open issue; blocking is what an open issue waits on", () => {
    assert.deepEqual(run("is:blocked"), [12, 17]);
    assert.deepEqual(run("is:blocking"), [11]);
    assert.deepEqual(run("is:blocked,blocking"), [11, 12, 17]);
    assert.deepEqual(run("-is:blocked state:Todo").includes(12), false);
  });

  test("a blocker out of the list's scope still counts", () => {
    assert.deepEqual(run("is:blocked", [waiting]), [12]);
  });

  test("a typo gets a suggestion", () => {
    const { errors } = parseQuery("is:blockd", c);
    assert.equal(errors[0]!.message, 'No condition named "blockd"');
    assert.deepEqual(errors[0]!.suggestions, ["blocked"]);
  });

  test("duplicate reads the issue's own field, with or without an index", () => {
    const original = issue(21);
    const copy = issue(22, { duplicateOfId: original.id });
    const list = [original, copy, quiet];
    assert.deepEqual(run("is:duplicate", list), [22]);
    assert.deepEqual(run("-is:duplicate", list), [18, 21]);
    assert.deepEqual(run("is:duplicate,blocking", [...list, blocker]), [11, 22]);
    const bare = baseCtx();
    assert.deepEqual(runQueryRows(list, parseQuery("is:duplicate", bare).filter, display(), bare).map((i) => i.number), [22]);
  });
});

describe("has:", () => {
  const linked = issue(31);
  const plain = issue(32);
  const c = baseCtx({ issues: indexOf([linked, plain], [linked]) });
  const run = (q: string) => {
    const p = parseQuery(q, c);
    assert.deepEqual(p.errors, []);
    return runQueryRows([linked, plain], p.filter, display(), c).map((i) => i.number).sort((a, b) => a - b);
  };

  test("link and its negation", () => {
    assert.deepEqual(run("has:link"), [31]);
    assert.deepEqual(run("-has:link"), [32]);
    assert.deepEqual(run("HAS:Link"), [31]);
  });

  test("without an index nothing has a link, as is:blocked finds nothing", () => {
    const bare = baseCtx();
    assert.deepEqual(runQueryRows([linked, plain], parseQuery("has:link", bare).filter, display(), bare), []);
  });

  test("written back, and an unknown word is an error with a suggestion", () => {
    const f: Filter = { is: ["duplicate"], has: ["link"], not: { has: ["link"] } };
    const text = formatQuery(f, c);
    assert.equal(text, "is:duplicate has:link -has:link");
    assert.deepEqual(parseQuery(text, c).filter, f);
    const { errors } = parseQuery("has:lnk", c);
    assert.equal(errors[0]!.message, 'No attachment kind named "lnk"');
    assert.deepEqual(errors[0]!.suggestions, ["link"]);
  });
});

describe("group by parent", () => {
  test("parents in their manual order, each named by its key and title; no parent last", () => {
    const g = runQuery(rows, {}, display({ groupBy: "parent" }), ctx);
    assert.deepEqual(g.map((x) => [x.name, x.issues.map((i) => i.number)]), [
      ["PLNR-2 Reboots", [4]],
      ["PLNR-1 Secrets", [3]],
      ["No parent", [2, 5, 1]],
    ]);
    assert.deepEqual(g[0]!.ref, { parent: other });
  });

  test("a deleted parent leaves its sub-issues with no parent", () => {
    const list = [issue(1, { deletedAt: "2026-10-20 10:00:00+00" }), child];
    const g = runQuery([child], {}, display({ groupBy: "parent" }), baseCtx({ issues: indexOf(list) }));
    assert.deepEqual(g.map((x) => x.key), ["parent:none"]);
  });

  test("sub-groups on a board; a parent with no rows gets no group", () => {
    const g = runQuery([child], {}, display({ groupBy: "state", subGroupBy: "parent", showEmptyGroups: true }), ctx);
    const todo = g.find((x) => x.name === "Todo")!;
    assert.deepEqual(todo.subGroups!.map((x) => x.name), ["PLNR-1 Secrets", "No parent"]);
  });
});

test("needsIssueIndex: only a query that reads other issues pays for them", () => {
  assert.equal(needsIssueIndex("parent:INFRA-1"), true);
  assert.equal(needsIssueIndex("state:Todo -is:blocked"), true);
  assert.equal(needsIssueIndex("IS:blocked"), true);
  assert.equal(needsIssueIndex("has:link"), true);
  assert.equal(needsIssueIndex("-has:link"), true);
  assert.equal(needsIssueIndex("is:duplicate,blocked"), true);
  assert.equal(needsIssueIndex("is:duplicate"), false, "a field of the issue itself");
  assert.equal(needsIssueIndex("-IS:Duplicate"), false);
  assert.equal(needsIssueIndex("state:Todo parent text"), false);
  assert.equal(needsIssueIndex(""), false);
});
