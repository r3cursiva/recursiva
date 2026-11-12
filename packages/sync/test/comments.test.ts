import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action, IssueHistory } from "@rsva/protocol";
import type { Comment, Reaction } from "@rsva/schema/models";
import { autorun } from "mobx";
import { DONE, ISSUE, ME, online, openedFeed, TODO, until } from "./fake.ts";

const [A, B] = ISSUE;
const OTHER = "00000000-0000-7000-8000-0000000000a2";
const T0 = "2026-10-27T10:00:00.000Z";
const T1 = "2026-10-27T11:00:00.000Z";
const cid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id, issueId: A, parentId: null, authorId: OTHER, body: `body ${id.slice(-2)}`, createdAt: T0, editedAt: null, deletedAt: null, via: null, ...over,
});
const reaction = (id: string, over: Partial<Reaction> = {}): Reaction => ({ id, issueId: A, commentId: null, userId: OTHER, emoji: "👍", createdAt: T0, ...over });
const I = (id: number, m: "Comment" | "Reaction", row: Comment | Reaction, by = OTHER): Action => ({ id, m, mid: row.id, a: "I", d: { ...row }, by });

const opened = (h: Partial<IssueHistory> = {}) => openedFeed(A, h);

test("a feed loads once on first read: threads with replies, tombstones only while they have replies, reactions grouped", async () => {
  const top = comment(cid(1));
  const reply = comment(cid(2), { parentId: top.id, createdAt: T1, authorId: ME });
  const gone = comment(cid(3), { deletedAt: T1, body: "" });
  const goneWithReply = comment(cid(4), { deletedAt: T1, body: "", createdAt: "2026-10-27T09:00:00.000Z" });
  const kept = comment(cid(5), { parentId: goneWithReply.id, createdAt: T1 });
  const { store, feed, requests } = await opened({
    comments: [reply, top, gone, goneWithReply, kept],
    reactions: [reaction(cid(10), { commentId: top.id }), reaction(cid(11), { commentId: top.id, userId: ME }), reaction(cid(12), { emoji: "🎉" })],
    history: [{ id: 7, a: "U", by: OTHER, at: T0, d: { stateId: DONE }, p: { stateId: TODO } }],
  });
  assert.deepEqual(feed.threads.map((t) => [t.comment.id, t.replies.map((r) => r.id)]), [[goneWithReply.id, [kept.id]], [top.id, [reply.id]]]);
  assert.deepEqual(feed.reactions(top.id), [{ emoji: "👍", userIds: [OTHER, ME], mine: true }]);
  assert.deepEqual(feed.reactions(A), [{ emoji: "🎉", userIds: [OTHER], mine: false }], "the issue's own reactions");
  assert.deepEqual(feed.history.map((e) => e.d), [{ stateId: DONE }]);
  store.feed(A);
  assert.equal(requests.filter((u) => u.includes("/sync/history/")).length, 1, "loaded once");
  store.dispose();
});

test("the reads of one render send one request", async () => {
  const { store, requests, history } = await online();
  history.set(A, { s: 10, history: [], comments: [], reactions: [], github: [], doc: null });
  const feed = store.feed(A);
  store.feed(A);
  store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.equal(requests.filter((u) => u.includes("/sync/history/")).length, 1);
  store.dispose();
});

test("addComment shows at once, is sent, and settles on its echo and ack", async () => {
  const { store, feed, socket } = await opened();
  const c = store.addComment(A, "Hello **there**");
  assert.equal(c.authorId, ME);
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["Hello **there**"]);
  assert.ok(store.isPending(c.id));
  const tx = socket().frames("tx")[0]!;
  assert.deepEqual(tx.ops, [{ op: "create", m: "Comment", id: c.id, set: { issueId: A, body: "Hello **there**" } }]);

  const reply = store.addComment(A, "Reply", c.id);
  assert.deepEqual(feed.threads[0]!.replies.map((r) => r.id), [reply.id]);

  socket().push({ t: "d", a: [I(11, "Comment", comment(c.id, { authorId: ME, body: "Hello **there**", createdAt: T1 }), ME)] });
  socket().push({ t: "ack", id: tx.id, s: 11 });
  assert.equal(store.isPending(c.id), false);
  assert.equal(feed.threads[0]!.comment.createdAt, T1, "the server's time replaces the local one");
  assert.equal(store.pendingCount, 1, "the reply is still in flight");
  store.dispose();
});

test("a refused new comment stays in its feed as it stands now, with the reason and the toast", async () => {
  const mine = comment(cid(1), { authorId: ME, body: "v1" });
  const { store, feed, socket } = await opened({ comments: [mine] });
  const lost = store.addComment(A, "the text", mine.id);
  store.editComment(lost.id, "the text, edited");
  const gone = store.addComment(A, "changed my mind");
  store.deleteComment(gone.id);
  const [txAdd, , txGone] = socket().frames("tx");
  socket().push({ t: "rej", id: txAdd!.id, code: "forbidden", msg: "not allowed" });
  await until(() => feed.notSent.length === 1, "kept");
  assert.deepEqual({ ...feed.notSent[0], at: "" }, { id: lost.id, issueId: A, parentId: mine.id, body: "the text, edited", at: "", reason: "not allowed" });
  assert.equal(store.lastRejection?.message, "not allowed", "a toast too: the feed may be off the screen");
  assert.equal(feed.threads[0]!.replies.length, 0, "not a comment any more");
  socket().push({ t: "rej", id: txGone!.id, code: "forbidden", msg: "no" });
  await until(() => store.lastRejection?.message === "no", "second refusal");
  assert.equal(feed.notSent.length, 1, "what the author deleted stays deleted");
  feed.dropNotSent(lost.id);
  assert.equal(feed.notSent.length, 0);
  store.dispose();
});

test("a refused comment reaches a feed nobody has open", async () => {
  const { store, socket, history } = await online();
  history.set(A, { s: 10, history: [], comments: [], reactions: [], github: [], doc: null });
  const lost = store.addComment(A, "the text");
  socket().push({ t: "rej", id: socket().frames("tx")[0]!.id, code: "forbidden", msg: "no" });
  await until(() => store.lastRejection !== null, "refused");
  assert.deepEqual(store.feed(A).notSent.map((c) => c.id), [lost.id]);
  store.dispose();
});

test("rejections revert: a new comment goes, an edit and a delete return to the latest server value", async () => {
  const theirs = comment(cid(1), { authorId: ME, body: "v1" });
  const { store, feed, socket } = await opened({ comments: [theirs] });
  const lost = store.addComment(A, "lost");
  store.editComment(theirs.id, "mine");
  assert.equal(store.feed(A).threads[0]!.comment.body, "mine");
  assert.ok(feed.threads[0]!.comment.editedAt, "shown as edited at once");
  const [txAdd, txEdit] = socket().frames("tx");
  // Another tab of the same user edits the comment before ours is rejected.
  socket().push({ t: "d", a: [{ id: 11, m: "Comment", mid: theirs.id, a: "U", d: { issueId: A, body: "v2", editedAt: T1 }, by: ME }] });
  assert.equal(feed.threads[0]!.comment.body, "mine", "the pending edit stays on top");
  socket().push({ t: "rej", id: txAdd!.id, code: "bad_ref", msg: "no" });
  socket().push({ t: "rej", id: txEdit!.id, code: "forbidden", msg: "no" });
  assert.equal(store.feed(A).threads.some((t) => t.comment.id === lost.id), false);
  assert.equal(feed.threads[0]!.comment.body, "v2", "not the value from before the edit");
  assert.equal(feed.threads[0]!.comment.editedAt, T1);

  store.deleteComment(theirs.id);
  assert.equal(feed.threads.length, 0, "a deleted comment without replies is hidden");
  socket().push({ t: "rej", id: socket().frames("tx")[2]!.id, code: "forbidden", msg: "no" });
  assert.equal(feed.threads[0]!.comment.body, "v2");
  assert.equal(store.pendingCount, 0);
  store.dispose();
});

test("deltas from another client: tracked for an opened issue, ignored for others, observers re-run", async () => {
  const { store, feed, socket } = await opened();
  let runs = 0;
  const stop = autorun(() => void (feed.threads, runs++));
  const c = comment(cid(1));
  socket().push({ t: "d", a: [I(11, "Comment", c), I(12, "Comment", comment(cid(2), { issueId: B }))] });
  assert.deepEqual(feed.threads.map((t) => t.comment.id), [c.id]);
  assert.equal(store.feed(B).threads.length, 0, "B was not loaded: its comment was not kept");
  socket().push({ t: "d", a: [{ id: 13, m: "Comment", mid: c.id, a: "U", d: { issueId: A, body: "edited", editedAt: T1 }, by: OTHER }] });
  assert.equal(feed.threads[0]!.comment.body, "edited");
  const r = reaction(cid(3), { commentId: c.id });
  socket().push({ t: "d", a: [I(14, "Reaction", r)] });
  assert.deepEqual(feed.reactions(c.id).map((g) => g.userIds), [[OTHER]]);
  socket().push({ t: "d", a: [{ id: 15, m: "Reaction", mid: r.id, a: "D", d: { issueId: A }, by: OTHER }] });
  assert.deepEqual(feed.reactions(c.id), []);
  assert.equal(runs, 2, "threads re-ran for the new comment only: an edit or a reaction does not change the thread list");
  stop();
  store.dispose();
});

test("deltas during the load wait in a buffer; those past the answer's cut are applied once", async () => {
  const h = await online();
  let answer!: (x: IssueHistory) => void;
  h.history.set(A, new Promise<IssueHistory>((r) => (answer = r)));
  const feed = h.store.feed(A);
  await until(() => h.requests.some((u) => u.includes("/sync/history/")), "request");
  const early = comment(cid(1));
  const late = comment(cid(2), { createdAt: T1 });
  h.socket().push({ t: "d", a: [I(11, "Comment", early), { id: 12, m: "Issue", mid: A, a: "U", d: { title: "Renamed", updatedAt: T1 }, by: OTHER }] });
  h.socket().push({ t: "d", a: [I(13, "Comment", late), { id: 14, m: "Issue", mid: A, a: "U", d: { priority: 2, updatedAt: T1 }, by: OTHER }] });
  assert.equal(h.store.issues.get(A)!.title, "Renamed", "issue deltas apply at once");
  // The server read at 12: it has the early comment and the rename, not what came after.
  answer({ s: 12, comments: [early], reactions: [], github: [], doc: null, history: [{ id: 12, a: "U", by: OTHER, at: T1, d: { title: "Renamed" }, p: { title: "First" } }] });
  await until(() => feed.status === "ready", "ready");
  assert.deepEqual(feed.threads.map((t) => t.comment.id), [early.id, late.id]);
  assert.deepEqual(feed.history.map((e) => [e.id, e.d, e.p]), [[12, { title: "Renamed" }, { title: "First" }], [14, { priority: 2 }, { priority: 0 }]]);
  h.store.dispose();
});

test("live history: another client's change records the server value it replaced, also under a pending local edit", async () => {
  const { store, feed, socket } = await opened();
  store.updateIssue(A, { title: "Mine" });
  socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: A, a: "U", d: { title: "Theirs", sortOrder: "zz", updatedAt: T1 }, by: OTHER }] });
  socket().push({ t: "d", a: [{ id: 12, m: "Issue", mid: A, a: "U", d: { sortOrder: "a5", updatedAt: T1 }, by: OTHER }] });
  assert.deepEqual(feed.history.map((e) => [e.by, e.at, e.d, e.p]), [[OTHER, T1, { title: "Theirs" }, { title: "First" }]], "a move alone is not history");
  store.dispose();
});

test("toggleReaction: add and remove at once; a duplicate add settles away, a rejected removal comes back", async () => {
  const mine = reaction(cid(1), { userId: ME, emoji: "🎉" });
  const { store, feed, socket } = await opened({ reactions: [mine] });
  store.toggleReaction(A, null, "👍");
  assert.deepEqual(feed.reactions(A).map((g) => [g.emoji, g.mine]), [["🎉", true], ["👍", true]]);
  // The server already had this reaction (another tab): no action, just the ack.
  socket().push({ t: "ack", id: socket().frames("tx")[0]!.id, s: 10 });
  assert.deepEqual(feed.reactions(A).map((g) => g.emoji), ["🎉"], "the unechoed row goes");

  store.toggleReaction(A, null, "🎉");
  assert.deepEqual(feed.reactions(A), []);
  assert.deepEqual(socket().frames("tx")[1]!.ops, [{ op: "delete", m: "Reaction", id: mine.id }]);
  socket().push({ t: "rej", id: socket().frames("tx")[1]!.id, code: "forbidden", msg: "no" });
  assert.deepEqual(feed.reactions(A).map((g) => g.emoji), ["🎉"]);

  store.toggleReaction(A, null, "🎉");
  socket().push({ t: "d", a: [{ id: 11, m: "Reaction", mid: mine.id, a: "D", d: { issueId: A }, by: ME }] });
  socket().push({ t: "ack", id: socket().frames("tx")[2]!.id, s: 11 });
  assert.deepEqual(feed.reactions(A), []);
  assert.equal(store.pendingCount, 0);
  store.dispose();
});

test("a new snapshot reloads opened feeds: what changed meanwhile is picked up", async () => {
  const h = await opened({ comments: [comment(cid(1))] });
  h.history.set(A, { s: 40, history: [], comments: [comment(cid(2))], reactions: [], github: [], doc: null });
  h.serve = (await import("./fake.ts")).snapshot(40);
  h.socket().push({ t: "resync" });
  await until(() => h.feed.threads[0]?.comment.id === cid(2), "reloaded feed");
  assert.equal(h.feed.threads.length, 1, "the comment deleted meanwhile is gone");
  h.store.dispose();
});

test("older activity comes in pages: loadOlder puts the page under what is loaded, deltas meanwhile still apply", async () => {
  const TOLD = "2026-10-27 09:00:00.123456+00";
  const newer = comment(cid(3), { createdAt: T1 });
  const h = await opened({
    s: 10,
    comments: [newer],
    history: [{ id: 9, a: "U", by: OTHER, at: T1, d: { priority: 1 }, p: { priority: 0 } }],
    older: TOLD,
  });
  assert.equal(h.feed.hasOlder, true);
  const old = comment(cid(1), { body: "old text" });
  let answer!: (x: IssueHistory) => void;
  h.history.set(`${A}?until=${encodeURIComponent(TOLD)}`, new Promise<IssueHistory>((r) => (answer = r)));
  h.feed.loadOlder();
  await until(() => h.requests.some((u) => u.includes("until=")), "older request");
  assert.equal(h.feed.loadingOlder, true);
  // While the page is on its way: an edit of the old comment the page already has, and a new reply.
  const reply = comment(cid(4), { parentId: old.id, createdAt: T1 });
  h.socket().push({ t: "d", a: [{ id: 11, m: "Comment", mid: old.id, a: "U", d: { issueId: A, body: "old text, edited" }, by: OTHER }, I(12, "Comment", reply)] });
  answer({ s: 11, comments: [{ ...old, body: "old text, edited" }], reactions: [], github: [], doc: null, history: [{ id: 3, a: "U", by: OTHER, at: T0, d: { title: "B" }, p: { title: "A" } }], older: null });
  await until(() => !h.feed.loadingOlder, "older loaded");
  assert.equal(h.feed.hasOlder, false);
  assert.deepEqual(h.feed.history.map((e) => e.id), [3, 9], "the older page goes before what was loaded");
  const threads = h.feed.threads;
  assert.deepEqual(threads.map((t) => [t.comment.id, t.comment.body, t.replies.map((r) => r.id)]), [
    [old.id, "old text, edited", [reply.id]],
    [newer.id, newer.body, []],
  ]);
  h.store.dispose();
});
