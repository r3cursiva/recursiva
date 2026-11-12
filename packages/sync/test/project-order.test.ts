import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@rsva/schema/models";
import { movedOrder, orderProjects } from "../src/project-order.ts";

const projects = (...ids: string[]) => ids.map((id) => ({ id, key: id.toUpperCase() })) as Project[];
const ids = (list: Project[]) => list.map((p) => p.id);

test("the order names projects first; the rest follow by key, and no order leaves the list as it is", () => {
  const byKey = projects("a", "b", "c", "d");
  assert.equal(orderProjects(byKey, []), byKey);
  assert.deepEqual(ids(orderProjects(byKey, ["c", "a"])), ["c", "a", "b", "d"]);
  assert.deepEqual(ids(orderProjects(byKey, ["gone", "d"])), ["d", "a", "b", "c"], "an id of nothing sorts nowhere");
});

test("a move lands before its new neighbour, or last", () => {
  assert.deepEqual(movedOrder(["a", "b", "c"], ["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(movedOrder(["a", "b", "c"], ["a", "b", "c"], "a", undefined), ["b", "c", "a"]);
});

test("the first move holds the whole list as shown, so later projects come after it", () => {
  assert.deepEqual(movedOrder([], ["a", "b", "c"], "c", "b"), ["a", "c", "b"]);
  assert.deepEqual(movedOrder(["b"], ["b", "a", "c"], "c", "b"), ["c", "b", "a"]);
});

test("an archived project keeps its place through moves of the others", () => {
  assert.deepEqual(movedOrder(["a", "x", "b", "c"], ["a", "b", "c"], "c", "b"), ["a", "x", "c", "b"]);
});
