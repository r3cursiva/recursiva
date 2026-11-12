import assert from "node:assert/strict";
import { test } from "node:test";
import { lineage, subtree } from "./issue-tree.ts";

const rows = [
  { id: "a", parentId: null },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
  { id: "d", parentId: "a" },
  { id: "e", parentId: null },
];
const get = (id: string) => rows.find((r) => r.id === id);
const subs = (id: string) => rows.filter((r) => r.parentId === id);

test("subtree: the issue and every sub-issue below it", () => {
  assert.deepEqual([...subtree("a", subs)].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual([...subtree("e", subs)], ["e"]);
});

test("lineage: the issue and its parents; a loop in stale data ends the walk", () => {
  assert.deepEqual([...lineage("c", get)], ["c", "b", "a"]);
  const loop = [{ id: "x", parentId: "y" }, { id: "y", parentId: "x" }];
  assert.deepEqual([...lineage("x", (id) => loop.find((r) => r.id === id))], ["x", "y"]);
});
