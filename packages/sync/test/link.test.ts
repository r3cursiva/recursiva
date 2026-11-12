// A link that fails without saying so, and everything that must not cost the user a change because of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_FORBIDDEN, CLOSE_TOO_BIG, MAX_FRAME_BYTES, type Action } from "@rsva/protocol";
import type { DocJSON } from "@rsva/schema/models";
import { IDBFactory } from "fake-indexeddb";
import { editSaved, harness, ISSUE, ME, online, openedFeed, PROJECT, TODO, until, type Harness } from "./fake.ts";

const [A, B] = ISSUE;
const FAST = { every: 20, pong: 20, ack: 10, connect: 30, stall: 30, stable: 40 };
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) as DocJSON;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rawDb = (idb: IDBFactory) =>
  new Promise<IDBDatabase>((resolve) => {
    const r = idb.open("rsva:atlas", 1);
    r.onupgradeneeded = () => (r.result.createObjectStore("kv"), r.result.createObjectStore("tx"));
    r.onsuccess = () => resolve(r.result);
  });

const txIds = async (idb: IDBFactory): Promise<string[]> => {
  const db = await rawDb(idb);
  const keys = await new Promise<string[]>((resolve) => {
    const r = db.transaction("tx").objectStore("tx").getAllKeys();
    r.onsuccess = () => resolve(r.result as string[]);
  });
  db.close();
  return keys;
};

/** Online, on short link times; this test answers pings by hand, or not at all. */
async function live(opts: Parameters<typeof online>[0] = {}): Promise<Harness> {
  const h = harness({ link: FAST, ...opts });
  await h.store.start();
  h.socket().hello();
  await until(() => h.socket().frames("sub").length > 0, "sub");
  return h;
}

test("a repeated `hello` leaves one probe timer, and dispose stops it", async () => {
  const made = new Set<ReturnType<typeof setInterval>>();
  const { setInterval: start, clearInterval: stop } = globalThis;
  globalThis.setInterval = ((...args: Parameters<typeof start>) => {
    const timer = start(...args);
    made.add(timer);
    return timer;
  }) as typeof start;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    made.delete(timer);
    stop(timer);
  }) as typeof stop;
  try {
    const h = await live();
    h.socket().hello();
    h.store.dispose();
    assert.equal(made.size, 0);
  } finally {
    globalThis.setInterval = start;
    globalThis.clearInterval = stop;
    made.forEach(stop);
  }
});

test("a quiet connection is asked after `every`; an answer keeps it, silence ends it and a new socket opens", async () => {
  const h = await live();
  const first = h.socket();
  await until(() => first.frames("ping").length === 1, "a ping");
  first.push({ t: "pong" });
  await until(() => first.frames("ping").length === 2, "the next ping");
  assert.equal(h.store.connection, "online");
  await until(() => h.store.connection !== "online", "silence read as a dead link");
  assert.ok(!first.closed || first.onclose === null, "the old socket is left alone: its close could take minutes");
  await until(() => h.sockets.length === 2, "a new socket");
  h.store.dispose();
});

test("a sent change with no answer pings at once instead of waiting for the next round", async () => {
  const h = await live({ link: { ...FAST, every: 60_000 } });
  h.store.updateIssue(A, { title: "edit" });
  await until(() => h.socket().frames("ping").length === 1, "a ping after the ack was overdue");
  assert.equal(h.store.pendingCount, 1);
  h.store.dispose();
});

test("a socket that never says hello is given up on", async () => {
  const h = harness({ link: FAST });
  await h.store.start();
  await until(() => h.sockets.length >= 2, "another try");
  assert.notEqual(h.store.connection, "online");
  h.store.dispose();
});

test("save state: saving, then stalled with no answer even on a live link, then saved; offline says so", async () => {
  const h = await live({ link: { ...FAST, every: 60_000, ack: 60_000 } });
  assert.equal(h.store.saveState, "saved");
  h.store.updateIssue(A, { title: "edit" });
  assert.equal(h.store.saveState, "saving");
  await until(() => h.store.saveState === "stalled", "stalled");
  const [tx] = h.socket().frames("tx");
  h.socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: A, a: "U", d: { title: "edit" } }] });
  h.socket().push({ t: "ack", id: tx!.id, s: 11 });
  assert.equal(h.store.saveState, "saved");
  h.store.updateIssue(B, { title: "offline" });
  h.socket().closeBy(1006);
  assert.equal(h.store.saveState, "offline");
  h.store.dispose();
});

test("rate_limited keeps the change, reports nothing, stops sending, then sends all of it again in order", async () => {
  const h = await live({ link: { ...FAST, every: 60_000, ack: 60_000 } });
  const { store } = h;
  store.updateIssue(A, { title: "one" });
  store.updateIssue(B, { title: "two" });
  const [t1, t2] = h.socket().frames("tx");
  h.socket().push({ t: "rej", id: t1!.id, code: "rate_limited", msg: "too many", wait: 30 });
  h.socket().push({ t: "rej", id: t2!.id, code: "rate_limited", msg: "too many", wait: 30 });
  assert.equal(store.issues.get(A)!.title, "one", "not reverted");
  assert.equal(store.lastRejection, null);
  assert.equal(store.pendingCount, 2);
  store.updateIssue(A, { priority: 1 });
  assert.equal(h.socket().frames("tx").length, 2, "nothing goes out during the wait");
  await until(() => h.socket().frames("tx").length === 5, "the queue again");
  assert.deepEqual(h.socket().frames("tx").slice(2, 4).map((f) => f.id), [t1!.id, t2!.id], "the refused one first");
  store.dispose();
});

test("the longest wait asked for holds: refusals behind the first one come with shorter ones", async () => {
  const h = await live({ link: { ...FAST, every: 60_000, ack: 60_000 } });
  h.store.updateIssue(A, { title: "one" });
  h.store.updateIssue(B, { title: "two" });
  const [t1, t2] = h.socket().frames("tx");
  const refused = Date.now();
  h.socket().push({ t: "rej", id: t1!.id, code: "rate_limited", msg: "too many", wait: 60 });
  h.socket().push({ t: "rej", id: t2!.id, code: "rate_limited", msg: "too many", wait: 1 });
  await until(() => h.socket().frames("tx").length === 4, "the queue again");
  // When it came back, not a look at one moment: on a busy runner a 20 ms sleep outlasted the 60 ms wait (PLNR-220).
  // A slow machine only makes this later; a hold cut to the 1 ms wait comes back within a few ms.
  assert.ok(Date.now() - refused >= 50, `back after ${Date.now() - refused} ms, before the longest wait`);
  h.store.dispose();
});

test("a view or a mark refused for the rate stays unconfirmed and goes again; refused for good it is dropped", async () => {
  const h = await live({ link: { ...FAST, every: 60_000 } });
  const id = "00000000-0000-7000-8000-00000000f001";
  h.store.views.save(id, { name: "Mine" });
  h.socket().push({ t: "rej", id: "view", code: "rate_limited", msg: "too many", wait: 5 });
  await until(() => h.socket().frames("view").length === 2, "the write goes again");
  h.socket().push({ t: "rej", id: "view", code: "invalid", msg: "no" });
  const asked = h.socket().frames("views").length;
  await until(() => h.socket().frames("views").length >= asked, "asked again");
  h.store.views.pin(`view:${id}`, true);
  assert.equal(h.socket().frames("view").length, 3);
  h.socket().push({ t: "rej", id: "mark", code: "rate_limited", msg: "too many", wait: 5 });
  await until(() => h.socket().frames("inbox").length > 1, "marks go again with the inbox request");
  h.store.dispose();
});

test("a change over the frame limit is refused here, with the text kept, and the queue behind it moves", async () => {
  const h = await live();
  const big = doc("я".repeat(MAX_FRAME_BYTES));
  h.store.updateDescription(A, big);
  assert.equal(h.socket().frames("tx").length, 0, "it never reaches the socket");
  assert.equal(h.store.pendingCount, 0);
  assert.equal(h.store.lastRejection?.code, "too_large");
  assert.equal(h.store.lastRejection?.lost[0]?.doc, big);
  h.store.updateIssue(B, { title: "behind it" });
  assert.equal(h.socket().frames("tx").length, 1);
  h.store.dispose();
});

test("the server closing on a frame too big refuses the frame that is, not the first one in line", async () => {
  const idb = new IDBFactory();
  const db = await rawDb(idb);
  const tx = (id: string, n: number, title: string) => ({ id, n, at: `2026-11-01T10:00:0${n}.000Z`, ops: [{ op: "update", m: "Issue", id: A, set: { title } }] });
  await new Promise((resolve) => {
    const t = db.transaction("tx", "readwrite");
    // A queue from before the size was checked: a small change in front of a big one.
    for (const row of [tx("00000000-0000-7000-8000-000000000001", 1, "small"), tx("00000000-0000-7000-8000-000000000002", 2, "x".repeat(MAX_FRAME_BYTES))]) t.objectStore("tx").put(row, row.id);
    t.oncomplete = resolve;
  });
  db.close();
  const h = await live({ idb });
  assert.equal(h.socket().frames("tx").length, 2);
  h.socket().closeBy(CLOSE_TOO_BIG);
  assert.equal(h.store.lastRejection?.code, "too_large");
  assert.equal(h.store.issues.get(A)!.title, "small", "the innocent one stays");
  await until(() => h.sockets.length === 2, "reconnect");
  h.socket().hello();
  assert.deepEqual(h.socket().frames("tx").map((f) => f.id), ["00000000-0000-7000-8000-000000000001"]);
  h.store.dispose();
});

test("a socket that dies right after hello backs off: hello alone is no sign of a working connection", async () => {
  const h = harness({ link: FAST, backoff: [10, 10_000] });
  await h.store.start();
  for (let i = 0; i < 6; i++) {
    const n = h.sockets.length;
    h.socket().hello();
    h.socket().closeBy(1011);
    if (i < 5) await until(() => h.sockets.length === n + 1, `reconnect ${i}`);
  }
  const t0 = performance.now();
  await until(() => h.sockets.length === 7 || performance.now() - t0 > 120, "the seventh try");
  assert.equal(h.sockets.length, 6, "the wait has grown to hundreds of ms");
  h.store.dispose();
});

test("any frame ends the wait for a pong: a slow link is alive as long as something arrives", async () => {
  const h = await live({ link: { ...FAST, every: 15, pong: 15 } });
  const stop = setInterval(() => h.socket().push({ t: "marks", m: [], at: "2026-11-01T10:00:00Z" }), 5);
  await wait(80);
  clearInterval(stop);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.store.connection, "online");
  h.store.dispose();
});

test("a big frame still going up is no dead link; bytes that stop moving are", async () => {
  const h = await live({ link: { ...FAST, every: 60_000, pong: 10 } });
  h.socket().push({ t: "caught-up" });
  const s = h.socket();
  // Fewer bytes at every look, not on a timer of its own: which of two timers a busy machine runs first decided this test,
  // and one run in ten failed under load (PLNR-166).
  let left = 1000;
  let looks = 0;
  let moving = true;
  Object.defineProperty(s, "bufferedAmount", { get: () => (looks++, moving ? (left -= 10) : left) });
  h.store.updateIssue(A, { title: "big" });
  await until(() => s.frames("ping").length === 1, "a ping");
  await until(() => looks > 3, "several timeouts of the pong");
  assert.equal(h.store.connection, "online", "the bytes are moving");
  moving = false;
  await until(() => h.store.connection !== "online", "they stopped");
  h.store.dispose();
});

test("a catch-up gets several waits: it is one frame, and on a slow link the answer comes after it", async () => {
  const h = await live({ link: { ...FAST, every: 5, pong: 20 } });
  await until(() => h.socket().frames("ping").length === 1, "a ping");
  await wait(50);
  assert.equal(h.store.connection, "online", "still catching up");
  await until(() => h.store.connection !== "online", "not for ever");
  h.store.dispose();
});

test("a pong behind the client is no reason to start over: another write may have gone out first", async () => {
  const h = await live({ link: { ...FAST, every: 5 } });
  await until(() => h.socket().frames("ping").length > 0, "a ping");
  h.socket().push({ t: "pong", s: 3 });
  await wait(20);
  assert.equal(h.requests.filter((u) => u.includes("bootstrap")).length, 1);
  h.store.dispose();
});

test("two pongs ahead of the client, with no delta between: it asks for what it missed", async () => {
  const h = await live({ link: { ...FAST, every: 5 } });
  await until(() => h.socket().frames("ping").length === 1, "a ping");
  h.socket().push({ t: "pong", s: 15 });
  assert.equal(h.socket().frames("sub").length, 1, "one pong may simply have overtaken a delta");
  await until(() => h.socket().frames("ping").length === 2, "the next ping");
  h.socket().push({ t: "pong", s: 15 });
  assert.deepEqual(h.socket().frames("sub").at(-1), { t: "sub", ws: "atlas", s: 10 });
  h.store.dispose();
});

test("an action this code cannot apply does not freeze the copy: a new snapshot gets past it", async () => {
  const h = await online();
  const bad = { id: 11, m: "NewModel", mid: A, a: "U", d: {} } as unknown as Action;
  h.socket().push({ t: "d", a: [bad] });
  await until(() => h.requests.filter((u) => u.includes("bootstrap")).length === 2, "a resync");
  h.store.dispose();
});

test("a description names the text it was edited from, and a second save names the first", async () => {
  const { store, socket, feed } = await openedFeed(A, { doc: { id: A, doc: null, updatedAt: "2026-10-27T00:00:00Z", tx: "00000000-0000-7000-8000-00000000aaaa" } });
  assert.equal(feed.status, "ready");
  store.updateDescription(A, doc("one"));
  store.updateDescription(A, doc("two"));
  const [t1, t2] = socket().frames("tx");
  assert.equal((t1!.ops[0] as { base?: string }).base, "00000000-0000-7000-8000-00000000aaaa");
  assert.equal((t2!.ops[0] as { base?: string }).base, t1!.id);
  store.dispose();
});

test("a refused description: the text goes back to theirs and the refusal holds what was typed", async () => {
  const { store, socket } = await openedFeed(A, { doc: { id: A, doc: doc("old") as never, updatedAt: "2026-10-27T00:00:00Z", tx: null } });
  store.updateDescription(A, doc("mine"));
  socket().push({ t: "d", a: [{ id: 11, m: "Document", mid: A, a: "U", d: { issueId: A, doc: doc("theirs"), updatedAt: "2026-10-27T01:00:00Z", tx: "00000000-0000-7000-8000-00000000bbbb" } }] });
  assert.deepEqual(store.description(A)!.doc, doc("mine"), "until the answer, what is being typed stays");
  socket().push({ t: "rej", id: socket().frames("tx")[0]!.id, code: "conflict", msg: "someone else changed the description meanwhile" });
  assert.deepEqual(store.description(A)!.doc, doc("theirs"));
  assert.deepEqual(store.lastRejection?.lost[0]?.doc, doc("mine"));
  assert.equal(store.description(A)!.tx, "00000000-0000-7000-8000-00000000bbbb", "the next save starts from theirs");
  store.dispose();
});

test("offline, description saves that never left replace each other; one that left is not touched", async () => {
  const h = await online();
  const { store } = h;
  store.updateDescription(A, doc("sent"));
  const [sent] = h.socket().frames("tx");
  h.socket().closeBy(1006);
  for (const t of ["a", "b", "c"]) store.updateDescription(A, doc(t));
  store.updateDescription(B, doc("other issue"));
  assert.equal(store.pendingCount, 3, "the sent one, one for all the offline saves of A, one for B");
  await until(() => h.sockets.length === 2, "reconnect");
  h.socket().hello();
  const out = h.socket().frames("tx");
  assert.equal(out[0]!.id, sent!.id);
  assert.deepEqual((out[0]!.ops[0] as { set: { doc: unknown } }).set.doc, doc("sent"), "one that may have reached the server keeps its text");
  assert.deepEqual((out[1]!.ops[0] as { set: { doc: unknown } }).set.doc, doc("c"), "only the last offline text goes");
  store.dispose();
});

test("a save read from the disk may have left: a later one does not replace it", async () => {
  const h = await online();
  h.socket().closeBy(1006);
  h.store.updateDescription(A, doc("one"));
  await h.store.persist();
  h.store.dispose();
  const again = harness({ idb: h.idb });
  await again.store.start();
  again.store.updateDescription(A, doc("two"));
  assert.equal(again.store.pendingCount, 2, "the save from the disk stays as it was");
  again.store.dispose();
});

test("offline saves replaced in the queue take a new id: another tab may hold the old one", async () => {
  const h = await online();
  h.socket().closeBy(1006);
  h.store.updateDescription(A, doc("one"));
  await h.store.persist();
  const before = await txIds(h.idb);
  h.store.updateDescription(A, doc("two"));
  await wait(10);
  const after = await txIds(h.idb);
  assert.equal(after.length, 1);
  assert.notEqual(after[0], before[0]);
  h.store.dispose();
});

test("offline, a save that grows past the frame limit is refused, not queued", async () => {
  const h = await online();
  h.socket().closeBy(1006);
  h.store.updateDescription(A, doc("small"));
  h.store.updateDescription(A, doc("я".repeat(MAX_FRAME_BYTES)));
  assert.equal(h.store.lastRejection?.code, "too_large");
  assert.equal(h.store.pendingCount, 0);
  h.store.dispose();
});

test("a save built on a refused one stands on what that one stood on", async () => {
  const h = await live({ link: { ...FAST, every: 60_000, ack: 60_000 } });
  const { store } = h;
  const old = "00000000-0000-7000-8000-00000000aaaa";
  store.updateDescription(A, doc("one"), old);
  const [t1] = h.socket().frames("tx");
  // A wait the server asked for keeps the second save in the queue, unsent.
  h.socket().push({ t: "rej", id: "view", code: "rate_limited", msg: "too many", wait: 20 });
  store.updateDescription(A, doc("two"));
  assert.equal(h.socket().frames("tx").length, 1);
  h.socket().push({ t: "rej", id: t1!.id, code: "invalid", msg: "no" });
  await until(() => h.socket().frames("tx").length === 2, "the second goes");
  assert.equal((h.socket().frames("tx")[1]!.ops[0] as { base?: string }).base, old);
  store.dispose();
});

test("two lists change at once: every change of a list says what it replaced", async () => {
  const h = await online();
  const other = "00000000-0000-7000-8000-0000000000e1";
  h.store.updateIssue(A, { labelIds: [other], title: "with a label" });
  const [tx] = h.socket().frames("tx");
  assert.deepEqual(tx!.ops[0], { op: "update", m: "Issue", id: A, set: { labelIds: [other], title: "with a label" }, base: { labelIds: [] } });
  h.store.updateIssue(A, { title: "no list" });
  assert.equal("base" in h.socket().frames("tx")[1]!.ops[0]!, false);
  h.store.dispose();
});

test("a refused new issue leaves its title and description with the refusal", async () => {
  const h = await online();
  h.store.createIssue(PROJECT, { title: "Written offline", stateId: TODO }, doc("all this text"));
  h.socket().push({ t: "rej", id: h.socket().frames("tx")[0]!.id, code: "forbidden", msg: "no" });
  assert.equal(h.store.lastRejection?.lost[0]?.text, "Written offline");
  assert.deepEqual(h.store.lastRejection?.lost[0]?.doc, doc("all this text"));
  h.store.dispose();
});

test("several refusals are counted, not overwritten", async () => {
  const h = await online();
  h.store.updateIssue(A, { title: "one" });
  h.store.updateIssue(B, { title: "two" });
  const [t1, t2] = h.socket().frames("tx");
  h.socket().push({ t: "rej", id: t1!.id, code: "bad_ref", msg: "no" });
  h.socket().push({ t: "rej", id: t2!.id, code: "bad_ref", msg: "no" });
  assert.equal(h.store.lastRejection?.count, 2);
  h.store.dispose();
});

test("every refused text stays with the refusal, not only the last", async () => {
  const h = await online();
  h.store.updateDescription(A, doc("first text"));
  h.store.updateDescription(B, doc("second text"));
  const [t1, t2] = h.socket().frames("tx");
  h.socket().push({ t: "rej", id: t1!.id, code: "conflict", msg: "no" });
  h.socket().push({ t: "rej", id: t2!.id, code: "conflict", msg: "no" });
  assert.deepEqual(h.store.lastRejection?.lost.map((l) => l.doc), [doc("first text"), doc("second text")]);
  h.store.dispose();
});

test("losing access says how many unsent changes went with the copy", async () => {
  const h = await online();
  h.store.updateIssue(A, { title: "unsent" });
  h.socket().closeBy(CLOSE_FORBIDDEN);
  assert.match(h.store.lastRejection!.message, /1 unsent changes could not be saved/);
  assert.equal(h.store.pendingCount, 0, "gone, not waiting: nothing promises to send them");
  assert.equal(h.store.saveState, "saved");
  h.store.dispose();
});

test("a queue shared by two tabs comes back in time order: each tab counts its own numbers", async () => {
  const idb = new IDBFactory();
  const db = await rawDb(idb);
  const tx = (id: string, n: number, at: string, title: string) => ({ id, n, at, ops: [{ op: "update", m: "Issue", id: A, set: { title } }] });
  await new Promise((resolve) => {
    const t = db.transaction("tx", "readwrite");
    for (const row of [tx("00000000-0000-7000-8000-000000000001", 50, "2026-11-01T10:00:00.000Z", "older, tab with many"), tx("00000000-0000-7000-8000-000000000002", 1, "2026-11-01T10:00:01.000Z", "newer, new tab")]) t.objectStore("tx").put(row, row.id);
    t.oncomplete = resolve;
  });
  db.close();
  const h = await online({ idb });
  assert.deepEqual(h.socket().frames("tx").map((f) => f.ops[0]!.id && (f.ops[0] as { set: { title: string } }).set.title), ["older, tab with many", "newer, new tab"]);
  assert.equal(h.store.issues.get(A)!.title, "newer, new tab");
  h.store.dispose();
});

test("a local copy that cannot be read is dropped whole: the snapshot does not mix with half of it", async () => {
  const cold = await online();
  await cold.store.persist();
  cold.store.dispose();
  await editSaved(cold.idb, (v) => {
    v.b.push({ m: "Issue", c: ["id"], r: null }); // the last batch breaks after the others went in
    v.b[0].r.push(["00000000-0000-7000-8000-00000000dead", "ghost@x.dev", "Ghost", "human", "owner"]);
    return v;
  });
  const h = harness({ idb: cold.idb });
  await h.store.start();
  assert.equal(h.store.status, "ready");
  assert.equal(h.store.users.has("00000000-0000-7000-8000-00000000dead"), false);
  assert.ok(h.store.users.has(ME));
  h.store.dispose();
});

/** Runs `body` with a `window` to send events to: the engine listens on the global object. */
async function withWindow(body: (events: EventTarget) => Promise<void>): Promise<void> {
  const events = new EventTarget();
  const g = globalThis as unknown as Record<string, unknown>;
  g.addEventListener = events.addEventListener.bind(events);
  g.removeEventListener = events.removeEventListener.bind(events);
  try {
    await body(events);
  } finally {
    delete g.addEventListener;
    delete g.removeEventListener;
  }
}

test("a queue from the disk that gets no answer shows as stalled, with no new change to start the clock", async () => {
  const first = await online();
  first.store.updateIssue(A, { title: "from the disk" });
  await first.store.persist();
  first.store.dispose();
  const h = await live({ idb: first.idb, link: { ...FAST, every: 60_000, ack: 60_000 } });
  assert.equal(h.store.pendingCount, 1);
  await until(() => h.store.saveState === "stalled", "stalled");
  h.store.dispose();
});

test("a write that cannot reach the disk marks the changes unsafe, and the browser asks before the tab closes", () =>
  withWindow(async (events) => {
    const h = await online();
    await h.store.persist();
    await new Promise<void>((resolve) => {
      h.idb.deleteDatabase("rsva:atlas").onsuccess = () => resolve();
    });
    h.store.updateIssue(A, { title: "memory only" });
    await until(() => h.store.unsafe, "unsafe");
    h.store.updateIssue(B, { title: "memory too" });
    await wait(5);
    assert.equal(h.store.unsafe, true, "a later result does not clear it while the first is still only in memory");
    const leave = new Event("beforeunload", { cancelable: true });
    events.dispatchEvent(leave);
    assert.equal(leave.defaultPrevented, true);
    h.store.dispose();
  }));

test("waking up: a live socket is checked at once, one waiting to reconnect stops waiting, offline drops it", () =>
  withWindow(async (events) => {
    const h = await live({ link: { ...FAST, every: 60_000 }, backoff: [60_000, 60_000] });
    events.dispatchEvent(new Event("focus"));
    assert.equal(h.socket().frames("ping").length, 1);
    h.socket().push({ t: "pong" });
    events.dispatchEvent(new Event("offline"));
    assert.equal(h.store.connection, "offline");
    assert.equal(h.sockets.length, 1, "the backoff is a minute");
    events.dispatchEvent(new Event("online"));
    assert.equal(h.sockets.length, 2, "not waited out");
    h.store.dispose();
  }));

test("the panel's numbers: a ping's round trip, how far behind, a change's time to its ack, and none of them after a drop", async () => {
  const h = await live({ link: { ...FAST, every: 60_000, pong: 60_000 } });
  assert.deepEqual(h.store.link, { pingMs: null, saveMs: null, behind: null, drops: 0, lostAt: null });
  h.store.measureLink();
  h.store.measureLink(); // the first is unanswered: no second frame
  assert.equal(h.socket().frames("ping").length, 1);
  await wait(5);
  h.socket().push({ t: "pong", s: h.store.lastSyncId + 3 });
  assert.ok(h.store.link.pingMs! >= 4, "the time from the ping to its pong");
  assert.equal(h.store.link.behind, 3);

  h.store.updateIssue(A, { title: "edit" });
  await wait(5);
  h.socket().push({ t: "ack", id: h.socket().frames("tx")[0]!.id, s: h.store.lastSyncId + 1 });
  assert.ok(h.store.link.saveMs! >= 4, "the time from the change to its ack");

  h.socket().closeBy(1006);
  const { pingMs, saveMs, behind, drops, lostAt } = h.store.link;
  assert.deepEqual({ pingMs, behind, drops }, { pingMs: null, behind: null, drops: 1 });
  assert.ok(lostAt);
  assert.ok(saveMs! >= 4, "the last save time stays: it says how the link was before it went");
  h.store.dispose();
});

test("a pong answers the first ping when two went out, and a failed attempt to connect is not a drop", async () => {
  const h = await live({ link: { ...FAST, every: 60_000, pong: 60_000 } });
  h.store.measureLink();
  await wait(10);
  h.socket().push({ t: "d", a: [] }); // any frame ends the wait, so the next look pings again
  h.store.measureLink();
  assert.equal(h.socket().frames("ping").length, 2);
  h.socket().push({ t: "pong" });
  assert.ok(h.store.link.pingMs! >= 9, "from the first ping, not the second");

  h.socket().closeBy(1006);
  await until(() => h.sockets.length === 2, "a new socket");
  h.socket().closeBy(1006); // never said hello
  assert.equal(h.store.link.drops, 1);
  h.store.dispose();
});
