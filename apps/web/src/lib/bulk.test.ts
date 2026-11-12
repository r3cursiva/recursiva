import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "@rsva/schema/models";
import { changeLists, mixedList, mixedOne, onAll, setAll, shared, undoOf } from "./bulk.ts";

const issue = (id: string, set: Partial<Issue> = {}) => ({ id, stateId: "todo", priority: 0, cycleId: null, parentId: null, assigneeIds: [], labelIds: [], ...set }) as Issue;

test("a shared value only when every issue has it", () => {
  assert.equal(shared([issue("a"), issue("b")], "stateId"), "todo");
  assert.equal(shared([issue("a"), issue("b", { stateId: "done" })], "stateId"), undefined);
  assert.equal(shared([issue("a"), issue("b")], "cycleId"), null);
});

test("a list picker shows as checked what is on every issue", () => {
  assert.deepEqual(onAll([issue("a", { labelIds: ["bug", "ui"] }), issue("b", { labelIds: ["ui", "api"] })], "labelIds"), ["ui"]);
  assert.deepEqual(onAll([], "labelIds"), []);
});

test("one value for all leaves out the issues that have it", () => {
  assert.deepEqual(setAll([issue("a"), issue("b", { priority: 1 })], "priority", 1), [{ id: "a", patch: { priority: 1 } }]);
});

test("ticking adds to every list and unticking takes off, each issue keeping the rest of its own", () => {
  const issues = [issue("a", { labelIds: ["bug", "ui"] }), issue("b", { labelIds: ["ui"] }), issue("c", { labelIds: ["ui", "api"] })];
  // "ui" was on all; untick it, tick "api"
  assert.deepEqual(changeLists(issues, "labelIds", ["ui"], ["api"]), [
    { id: "a", patch: { labelIds: ["bug", "api"] } },
    { id: "b", patch: { labelIds: ["api"] } },
    { id: "c", patch: { labelIds: ["api"] } },
  ]);
  // nothing changed for an issue: no patch for it
  assert.deepEqual(changeLists(issues, "labelIds", ["ui"], ["ui", "bug"]), [
    { id: "b", patch: { labelIds: ["ui", "bug"] } },
    { id: "c", patch: { labelIds: ["ui", "api", "bug"] } },
  ]);
});

test("undo writes back each issue's own values of the fields the act changed", () => {
  const issues = [issue("a", { labelIds: ["bug"], priority: 2 }), issue("b", { labelIds: [] })];
  const act = changeLists(issues, "labelIds", [], ["ui"]);
  assert.deepEqual(undoOf(issues, act), [
    { id: "a", patch: { labelIds: ["bug"] } },
    { id: "b", patch: { labelIds: [] } },
  ]);
  assert.deepEqual(undoOf(issues, [{ id: "a", patch: { archivedAt: "2026-11-05T00:00:00Z" } }]), [{ id: "a", patch: { archivedAt: null } }]);
});

test("the values only some issues have are mixed: a dash in the picker, none when they agree (RSVA-303)", () => {
  assert.deepEqual([...mixedOne([issue("a"), issue("b", { cycleId: "c1" })], "cycleId")].sort(), ["", "c1"]);
  assert.deepEqual([...mixedOne([issue("a", { priority: 2 }), issue("b", { priority: 2 })], "priority")], []);
  assert.deepEqual([...mixedOne([issue("a", { priority: 0 }), issue("b", { priority: 3 })], "priority")].sort(), ["0", "3"]);
  const issues = [issue("a", { labelIds: ["bug", "ui"] }), issue("b", { labelIds: ["ui", "api"] })];
  assert.deepEqual([...mixedList(issues, "labelIds")].sort(), ["api", "bug"]);
  assert.deepEqual([...mixedList([issue("a")], "labelIds")], []);
});
