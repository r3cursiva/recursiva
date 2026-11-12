// Relations between issues and links on an issue: the write pipeline's rules (PLNR-49).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { Op } from "@rsva/protocol";
import { relationPatches, type IssuePatch } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { importFixture, issueWithRefs, rejects, type Fixture } from "../test/helpers.ts";
import { applyTx } from "./write.ts";

const { issue, attachment, syncAction } = schema;

let ws: Fixture;
let refs: Awaited<ReturnType<typeof issueWithRefs>>;
before(async () => {
  ws = await importFixture();
  refs = await issueWithRefs(ws.workspaceId);
});

const as = (actor: string, ops: Op[]) => applyTx(ws.workspaceId, actor, randomUUID(), ops);
const update = (id: string, set: IssuePatch & { deletedAt?: string | null }) => as(ws.ownerId, [{ op: "update", m: "Issue", id, set }]);
const row = async (id: string) => (await db.select().from(issue).where(eq(issue.id, id)))[0]!;

async function newIssue(set: IssuePatch = {}): Promise<string> {
  const id = randomUUID();
  await as(ws.ownerId, [{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: "rel", stateId: refs.states[0]!.id, ...set } }]);
  return id;
}

/** The ops the browser and the API send for a relation, from the rows as stored. */
async function relate(a: string, type: Parameters<typeof relationPatches>[2], b: string) {
  const ops: Op[] = relationPatches(await row(a), await row(b), type).map(({ id, set }) => ({ op: "update", m: "Issue", id, set }));
  return as(ws.ownerId, ops);
}

test("relations are fields of the issue: history from → to, read back from the row", async () => {
  const [a, b, c] = [await newIssue(), await newIssue(), await newIssue()];
  const r = await update(a, { blockedByIds: [b], relatedIds: [c] });
  assert.deepEqual(r.actions[0]!.d!.blockedByIds, [b]);
  const [logged] = await db.select({ prev: syncAction.prev }).from(syncAction).where(and(eq(syncAction.workspaceId, ws.workspaceId), eq(syncAction.id, r.s)));
  assert.deepEqual(logged!.prev, { blockedByIds: [], relatedIds: [] });
  assert.deepEqual([(await row(a)).blockedByIds, (await row(a)).relatedIds], [[b], [c]]);
  // Created with relations too.
  const d = await newIssue({ duplicateOfId: a });
  assert.equal((await row(d)).duplicateOfId, a);
});

test("refused: itself, the same pair twice from either end, an issue elsewhere or deleted", async () => {
  const [a, b] = [await newIssue(), await newIssue()];
  await rejects(update(a, { blockedByIds: [a] }), "bad_ref", /itself/);
  await rejects(update(a, { blockedByIds: [b], relatedIds: [b] }), "bad_ref", /one relation/);
  await rejects(update(a, { blockedByIds: [b, b] }), "invalid", /listed twice/);
  await update(a, { blockedByIds: [b] });
  await rejects(update(b, { blockedByIds: [a] }), "bad_ref", /other way round/);
  await rejects(update(b, { duplicateOfId: a }), "bad_ref", /other way round/);
  await rejects(update(a, { relatedIds: [randomUUID()] }), "bad_ref", /not in the workspace/);
  const gone = await newIssue();
  await update(gone, { deletedAt: new Date().toISOString() });
  await rejects(update(a, { relatedIds: [gone] }), "bad_ref", /deleted/);
});

test("a blocker deleted later stays in the list: other relation edits still pass", async () => {
  const [a, b, c] = [await newIssue(), await newIssue(), await newIssue()];
  await update(a, { blockedByIds: [b] });
  await update(b, { deletedAt: new Date().toISOString() });
  await update(a, { blockedByIds: [b, c] });
  assert.deepEqual((await row(a)).blockedByIds, [b, c]);
});

test("relationPatches: changing the kind moves the pair to the end that stores the new one, in one transaction", async () => {
  const [a, b] = [await newIssue(), await newIssue()];
  await relate(a, "related", b);
  assert.deepEqual((await row(a)).relatedIds, [b]);
  // "a blocks b" is stored on b; the old relation on a goes in the same transaction, before the new one is checked.
  const r = await relate(a, "blocks", b);
  assert.equal(r.actions.length, 2);
  assert.deepEqual([(await row(a)).relatedIds, (await row(b)).blockedByIds], [[], [a]]);
  await relate(b, "duplicates", a);
  assert.deepEqual([(await row(b)).blockedByIds, (await row(a)).duplicateOfId], [[], b]);
  await relate(a, null, b);
  assert.equal((await row(a)).duplicateOfId, null);
  // Nothing to remove: no ops, no transaction.
  assert.deepEqual(relationPatches(await row(a), await row(b), null), []);
});

test("links: cleaned address, kind from the address, title cleaned; edit and remove; a deleted issue takes none", async () => {
  const a = await newIssue();
  const id = randomUUID();
  const r = await as(ws.ownerId, [{ op: "create", m: "Attachment", id, set: { issueId: a, url: "  https://github.com/acme/app/pull/12/files ", title: "Fix\nlogin " } }]);
  assert.deepEqual(
    { kind: r.actions[0]!.d!.kind, url: r.actions[0]!.d!.url, title: r.actions[0]!.d!.title },
    { kind: "github_pr", url: "https://github.com/acme/app/pull/12/files", title: "Fix login" },
  );
  const e = await as(ws.agentId, [{ op: "update", m: "Attachment", id, set: { url: "https://github.com/acme/app/commit/0123456789abcdef" } }]);
  assert.deepEqual(e.actions[0]!.d, { url: "https://github.com/acme/app/commit/0123456789abcdef", kind: "github_commit" });
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", "not a url", `https://e.com/${"x".repeat(2100)}`]) {
    await rejects(as(ws.ownerId, [{ op: "create", m: "Attachment", id: randomUUID(), set: { issueId: a, url, title: "" } }]), "invalid");
  }
  const d = await as(ws.ownerId, [{ op: "delete", m: "Attachment", id }]);
  assert.deepEqual(d.actions[0]!.d, { issueId: a });
  assert.equal((await db.select().from(attachment).where(eq(attachment.id, id))).length, 0);
  // Removing again is a no-op, as for reactions.
  assert.deepEqual((await as(ws.ownerId, [{ op: "delete", m: "Attachment", id }])).actions, []);
  await update(a, { deletedAt: new Date().toISOString() });
  await rejects(as(ws.ownerId, [{ op: "create", m: "Attachment", id: randomUUID(), set: { issueId: a, url: "https://e.com", title: "" } }]), "bad_ref");
});
