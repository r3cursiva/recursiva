// The rules a move to another project maps state and labels by (PLNR-448), shared by the browser and the server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { movedKeysOf, moveLabels, moveState } from "../src/models.ts";

const state = (id: string, name: string, group: string, position: number, isDefault = false) => ({ id, name, group, position, isDefault });
const TO = [state("b", "Backlog", "backlog", 0, true), state("r", "Review", "started", 3), state("p", "In progress", "started", 2), state("d", "Done", "completed", 4)];

test("a state: the same name, then ignoring case, then the group's default, then its first, then the default", () => {
  assert.equal(moveState({ name: "Done", group: "completed" }, TO), "d");
  assert.equal(moveState({ name: "IN PROGRESS ", group: "started" }, TO), "p");
  assert.equal(moveState({ name: "Doing", group: "started" }, TO), "p", "the first started state by position");
  assert.equal(moveState({ name: "Doing", group: "started" }, [...TO, state("q", "Queue", "started", 9, false)]), "p");
  const withDefault = [state("x", "Triage", "backlog", 0), state("y", "Ready", "unstarted", 1, true), state("z", "Next", "unstarted", 0.5)];
  assert.equal(moveState({ name: "Todo", group: "unstarted" }, withDefault), "y", "the default when it is of that group");
  assert.equal(moveState({ name: "Gone", group: "cancelled" }, TO), "b", "no such group: the default");
  assert.equal(moveState(undefined, TO), "b");
  assert.throws(() => moveState(undefined, []));
});

test("labels: workspace and target ones stay, a project's goes to the target's of the same name or is dropped, each once", () => {
  const labels = new Map([
    ["w", { id: "w", name: "ws", projectId: null }],
    ["s1", { id: "s1", name: "Bug", projectId: "S" }],
    ["s2", { id: "s2", name: "bug ", projectId: "X" }],
    ["s3", { id: "s3", name: "solo", projectId: "S" }],
    ["t1", { id: "t1", name: "bug", projectId: "T" }],
  ]);
  const target = [...labels.values()].filter((l) => l.projectId === "T");
  assert.deepEqual(moveLabels(["s1", "w", "s3", "t1", "s2", "nope"], labels, "T", target), { labelIds: ["t1", "w"], dropped: ["s3", "nope"] });
});

test("the keys a moved issue may have kept: under every key of its project, now and before", () => {
  assert.deepEqual(movedKeysOf("OLD", 3, { key: "NEW", formerKeys: ["OLD", "OLDER"] }), ["OLD-3", "NEW-3", "OLDER-3"]);
  assert.deepEqual(movedKeysOf("GONE", 7, undefined), ["GONE-7"]);
});
