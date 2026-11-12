import assert from "node:assert/strict";
import { test } from "node:test";
import { shortDate } from "@rsva/display/time";
import { shortTime } from "./time.ts";

// Late in a local day, so "earlier today" has room whatever zone the tests run in.
const now = new Date(2026, 9, 30, 23, 0).getTime();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

test("shortTime: minutes, hours, the clock earlier today, then the date", () => {
  assert.equal(shortTime(ago(0), now), "now");
  assert.equal(shortTime(ago(40), now), "40m");
  assert.equal(shortTime(ago(59), now), "59m");
  assert.equal(shortTime(ago(60), now), "1h");
  assert.equal(shortTime(ago(11 * 60 + 59), now), "11h");
  assert.equal(shortTime(ago(12 * 60), now), "11:00");
  assert.equal(shortTime(new Date(2026, 9, 29, 10, 0).toISOString(), now), "Oct 29");
});

test("shortDate", () => {
  assert.equal(shortDate(new Date(2026, 9, 29, 10, 0).toISOString()), "Oct 29");
});
