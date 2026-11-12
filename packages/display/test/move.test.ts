// What a move asks before it moves (PLNR-448): the sub-issues it would leave behind, at any depth, each once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { subIssuesLeft } from "../src/move.ts";

const tree: Record<string, string[]> = { a: ["b", "c"], b: ["d"], c: [], d: ["b"], x: ["c"] };
const subs = (id: string) => (tree[id] ?? []).map((k) => ({ id: k }));

test("sub-issues at any depth, not the issues moved themselves, each once even in a loop", () => {
  assert.deepEqual(subIssuesLeft(subs, ["a"]).map((i) => i.id), ["b", "d", "c"]);
  assert.deepEqual(subIssuesLeft(subs, ["a", "b"]).map((i) => i.id), ["c", "d"], "one moved along is not asked about");
  assert.deepEqual(subIssuesLeft(subs, ["a", "x"]).map((i) => i.id), ["b", "d", "c"]);
  assert.deepEqual(subIssuesLeft(subs, ["c"]), []);
});
