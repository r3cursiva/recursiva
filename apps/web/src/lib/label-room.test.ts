import assert from "node:assert/strict";
import { test } from "node:test";
import { fitLabels, labelRoom } from "./label-room.ts";

test("the room is 40% of the list, in steps", () => {
  assert.equal(labelRoom(1000), 400);
  assert.equal(labelRoom(1039), 400, "under a step: the same room");
  assert.equal(labelRoom(1040), 416);
});

test("as many tags as fit, with the count of the rest", () => {
  assert.equal(fitLabels([60, 60, 60], 149), 1, "two tags and their +1 are 149.2 wide");
  assert.equal(fitLabels([60, 60, 60], 150), 2);
  assert.equal(fitLabels([60, 60, 60], 195), 2);
  assert.equal(fitLabels([60, 60, 60], 196), 3, "the last tag needs no count");
});

test("the count's room grows with its digits", () => {
  const tags = (n: number) => Array.from({ length: n }, () => 60);
  assert.equal(fitLabels(tags(10), 150), 2, "two tags and +8 are 149.2 wide");
  assert.equal(fitLabels(tags(12), 150), 1, "two tags and +10 are 155.8 wide");
  assert.equal(fitLabels(tags(12), 156), 2);
});

test("one tag at least, none without labels", () => {
  assert.equal(fitLabels([200, 60], 100), 1);
  assert.equal(fitLabels([], 100), 0);
});
