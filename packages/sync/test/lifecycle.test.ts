// Archive, delete and restore in the engine (PLNR-33): plain field edits, so the shelves follow at once and a rejection
// puts the issue back; the sub-issue index hides what is archived or deleted.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action } from "@rsva/protocol";
import { DONE, ISSUE, online, PROJECT } from "./fake.ts";

const [A, B] = ISSUE;
const U = (id: number, mid: string, d: Record<string, unknown>): Action => ({ id, m: "Issue", mid, a: "U", d });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("archive moves the issue to its shelf at once; archiving it again sends nothing; a rejection puts it back", async () => {
  const { store, socket } = await online();
  store.updateIssue(A, { archivedAt: "2026-10-29T10:00:00Z" });
  assert.ok(!ids(store.issuesOf(PROJECT)).includes(A));
  assert.deepEqual(ids(store.issuesOf(PROJECT, "archived")), [A]);
  store.updateIssue(A, { archivedAt: "2026-10-29T11:00:00Z" });
  const sent = socket().frames("tx");
  assert.equal(sent.length, 1, "already archived: not a change");
  socket().push({ t: "rej", id: sent[0]!.id, code: "invalid", msg: "only completed or cancelled issues can be archived" });
  assert.ok(ids(store.issuesOf(PROJECT)).includes(A));
  assert.deepEqual(store.issuesOf(PROJECT, "archived"), []);
  store.dispose();
});

test("a deleted sub-issue leaves its parent's list and the lists, stays in the trash and in the whole tree", async () => {
  const { store, socket } = await online();
  socket().push({ t: "d", a: [U(11, B, { parentId: A })] });
  assert.deepEqual(ids(store.subIssuesOf(A)), [B]);
  assert.ok(store.mayDelete(store.issues.get(B)!), "the owner, who created it");
  store.updateIssue(B, { deletedAt: "2026-10-29T10:00:00Z" });
  assert.deepEqual(store.subIssuesOf(A), []);
  assert.deepEqual(ids(store.subIssuesOf(A, true)), [B]);
  assert.deepEqual(ids(store.issuesOf(PROJECT, "deleted")), [B]);
  assert.ok(!ids(store.issuesOf(PROJECT)).includes(B));
  // Restoring is the same field back to null.
  store.updateIssue(B, { deletedAt: null });
  assert.deepEqual(ids(store.subIssuesOf(A)), [B]);
  assert.deepEqual(store.issuesOf(PROJECT, "deleted"), []);
  store.dispose();
});

test("an urgent project counts only active issues and follows edits", async () => {
  const { store } = await online();
  assert.equal(store.hasUrgent(PROJECT), false);
  store.updateIssue(A, { priority: 1 });
  assert.equal(store.hasUrgent(PROJECT), true);
  store.updateIssue(A, { stateId: DONE });
  assert.equal(store.hasUrgent(PROJECT), false, "completed");
  store.dispose();
});

test("the active count leaves out closed, archived and deleted issues, and follows edits and rejections", async () => {
  const { store, socket } = await online();
  assert.equal(store.activeCount(PROJECT), 3);
  store.updateIssue(A, { stateId: DONE });
  assert.equal(store.activeCount(PROJECT), 2, "completed");
  store.updateIssue(A, { archivedAt: "2026-10-29T10:00:00Z" });
  store.updateIssue(B, { deletedAt: "2026-10-29T10:00:00Z" });
  assert.equal(store.activeCount(PROJECT), 1, "archived and deleted");
  const sent = socket().frames("tx");
  socket().push({ t: "rej", id: sent.at(-1)!.id, code: "forbidden", msg: "not yours" });
  assert.equal(store.activeCount(PROJECT), 2, "the deletion was rejected");
  store.dispose();
});

test("Delete permanently (RSVA-457): a live issue sends nothing; one in the trash goes at once, and a refusal puts it back there", async () => {
  const { store, socket } = await online();
  store.purgeIssue(A);
  assert.deepEqual(socket().frames("tx"), [], "only an issue in the trash is deleted for good");
  store.updateIssue(A, { deletedAt: "2026-11-07T10:00:00Z" });
  store.purgeIssue(A);
  const sent = socket().frames("tx");
  assert.deepEqual(sent.at(-1)!.ops, [{ op: "delete", m: "Issue", id: A }]);
  assert.equal(store.issues.get(A), undefined);
  assert.deepEqual(store.issuesOf(PROJECT, "deleted"), []);
  socket().push({ t: "rej", id: sent.at(-1)!.id, code: "forbidden", msg: "only the issue's creator or an admin deletes it permanently" });
  assert.deepEqual(ids(store.issuesOf(PROJECT, "deleted")), [A]);
  store.dispose();
});

test("an issue deleted for good elsewhere goes from the copy with its links", async () => {
  const { store, socket } = await online();
  socket().push({ t: "d", a: [{ id: 11, m: "Attachment", mid: "a1", a: "I", d: { issueId: A, url: "https://example.com/a", title: "a link", kind: "link" } }] });
  assert.equal(store.attachmentsOf(A).length, 1);
  socket().push({ t: "d", a: [{ id: 12, m: "Issue", mid: A, a: "D", d: { projectId: PROJECT } }] });
  assert.equal(store.issues.get(A), undefined);
  assert.deepEqual(store.attachmentsOf(A), []);
  store.dispose();
});
