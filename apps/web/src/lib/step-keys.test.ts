import assert from "node:assert/strict";
import { test } from "node:test";
import { neighbour, normKey, stepIn, stepKey } from "./step-keys.ts";

test("J and ↓ step down, K and ↑ up, nothing else steps", () => {
  assert.deepEqual(["j", "ArrowDown", "k", "ArrowUp", "J", "h", "Enter"].map(stepKey), [1, 1, -1, -1, 0, 0, 0]);
});

test("a step stays at the ends and starts at the first row", () => {
  const rows = ["a", "b", "c"];
  assert.equal(stepIn(rows, 1, 1), "c");
  assert.equal(stepIn(rows, 2, 1), "c");
  assert.equal(stepIn(rows, 0, -1), "a");
  assert.equal(stepIn(rows, -1, 1), "a");
  assert.equal(stepIn(rows, -1, -1), "a");
  assert.equal(stepIn([], -1, 1), undefined);
});

test("a letter is read in lower case, a named key as it is", () => {
  const e = (key: string) => ({ key }) as KeyboardEvent;
  assert.deepEqual(["J", "j", "Enter", "ArrowDown"].map((k) => normKey(e(k))), ["j", "j", "Enter", "ArrowDown"]);
});

test("a leaving row hands the selection to the next row, else the one before", () => {
  const rows = ["a", "b", "c"];
  assert.equal(neighbour(rows, "b"), "c");
  assert.equal(neighbour(rows, "c"), "b");
  assert.equal(neighbour(["a"], "a"), undefined);
  assert.equal(neighbour(rows, "gone"), "a");
});
