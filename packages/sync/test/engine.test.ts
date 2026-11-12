import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_FORBIDDEN, CLOSE_TRY_AGAIN, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION, type AccountSettings, type Action } from "@rsva/protocol";
import { autorun } from "mobx";
import { OTHER_PERSON } from "../src/client.ts";
import { lines } from "../src/lines.ts";
import { deleteCopy, DONE, editSaved, harness, ISSUE, ME, online, PROJECT, snapshot, TODO, until } from "./fake.ts";

const [A, B, C] = ISSUE;
const U = (id: number, mid: string, d: Record<string, unknown>): Action => ({ id, m: "Issue", mid, a: "U", d });

test("the viewer's own settings come with the snapshot; from a server that sends none, nothing is reported", async () => {
  const got: AccountSettings[] = [];
  const h = harness({ onAccount: (s) => got.push(s) });
  await h.store.start();
  assert.deepEqual(got, [{ timeZone: "Europe/Sofia", weekStart: 0, theme: { mode: "dark", light: "latte", dark: "mocha" }, ui: { panes: "flat", density: "comfortable", start: "inbox", project: "issues", quiet: 7 } }]);
  const old = harness({ onAccount: (s) => got.push(s) });
  old.settings = null;
  await old.store.start();
  assert.equal(old.store.status, "ready");
  assert.equal(got.length, 1);
  h.store.dispose();
  old.store.dispose();
});

test("cold start streams the snapshot, derives sorted lists, then subscribes from its number", async () => {
  const h = harness();
  const { store } = h;
  assert.equal(store.status, "loading");
  await store.start();
  assert.equal(store.status, "ready");
  assert.equal(store.lastSyncId, 10);
  assert.equal(store.workspace?.slug, "atlas");
  assert.equal(store.me?.name, "Robin");
  assert.equal(store.role, "owner");
  assert.deepEqual(store.issuesOf(PROJECT).map((i) => i.title), ["First", "Second", "Third"]);
  assert.equal(store.issuesOf(PROJECT), store.issuesOf(PROJECT), "a cached list is the same array");
  assert.deepEqual(store.statesOf(PROJECT).map((s) => s.name), ["Todo", "Done"]);
  assert.deepEqual(store.labelsOf(PROJECT).map((l) => l.name), ["ws", "bug"]);
  assert.deepEqual(store.projectList().map((p) => p.key), ["PLANE"]);
  assert.equal(store.issueByKey("PLANE-2")?.id, B);
  assert.equal(store.issueKey(store.issues.get(C)!), "PLANE-3");
  assert.ok(performance.getEntriesByName("rsva:data").length > 0);
  assert.ok(h.requests[0]!.endsWith("/sync/bootstrap?ws=atlas&project=PLANE"));
  assert.equal(h.socket().url, "ws://planner.test/ws");

  assert.equal(store.connection, "connecting");
  h.socket().hello();
  assert.equal(store.connection, "online");
  // The inbox (PLNR-26) and the saved views (PLNR-74) ask for their first answer right after the subscription.
  assert.deepEqual(h.socket().sent, [{ t: "sub", ws: "atlas", s: 10 }, { t: "inbox" }, { t: "views" }]);
  store.dispose();
});

test("a field change re-runs only the observers that read it", async () => {
  const { store, socket } = await online();
  let titleA = 0;
  let titleB = 0;
  let list = 0;
  const stop = [
    autorun(() => void (store.issues.get(A)!.title, titleA++)),
    autorun(() => void (store.issues.get(B)!.title, titleB++)),
    autorun(() => void (store.issuesOf(PROJECT), list++)),
  ];
  socket().push({ t: "d", a: [U(11, B, { title: "B2" })] });
  socket().push({ t: "d", a: [U(12, A, { priority: 2, labelIds: [] })] }); // equal array: no change
  assert.deepEqual([titleA, titleB, list], [1, 2, 1]);
  socket().push({ t: "d", a: [U(13, A, { sortOrder: "a9" })] });
  assert.deepEqual([titleA, titleB, list], [1, 2, 2]);
  assert.deepEqual(store.issuesOf(PROJECT).map((i) => i.id), [B, C, A]);
  stop.forEach((s) => s());
  store.dispose();
});

test("deltas apply in order; a gap re-subscribes and the gapped frame is ignored", async () => {
  const { store, socket } = await online();
  socket().push({ t: "d", a: [U(11, A, { title: "A11" }), U(12, A, { title: "A12" })] });
  assert.equal(store.lastSyncId, 12);
  socket().push({ t: "d", a: [U(14, A, { title: "A14" })] });
  assert.equal(store.issues.get(A)!.title, "A12");
  assert.equal(store.lastSyncId, 12);
  assert.deepEqual(socket().frames("sub").at(-1), { t: "sub", ws: "atlas", s: 12 });
  socket().push({ t: "d", a: [U(15, A, { title: "A15" })] }); // still waiting: no second sub
  assert.equal(socket().frames("sub").length, 2);
  // Catch-up overlaps what was applied: old numbers are skipped.
  socket().push({ t: "d", a: [U(12, A, { title: "old" }), U(13, A, { title: "A13" }), U(14, A, { title: "A14" })] });
  assert.equal(store.issues.get(A)!.title, "A14");
  assert.equal(store.lastSyncId, 14);
  store.dispose();
});

test("someone else's live change to an issue is reported once per frame; a catch-up, the viewer's own and a no-cell change are not", async () => {
  const seen: string[][] = [];
  const { store, socket } = await online({ onOthersChange: (ids) => seen.push([...ids]) });
  const OTHER = "00000000-0000-7000-8000-0000000000a2";
  const by = (a: Action, who: string): Action => ({ ...a, by: who });
  // Before caught-up the frames bring the copy up to date: nothing happened now.
  socket().push({ t: "d", a: [by(U(11, A, { title: "caught up" }), OTHER)] });
  socket().push({ t: "caught-up" });
  socket().push({ t: "d", a: [by(U(12, A, { title: "mine" }), ME), by(U(13, B, { updatedAt: "2026-11-05T10:00:00Z", gh: {} }), OTHER), U(14, B, { title: "import" })] });
  assert.deepEqual(seen, []);
  socket().push({ t: "d", a: [by(U(15, A, { stateId: DONE }), OTHER), by(U(16, A, { priority: 1 }), OTHER), by(U(17, C, { title: "C17" }), OTHER)] });
  assert.deepEqual(seen, [[A, C]]);
  assert.equal(store.issues.get(A)!.stateId, DONE, "reported after the pool has it");
  // A gap re-subscribes: what the answer brings is a catch-up again.
  socket().push({ t: "d", a: [by(U(19, A, { title: "gapped" }), OTHER)] });
  socket().push({ t: "d", a: [by(U(18, B, { title: "B18" }), OTHER), by(U(19, A, { title: "A19" }), OTHER)] });
  assert.equal(seen.length, 1);
  store.dispose();
});

test("an edit applies at once, is sent, and is dropped once acked and its number applied", async () => {
  const { store, socket } = await online();
  store.updateIssue(A, { title: "Mine", priority: 0 }); // priority is unchanged: not sent
  assert.equal(store.issues.get(A)!.title, "Mine");
  assert.equal(store.pendingCount, 1);
  assert.ok(store.isPending(A));
  const [tx] = socket().frames("tx");
  assert.deepEqual(tx!.ops, [{ op: "update", m: "Issue", id: A, set: { title: "Mine" } }]);

  // The ack overtakes its delta: the edit stays pending until number 11 is applied.
  socket().push({ t: "ack", id: tx!.id, s: 11 });
  assert.equal(store.pendingCount, 1);
  socket().push({ t: "d", a: [U(11, A, { title: "Mine", updatedAt: "2026-10-27T01:00:00Z" })] });
  assert.equal(store.pendingCount, 0);
  assert.equal(store.isPending(A), false);
  assert.equal(store.issues.get(A)!.title, "Mine");

  // Ack after the delta: dropped at once.
  store.updateIssue(B, { priority: 1 });
  const tx2 = socket().frames("tx")[1]!;
  socket().push({ t: "d", a: [U(12, B, { priority: 1 })] });
  assert.equal(store.pendingCount, 1);
  socket().push({ t: "ack", id: tx2.id, s: 12 });
  assert.equal(store.pendingCount, 0);

  store.updateIssue(B, { priority: 1 }); // no-op: nothing queued
  assert.equal(store.pendingCount, 0);
  store.dispose();
});

test("a concurrent server delta is applied under the pending patch (rebase)", async () => {
  const { store, socket } = await online();
  store.updateIssue(A, { title: "Mine" });
  const tx = socket().frames("tx")[0]!;
  // Someone else changed the title and the priority before our transaction reached the server.
  socket().push({ t: "d", a: [U(11, A, { title: "Theirs", priority: 3 })] });
  assert.equal(store.issues.get(A)!.title, "Mine", "the local edit stays on top");
  assert.equal(store.issues.get(A)!.priority, 3, "other fields take the server value");
  socket().push({ t: "d", a: [U(12, A, { title: "Mine" })] });
  socket().push({ t: "ack", id: tx.id, s: 12 });
  assert.equal(store.pendingCount, 0);
  assert.equal(store.issues.get(A)!.title, "Mine");
  store.dispose();
});

test("after the ack the server's normalised value wins over the local one", async () => {
  const { store, socket } = await online();
  store.updateIssue(A, { title: "  Mine  " });
  const tx = socket().frames("tx")[0]!;
  socket().push({ t: "d", a: [U(11, A, { title: "Mine" })] });
  assert.equal(store.issues.get(A)!.title, "  Mine  ", "still pending: the local value shows");
  socket().push({ t: "ack", id: tx.id, s: 11 });
  assert.equal(store.issues.get(A)!.title, "Mine");
  store.dispose();
});

test("a rejection reverts to the latest server value and reports it", async () => {
  const { store, socket } = await online();
  store.updateIssue(A, { title: "Mine", stateId: DONE });
  store.updateIssue(A, { priority: 2 });
  const [tx1, tx2] = socket().frames("tx");
  socket().push({ t: "d", a: [U(11, A, { title: "Theirs" })] });
  socket().push({ t: "rej", id: tx1!.id, code: "bad_ref", msg: "state is not in the issue's project" });
  const a = store.issues.get(A)!;
  assert.equal(a.title, "Theirs", "not the title from before the edit");
  assert.equal(a.stateId, TODO);
  assert.equal(a.priority, 2, "the other pending edit stays");
  assert.deepEqual(store.lastRejection, { code: "bad_ref", message: "state is not in the issue's project", count: 1, lost: [{ text: "Mine", doc: null }] });
  assert.equal(store.pendingCount, 1);
  store.clearRejection();
  assert.equal(store.lastRejection, null);
  socket().push({ t: "d", a: [U(12, A, { priority: 2 })] });
  socket().push({ t: "ack", id: tx2!.id, s: 12 });
  assert.equal(store.isPending(A), false);
  store.dispose();
});

test("after a reconnect the engine re-subscribes and resends unconfirmed transactions in order", async () => {
  const h = await online();
  const { store } = h;
  store.updateIssue(A, { title: "one" });
  const first = h.socket();
  first.push({ t: "ack", id: first.frames("tx")[0]!.id, s: 11 }); // acked, delta not yet here
  first.close();
  await until(() => store.connection === "offline", "offline");
  store.updateIssue(B, { title: "two" });
  store.updateIssue(C, { title: "three" });
  assert.equal(store.pendingCount, 3);
  await until(() => h.sockets.length === 2, "reconnect");
  assert.equal(store.connection, "connecting");
  h.socket().hello();
  const sent = h.socket().sent;
  assert.deepEqual(sent[0], { t: "sub", ws: "atlas", s: 10 });
  assert.deepEqual(
    sent.slice(1).map((f) => (f.t === "tx" ? f.ops[0]!.id : f.t)),
    [B, C, "inbox", "views"],
    "the acked transaction is not resent; the rest go in order, then the inbox and views requests",
  );
  h.socket().push({ t: "d", a: [U(11, A, { title: "one" })] });
  assert.equal(store.pendingCount, 2);
  store.dispose();
});

test("a server that closes to have a write sent again (database unavailable) keeps the edit and gets it after reconnecting", async () => {
  const h = await online();
  const { store } = h;
  store.updateIssue(A, { title: "kept" });
  const [tx] = h.socket().frames("tx");
  h.socket().closeBy(CLOSE_TRY_AGAIN);
  assert.equal(store.issues.get(A)!.title, "kept", "not rolled back, as a rejection would");
  assert.equal(store.pendingCount, 1);
  await until(() => h.sockets.length === 2, "reconnect");
  h.socket().hello();
  assert.deepEqual(h.socket().frames("tx"), [tx], "the same transaction, so the server can tell a repeat");
  store.dispose();
});

test("action R and a resync frame replace the pool with a new snapshot, keeping pending edits", async () => {
  const h = await online();
  const { store } = h;
  store.updateIssue(A, { title: "Mine" });
  h.serve = snapshot(40, ["Imported A", "Imported B", "Imported C"]);
  h.socket().push({ t: "d", a: [{ id: 11, m: "Workspace", mid: "x", a: "R" }] });
  await until(() => store.lastSyncId === 40, "new snapshot");
  assert.equal(h.requests.filter((u) => u.includes("bootstrap")).length, 2);
  assert.equal(store.issues.get(B)!.title, "Imported B");
  assert.equal(store.issues.get(A)!.title, "Mine", "the pending edit is re-applied on the new data");
  const subs = h.socket().frames("sub");
  assert.deepEqual(subs.at(-1), { t: "sub", ws: "atlas", s: 40 });

  h.serve = snapshot(50);
  h.socket().push({ t: "resync" });
  await until(() => store.lastSyncId === 50, "resync");
  assert.equal(store.issues.get(B)!.title, "Second");
  store.dispose();
});

test("an edit acked before its delta survives a resync: the new snapshot's value stays, not the one before the edit", async () => {
  const h = await online();
  const { store } = h;
  store.updateIssue(A, { title: "Edited" });
  const [tx] = h.socket().frames("tx");
  h.socket().push({ t: "ack", id: tx!.id, s: 11 });
  assert.equal(store.pendingCount, 1, "its number is not applied yet");
  // The resync comes first; the new snapshot already holds the edit.
  h.serve = snapshot(20, ["Edited", "Second", "Third"]);
  h.socket().push({ t: "resync" });
  await until(() => store.lastSyncId === 20, "resync");
  assert.equal(store.pendingCount, 0);
  assert.equal(store.issues.get(A)!.title, "Edited");
  // A later rejection elsewhere has nothing of this edit left to roll back to.
  store.updateIssue(A, { title: "Again" });
  const [, again] = h.socket().frames("tx");
  h.socket().push({ t: "rej", id: again!.id, code: "invalid", msg: "no" });
  assert.equal(store.issues.get(A)!.title, "Edited");
  store.dispose();
});

test("an open tab lets another delete its database (sign-in as someone else) and keeps working from memory", async () => {
  const h = await online();
  await h.store.persist();
  await deleteCopy(h.idb);
  // Writes to the closed database fail quietly instead of throwing out of the engine.
  h.store.updateIssue(A, { title: "After" });
  h.socket().push({ t: "d", a: [U(11, B, { title: "B11" })] });
  await h.store.persist();
  assert.equal(h.store.issues.get(A)!.title, "After");
  h.store.dispose();
});

test("warm start loads IndexedDB before any network call; the stored copy holds server values only", async () => {
  const cold = await online();
  cold.store.updateIssue(A, { title: "Mine" }); // pending, not acked
  cold.socket().push({ t: "d", a: [U(11, B, { title: "B11" })] });
  await cold.store.persist();
  cold.store.dispose();

  const warm = harness({ idb: cold.idb, fetch: () => Promise.reject(new Error("offline")) });
  const ready = warm.store.start();
  await ready;
  const { store } = warm;
  assert.equal(store.status, "ready");
  assert.equal(store.lastSyncId, 11);
  assert.equal(store.issues.get(B)!.title, "B11");
  assert.equal(store.issues.get(A)!.title, "Mine", "the queue is replayed");
  assert.ok(store.isPending(A));
  assert.equal(warm.requests.length, 0);
  warm.socket().hello();
  assert.deepEqual(warm.socket().sent[0], { t: "sub", ws: "atlas", s: 11 });
  const tx = warm.socket().frames("tx")[0]!;
  // The stored snapshot kept the server title, so a rejection after reload still reverts correctly.
  warm.socket().push({ t: "rej", id: tx.id, code: "x", msg: "no" });
  assert.equal(store.issues.get(A)!.title, "First");
  store.dispose();
});

test("a stored snapshot of another protocol version is ignored", async () => {
  const cold = await online();
  await cold.store.persist();
  cold.store.dispose();
  await editSaved(cold.idb, (v) => ({ ...v, v: PROTOCOL_VERSION - 1 }));
  const warm = harness({ idb: cold.idb });
  await warm.store.start();
  assert.equal(warm.requests.length, 1, "went to the network");
  warm.store.dispose();
});

test("createIssue shows KEY-? until the server's insert assigns the number", async () => {
  const { store, socket } = await online();
  const issue = store.createIssue(PROJECT, { title: "New", stateId: TODO });
  assert.equal(store.issueKey(issue), "PLANE-?");
  assert.equal(store.issuesOf(PROJECT)[0], issue, "on top");
  assert.ok(store.isPending(issue.id));
  const tx = socket().frames("tx")[0]!;
  assert.deepEqual(tx.ops, [{ op: "create", m: "Issue", id: issue.id, projectId: PROJECT, set: { title: "New", stateId: TODO } }]);
  socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: issue.id, a: "I", d: { ...issue, number: 4, sortOrder: "a0" } }] });
  socket().push({ t: "ack", id: tx.id, s: 11 });
  assert.equal(store.issueKey(issue), "PLANE-4");
  assert.equal(store.issueByKey("PLANE-4"), issue);
  assert.equal(store.pendingCount, 0);

  const lost = store.createIssue(PROJECT, { title: "Lost", stateId: TODO });
  socket().push({ t: "rej", id: socket().frames("tx")[1]!.id, code: "invalid", msg: "bad" });
  assert.equal(store.issues.has(lost.id), false);
  store.dispose();
});

test("a protocol mismatch on hello calls the reload hook", async () => {
  const h = harness();
  await h.store.start();
  h.socket().hello(PROTOCOL_VERSION + 1);
  assert.equal(h.reloads, 1);
  assert.equal(h.socket().sent.length, 0);
  h.store.dispose();
});

test("the reconnect hook runs on the hello of every socket but the first: a deploy restarts the server", async () => {
  let reconnects = 0;
  const h = await online({ onReconnect: () => void reconnects++ });
  assert.equal(reconnects, 0);
  h.socket().closeBy(1006);
  await until(() => h.sockets.length === 2, "a second socket");
  assert.equal(reconnects, 0, "no hello on it yet");
  h.socket().hello();
  assert.equal(reconnects, 1);
  h.store.dispose();
});

test("a failed cold snapshot reports an error, then retries", async () => {
  let calls = 0;
  const body = snapshot(10).map((l) => JSON.stringify(l)).join("\n");
  const h = harness({
    fetch: (async () => (calls++ === 0 ? new Response(null, { status: 503 }) : new Response(body))) as typeof fetch,
  });
  await h.store.start();
  assert.equal(h.store.status, "error");
  assert.match(h.store.error!, /503/);
  await until(() => h.store.status === "ready", "retry");
  assert.equal(h.store.error, null);
  h.store.dispose();
});

test("lines() reassembles lines split across chunks and multi-byte characters", async () => {
  const bytes = new TextEncoder().encode('{"a":"привет"}\n\n{"b":1}\n{"c":2}');
  const chunks = [bytes.slice(0, 7), bytes.slice(7, 8), bytes.slice(8, 20), bytes.slice(20)];
  const body = new ReadableStream<Uint8Array>({ start: (c) => (chunks.forEach((x) => c.enqueue(x)), c.close()) });
  const out = [];
  for await (const l of lines(body)) out.push(l);
  assert.deepEqual(out, ['{"a":"привет"}', '{"b":1}', '{"c":2}']);
});

test("an ended session stops the engine: no retries, no reconnects, local data kept for the same person", async () => {
  const h = harness();
  h.refuse = 401;
  await h.store.start();
  assert.equal(h.store.errorCode, "unauthorized");
  assert.equal(h.store.status, "error");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.requests.filter((u) => u.includes("/sync/bootstrap")).length, 1, "no retry");
  h.store.dispose();

  // Signed out elsewhere while the data is on screen: the live socket closes with CLOSE_UNAUTHORIZED, and the one more
  // that tells whether the browser holds a newer session is refused while opening.
  const o = await online();
  o.store.updateIssue(A, { title: "unsent" });
  const sockets = o.sockets.length;
  o.socket().closeBy(CLOSE_UNAUTHORIZED);
  assert.equal(o.store.errorCode, null, "not yet: the session may have been replaced");
  await until(() => o.sockets.length === sockets + 1);
  o.socket().closeBy(CLOSE_UNAUTHORIZED);
  assert.equal(o.store.errorCode, "unauthorized");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(o.sockets.length, sockets + 1, "no more sockets");
  await o.store.persist();
  o.store.dispose();
  // The queue survives: the same person signing in again sends it.
  const again = await online({ idb: o.idb });
  assert.equal(again.store.issues.get(A)?.title, "unsent");
  assert.ok(again.socket().frames("tx").length > 0);
  again.store.dispose();
});

test("someone else signed in in this browser: the queue is not sent in their name, on a socket or after a resync", async () => {
  const OTHER = "00000000-0000-7000-8000-0000000000a2";
  // Offline, then back with another person's credential: the socket says whose it is.
  const h = await online();
  h.store.updateIssue(A, { title: "mine" });
  h.socket().close();
  await until(() => h.sockets.length === 2, "reconnect");
  h.socket().hello(PROTOCOL_VERSION, OTHER);
  assert.deepEqual(h.socket().sent, [], "no sub, no transaction");
  assert.equal(h.store.errorCode, "unauthorized");
  assert.equal(h.store.pendingCount, 1, "kept for its own person");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.sockets.length, 2, "no more sockets");
  h.store.dispose();

  // A resync under the other credential would make the queue theirs: refused before the snapshot replaces anything.
  const r = await online();
  r.store.updateIssue(A, { title: "mine" });
  const sent = r.socket().sent.length;
  r.me = OTHER;
  r.socket().push({ t: "resync" });
  await until(() => r.store.errorCode !== null, "stopped");
  assert.equal(r.store.errorCode, "unauthorized");
  assert.equal(r.store.me?.id, ME);
  assert.equal(r.store.issues.get(A)!.title, "mine");
  assert.equal(r.store.pendingCount, 1);
  assert.equal(r.socket().sent.length, sent, "nothing more went out");
  await r.store.persist();
  r.store.dispose();

  // The queue outlives a saved copy of another protocol version: its own owner is what the next snapshot is checked against.
  await editSaved(r.idb, (v) => ({ ...v, v: PROTOCOL_VERSION - 1 }));
  const cold = harness({ idb: r.idb });
  cold.me = OTHER;
  void cold.store.start();
  await until(() => cold.store.errorCode !== null, "stopped");
  assert.equal(cold.store.errorCode, "unauthorized");
  assert.equal(cold.store.pendingCount, 1);
  cold.socket().hello(PROTOCOL_VERSION, OTHER);
  assert.deepEqual(cold.socket().sent, []);
  cold.store.dispose();
});

test("PLNR-254: the person whose database another's sign-in deleted gets their queue back on disk by signing in again", async () => {
  const OTHER = "00000000-0000-7000-8000-0000000000a2";
  const h = await online();
  await h.store.persist();
  await deleteCopy(h.idb);
  h.store.updateIssue(A, { title: "unsent" });
  h.socket().close();
  await until(() => h.sockets.length === 2, "reconnect");
  h.socket().hello(PROTOCOL_VERSION, OTHER);
  assert.equal(h.store.errorCode, "unauthorized");
  assert.equal(h.store.error, OTHER_PERSON);
  assert.equal(h.store.pendingCount, 1);
  assert.equal(h.store.belongsTo(ME), true);
  assert.equal(h.store.belongsTo(OTHER), false);
  h.store.dispose();

  // Without the rewrite the change is on no disk: a reload would lose it.
  const lost = harness({ idb: h.idb, fetch: () => Promise.reject(new Error("offline")) });
  await lost.store.start();
  assert.equal(lost.store.pendingCount, 0);
  lost.store.dispose();

  await h.store.rewrite();
  const warm = harness({ idb: h.idb, fetch: () => Promise.reject(new Error("offline")) });
  await warm.store.start();
  assert.equal(warm.store.pendingCount, 1);
  assert.equal(warm.store.issues.get(A)!.title, "unsent");
  warm.store.dispose();

  // The same person signed in again: the rewritten queue goes out under their name.
  const again = await online({ idb: h.idb });
  assert.equal(again.store.issues.get(A)!.title, "unsent");
  assert.equal(again.store.pendingCount, 1);
  assert.equal(again.socket().frames("tx").length, 1);
  again.store.dispose();
});

test("a workspace the viewer may not open: forbidden, not retried", async () => {
  const h = harness();
  h.refuse = 403;
  await h.store.start();
  assert.equal(h.store.errorCode, "forbidden");
  const o = await online();
  o.socket().closeBy(CLOSE_FORBIDDEN);
  assert.equal(o.store.errorCode, "forbidden");
  h.store.dispose();
  o.store.dispose();
});
