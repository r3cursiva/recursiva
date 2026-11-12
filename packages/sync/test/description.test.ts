import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action, IssueHistory } from "@rsva/protocol";
import type { DocJSON } from "@rsva/schema/models";
import { ISSUE, ME, online, openedFeed, PROJECT, TODO, until } from "./fake.ts";

const [A] = ISSUE;
const OTHER = "00000000-0000-7000-8000-0000000000a2";
const T1 = "2026-10-27T11:00:00.000Z";
const T2 = "2026-10-27T12:00:00.000Z";
const doc = (text: string): DocJSON => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const saved = (id: number, text: string | null, at = T1, by = OTHER): Action => ({
  id,
  m: "Document",
  mid: A,
  a: "U",
  d: { issueId: A, ...(text === null ? {} : { doc: doc(text) }), updatedAt: at },
  by,
});

const opened = (h: Partial<IssueHistory> = {}) => openedFeed(A, { doc: { id: A, doc: doc("server v1"), updatedAt: T1 }, ...h });

test("the description loads with the feed and follows deltas; the issue's updatedAt moves with it; history says only that it changed", async () => {
  const { store, feed, socket } = await opened();
  assert.deepEqual(store.description(A)?.doc, doc("server v1"));
  socket().push({ t: "d", a: [saved(11, "from an agent", T2)] });
  assert.deepEqual(store.description(A)?.doc, doc("from an agent"));
  assert.equal(store.issues.get(A)!.updatedAt, T2);
  assert.deepEqual(feed.history.map((e) => [e.id, e.d]), [[11, { description: true }]]);
  // A compacted (older) action without the document changes nothing but the time.
  socket().push({ t: "d", a: [saved(12, null, T2)] });
  assert.deepEqual(store.description(A)?.doc, doc("from an agent"));
  store.dispose();
});

test("an edit shows at once, stays over others' saves while pending, and a rejection returns the latest server copy", async () => {
  const { store, socket } = await opened();
  store.updateDescription(A, doc("mine"));
  assert.deepEqual(store.description(A)?.doc, doc("mine"));
  assert.ok(store.isPending(A, "Document"));
  assert.equal(store.isPending(A), false, "the issue itself has nothing pending");
  const tx = socket().frames("tx")[0]!;
  assert.deepEqual(tx.ops, [{ op: "update", m: "Document", id: A, set: { doc: doc("mine") } }]);
  socket().push({ t: "d", a: [saved(11, "theirs")] });
  assert.deepEqual(store.description(A)?.doc, doc("mine"), "the pending edit stays on top");
  socket().push({ t: "rej", id: tx.id, code: "invalid", msg: "no" });
  assert.deepEqual(store.description(A)?.doc, doc("theirs"));
  assert.equal(store.isPending(A, "Document"), false);

  store.updateDescription(A, doc("again"));
  const tx2 = socket().frames("tx")[1]!;
  socket().push({ t: "d", a: [saved(12, "again", T2, ME)] });
  socket().push({ t: "ack", id: tx2.id, s: 12 });
  assert.deepEqual(store.description(A)?.doc, doc("again"));
  assert.equal(store.isPending(A, "Document"), false);
  store.updateDescription(A, doc("again"));
  assert.equal(socket().frames("tx").length, 2, "an unchanged description sends nothing");
  store.dispose();
});

test("a new issue with a description: one transaction, shown at once, gone with the issue if rejected", async () => {
  const h = await online();
  const issue = h.store.createIssue(PROJECT, { title: "New", stateId: TODO }, doc("details"));
  assert.deepEqual(h.store.description(issue.id)?.doc, doc("details"));
  const tx = h.socket().frames("tx")[0]!;
  assert.deepEqual(tx.ops.map((o) => `${o.op}:${o.m}`), ["create:Issue", "update:Document"]);
  h.socket().push({ t: "rej", id: tx.id, code: "invalid", msg: "no" });
  assert.equal(h.store.issues.get(issue.id), undefined);
  assert.equal(h.store.description(issue.id), undefined);
  h.store.dispose();
});

test("an edit made offline survives a reload and is sent when the socket is back", async () => {
  const h = await opened();
  h.store.updateDescription(A, doc("offline"));
  await h.store.persist();
  h.store.dispose();
  const again = await online({ idb: h.idb });
  again.history.set(A, { s: 10, history: [], comments: [], reactions: [], github: [], doc: { id: A, doc: doc("server v1"), updatedAt: T1 } });
  const tx = again.socket().frames("tx").find((f) => f.ops[0]!.m === "Document");
  assert.deepEqual(tx?.ops[0], { op: "update", m: "Document", id: A, set: { doc: doc("offline") } });
  const feed = again.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(again.store.description(A)?.doc, doc("offline"), "the server copy goes under the pending edit");
  again.store.dispose();
});

test("a failed first load leaves the description unknown (no document, status error); retry loads it", async () => {
  const h = await online();
  // A thenable rather than a rejected promise: it fails only when the fetch awaits it.
  const offline = { then: (_: unknown, reject: (e: Error) => void) => reject(new Error("offline")) } as unknown as Promise<IssueHistory>;
  h.history.set(A, offline);
  const feed = h.store.feed(A);
  await until(() => feed.status === "error", "the failed load");
  assert.equal(h.store.description(A), undefined);
  h.history.set(A, { s: 10, history: [], comments: [], reactions: [], github: [], doc: { id: A, doc: doc("server v1"), updatedAt: T1 } });
  feed.retry();
  assert.equal(feed.status, "loading");
  await until(() => feed.status === "ready", "the retry");
  assert.deepEqual(h.store.description(A)?.doc, doc("server v1"));
  // Only a failed load is retried.
  const requests = h.requests.length;
  feed.retry();
  assert.equal(h.requests.length, requests);
  h.store.dispose();
});
