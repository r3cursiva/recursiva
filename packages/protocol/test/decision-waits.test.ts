import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "@rsva/schema/models";
import { decisionWaits } from "../src/my-work.ts";

const issue = (extra: Partial<Issue> = {}) => ({ id: "i", projectId: "p", stateId: "todo", assigneeIds: [], createdById: "bot", archivedAt: null, deletedAt: null, ...extra }) as unknown as Issue;
const source = (me: string, role = "member", triagers: string[] = []) => ({
  me: { id: me },
  role,
  workspace: { triagers },
  projects: new Map([["p", { archivedAt: null }]]),
  states: new Map([
    ["todo", { group: "unstarted" }],
    ["done", { group: "completed" }],
  ]) as never,
  users: new Map([
    ["bot", { kind: "agent" }],
    ["ann", { kind: "human" }],
  ]),
});
const open = { status: "open" };

test("a question waits on whoever triages an agent's issue, on its assignee and on a person's issue's creator", () => {
  assert.equal(decisionWaits(source("owner", "owner"), open, issue()), true, "an owner triages when nobody is named");
  assert.equal(decisionWaits(source("member"), open, issue()), false);
  assert.equal(decisionWaits(source("member"), open, issue({ assigneeIds: ["member"] })), true);
  assert.equal(decisionWaits(source("ann"), open, issue({ createdById: "ann" })), true);
  assert.equal(decisionWaits(source("owner", "owner", ["ann"]), open, issue()), false, "named triagers take it from the owners");
});

test("not when answered, nor on a closed, archived or deleted issue", () => {
  const owner = source("owner", "owner");
  assert.equal(decisionWaits(owner, { status: "answered" }, issue()), false);
  assert.equal(decisionWaits(owner, open, issue({ stateId: "done" })), false);
  assert.equal(decisionWaits(owner, open, issue({ archivedAt: "2026-11-01T00:00:00Z" })), false);
  assert.equal(decisionWaits(owner, open, issue({ deletedAt: "2026-11-01T00:00:00Z" })), false);
  assert.equal(decisionWaits(owner, open, undefined), false);
});
