import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cycle, Issue } from "@rsva/schema/models";
import type { CycleCounts } from "./cycles.ts";
import { cycleDays, cycleLines, endText, type CycleWords } from "./project-milestones.ts";

const TODAY = "2026-11-01";

const cycle = (id: string, over: Partial<Cycle>): Cycle => ({ id, name: `Cycle ${id}`, number: 1, startDate: null, endDate: null, completedAt: null, summary: null, leadId: null, cycleId: null, ...over }) as unknown as Cycle;

const DONE = cycle("10", {
  startDate: "2026-10-01",
  endDate: "2026-10-14",
  completedAt: new Date(2026, 9, 14, 18).toISOString(),
  summary: { groups: { completed: 2, started: 2 }, open: ["c", "d", "e"], scope: [3, 4], started: [], done: [] },
});
const ACTIVE = cycle("11", { startDate: "2026-10-15", endDate: "2026-11-05" });
const UPCOMING = cycle("12", { startDate: "2026-11-06", endDate: "2026-11-20" });
const DRAFT = cycle("13", {});
const LATE = cycle("9", { startDate: "2026-09-01", endDate: "2026-09-14" });

const issue = (id: string, over: Partial<Issue> = {}) => ({ id, cycleId: "10", delegateId: null, assigneeIds: [], stateId: "open", ...over }) as unknown as Issue;
const ISSUES: Record<string, Issue> = {
  a: issue("a", { stateId: "done", delegateId: "bot" }),
  b: issue("b", { stateId: "done", assigneeIds: ["me"] }),
  c: issue("c", { cycleId: "11" }),
  d: issue("d", { cycleId: null }),
  e: issue("e"),
};
const WORDS: CycleWords = {
  issue: (id) => ISSUES[id],
  key: (i) => `K-${i.id}`,
  doer: (i) => i.delegateId ?? i.assigneeIds[0] ?? null,
  cycleName: (id) => `Cycle ${id}`,
  issuesIn: (id) => Object.values(ISSUES).filter((i) => i.cycleId === id),
  done: (i) => i.stateId === "done",
};
const COUNTS: CycleCounts = { total: 5, backlog: 0, unstarted: 0, started: 3, completed: 2, cancelled: 1, progress: 3, review: 0, approved: 0 };

test("a project's cycles as days, the latest first: planned dates ahead, drafts left out, an end on the day it was completed", () => {
  const days = cycleDays([DONE, ACTIVE, UPCOMING, DRAFT, LATE], TODAY);
  assert.deepEqual(
    days.map((d) => [d.key, d.rows.map((r) => `${r.edge}:${r.cycle.id}:${r.mark}`)]),
    [
      ["2026-11-20", ["end:12:planned"]],
      ["2026-11-06", ["start:12:planned"]],
      ["2026-11-05", ["end:11:planned"]],
      ["2026-10-15", ["start:11:start"]],
      ["2026-10-14", ["end:10:end"]],
      ["2026-10-01", ["start:10:start"]],
      ["2026-09-14", ["end:9:end"]],
      ["2026-09-01", ["start:9:start"]],
    ],
  );
});

test("a day says where it stands among the cycles", () => {
  const between = cycle("8", { startDate: "2026-08-01", endDate: "2026-08-02" });
  const days = cycleDays([ACTIVE, between, cycle("7", { startDate: "2026-08-20", endDate: "2026-08-21" })], TODAY);
  assert.equal(days.find((d) => d.key === "2026-11-05")!.context, "Cycle 11 · day 22 of 22");
  assert.equal(days.find((d) => d.key === "2026-08-20")!.context, "Cycle 7 · day 1 of 2");
  assert.equal(cycleDays([between], TODAY)[0]!.context, "Cycle 8 · day 2 of 2");
});

test("a completed cycle's line: done of the scope without the canceled, where its open issues went", () => {
  assert.equal(endText(DONE, COUNTS, WORDS), "2 of 4 done · 50% · 1 moved to Cycle 11");
  assert.equal(endText(cycle("x", { endDate: "2026-10-01" }), COUNTS, WORDS), "2 of 4 done · 50% · not completed");
});

test("an opened cycle: who did what, where the unfinished went, how far the scope grew", () => {
  assert.deepEqual(cycleLines(DONE, COUNTS, WORDS, (u) => u.toUpperCase()), [
    { label: "Done 2", value: "BOT 1, ME 1" },
    { label: "Moved to Cycle 11", value: "K-c" },
    { label: "Moved out of cycles", value: "K-d" },
    { label: "Left unfinished", value: "K-e" },
    { label: "Added mid-cycle", value: "1" },
  ]);
});
