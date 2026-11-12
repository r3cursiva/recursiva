import assert from "node:assert/strict";
import { test } from "node:test";
import { generateNKeysBetween } from "fractional-indexing";
import { keyForMove, keyForPosition, keysForMove } from "./sort-keys.ts";

const keys = generateNKeysBetween(null, null, 6); // a0 … a5

test("between two adjacent keys", () => {
  const k = keyForPosition(keys, keys[1]!, keys[2]!);
  assert.ok(keys[1]! < k && k < keys[2]!);
});

test("neighbours in a group are not adjacent in the project: the key stays below the next project key", () => {
  // The group shows a1 and a4; a2 and a3 belong to other groups.
  const k = keyForPosition(keys, keys[1]!, keys[4]!);
  assert.ok(keys[1]! < k && k < keys[2]!, k);
  assert.ok(!keys.includes(k));
});

test("top of a group goes right before its first issue, after the previous project key", () => {
  const k = keyForPosition(keys, null, keys[3]!);
  assert.ok(keys[2]! < k && k < keys[3]!, k);
});

test("empty group and empty project", () => {
  const k = keyForPosition(keys, null, null);
  assert.ok(k > keys.at(-1)!);
  assert.equal(typeof keyForPosition([], null, null), "string");
});

test("unnumbered local issues (empty keys) are ignored", () => {
  const k = keyForPosition(["", ...keys], null, keys[0]!);
  assert.ok(k < keys[0]! && k !== "");
});

test("many inserts at the same place keep keys unique and ordered", () => {
  const all = [...keys];
  for (let n = 0; n < 200; n++) {
    const k = keyForPosition(all, all[1]!, all[2]!);
    assert.ok(all[1]! < k && k < all[2]!);
    all.splice(2, 0, k);
  }
  assert.equal(new Set(all).size, all.length);
});

test("keyForMove: within a group, to another place and to the same place", () => {
  const rows = keys.map((sortOrder, i) => ({ id: `i${i}`, sortOrder }));
  const group = [rows[0]!, rows[2]!, rows[4]!];
  // i4 to the top of its group.
  const k = keyForMove(rows, group, "i4", 0)!;
  assert.ok(k < rows[0]!.sortOrder);
  // i2 stays between i0 and i4.
  assert.equal(keyForMove(rows, group, "i2", 1), null);
  // i0 to the end: after i4 and before i5 of another group.
  const e = keyForMove(rows, group, "i0", 3)!;
  assert.ok(rows[4]!.sortOrder < e && e < rows[5]!.sortOrder, e);
});

test("keyForMove: an issue from another group lands between the target neighbours", () => {
  const rows = keys.map((sortOrder, i) => ({ id: `i${i}`, sortOrder }));
  const target = [rows[1]!, rows[3]!];
  const k = keyForMove(rows, target, "i5", 1)!;
  assert.ok(rows[1]!.sortOrder < k && k < rows[2]!.sortOrder, k);
});

test("keysForMove: marked issues land as one block, in order, between the target neighbours (RSVA-303)", () => {
  const items = keys.map((sortOrder, i) => ({ id: `i${i}`, sortOrder }));
  // One column holds i0, i1, i2, i4; i2 is dragged with i0 (marked) and i5 from another column, dropped between i1 and i4
  // (index 2 among the cards but i2: i0, i1 | i4).
  const column = [items[0]!, items[1]!, items[2]!, items[4]!];
  const got = keysForMove(items, column, "i2", ["i0", "i2", "i5"], 2);
  assert.equal(got.length, 3);
  assert.ok(keys[1]! < got[0]! && got[0]! < got[1]! && got[1]! < got[2]! && got[2]! < keys[3]!, got.join());
  // To the top of the column: before i1 once i0 is out of it.
  const top = keysForMove(items, column, "i2", ["i0", "i2"], 0);
  assert.ok(top[1]! < keys[1]! && top[0]! < top[1]!, top.join());
});
