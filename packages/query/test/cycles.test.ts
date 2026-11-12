// cycle: filter and grouping by cycle (PLNR-63).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cycle } from "@rsva/schema/models";
import { formatQuery, parseQuery, runQuery, sortedCycles, type Filter } from "../src/index.ts";
import { ctx as baseCtx, display, issue } from "./fixture.ts";

const P = "00000000-0000-4000-8000-000000000001";
const cycle = (n: number, startDate: string | null, endDate: string | null, completedAt: string | null = null): Cycle => ({
  id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
  projectId: P,
  number: n,
  name: `Cycle ${n}`,
  description: "",
  startDate,
  endDate,
  leadId: null,
  createdById: null,
  createdAt: "2026-10-01 10:00:00+00",
  completedAt,
  summary: null,
});

// Today is 2026-10-27 (the fixture's): 11 completed, 12 in progress, 13 and 14 ahead, 15 a draft.
const C = {
  c11: cycle(11, "2026-10-13", "2026-10-26", "2026-10-26 18:00:00+00"),
  c12: cycle(12, "2026-10-27", "2026-11-09"),
  c13: cycle(13, "2026-11-10", "2026-11-23"),
  c14: cycle(14, "2026-11-24", "2026-12-07"),
  c15: cycle(15, null, null),
};
const ctx = () => baseCtx({ cycles: new Map(Object.values(C).map((c) => [c.id, c])) });

const ISSUES = [
  issue(1, { cycleId: C.c12.id }),
  issue(2, { cycleId: C.c13.id }),
  issue(3, { cycleId: C.c11.id }),
  issue(4, { cycleId: null }),
  issue(5, { cycleId: C.c15.id }),
];
const flat = (f: Filter) => runQuery(ISSUES, f, display({ groupBy: "none" }), ctx()).flatMap((g) => g.issues.map((i) => i.number));

test("cycle: names, the short C12, active, next and none", () => {
  const q = (text: string) => parseQuery(text, ctx());
  assert.deepEqual(q("cycle:active").filter.cycle, ["active"]);
  assert.deepEqual(q("cycle:C13,next").filter.cycle, [C.c13.id, "next"]);
  assert.deepEqual(q('cycle:"Cycle 12" -cycle:none').filter, { cycle: [C.c12.id], not: { cycle: ["none"] } });
  const bad = q("cycle:C99");
  assert.equal(bad.errors[0]?.message, 'No cycle named "C99"');
});

test("active and next follow the calendar; none is no cycle", () => {
  assert.deepEqual(flat({ cycle: ["active"] }), [1]);
  assert.deepEqual(flat({ cycle: ["next"] }), [2]);
  assert.deepEqual(flat({ cycle: ["none"] }), [4]);
  assert.deepEqual(flat({ cycle: [C.c11.id, "none"] }), [3, 4]);
  assert.deepEqual(flat({ not: { cycle: ["none"] } }), [1, 2, 3, 5]);
});

test("formatQuery writes a cycle by name and the words as they are", () => {
  assert.equal(formatQuery({ cycle: [C.c12.id, "next"] }, ctx()), 'cycle:"Cycle 12",next');
});

test("grouping by cycle: time order, drafts after dated cycles, a completed one only when used, no cycle last", () => {
  const groups = runQuery(ISSUES, {}, display({ groupBy: "cycle", showEmptyGroups: true }), ctx());
  assert.deepEqual(
    groups.map((g) => [g.name, g.issues.map((i) => i.number)]),
    [["Cycle 12", [1]], ["Cycle 13", [2]], ["Cycle 14", []], ["Cycle 15", [5]], ["Cycle 11", [3]], ["No cycle", [4]]],
  );
});

test("sortedCycles leaves completed cycles out unless asked", () => {
  assert.deepEqual(sortedCycles(Object.values(C)).map((c) => c.number), [12, 13, 14, 15]);
  assert.deepEqual(sortedCycles(Object.values(C), true).map((c) => c.number), [11, 12, 13, 14, 15]);
});
