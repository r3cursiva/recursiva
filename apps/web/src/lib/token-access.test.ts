import assert from "node:assert/strict";
import { test } from "node:test";
import { accessReady, changeScope, startAccess } from "./token-access.ts";

const agent = { role: "member", rights: ["labels.write"] } as const;

test("Write to Custom keeps every row Write reached: a save narrows nothing", () => {
  assert.deepEqual(changeScope({ scope: "write" }, "custom", agent), { scope: "custom", grants: ["issues.write", "comments.write", "cycles.write", "views.write", "labels.write"] });
  assert.deepEqual(changeScope({ scope: "read" }, "custom", agent), { scope: "custom", grants: [] }, "from Read: nothing yet");
  assert.deepEqual(changeScope({ scope: "custom", grants: ["labels.write"] }, "custom", agent), { scope: "custom", grants: ["labels.write"] });
  assert.deepEqual(changeScope({ scope: "custom", grants: ["labels.write"] }, "write", agent), { scope: "write" });
  assert.equal(accessReady(changeScope({ scope: "read" }, "custom", agent)), false);
});

test("the dialog starts from what the token can change now", () => {
  assert.deepEqual(startAccess({ scope: "write", grants: [] }, agent), { scope: "write" });
  // Labels closed to members: the stored grant is held back, so the dialog starts it at Read.
  assert.deepEqual(startAccess({ scope: "custom", grants: ["issues.write", "labels.write"] }, { role: "member", rights: [] }), { scope: "custom", grants: ["issues.write"] });
  assert.deepEqual(startAccess({ scope: "custom", grants: ["issues.write"] }, null), { scope: "custom", grants: [] });
});
