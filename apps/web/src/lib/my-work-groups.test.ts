import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkItem } from "@rsva/protocol/my-work";
import type { Issue, WorkflowState } from "@rsva/schema/models";
import type { SyncStore } from "@rsva/sync";
import { regroup } from "./my-work-groups.ts";

const state = (id: string, group: WorkflowState["group"], position: number) => ({ id, projectId: "p", group, position, name: id }) as unknown as WorkflowState;
// Two started states: the first is In Progress, the second In Review (startedStage).
const states = [state("todo", "unstarted", 1), state("doing", "started", 2), state("review", "started", 3), state("done", "completed", 4)];
const engine = {
  states: new Map(states.map((s) => [s.id, s])),
  statesOf: () => states,
  projects: new Map([["p", { id: "p", name: "Planner" }]]),
} as unknown as SyncStore;
const item = (id: string, stateId: string, priority = 0): WorkItem => ({ ws: "w", issue: { id, projectId: "p", stateId, priority } as Issue, group: "next", from: null, since: "" });
const items = [item("a", "todo", 1), item("b", "review"), item("c", "doing", 1)];

test("by status: every column, the started one by stage, items in their order", () => {
  const lanes = regroup("status", items, () => engine, () => "", false);
  assert.deepEqual(lanes.map((l) => l.name), ["Backlog", "Todo", "In Progress", "In Review", "Approved", "Done", "Cancelled"]);
  assert.deepEqual(lanes.map((l) => l.rows.map((x) => x.issue.id).join("")), ["", "a", "c", "b", "", "", ""]);
});

test("by priority and by project: priority columns all there, projects only those with work", () => {
  assert.deepEqual(regroup("priority", items, () => engine, () => "", false).map((l) => l.rows.length), [2, 0, 0, 0, 1]);
  const projects = regroup("project", items, () => engine, (s) => s.toUpperCase(), true);
  assert.deepEqual(projects.map((l) => [l.name, l.rows.length]), [["Planner · W", 3]]);
});
