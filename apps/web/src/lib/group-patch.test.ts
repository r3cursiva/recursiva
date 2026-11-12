import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, Label, User, WorkflowState } from "@rsva/schema/models";
import { groupDefaults, movePatch, presetFor, type GroupTarget } from "./group-patch.ts";

const state = (id: string, group: string, position: number) => ({ id, group, position, name: id }) as WorkflowState;
const STATES = [state("backlog", "backlog", 0), state("todo", "unstarted", 1), state("doing", "started", 2), state("review", "started", 3), state("done", "completed", 4)];
const user = (id: string) => ({ id, name: id }) as User;
const label = (id: string) => ({ id, name: id }) as Label;
const issue = (set: Partial<Issue>) => ({ id: "x", stateId: "todo", priority: 0, assigneeIds: [], labelIds: [], ...set }) as Issue;

const byState = (id: string): GroupTarget => ({ groupBy: "state", ref: { state: STATES.find((s) => s.id === id)! } });
const byUser = (id: string | null): GroupTarget => ({ groupBy: "assignee", ref: id ? { user: user(id) } : null });
const byLabel = (id: string | null): GroupTarget => ({ groupBy: "label", ref: id ? { label: label(id) } : null });

test("quick add defaults per grouping", () => {
  assert.deepEqual(groupDefaults(byState("doing"), STATES), { stateId: "doing" });
  assert.deepEqual(groupDefaults({ groupBy: "stateGroup", ref: { stateGroup: "started" } }, STATES), { stateId: "doing" });
  assert.deepEqual(groupDefaults({ groupBy: "priority", ref: { priority: 2 } }, STATES), { priority: 2 });
  assert.deepEqual(groupDefaults(byUser("anna"), STATES), { assigneeIds: ["anna"] });
  assert.deepEqual(groupDefaults(byUser(null), STATES), {});
  assert.deepEqual(groupDefaults(byLabel("bug"), STATES), { labelIds: ["bug"] });
  assert.deepEqual(groupDefaults({ groupBy: "none", ref: null }, STATES), {});
});

test("drop between states and priorities sets the field", () => {
  assert.deepEqual(movePatch(issue({}), byState("todo"), byState("done"), STATES), { stateId: "done" });
  assert.deepEqual(movePatch(issue({}), byState("todo"), byState("todo"), STATES), {});
  assert.deepEqual(movePatch(issue({ priority: 4 }), { groupBy: "priority", ref: { priority: 4 } }, { groupBy: "priority", ref: { priority: 1 } }, STATES), { priority: 1 });
});

test("drop between state groups keeps the state when it is already in the group", () => {
  const started = { groupBy: "stateGroup", ref: { stateGroup: "started" } } as const;
  const completed = { groupBy: "stateGroup", ref: { stateGroup: "completed" } } as const;
  assert.deepEqual(movePatch(issue({ stateId: "review" }), completed, started, STATES), {});
  assert.deepEqual(movePatch(issue({ stateId: "review" }), started, completed, STATES), { stateId: "done" });
});

test("drop between assignees swaps the source person for the target and keeps the others", () => {
  const i = issue({ assigneeIds: ["anna", "vera"] });
  assert.deepEqual(movePatch(i, byUser("anna"), byUser("boris"), STATES), { assigneeIds: ["vera", "boris"] });
  assert.deepEqual(movePatch(i, byUser("anna"), byUser("vera"), STATES), { assigneeIds: ["vera"] });
  assert.deepEqual(movePatch(i, byUser("anna"), byUser(null), STATES), { assigneeIds: [] });
  assert.deepEqual(movePatch(issue({}), byUser(null), byUser("boris"), STATES), { assigneeIds: ["boris"] });
});

test("drop between labels works like assignees", () => {
  const i = issue({ labelIds: ["bug", "ui"] });
  assert.deepEqual(movePatch(i, byLabel("bug"), byLabel("perf"), STATES), { labelIds: ["ui", "perf"] });
  assert.deepEqual(movePatch(i, byLabel("bug"), byLabel(null), STATES), { labelIds: [] });
});

test("drop between parents sets or clears the parent; an issue does not go under itself", () => {
  const byParent = (id: string | null): GroupTarget => ({ groupBy: "parent", ref: id ? { parent: issue({ id }) } : null });
  assert.deepEqual(groupDefaults(byParent("epic"), STATES), { parentId: "epic" });
  assert.deepEqual(groupDefaults(byParent(null), STATES), {});
  assert.deepEqual(movePatch(issue({}), byParent(null), byParent("epic"), STATES), { parentId: "epic" });
  assert.deepEqual(movePatch(issue({ parentId: "epic" }), byParent("epic"), byParent(null), STATES), { parentId: null });
  assert.deepEqual(movePatch(issue({ parentId: "epic" }), byParent("epic"), byParent("epic"), STATES), {});
  assert.equal(movePatch(issue({ id: "epic" }), byParent(null), byParent("epic"), STATES), null);
});

test("author grouping cannot be changed by a drop", () => {
  const a: GroupTarget = { groupBy: "createdBy", ref: { user: user("anna") } };
  const b: GroupTarget = { groupBy: "createdBy", ref: { user: user("boris") } };
  assert.equal(movePatch(issue({}), a, b, STATES), null);
  assert.deepEqual(movePatch(issue({}), a, a, STATES), {});
});

test("a column and a swimlane together preset both fields; without a state group the default state", () => {
  const withDefault = STATES.map((s) => ({ ...s, isDefault: s.id === "todo" }));
  assert.deepEqual(presetFor([byState("doing"), { groupBy: "priority", ref: { priority: 1 } }], withDefault), { stateId: "doing", priority: 1 });
  assert.deepEqual(presetFor([byUser("anna")], withDefault), { assigneeIds: ["anna"], stateId: "todo" });
  assert.deepEqual(presetFor([], STATES), { stateId: "backlog" });
});
