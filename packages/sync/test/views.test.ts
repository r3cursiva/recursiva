import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedView, ViewFields } from "@rsva/protocol";
import { IDBObjectStore } from "fake-indexeddb";
import { Views } from "../src/views.ts";
import { ME, online, PROJECT, until } from "./fake.ts";

const OTHER = "00000000-0000-7000-8000-0000000000a2";
const vid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const pin = (n: number) => `view:${vid(n)}` as const;
const fields: ViewFields = { name: "Review", icon: "eye", query: 'project:PLNR state:"In Review"', display: {}, layout: "list", shared: false, tab: true, position: 1 };
const view = (n: number, over: Partial<SavedView> = {}): SavedView => ({
  id: vid(n),
  ownerId: ME,
  createdAt: `2026-10-30 10:0${n}:00+00`,
  updatedAt: `2026-10-30 10:0${n}:00+00`,
  ...fields,
  ...over,
});

test("views come whole once, then by change; a write shows at once and settles on its echo", async () => {
  const { store, socket } = await online();
  assert.deepEqual(socket().frames("views"), [{ t: "views" }]);
  assert.equal(store.views.status, "loading");
  socket().push({ t: "views", full: true, v: [view(2), view(1, { ownerId: OTHER, shared: true })], gone: [], p: [[vid(1), true]], s: [pin(1)], at: "2026-10-30 10:02:00+00" });
  assert.deepEqual(store.views.list.map((v) => v.id), [vid(1), vid(2)], "oldest first");
  assert.equal(store.views.pinned(pin(1)), true);

  store.views.save(vid(3), { ...fields, name: "Mine" });
  store.views.pin(pin(2), true);
  assert.equal(store.views.get(vid(3))?.name, "Mine");
  assert.deepEqual(store.views.pins, [pin(1), pin(2)], "a new pin goes last");
  assert.deepEqual(socket().frames("view").map((f) => f.t === "view" && f.w), [
    { op: "save", id: vid(3), set: { ...fields, name: "Mine" } },
    { op: "pins", refs: [pin(1), pin(2)] },
  ]);
  assert.equal(store.unconfirmedOutbox, true, "a reload for a new version waits for the echoes (PLNR-261)");

  // Someone else's rename of the shared one arrives meanwhile; then our echoes.
  socket().push({ t: "views", v: [view(1, { ownerId: OTHER, shared: true, name: "Renamed" })], gone: [], p: [], at: "2026-10-30 10:03:00+00" });
  assert.equal(store.views.get(vid(1))?.name, "Renamed");
  assert.equal(store.views.get(vid(3))?.name, "Mine", "still in flight");
  socket().push({ t: "views", v: [view(3, { name: "Mine" })], gone: [], p: [], at: "2026-10-30 10:04:00+00" });
  socket().push({ t: "views", v: [], gone: [], p: [], s: [pin(1), pin(2)], at: "2026-10-30 10:05:00+00" });
  assert.equal(store.views.pinned(pin(2)), true);
  assert.equal(store.unconfirmedOutbox, false);

  store.views.remove(vid(3));
  assert.equal(store.views.get(vid(3)), undefined, "gone at once");
  socket().push({ t: "rej", id: "view", code: "invalid", msg: "no such view" });
  assert.deepEqual(socket().frames("views").at(-1), { t: "views" }, "a refusal asks for everything again");
  socket().push({ t: "views", full: true, v: [view(3)], gone: [], p: [], at: "2026-10-30 10:06:00+00" });
  assert.ok(store.views.get(vid(3)), "back as the server has it");
  store.dispose();
});

test("a warm start shows the saved views and asks only for changes; unconfirmed writes go again", async () => {
  const h = await online();
  h.socket().push({ t: "views", full: true, v: [view(1)], gone: [], p: [], at: "2026-10-30 10:01:00+00" });
  h.store.views.save(vid(1), { name: "Offline rename" });
  await h.store.persist();
  h.store.dispose();

  const warm = await online({ idb: h.idb });
  assert.equal(warm.store.views.status, "ready", "from IndexedDB, before any answer");
  assert.equal(warm.store.views.get(vid(1))?.name, "Offline rename");
  await until(() => warm.socket().frames("views").length > 0, "views request");
  assert.deepEqual(warm.socket().frames("views"), [{ t: "views", at: "2026-10-30 10:01:00+00" }]);
  assert.deepEqual(warm.socket().frames("view"), [{ t: "view", w: { op: "save", id: vid(1), set: { name: "Offline rename" } } }]);
  warm.store.dispose();
});

test("an unechoed write on top of a failed snapshot write is only in memory: a reload loses it (PLNR-261)", async () => {
  const h = await online();
  h.socket().push({ t: "views", full: true, v: [view(1)], gone: [], p: [], at: "2026-10-30 10:01:00+00" });
  const put = IDBObjectStore.prototype.put;
  let failed = 0;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (key !== "snapshot") return put.call(this, value, key);
    failed++;
    throw new DOMException("The quota has been exceeded", "QuotaExceededError");
  };
  try {
    h.store.views.pin(pin(1), true);
    await until(() => failed > 0, "the snapshot write");
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  assert.equal(h.store.pendingCount, 0, "not an issue change: the old hold saw nothing to lose");
  assert.equal(h.store.unconfirmedOutbox, true);

  // Reloaded now, the pin is gone: nothing on disk sends it again.
  h.store.dispose();
  const warm = await online({ idb: h.idb });
  assert.equal(warm.store.views.pinned(pin(1)), false);
  assert.deepEqual(warm.socket().frames("view"), []);
  warm.store.dispose();
});

test("the viewer's order of projects: at once, on its echo, from any window, kept for a warm start", async () => {
  const h = await online();
  const { store, socket } = h;
  const keys = () => store.projectList().map((p) => p.key);
  const added = [vid(21), vid(22)];
  socket().push({
    t: "d",
    a: added.map((mid, i) => ({ id: 11 + i, m: "Project" as const, mid, a: "I" as const, d: { id: mid, key: `Z${i}`, name: `Z${i}`, color: null, formerKeys: [], issueCounter: 0, createdAt: "2026-10-27T00:00:00Z", archivedAt: null } })),
  });
  socket().push({ t: "views", full: true, v: [], gone: [], p: [], o: [], at: "2026-10-30 10:00:00+00" });
  assert.deepEqual(keys(), ["PLANE", "Z0", "Z1"], "by key with no order");

  store.moveProject(vid(21), 99);
  assert.deepEqual(keys(), ["PLANE", "Z1", "Z0"], "at once");
  store.moveProject(PROJECT, -1);
  assert.equal(socket().frames("view").length, 1, "already first: nothing to write");
  store.moveProject(vid(21), 0);
  assert.deepEqual(keys(), ["Z0", "PLANE", "Z1"]);
  const sent = socket().frames("view").map((f) => (f.t === "view" && f.w.op === "order" ? f.w.ids : null));
  assert.deepEqual(sent, [[PROJECT, vid(22), vid(21)], [vid(21), PROJECT, vid(22)]]);

  socket().push({ t: "views", full: true, v: [], gone: [], p: [], o: [], at: "2026-10-30 10:01:00+00" });
  assert.deepEqual(keys(), ["Z0", "PLANE", "Z1"], "a whole frame answers a request, not the writes in flight");
  socket().push({ t: "views", v: [], gone: [], p: [], o: sent[0]!, at: "2026-10-30 10:02:00+00" });
  assert.deepEqual(keys(), ["Z0", "PLANE", "Z1"], "the first echo: the second write is still in flight");
  socket().push({ t: "views", v: [], gone: [], p: [], o: sent[1]!, at: "2026-10-30 10:03:00+00" });
  assert.deepEqual(keys(), ["Z0", "PLANE", "Z1"]);

  socket().push({ t: "views", v: [], gone: [], p: [], o: [vid(22), PROJECT, vid(21)], at: "2026-10-30 10:04:00+00" });
  assert.deepEqual(keys(), ["Z1", "PLANE", "Z0"], "moved in another window");

  store.moveProject(PROJECT, 0);
  await store.persist();
  store.dispose();
  const warm = await online({ idb: h.idb });
  assert.deepEqual(warm.store.views.projectOrder, [PROJECT, vid(22), vid(21)], "before any answer, the unconfirmed move too");
  await until(() => warm.socket().frames("view").length > 0, "the move goes again");
  warm.store.dispose();
});

test("pins and hidden projects: whole lists, at once, each settled by the echo of its own list (PLNR-292)", async () => {
  const { store, socket } = await online();
  const issue = `issue:${vid(31)}` as const;
  socket().push({ t: "views", full: true, v: [view(1)], gone: [], p: [], o: [], s: [pin(1)], h: [], at: "2026-10-30 10:00:00+00" });
  store.views.pin(issue, true);
  store.views.pin(issue, true);
  store.views.hideProject(PROJECT, true);
  store.views.setPins([issue, pin(1)]);
  assert.deepEqual(store.views.pins, [issue, pin(1)], "moved at once");
  assert.deepEqual(store.views.hiddenProjects, [PROJECT]);
  assert.deepEqual(
    socket().frames("view").map((f) => f.t === "view" && f.w),
    [
      { op: "pins", refs: [pin(1), issue] },
      { op: "hidden", ids: [PROJECT] },
      { op: "pins", refs: [issue, pin(1)] },
    ],
    "pinning what is pinned writes nothing",
  );
  // The hidden list's echo answers only the hidden write: the pins stay as the viewer last set them.
  socket().push({ t: "views", v: [], gone: [], p: [], h: [PROJECT], at: "2026-10-30 10:01:00+00" });
  socket().push({ t: "views", v: [], gone: [], p: [], s: [pin(1), issue], at: "2026-10-30 10:02:00+00" });
  assert.deepEqual(store.views.pins, [issue, pin(1)], "the second pins write is still in flight");
  socket().push({ t: "views", v: [], gone: [], p: [], s: [issue, pin(1)], at: "2026-10-30 10:03:00+00" });
  assert.equal(store.unconfirmedOutbox, false);
  store.views.movePin(issue, undefined);
  store.views.movePin(issue, undefined);
  assert.deepEqual(store.views.pins, [pin(1), issue], "dropped last; dropped where it is writes nothing");
  assert.equal(socket().frames("view").length, 4);
  store.views.hideProject(PROJECT, false);
  assert.deepEqual(store.views.hiddenProjects, []);
  store.dispose();
});

test("a copy saved before PLNR-292 keeps its pinned views as pins", () => {
  const views = new Views(() => ME, () => {}, () => {});
  views.load({ v: [view(1), view(2)], p: [[vid(1), true], [vid(2), false]], at: null, w: [] });
  assert.deepEqual(views.pins, [pin(1)]);
  assert.deepEqual(views.hiddenProjects, []);
});

test("projects' homes travel as views but are kept apart from them (ADR 0053)", async () => {
  const { store, socket } = await online();
  const home = view(3, { name: "Home", layout: "home", tab: false, shared: true, display: { widgets: [] } });
  socket().push({ t: "views", full: true, v: [view(1), home], gone: [], p: [], at: "2026-10-30 10:03:00+00" });
  assert.deepEqual(store.views.list.map((v) => v.id), [vid(1)], "a home is no view of the list, the palette or the views page");
  assert.deepEqual(store.views.homes.map((v) => v.id), [vid(3)]);
  assert.equal(store.views.get(vid(3))?.layout, "home");
});
