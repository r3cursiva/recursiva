import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { Viewer } from "@rsva/policy";
import type { Op } from "@rsva/protocol";
import { importFixture, type Fixture } from "../test/helpers.ts";
import { diff } from "./rows.ts";
import { submitTx, type Submit } from "./submit.ts";

let ws: Fixture;
before(async () => {
  ws = await importFixture();
});

/** A read-only token: every change is forbidden by the rights check. */
const readOnly: Viewer = { role: "member", scope: "read" };
const owner: Viewer = { role: "owner" };
const MiB = 2 ** 20;
const rename = (id: string, name = "Renamed by submit test"): Op[] => [{ op: "update", m: "Workspace", id, set: { name } }];
const submit = (t: Partial<Submit>) =>
  submitTx({ workspaceId: ws.workspaceId, userId: randomUUID(), txId: randomUUID(), ops: rename(ws.workspaceId), viewer: () => owner, signedIn: true, ...t });

test("the budget is checked before access and rights: an over-budget forbidden change hears 'budget', and access is not read", async () => {
  let read = false;
  const out = await submit({
    bytes: 17 * MiB,
    viewer: () => {
      read = true;
      return readOnly;
    },
  });
  assert.equal(out?.ok, false);
  assert.equal(out?.ok === false && out.refused.by, "budget");
  assert.ok(out?.ok === false && out.refused.by === "budget" && out.refused.retryAfter > 0);
  assert.equal(read, false, "the access check (a database read on the socket) waits for the budget");
});

test("a change the rights refuse has spent its budget (Telegram and email replies included, RSVA-428)", async () => {
  const userId = randomUUID();
  const first = await submit({ userId, bytes: 16 * MiB - 100, viewer: () => readOnly });
  assert.deepEqual(first, { ok: false, refused: { by: "rights", msg: "the token is read-only" } });
  // The bucket refills at 16 MiB a minute (about 280 bytes a millisecond), so the second change asks for half of it: a
  // loaded machine may take a few seconds between the two calls, never 30. Asking for 200 bytes (before RSVA-506) needed
  // the two calls within 0.4 ms; under the full parallel `pnpm test` they were not, the owner's rename went through, and
  // the next test's rename to the same name was no change.
  const second = await submit({ userId, bytes: 8 * MiB, viewer: () => owner });
  assert.equal(second?.ok === false && second.refused.by, "budget", "the refused change took 16 MiB less 100 bytes of the budget");
});

test("no access any more stops the write; the pipeline's refusal comes back with its code; an allowed change is applied", async () => {
  assert.equal(await submit({ viewer: async () => null }), null);
  const missing = await submit({ userId: ws.ownerId, ops: [{ op: "update", m: "Issue", id: randomUUID(), set: { priority: 1 } }] });
  assert.equal(missing?.ok === false && missing.refused.by === "pipeline" && missing.refused.code, "not_found");
  // A name of its own: whatever another test renamed the workspace to, this one is a change.
  const name = `Renamed by submit test ${randomUUID()}`;
  const done = await submit({ userId: ws.ownerId, ops: rename(ws.workspaceId, name) });
  assert.ok(done?.ok && done.r.actions.some((a) => a.m === "Workspace" && a.d?.name === name));
});

test("diff compares by JSON: equal lists and scalars are no change, others come with their values before", () => {
  const row = { name: "A", labelIds: ["x", "y"], leadId: null, startDate: "2026-11-01" };
  assert.deepEqual(diff(row, { name: "A", labelIds: ["x", "y"], leadId: null, startDate: "2026-11-01" }), { changed: {}, prev: {} });
  assert.deepEqual(diff(row, { name: "B", labelIds: ["y", "x"], leadId: "u" }), {
    changed: { name: "B", labelIds: ["y", "x"], leadId: "u" },
    prev: { name: "A", labelIds: ["x", "y"], leadId: null },
  });
});
