import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, dayIn, dayStart, daysBetween, localDay } from "../src/days.ts";

test("addDays crosses months, years and leap days; daysBetween is its inverse", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30", "a European DST night is an ordinary day");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(daysBetween("2026-10-27", "2026-11-09"), 13);
  assert.equal(daysBetween("2026-11-09", "2026-10-27"), -13);
  for (const n of [-400, -1, 0, 1, 31, 366]) assert.equal(daysBetween("2026-11-07", addDays("2026-11-07", n)), n);
});

test("localDay reads the runtime's zone", () => {
  assert.equal(localDay(new Date(2026, 10, 7, 0, 5)), "2026-11-07");
  assert.equal(localDay(new Date(2026, 10, 7, 23, 55)), "2026-11-07");
});

test("dayIn and dayStart read a named zone, across clock changes (RSVA-13)", () => {
  const at = new Date("2026-11-07T23:30:00Z");
  assert.equal(dayIn(at, "Europe/Sofia"), "2026-11-08");
  assert.equal(dayIn(at, "America/Los_Angeles"), "2026-11-07");
  assert.equal(dayStart("2026-11-08", "Europe/Sofia").toISOString(), "2026-11-07T22:00:00.000Z");
  assert.equal(dayStart("2026-10-25", "Europe/Sofia").toISOString(), "2026-10-24T21:00:00.000Z", "summer time until 04:00");
  assert.equal(dayStart("2026-11-08", "Asia/Kolkata").toISOString(), "2026-11-07T18:30:00.000Z");
  assert.equal(dayStart("2026-11-01", "America/Los_Angeles").toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(dayStart("2026-09-06", "America/Santiago").toISOString(), "2026-09-06T04:00:00.000Z", "midnight skipped: 01:00 starts the day");
  assert.equal(dayStart("2026-11-07").getTime(), new Date(2026, 10, 7).getTime(), "no zone: the runtime's");
});
