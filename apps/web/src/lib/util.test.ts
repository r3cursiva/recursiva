import { assignable } from "@rsva/schema/models";
import { capCount, errorText, groupBy, plural, seeded, toggled } from "@rsva/schema/util";
import { avatarTone } from "@rsva/display/avatar";
import { tileTone } from "@rsva/display/tile";
import assert from "node:assert/strict";
import { test } from "node:test";

// The small helpers of packages/schema/src/util.ts and the name hash behind the avatar and tile tones (packages/ui).

test("plural counts with the word, in the singular only for one", () => {
  assert.equal(plural(1, "issue"), "1 issue");
  assert.equal(plural(0, "issue"), "0 issues");
  assert.equal(plural(3, "issue"), "3 issues");
  assert.equal(plural(1, "repository", "repositories"), "1 repository");
  assert.equal(plural(2, "repository", "repositories"), "2 repositories");
});

test("errorText is an Error's message or the value as text", () => {
  assert.equal(errorText(new TypeError("no")), "no");
  assert.equal(errorText("plain"), "plain");
  assert.equal(errorText(404), "404");
});

test("groupBy keeps first-seen key order and item order", () => {
  const groups = groupBy([3, 1, 4, 1, 5, 9, 2, 6], (n) => n % 2);
  assert.deepEqual([...groups], [[1, [3, 1, 1, 5, 9]], [0, [4, 2, 6]]]);
  assert.deepEqual([...groupBy(new Set(["a", "bb", "c"]), (s) => s.length)], [[1, ["a", "c"]], [2, ["bb"]]]);
});

test("a name keeps the avatar and tile tones it always had", () => {
  assert.deepEqual(["Robin Vale", "bot", "Arsen", "Recursiva"].map(avatarTone), ["mauve", "slate", "slate", "mauve"]);
  assert.deepEqual(["Robin Vale", "bot", "Arsen", "Recursiva"].map(tileTone), ["teal", "indigo", "indigo", "umber"]);
});

// Values taken from the hand-written copies (fixtures, perf, sync-lab) before they were merged: saved fuzz seeds, the generated
// fixtures and the perf:net base depend on them.
test("seeded keeps the sequences the old copies gave", () => {
  const first = (seed: number) => {
    const next = seeded(seed);
    return [next(), next(), next(), next(), next()];
  };
  assert.deepEqual(first(1), [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849]);
  assert.deepEqual(first(295), [0.8721918421797454, 0.6876641470007598, 0.11171024828217924, 0.9564049707259983, 0.3032616195268929]);
  assert.deepEqual(first(42), [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423]);
});

test("the sync-lab fuzz draw (word modulo n) is the same through seeded", () => {
  for (const [seed, want] of [[1, [7, 3, 787, 1, 3]], [295, [8, 2, 863, 6, 38]], [42, [6, 0, 704, 4, 78]]] as const) {
    const next = seeded(seed);
    const rand = (n: number) => (next() * 4294967296) % n;
    assert.deepEqual([rand(10), rand(10), rand(1000), rand(7), rand(100)], want);
  }
});

test("toggled takes an item off a list it is on, else adds it at the end, and leaves the list as it was (RSVA-430)", () => {
  const ids = ["a", "b"] as const;
  assert.deepEqual(toggled(ids, "a"), ["b"]);
  assert.deepEqual(toggled(ids, "c"), ["a", "b", "c"]);
  assert.deepEqual(ids, ["a", "b"]);
});

test("assignable: people and agents by name, no bots (RSVA-430)", () => {
  const users = [
    { name: "Zoe", kind: "human" },
    { name: "CI", kind: "bot" },
    { name: "Ann", kind: "agent" },
  ] as const;
  assert.deepEqual(assignable(users).map((u) => u.name), ["Ann", "Zoe"]);
});

test("capCount stops at 99+", () => {
  assert.deepEqual([0, 7, 99, 100, 1234].map(capCount), ["0", "7", "99", "99+", "99+"]);
});
