import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action, InboxFrame } from "@rsva/protocol";
import { DONE, ISSUE, ME, online, until } from "./fake.ts";

const [A, B] = ISSUE;
const OTHER = "00000000-0000-7000-8000-0000000000a2";
const T0 = new Date().toISOString();
const cid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const commentBy = (id: number, issueId: string, by: string, parentId: string | null = null): Action => ({
  id,
  m: "Comment",
  mid: cid(id),
  a: "I",
  by,
  d: { id: cid(id), issueId, parentId, authorId: by, body: "hi", createdAt: T0, editedAt: null, deletedAt: null },
});
const inbox = (over: Partial<InboxFrame> = {}): InboxFrame => ({
  t: "inbox",
  s: 10,
  e: [{ id: 5, issueId: B, kind: "assigned", by: OTHER, at: T0 }],
  m: [],
  c: [],
  th: [],
  at: null,
  ...over,
});

test("the first connection asks for the whole inbox; deltas after its cut are classified here and kept", async () => {
  const { store, socket } = await online();
  assert.deepEqual(socket().frames("inbox"), [{ t: "inbox" }]);
  assert.equal(store.inbox.status, "loading");
  // A comment on an issue the viewer created arrives before the answer cut at 10: it stays.
  socket().push({ t: "d", a: [commentBy(11, A, OTHER)] });
  socket().push(inbox());
  assert.equal(store.inbox.status, "ready");
  assert.deepEqual(store.inbox.rows.map((r) => [r.issue.id, r.latest.kind, r.unread]), [[A, "comment", true], [B, "assigned", true]]);
  assert.equal(store.inbox.unread, 2);
  // The viewer's own comment: no event, but replies in that thread now concern them.
  socket().push({ t: "d", a: [commentBy(12, B, ME)] });
  socket().push({ t: "d", a: [commentBy(13, B, OTHER, cid(12))] });
  assert.deepEqual(store.inbox.rows[0]!.events.map((e) => e.kind), ["assigned", "reply"]);
  store.dispose();
});

test("mentions in deltas: a comment, an edit and a description reach the viewer", async () => {
  const { store, socket } = await online();
  socket().push(inbox({ e: [] }));
  const mention = { ...commentBy(11, B, OTHER), d: { ...commentBy(11, B, OTHER).d, mentionIds: [ME] } };
  socket().push({ t: "d", a: [mention] });
  socket().push({ t: "d", a: [{ id: 12, m: "Comment", mid: cid(11), a: "U", by: OTHER, d: { issueId: B, body: "edited", editedAt: T0, mentionIds: [OTHER] } }] });
  socket().push({ t: "d", a: [{ id: 13, m: "Document", mid: A, a: "U", by: OTHER, d: { issueId: A, doc: { type: "doc", content: [{ type: "paragraph" }] }, updatedAt: T0, mentionIds: [ME] } }] });
  const kinds = store.inbox.rows.map((r) => [r.issue.id, r.events.map((e) => [e.kind, e.commentId ?? null])]);
  assert.deepEqual(kinds, [[A, [["mention", null]]], [B, [["mention", cid(11)]]]], "the edit mentions someone else");
  store.dispose();
});

test("marks apply at once, settle on the echo, and a newer event brings an archived issue back", async () => {
  const { store, socket } = await online();
  socket().push(inbox());
  store.inbox.read([B]);
  assert.equal(store.inbox.unread, 0);
  assert.equal(store.unconfirmedOutbox, true, "a reload for a new version waits for the echo (PLNR-261)");
  const sent = socket().frames("mark")[0]!.m[0]!;
  assert.deepEqual(sent, { issueId: B, readId: 5, archivedId: 0, snoozedId: 0, snoozedUntil: null });
  socket().push({ t: "marks", m: [sent], at: "2026-10-28 10:00:00.000001+00" });
  assert.equal(store.unconfirmedOutbox, false);

  const before = store.inbox.marksOf([B]);
  store.inbox.archive([B]);
  assert.equal(store.inbox.rows.length, 0);
  store.inbox.restore(before);
  assert.equal(store.inbox.rows.length, 1, "undo");
  store.inbox.archive([B]);
  socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: B, a: "U", by: OTHER, d: { assigneeIds: [ME] } }] });
  // The pool row had no assignees: a new assignment, newer than the archive.
  assert.deepEqual(store.inbox.rows.map((r) => [r.issue.id, r.events.map((e) => e.id), r.unread]), [[B, [11], true]]);
  store.dispose();
});

test("a snoozed issue hides until a newer event; a warm start shows the saved inbox and asks only for newer marks", async () => {
  const h = await online();
  h.socket().push(inbox({ at: "2026-10-28 09:00:00+00" }));
  h.store.inbox.snooze(B, new Date(Date.now() + 3_600_000));
  assert.ok(h.store.inbox.rows[0]!.snoozedUntil);
  assert.equal(h.store.inbox.unread, 0);
  // A state change of an issue the viewer created: a state event, newer than the snooze.
  h.socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: B, a: "U", by: OTHER, d: { stateId: DONE } }] });
  assert.equal(h.store.inbox.rows[0]!.snoozedUntil, null);
  await h.store.persist();
  h.store.dispose();

  const warm = await online({ idb: h.idb });
  assert.equal(warm.store.inbox.status, "ready", "from IndexedDB, before any answer");
  assert.deepEqual(warm.store.inbox.rows[0]!.events.map((e) => e.id), [5, 11]);
  await until(() => warm.socket().frames("inbox").length > 0, "inbox request");
  assert.deepEqual(warm.socket().frames("inbox"), [{ t: "inbox", at: "2026-10-28 09:00:00+00" }]);
  // The snooze was never echoed: it goes again.
  assert.equal(warm.socket().frames("mark").length, 1);
  warm.store.dispose();
});

test("a delta inside the answer's cut is not counted twice; a reply that came before the answer is still a reply", async () => {
  const { store, socket } = await online();
  // Before the answer: a reply to the viewer's thread, which the client only learns about from the answer.
  socket().push({ t: "d", a: [commentBy(11, B, OTHER, cid(3))] });
  socket().push(inbox({ s: 10, th: [cid(3)], c: [B] }));
  assert.deepEqual(store.inbox.rows[0]!.events.map((e) => [e.id, e.kind]), [[5, "assigned"], [11, "reply"]]);
  // The fan-out may deliver an action the answer already holds after the answer: it is in, not new.
  const h = await online();
  h.socket().push(inbox({ s: 12, e: [{ id: 12, issueId: A, kind: "comment", by: OTHER, at: T0, commentId: cid(12) }] }));
  h.socket().push({ t: "d", a: [commentBy(11, A, OTHER), commentBy(12, A, OTHER)] });
  assert.deepEqual(h.store.inbox.rows.find((r) => r.issue.id === A)!.events.map((e) => e.id), [12]);
  store.dispose();
  h.store.dispose();
});

test("saved before the answer's own deltas arrived: the warm start does not count them again", async () => {
  const h = await online();
  h.socket().push(inbox({ s: 12, e: [{ id: 12, issueId: A, kind: "comment", by: OTHER, at: T0, commentId: cid(12) }] }));
  await h.store.persist(); // the snapshot is still at 10
  h.store.dispose();
  const warm = await online({ idb: h.idb });
  warm.socket().push({ t: "d", a: [commentBy(11, A, OTHER), commentBy(12, A, OTHER)] });
  assert.deepEqual(warm.store.inbox.rows.find((r) => r.issue.id === A)!.events.map((e) => e.id), [12]);
  warm.store.dispose();
});

test("Unsubscribe and Subscribe are marks from the engine's lastSyncId: the classifier reads them, undo keeps them", async () => {
  const { store, socket } = await online();
  socket().push(inbox({ e: [] }));
  const issue = store.issues.get(A)!;
  const before = store.inbox.marksOf([A]);
  assert.deepEqual(store.inbox.subscription(issue), { following: true, chosen: false, involved: "creator" });
  store.inbox.subscribe(A, false);
  assert.deepEqual(store.inbox.subscription(issue), { following: false, chosen: true, involved: "creator" });
  const s = store.lastSyncId;
  const sent = socket().frames("mark")[0]!.m[0]!;
  assert.deepEqual([sent.subscribed, sent.subscribedId], [false, s]);

  // Comments stop; a mention still comes.
  const mention = { ...commentBy(s + 2, A, OTHER), d: { ...commentBy(s + 2, A, OTHER).d, mentionIds: [ME] } };
  socket().push({ t: "d", a: [commentBy(s + 1, A, OTHER), mention] });
  assert.deepEqual(store.inbox.rows.map((r) => r.events.map((e) => [e.id, e.kind])), [[[s + 2, "mention"]]]);

  // Undoing an archive puts back the inbox marks from before the choice, not the choice.
  store.inbox.archive([A]);
  store.inbox.restore(before);
  assert.deepEqual(store.inbox.marksOf([A]).map((m) => [m.archivedId, m.subscribed, m.subscribedId]), [[0, false, s]]);

  store.inbox.subscribe(A, true);
  socket().push({ t: "d", a: [commentBy(s + 3, A, OTHER)] });
  assert.deepEqual(store.inbox.rows[0]!.events.map((e) => e.kind), ["mention", "comment"]);
  store.dispose();
});
