import assert from "node:assert/strict";
import { test } from "node:test";
import { compactAge, dayRange } from "../src/time.ts";

const MIN = 60_000;

test("compactAge: whole units rounded down, under a minute is now", () => {
  assert.equal(compactAge(-5 * MIN), "now", "a clock ahead of ours is not a negative age");
  assert.equal(compactAge(59_999), "now");
  assert.equal(compactAge(MIN), "1m");
  assert.equal(compactAge(59 * MIN + 59_999), "59m");
  assert.equal(compactAge(60 * MIN), "1h");
  assert.equal(compactAge(100 * MIN), "1h");
  assert.equal(compactAge(24 * 60 * MIN - 1), "23h");
  assert.equal(compactAge(24 * 60 * MIN), "1d");
  assert.equal(compactAge(47 * 60 * MIN), "1d");
});

test("dayRange: both ends as date fields; collapsed, one month is written once", () => {
  const y = new Date().getFullYear();
  assert.equal(dayRange(`${y}-10-27`, `${y}-11-09`), "Oct 27 – Nov 9");
  assert.equal(dayRange(`${y}-11-03`, `${y}-11-16`), "Nov 3 – Nov 16");
  assert.equal(dayRange(`${y}-11-03`, `${y}-11-16`, true), "Nov 3 – 16");
  assert.equal(dayRange(`${y}-10-28`, `${y}-11-03`, true), "Oct 28 – Nov 3");
  assert.equal(dayRange(`${y - 1}-11-03`, `${y - 1}-11-16`, true), `Nov 3 – 16, ${y - 1}`);
  assert.equal(dayRange(`${y - 1}-12-29`, `${y}-01-04`), `Dec 29, ${y - 1} – Jan 4`);
});
