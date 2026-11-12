import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cycle } from "@rsva/schema/models";
import { burnSeries, idealAt, pointAt, type CycleCounts } from "./cycles.ts";

const cycle: Cycle = {
  id: "c", projectId: "p", number: 2, name: "Phone and My work", description: "", startDate: "2026-11-07", endDate: "2026-11-13", leadId: null,
  createdById: null, createdAt: "", completedAt: null, summary: null,
};
const counts: CycleCounts = { total: 5, backlog: 2, unstarted: 0, started: 0, completed: 3, cancelled: 0, progress: 0, review: 0, approved: 0 };
// Day 2 of 7, at 18:00 local: three quarters through it.
const at = new Date(2026, 10, 8, 18);
const past = { start: "2026-11-07", scope: [4, 5], started: [0, 3], done: [0, 3] };

test("burn-up: the start, the ends of the days that are over, then now, three quarters through day 2", () => {
  const s = burnSeries(cycle, past, counts, at)!;
  assert.deepEqual(s.scope, [4, 5, 5]);
  assert.deepEqual(s.done, [0, 3, 3]);
  assert.equal(s.today, 2);
  assert.equal(s.now, 1.75);
  assert.equal(pointAt(s, 1), 1);
  assert.equal(pointAt(s, 2), 1.75);
  // Seven days to the whole scope: 5 × 1.75 / 7.
  assert.equal(idealAt(s, s.now!), 1);
  assert.equal(idealAt(s, 7), 5);
});

test("burn-up: before the server answers, the points repeat today's counts, not zero", () => {
  const s = burnSeries(cycle, null, counts, at)!;
  assert.deepEqual(s.scope, [5, 5, 5]);
  assert.deepEqual(s.done, [3, 3, 3]);
});

test("burn-up: past its end, every day to the last; no now", () => {
  const s = burnSeries(cycle, { ...past, scope: [4, 5, 5, 5, 5, 5, 5, 5], started: Array(8).fill(3), done: Array(8).fill(3) }, counts, new Date(2026, 10, 15, 9))!;
  assert.equal(s.scope.length, 8);
  assert.equal(s.today, null);
  assert.equal(s.now, null);
});
