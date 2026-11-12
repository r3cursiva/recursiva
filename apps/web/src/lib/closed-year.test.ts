import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@rsva/schema/days";
import { closedYear, yearBegan, yearDays, yearStep } from "./closed-year.ts";

/** Days from `first`, each with what people and agents closed on it; the rest of `n` days are empty. */
const days = (first: string, n: number, closed: Record<string, [people: number, agents: number]> = {}) =>
  Array.from({ length: n }, (_, k) => {
    const day = addDays(first, k);
    const [people, agents] = closed[day] ?? [0, 0];
    return { day, people, agents };
  });

test("the grid begins on the first day of a week and ends today", () => {
  // 2026-11-10 is a Tuesday.
  assert.equal(yearDays("2026-11-10", 1), 52 * 7 + 2);
  assert.equal(yearDays("2026-11-10", 0), 52 * 7 + 3);
  assert.equal(yearDays("2026-11-09", 1), 52 * 7 + 1);
  assert.equal(addDays("2026-11-10", 1 - yearDays("2026-11-10", 1)), "2025-11-10");
});

test("a cell counts whose closes were asked for; the share by agents is of all", () => {
  const y = (who: "all" | "people" | "agents") => closedYear(days("2026-11-02", 9, { "2026-11-03": [2, 1], "2026-11-10": [0, 3] }), who);
  assert.deepEqual([y("all").total, y("all").agents], [6, 4]);
  assert.deepEqual([y("people").total, y("people").cells[1]!.n, y("people").cells[8]!.n], [2, 2, 0]);
  assert.equal(y("agents").total, 4);
});

test("one day far above the rest does not dim them: the top level is where a tenth of the working days are", () => {
  const closed: Record<string, [number, number]> = { "2026-06-01": [40, 0] };
  for (let k = 1; k <= 20; k++) closed[addDays("2026-06-01", k)] = [k % 4 === 0 ? 4 : 2, 0];
  const { cells } = closedYear(days("2026-06-01", 28, closed), "all");
  assert.deepEqual(cells.slice(0, 5).map((c) => c.level), [4, 2, 2, 2, 4]);
  assert.equal(cells[25]!.level, 0);
});

test("a month is named over the week it begins in, the first only with room for it", () => {
  // Weeks of Oct 26, Nov 2, …: October has one week before November, so it is not named.
  const y = closedYear(days("2026-10-26", 49), "all");
  assert.deepEqual(y.months, [{ week: 1, day: "2026-11-02" }, { week: 6, day: "2026-12-07" }]);
  assert.deepEqual(closedYear(days("2026-10-05", 42), "all").months.map((m) => m.week), [0, 4]);
});

test("the longest pause is a week or more with nothing closed after the first close; the busiest week is named by its first day", () => {
  const y = closedYear(days("2026-10-05", 35, { "2026-10-06": [1, 0], "2026-10-20": [2, 2], "2026-10-23": [1, 0], "2026-10-30": [1, 0] }), "all");
  assert.deepEqual(y.pause, { days: 13, from: "2026-10-07", to: "2026-10-19" });
  // The days before the first close are no pause, the days since the last one are.
  const late = closedYear(days("2026-10-05", 35, { "2026-10-28": [1, 0] }), "all");
  assert.deepEqual(late.pause, { days: 11, from: "2026-10-29", to: "2026-11-08" });
  assert.deepEqual(y.busiest, { from: "2026-10-19", n: 5 });
  const none = closedYear(days("2026-10-05", 6), "all");
  assert.deepEqual([none.pause, none.busiest], [null, null]);
});

test("the days before a project began are no days of its year; an imported close moves the beginning back", () => {
  const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();
  assert.equal(yearBegan(noon("2026-10-27"), [null, noon("2026-11-02")]), "2026-10-27");
  assert.equal(yearBegan(noon("2026-10-27"), [noon("2026-11-02"), noon("2026-09-30")]), "2026-09-30");
  const y = closedYear(days("2026-10-19", 21), "all", "2026-10-27");
  assert.deepEqual([y.since, y.cells.filter((c) => c.before).length, y.cells[8]!.before], ["2026-10-27", 8, false]);
  // Older than the grid: every day counts, and there is nothing to say.
  assert.equal(closedYear(days("2026-10-19", 21), "all", "2025-01-01").since, null);
  assert.equal(yearStep(10, 21, "ArrowLeft", 8), -1);
  assert.equal(yearStep(9, 21, "ArrowUp", 8), 8);
});

test("arrows step a day within the week and a week across", () => {
  assert.equal(yearStep(8, 30, "ArrowUp"), 7);
  assert.equal(yearStep(7, 30, "ArrowUp"), -1);
  assert.equal(yearStep(13, 30, "ArrowDown"), -1);
  assert.equal(yearStep(8, 30, "ArrowLeft"), 1);
  assert.equal(yearStep(25, 30, "ArrowRight"), -1);
  assert.equal(yearStep(8, 30, "Enter"), -1);
});
