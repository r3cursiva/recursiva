// Undo of what this TUI changed (PLNR-440): last change first, and a field someone changed since is left as they set it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueUpdate } from "@rsva/schema/models";
import { beforeOf, Undo } from "./undo.ts";

test("u puts back the last change, then the one before; then there is nothing", () => {
  const rows = new Map<string, IssueUpdate>([["a", { stateId: "todo", priority: 0, assigneeIds: [] }]]);
  const undo = new Undo();
  const change = (patch: IssueUpdate, said: string) => {
    undo.record({ id: "a", before: beforeOf(rows.get("a")!, patch), after: patch, said });
    rows.set("a", { ...rows.get("a"), ...patch });
  };
  change({ stateId: "done" }, "→ Done");
  change({ priority: 1, assigneeIds: ["ann"] }, "!urgent +ann");
  const take = () => undo.take((id) => rows.get(id));
  assert.deepEqual(take()?.patch, { priority: 0, assigneeIds: [] });
  assert.deepEqual(take()?.patch, { stateId: "todo" });
  assert.equal(take(), null);
});

test("a field changed elsewhere since is left as it is; a time the server stamped counts as set", () => {
  const undo = new Undo();
  undo.record({ id: "a", before: { stateId: "todo", priority: 0 }, after: { stateId: "done", priority: 2 }, said: "x" });
  // Someone set the priority again in the web; the state is still ours.
  assert.deepEqual(undo.take(() => ({ stateId: "done", priority: 1 }))?.patch, { stateId: "todo" });
  // Deleted here at one time, echoed by the server with its own: still ours to undo.
  undo.record({ id: "a", before: { deletedAt: null }, after: { deletedAt: "2026-11-07T10:00:00.000Z" }, said: "trash" });
  assert.deepEqual(undo.take(() => ({ deletedAt: "2026-11-07T10:00:00.420Z" }))?.patch, { deletedAt: null });
  // Restored by someone else meanwhile: nothing to put back.
  undo.record({ id: "a", before: { deletedAt: null }, after: { deletedAt: "2026-11-07T10:00:00.000Z" }, said: "trash" });
  assert.deepEqual(undo.take(() => ({ deletedAt: null }))?.patch, {});
});
