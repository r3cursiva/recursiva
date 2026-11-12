import assert from "node:assert/strict";
import { test } from "node:test";
import type { Op } from "@rsva/protocol";
import { DONE, ISSUE, online } from "./fake.ts";

const [A, B, C] = ISSUE;

test("a bulk change is one transaction: an issue it changes nothing on is left out, a list carries its base", async () => {
  const { store, socket } = await online();
  store.updateIssue(C, { stateId: DONE });
  store.updateIssues([
    { id: A, patch: { stateId: DONE, labelIds: ["bug"] } },
    { id: B, patch: { stateId: DONE } },
    { id: C, patch: { stateId: DONE } },
  ]);
  const [, tx] = socket().frames("tx");
  assert.deepEqual(
    tx!.ops.map((o: Op) => o.op === "update" && o.m === "Issue" && [o.id, o.set, o.base]),
    [
      [A, { stateId: DONE, labelIds: ["bug"] }, { labelIds: [] }],
      [B, { stateId: DONE }, undefined],
    ],
  );
  assert.equal(store.issues.get(B)!.stateId, DONE, "shown at once");
  store.updateIssues([{ id: A, patch: { stateId: DONE } }]); // nothing to change: nothing sent
  assert.equal(socket().frames("tx").length, 2);
  store.dispose();
});
