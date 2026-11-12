import assert from "node:assert/strict";
import { test } from "node:test";
import { txChunks, type Action, type Op, type SnapshotLine } from "@rsva/protocol";
import { DONE, ISSUE, online, PROJECT, reopened, snapshot, TODO, until, WS } from "./fake.ts";

const [A, B, C] = ISSUE;
const BUG = "00000000-0000-7000-8000-0000000000e1";

test("a renamed project is found by its old keys too; archive hides it from the list", async () => {
  const { store, socket } = await online();
  assert.equal(store.projectByKey("PLN")?.id, PROJECT, "a former key from the snapshot");
  store.updateProject(PROJECT, { key: "PL" });
  assert.equal(store.projectByKey("PL")?.id, PROJECT);
  assert.equal(store.issueKey(store.issues.get(A)!), "PL-1");
  const [tx] = socket().frames("tx");
  socket().push({ t: "d", a: [{ id: 11, m: "Project", mid: PROJECT, a: "U", d: { key: "PL", formerKeys: ["PLN", "PLANE"] } }] });
  socket().push({ t: "ack", id: tx!.id, s: 11 });
  assert.equal(store.projectByKey("PLANE")?.key, "PL", "the old key leads to the project");
  assert.equal(store.issueByKey("PLANE-2")?.id, B);

  store.updateProject(PROJECT, { archivedAt: "2026-10-28T00:00:00Z" });
  assert.deepEqual(store.projectList(), []);
  assert.deepEqual(store.archivedProjects().map((p) => p.id), [PROJECT]);
  store.updateProject(PROJECT, { archivedAt: "2026-10-29T00:00:00Z" }); // already archived: nothing sent
  assert.equal(socket().frames("tx").length, 2);
  store.dispose();
});

test("a new project shows at once with its states, all in one transaction; a rejection takes it all back", async () => {
  const { store, socket } = await online();
  const p = store.createProject({ name: "  New   site ", key: "SITE", color: "teal" });
  assert.deepEqual([p.name, p.key, p.color, p.issueCounter, p.archivedAt], ["New site", "SITE", "teal", 0, null]);
  assert.equal(store.projectByKey("SITE")?.id, p.id);
  assert.ok(store.projectList().some((x) => x.id === p.id));
  assert.deepEqual(store.statesOf(p.id).map((s) => [s.name, s.group, s.isDefault]), [
    ["Backlog", "backlog", true],
    ["Todo", "unstarted", false],
    ["In Progress", "started", false],
    ["Done", "completed", false],
    ["Cancelled", "cancelled", false],
  ]);
  const [tx] = socket().frames("tx");
  assert.deepEqual(tx!.ops.map((o: Op) => `${o.op}:${o.m}`), ["create:Project", ...Array(5).fill("create:WorkflowState")], "one transaction");
  assert.deepEqual(tx!.ops[0], { op: "create", m: "Project", id: p.id, set: { name: "New site", key: "SITE", color: "teal" } });

  socket().push({ t: "rej", id: tx!.id, code: "conflict", msg: "project SITE exists" });
  assert.equal(store.projects.get(p.id), undefined);
  assert.equal(store.statesOf(p.id).length, 0);
  store.dispose();
});

test("moving the default sends the old one off and the new one on, in one transaction", async () => {
  const { store, socket } = await online();
  store.updateState(DONE, { isDefault: true });
  assert.deepEqual(store.statesOf(PROJECT).map((s) => [s.name, s.isDefault]), [["Todo", false], ["Done", true]]);
  assert.deepEqual(socket().frames("tx")[0]!.ops, [
    { op: "update", m: "WorkflowState", id: TODO, set: { isDefault: false } },
    { op: "update", m: "WorkflowState", id: DONE, set: { isDefault: true } },
  ]);
  store.updateState(DONE, { isDefault: false }); // switching a default off is not a move
  assert.equal(socket().frames("tx").length, 1);
  store.dispose();
});

test("deleting a state moves its issues first; a rejection brings the state and the issues back", async () => {
  const { store, socket } = await online();
  store.deleteState(TODO, DONE);
  assert.deepEqual(store.statesOf(PROJECT).map((s) => [s.name, s.isDefault]), [["Done", true]]);
  for (const id of [A, B, C]) assert.equal(store.issues.get(id)!.stateId, DONE);
  const [tx] = socket().frames("tx");
  assert.deepEqual(
    tx!.ops.map((o: Op) => `${o.op}:${o.m}`),
    ["update:Issue", "update:Issue", "update:Issue", "update:WorkflowState", "delete:WorkflowState"],
  );
  socket().push({ t: "rej", id: tx!.id, code: "bad_ref", msg: "no" });
  assert.deepEqual(store.statesOf(PROJECT).map((s) => [s.name, s.isDefault]), [["Todo", true], ["Done", false]]);
  for (const id of [A, B, C]) assert.equal(store.issues.get(id)!.stateId, TODO);
  store.dispose();
});

test("a pending state removal is kept in the saved copy: after a reload, a rejection still restores it", async () => {
  const h = await online();
  const s = h.store.createState(PROJECT, "Review", "started");
  const [create] = h.socket().frames("tx");
  const row = { id: s.id, projectId: PROJECT, name: "Review", group: "started", color: "#F59E0B", position: s.position, isDefault: false };
  h.socket().push({ t: "d", a: [{ id: 11, m: "WorkflowState", mid: s.id, a: "I", d: row } satisfies Action] });
  h.socket().push({ t: "ack", id: create!.id, s: 11 });
  h.store.deleteState(s.id, TODO);
  assert.equal(h.store.states.get(s.id), undefined);
  const again = await reopened(h);
  assert.equal(again.store.states.get(s.id), undefined, "the queued removal is replayed over the saved copy");
  again.socket().hello();
  await until(() => again.socket().frames("tx").length > 0, "the queue is sent again");
  const [del] = again.socket().frames("tx");
  again.socket().push({ t: "rej", id: del!.id, code: "bad_ref", msg: "no" });
  assert.equal(again.store.states.get(s.id)?.name, "Review");
  again.store.dispose();
});

test("deleting a label takes it off issues and lifts labels inside it", async () => {
  const { store, socket } = await online();
  const child = store.createLabel(PROJECT, "frontend", "#00ff00");
  store.updateLabel(child.id, { parentId: BUG });
  store.updateIssue(A, { labelIds: [BUG, child.id] });
  store.deleteLabel(BUG);
  assert.deepEqual(store.issues.get(A)!.labelIds, [child.id]);
  assert.equal(store.labels.get(child.id)!.parentId, null);
  assert.equal(store.labels.get(BUG), undefined);
  assert.deepEqual(
    socket().frames("tx").at(-1)!.ops.map((o: Op) => `${o.op}:${o.m}`),
    ["update:Issue", "update:Label", "delete:Label"],
  );
  store.dispose();
});

test("a local copy saved without the project's newer fields still opens, and keeps them once they arrive", async () => {
  // A snapshot of the current protocol whose Project batch lacks color and formerKeys (a half-updated dev server).
  const serve = snapshot(10).map((l) =>
    l.t === "b" && l.m === "Project" ? { ...l, c: ["id", "key", "name", "issueCounter", "createdAt", "archivedAt"], r: [[PROJECT, "PLANE", "Plane", 3, "2026-10-27T00:00:00Z", null]] } : l,
  );
  const h = await online({ serve });
  assert.equal(h.store.projectByKey("PLANE")?.id, PROJECT);
  assert.deepEqual(h.store.projects.get(PROJECT)!.formerKeys, []);
  h.socket().push({ t: "d", a: [{ id: 11, m: "Project", mid: PROJECT, a: "U", d: { color: "teal" } }] });
  const again = await reopened(h);
  assert.equal(again.store.projects.get(PROJECT)!.color, "teal", "the field is in the saved copy now");
  assert.equal(again.store.projectByKey("PLANE")?.id, PROJECT);
  again.store.dispose();
});

test("a workspace rename shows at once, goes alone in its transaction and is reverted when refused", async () => {
  const { store, socket } = await online();
  store.updateWorkspace({ name: "Atlas", color: "teal" }); // the name is unchanged: only the color is sent
  assert.equal(store.workspace?.color, "teal");
  const [tx] = socket().frames("tx");
  assert.deepEqual(tx!.ops, [{ op: "update", m: "Workspace", id: WS.id, set: { color: "teal" } }]);
  socket().push({ t: "rej", id: tx!.id, code: "forbidden", msg: "a member cannot change Workspace" });
  assert.equal(store.workspace?.color, null, "back to the server's value");

  store.updateWorkspace({ name: "Beacon" });
  // Someone else changes the color meanwhile: their value shows, the pending name stays on top.
  socket().push({ t: "d", a: [{ id: 11, m: "Workspace", mid: WS.id, a: "U", d: { color: "umber" } }] });
  assert.deepEqual([store.workspace?.name, store.workspace?.color], ["Beacon", "umber"]);
  store.dispose();
});

test("the saved copy keeps the server's workspace and the queue replays a pending rename over it", async () => {
  const h = await online();
  h.socket().push({ t: "d", a: [{ id: 11, m: "Workspace", mid: WS.id, a: "U", d: { color: "indigo" } }] });
  h.store.updateWorkspace({ name: "Renamed" });
  const again = await reopened(h);
  assert.deepEqual([again.store.workspace?.name, again.store.workspace?.color], ["Renamed", "indigo"]);
  again.socket().hello();
  await until(() => again.socket().frames("tx").length > 0, "the queue is sent again");
  const [tx] = again.socket().frames("tx");
  again.socket().push({ t: "rej", id: tx!.id, code: "invalid", msg: "no" });
  assert.equal(again.store.workspace?.name, "Atlas", "the saved copy held the server's name, not the pending one");
  again.store.dispose();
});

test("a local copy saved before the workspace had a color opens with none", async () => {
  const serve = snapshot(10).map((l) => (l.t === "meta" ? { ...l, ws: { id: WS.id, slug: WS.slug, name: WS.name } } : l)) as SnapshotLine[];
  const h = await online({ serve });
  assert.equal(h.store.workspace?.color, null);
  h.store.dispose();
});

test("a big change is split under the server's limit: `first` over as many transactions as it takes, `last` with its end", () => {
  const ops = (n: number, tag: string) => Array.from({ length: n }, (_, i): Op => ({ op: "delete", m: "Label", id: `${tag}${i}` }));
  const sizes = (first: number, last: number) => txChunks({ first: ops(first, "first"), last: ops(last, "last") }, 500).map((tx) => tx.length);
  assert.deepEqual(sizes(499, 1), [500]);
  assert.deepEqual(sizes(500, 1), [500, 1]);
  assert.deepEqual(sizes(1001, 2), [500, 500, 3]);
  assert.deepEqual(sizes(0, 1), [1]);
  const [one, two] = txChunks({ first: ops(500, "first"), last: ops(1, "last") }, 500);
  assert.deepEqual([one!.at(-1)!.id, two!.map((o) => o.id)], ["first499", ["last0"]], "in order, the last ops at the end");
});
