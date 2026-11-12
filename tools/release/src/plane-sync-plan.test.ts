import assert from "node:assert/strict";
import { test } from "node:test";
import { editsFrom, parseActions, refusal } from "./plane-sync-plan.ts";

test("a workspace that moved here for good, or a slug that is not one, is refused", () => {
  assert.match(refusal("arsen")!, /lives in recursiva/);
  assert.match(refusal("a'; drop")!, /not a workspace slug/);
  assert.equal(refusal("acme"), null);
});

test("edits since the import: what it would overwrite counts, a project's colour and its own mark do not", () => {
  const actions = parseActions("Project|color\nProject|key,name\nProject|archivedAt\nWorkspace|\nWorkspace|name\nIssue|title\nComment|\n");
  assert.deepEqual(actions[0], { model: "Project", fields: ["color"] });
  assert.deepEqual(editsFrom(actions), { Project: 2, Workspace: 1, Issue: 1, Comment: 1 });
  assert.deepEqual(editsFrom(parseActions("Project|color\nWorkspace|\n")), {});
});
