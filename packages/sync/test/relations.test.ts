// Relations and links in the engine (PLNR-49): both ends read through the pool's index, one transaction per change,
// a rejection puts the pair back; links are cleaned as the server stores them.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action } from "@rsva/protocol";
import { DONE, ISSUE, online } from "./fake.ts";

const [A, B, C] = ISSUE;
const keys = (xs: { id: string }[]) => xs.map((x) => x.id);

test("both ends: blocked by / blocks, related from either side, duplicate of / duplicates; blocked only while the blocker is open", async () => {
  const { store, socket } = await online();
  store.addRelation(A, "blocks", B);
  store.addRelation(C, "related", A);
  store.addRelation(C, "duplicateOf", B);
  assert.equal(socket().frames("tx").length, 3, "one transaction per change");
  assert.deepEqual(store.issues.get(B)!.blockedByIds, [A], "blocks is stored on the other end");
  assert.deepEqual(keys(store.relationsOf(A).blocks), [B]);
  assert.deepEqual(keys(store.relationsOf(B).blockedBy), [A]);
  assert.deepEqual(keys(store.relationsOf(A).related), [C]);
  assert.deepEqual(keys(store.relationsOf(B).duplicates), [C]);
  assert.equal(store.relationsOf(C).duplicateOf?.id, B);
  assert.ok(store.isBlocked(store.issues.get(B)!));
  assert.ok(store.isBlocking(store.issues.get(A)!));
  assert.ok(!store.isBlocking(store.issues.get(C)!), "nobody waits on it");
  socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: A, a: "U", d: { stateId: DONE } } satisfies Action] });
  assert.ok(!store.isBlocked(store.issues.get(B)!), "a closed blocker blocks no more");
  assert.ok(!store.isBlocking(store.issues.get(A)!), "nor does it count as blocking");
  store.dispose();
});

test("another kind for the pair moves it in one transaction; a rejection restores the old relation", async () => {
  const { store, socket } = await online();
  store.addRelation(A, "related", B);
  store.addRelation(A, "blockedBy", B);
  const tx = socket().frames("tx").at(-1)!;
  assert.equal(tx.ops.length, 1, "related and blockedBy are both on A: one op");
  assert.deepEqual([store.issues.get(A)!.relatedIds, store.issues.get(A)!.blockedByIds], [[], [B]]);
  socket().push({ t: "rej", id: tx.id, code: "bad_ref", msg: "no" });
  assert.deepEqual([store.issues.get(A)!.relatedIds, store.issues.get(A)!.blockedByIds], [[B], []]);
  store.removeRelation(B, A);
  assert.deepEqual(store.issues.get(A)!.relatedIds, [], "removed from whichever end holds it");
  store.dispose();
});

test("links: the address is cleaned and typed at once; a bad one adds nothing", async () => {
  const { store, socket } = await online();
  assert.equal(store.addLink(A, "javascript:alert(1)"), null);
  const l = store.addLink(A, " https://github.com/acme/app/pull/5 ", "  PR\n")!;
  assert.deepEqual([l.url, l.kind, l.title], ["https://github.com/acme/app/pull/5", "github_pr", "PR"]);
  store.updateLink(l.id, { url: "https://example.com/x" });
  assert.equal(store.attachmentsOf(A)[0]!.kind, "link");
  store.removeLink(l.id);
  assert.deepEqual(store.attachmentsOf(A), []);
  assert.equal(socket().frames("tx").length, 3);
  store.dispose();
});

test("has a link: a link, a pull request or a commit counts, a file does not; live as links come and go (RSVA-174)", async () => {
  const { store, socket } = await online();
  const has = (id: string) => store.hasLink(store.issues.get(id)!);
  const at = (id: number, mid: string, issueId: string, kind: string) => ({ id, m: "Attachment", mid, a: "I", d: { issueId, url: `https://example.com/${mid}`, title: "", kind } }) satisfies Action;
  assert.ok(!has(A));
  socket().push({ t: "d", a: [at(11, "f1", A, "file"), at(12, "p1", B, "github_pr")] });
  assert.ok(!has(A), "a file is not a link");
  assert.ok(has(B));
  socket().push({ t: "d", a: [at(13, "l1", A, "link")] });
  assert.ok(has(A));
  socket().push({ t: "d", a: [{ id: 14, m: "Attachment", mid: "l1", a: "D", d: { issueId: A } } satisfies Action] });
  assert.ok(!has(A), "gone with its last link");
  store.dispose();
});
