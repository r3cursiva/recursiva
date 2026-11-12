import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, WorkflowState } from "@rsva/schema/models";
import { closed } from "./my-work-home.ts";

// Local noon, so a completed day is the same day in any zone the tests run in.
const at = (day: string) => new Date(`${day}T12:00:00`).toISOString();
const NOW = Date.parse(at("2026-11-10"));
let n = 0;
const issue = (over: Partial<Issue> = {}): Issue =>
  ({ id: `i${++n}`, projectId: "a", stateId: "done", delegateId: null, dueDate: null, completedAt: null, updatedAt: at("2026-11-01"), archivedAt: null, deletedAt: null, ...over }) as Issue;
const states = new Map(
  (["todo:unstarted", "done:completed"] as const).map((s) => {
    const [id, group] = s.split(":");
    return [id!, { id, group } as WorkflowState];
  }),
);
test("closed issues are counted by the day they were completed, by people and by agents, and since the last visit", () => {
  const issues = [
    issue({ completedAt: at("2026-11-10") }),
    issue({ completedAt: at("2026-11-10"), delegateId: "bot" }),
    issue({ completedAt: at("2026-11-08"), delegateId: "bot" }),
    issue({ completedAt: at("2026-10-01") }),
    issue({ completedAt: at("2026-11-10"), deletedAt: at("2026-11-10") }),
    issue({ completedAt: at("2026-11-10"), projectId: "other" }),
    // Became overdue since the visit; late before it; not late.
    issue({ stateId: "todo", dueDate: "2026-11-09" }),
    issue({ stateId: "todo", dueDate: "2026-11-01" }),
    issue({ stateId: "todo", dueDate: "2026-11-10" }),
  ];
  const source = { issues: new Map(issues.map((i) => [i.id, i])), states };
  const out = closed([["w", source]], (_, i) => i.projectId === "a", NOW, at("2026-11-09"), 3);
  assert.deepEqual(out.days, [
    { day: "2026-11-08", people: 0, agents: 1 },
    { day: "2026-11-09", people: 0, agents: 0 },
    { day: "2026-11-10", people: 1, agents: 1 },
  ]);
  assert.deepEqual(out.since, { closed: 2, agents: 1, overdue: 1 });
  assert.equal(closed([["w", source]], () => true, NOW, null, 3).since, null);
});
