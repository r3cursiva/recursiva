import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cycle } from "@rsva/schema/models";
import { clashWith, freeStart, monthGrid, monthOf, nextCycleName, shifted, suggestDates } from "./cycle-calendar.ts";

const cycle = (number: number, startDate: string | null, endDate: string | null): Cycle => ({
  id: `c${number}`, projectId: "p", number, name: `Cycle ${number}`, description: "", startDate, endDate, leadId: null,
  createdById: null, createdAt: "", completedAt: null, summary: null,
});
// As on the artboards: two-week cycles from Tuesdays.
const C = [cycle(12, "2026-10-27", "2026-11-09"), cycle(13, "2026-11-10", "2026-11-23"), cycle(14, "2026-11-24", "2026-12-07"), cycle(15, null, null)];

test("a month's page runs Monday to Sunday", () => {
  const nov = monthGrid(2026, 10);
  assert.equal(nov[0], "2026-10-26");
  assert.equal(nov.at(-1), "2026-12-06");
  assert.equal(nov.length % 7, 0);
});

test("a month's page starts on the person's first day of the week", () => {
  // November 2026 starts on a Sunday and ends on a Monday.
  const sun = monthGrid(2026, 10, 0);
  assert.deepEqual([sun[0], sun.at(-1), sun.length], ["2026-11-01", "2026-12-05", 35]);
  const sat = monthGrid(2026, 10, 6);
  assert.deepEqual([sat[0], sat.at(-1), sat.length], ["2026-10-31", "2026-12-04", 35]);
});

test("a new cycle is offered the day after the last one, as long as it was, and the next number", () => {
  assert.deepEqual(suggestDates(C, "2026-10-30"), { startDate: "2026-12-08", endDate: "2026-12-21" });
  assert.deepEqual(suggestDates([], "2026-10-30"), { startDate: "2026-10-30", endDate: "2026-11-12" });
  assert.equal(nextCycleName(C), "Cycle 16");
});

test("a range meets the cycle it overlaps; the fix moves it past, keeping its length; a cycle never meets itself", () => {
  const r = { startDate: "2026-12-01", endDate: "2026-12-14" };
  assert.equal(clashWith(C, null, r)?.number, 14);
  assert.deepEqual(freeStart(C, null, r), { startDate: "2026-12-08", endDate: "2026-12-21" });
  assert.equal(clashWith(C, "c12", { startDate: "2026-10-27", endDate: "2026-11-09" }), null);
});

test("a calendar page follows a day and steps across year ends", () => {
  assert.deepEqual(monthOf("2026-11-02"), { y: 2026, m: 10 });
  assert.deepEqual(shifted({ y: 2026, m: 0 }, -1), { y: 2025, m: 11 });
  assert.deepEqual(shifted({ y: 2026, m: 11 }, 1), { y: 2027, m: 0 });
  assert.deepEqual(shifted({ y: 2026, m: 5 }, -18), { y: 2024, m: 11 });
});
