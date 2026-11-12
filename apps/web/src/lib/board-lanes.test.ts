import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueGroup } from "@rsva/query";
import type { Issue } from "@rsva/schema/models";
import { columnIssues, columnOf, laneList, sameHeight } from "./board-lanes.ts";

const g = (key: string, n: number): IssueGroup => ({ key, groupBy: "priority", name: key, ref: null, issues: Array.from({ length: n }, () => ({}) as Issue) });

test("lanes are the union of sub-groups in first-seen order, counted across columns", () => {
  const lanes = laneList([{ subGroups: [g("high", 2), g("low", 1)] }, { subGroups: [g("none", 3), g("high", 4)] }, {}]);
  assert.deepEqual(
    lanes.map((l) => [l.lane.key, l.count]),
    [
      ["high", 6],
      ["low", 1],
      ["none", 3],
    ],
  );
});

const issue = (id: string) => ({ id }) as Issue;
const col = (key: string, ids: string[], subGroups?: IssueGroup[]): IssueGroup => ({ key, groupBy: "state", name: key, ref: null, issues: ids.map(issue), ...(subGroups && { subGroups }) });

test("a column walks lane by lane in the board's lane order, each issue once", () => {
  const lane = (key: string, ids: string[]) => ({ ...col(key, ids), groupBy: "label" as const });
  const todo = col("todo", ["a", "b", "c"], [lane("bug", ["c", "a"]), lane("ui", ["b", "a"])]);
  const other = col("done", ["d"], [lane("ui", ["d"])]);
  const lanes = laneList([other, todo]);
  assert.deepEqual(columnIssues(todo, lanes).map((i) => i.id), ["b", "a", "c"]);
  assert.deepEqual(columnIssues(todo, null).map((i) => i.id), ["a", "b", "c"]);
});

test("the column follows the issue: the preferred one while it holds it, else the first that does", () => {
  const groups = [col("empty", []), col("todo", ["a", "b"]), col("bug", ["b"]), col("done", ["c"])];
  assert.equal(columnOf(groups, "b", "bug")?.key, "bug");
  assert.equal(columnOf(groups, "b", null)?.key, "todo");
  // Its state changed: the preferred column no longer holds it.
  assert.equal(columnOf(groups, "c", "todo")?.key, "done");
  // Filtered out by an edit: it stays where it was.
  assert.equal(columnOf(groups, "gone", "bug")?.key, "bug");
  assert.equal(columnOf(groups, "gone", null)?.key, "todo");
  assert.equal(columnOf(groups, null, null)?.key, "todo");
});

test("sameHeight keeps the row across columns, clamped to the shorter one, the first row for an issue not there", () => {
  const col = (...ids: string[]) => ids.map((id) => ({ id }) as Issue);
  const here = col("a", "b", "c");
  assert.equal(sameHeight(here, col("x", "y", "z"), "b")?.id, "y");
  assert.equal(sameHeight(here, col("x"), "c")?.id, "x");
  assert.equal(sameHeight(here, col("x", "y"), "gone")?.id, "x");
  assert.equal(sameHeight([], col("x", "y"), "b")?.id, "x");
  assert.equal(sameHeight(here, [], "a"), undefined);
});
