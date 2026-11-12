import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cycle } from "@rsva/schema/models";
import { cycleEnd, datePresets, daysToNext } from "../src/date-presets.ts";

const days = (today: string, weekStart = 1, end: string | null = null) => datePresets(today, weekStart, end).map((p) => `${p.label} ${p.day}`);

test("today, the coming Friday and next week from a Wednesday", () => {
  assert.deepEqual(days("2026-11-04"), ["Today 2026-11-04", "Fri 2026-11-06", "Next week 2026-11-09"]);
});

test("on a Friday or a Saturday, Fri is the next week's: today is Today", () => {
  assert.deepEqual(days("2026-11-06").slice(0, 2), ["Today 2026-11-06", "Fri 2026-11-13"]);
  assert.deepEqual(days("2026-11-07").slice(0, 2), ["Today 2026-11-07", "Fri 2026-11-13"]);
});

test("next week starts on the person's first day of the week, a week on when that is today", () => {
  assert.equal(days("2026-11-09")[2], "Next week 2026-11-16"); // Monday
  assert.equal(days("2026-11-04", 0)[2], "Next week 2026-11-08"); // Sunday first
  assert.equal(days("2026-11-04", 6)[2], "Next week 2026-11-07"); // Saturday first
  assert.equal(days("2026-12-30")[2], "Next week 2027-01-04"); // across a year
});

test("End of cycle only with an end", () => {
  assert.equal(days("2026-11-04", 1, "2026-11-15")[3], "End of cycle 2026-11-15");
  assert.equal(days("2026-11-04").length, 3);
});

test("the cycle's end: the issue's cycle, else the one in progress, never a past day", () => {
  const cycle = (id: string, startDate: string | null, endDate: string | null, completedAt: string | null = null) => ({ id, startDate, endDate, completedAt }) as Cycle;
  const running = cycle("a", "2026-11-01", "2026-11-14");
  const next = cycle("b", "2026-11-15", "2026-11-28");
  const today = "2026-11-04";
  assert.equal(cycleEnd(undefined, [next, running], today), "2026-11-14");
  assert.equal(cycleEnd(next, [next, running], today), "2026-11-28");
  assert.equal(cycleEnd(cycle("c", null, null), [running], today), null); // a draft: not the running one's end
  assert.equal(cycleEnd(cycle("d", "2026-10-01", "2026-10-14"), [running], today), null);
  assert.equal(cycleEnd(undefined, [next, cycle("e", "2026-11-01", "2026-11-14", "2026-11-03T10:00:00Z")], today), null);
  assert.equal(cycleEnd(cycle("f", "2026-11-01", "2026-11-14", "2026-11-03T10:00:00Z"), [running], today), null); // its own, completed early
});

test("a cycle that ends today offers today", () => {
  const ending = { id: "a", startDate: "2026-10-22", endDate: "2026-11-04", completedAt: null } as Cycle;
  assert.equal(cycleEnd(ending, [ending], "2026-11-04"), "2026-11-04");
  assert.equal(cycleEnd(undefined, [ending], "2026-11-04"), "2026-11-04");
  assert.deepEqual(datePresets("2026-11-04", 1, "2026-11-04").map((p) => `${p.label} ${p.day}`).filter((p) => p.endsWith("2026-11-04")), ["Today 2026-11-04", "End of cycle 2026-11-04"]);
});

test("days to the next weekday: 1 to 7", () => {
  assert.equal(daysToNext(3, 5), 2);
  assert.equal(daysToNext(5, 5), 7);
  assert.equal(daysToNext(0, 1), 1);
});
