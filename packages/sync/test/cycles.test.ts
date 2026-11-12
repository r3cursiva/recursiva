// Cycles in the engine (PLNR-63): created at once with a guessed number, completed with the moves after the completion.
import assert from "node:assert/strict";
import { test } from "node:test";
import { completeCycleOps, deleteCycleOps, txChunks, type Op } from "@rsva/protocol";
import { DONE, ISSUE, online, PROJECT } from "./fake.ts";

const [A, B, C] = ISSUE;

test("a new cycle shows at once, numbered after the project's last; the server's echo sets the number", async () => {
  const { store, socket } = await online();
  const c = store.createCycle(PROJECT, { name: "Cycle 1", startDate: "2026-11-02", endDate: "2026-11-15" });
  assert.equal(c.number, 1);
  assert.deepEqual(store.cyclesOf(PROJECT).map((x) => x.name), ["Cycle 1"]);
  const [tx] = socket().frames("tx");
  assert.deepEqual(tx!.ops, [{ op: "create", m: "Cycle", id: c.id, set: { projectId: PROJECT, name: "Cycle 1", startDate: "2026-11-02", endDate: "2026-11-15" } }]);
  socket().push({ t: "d", a: [{ id: 11, m: "Cycle", mid: c.id, a: "I", d: { ...c, number: 7 } }] });
  socket().push({ t: "ack", id: tx!.id, s: 11 });
  assert.equal(store.cycles.get(c.id)!.number, 7);
  store.dispose();
});

test("completing sends the completion first, then moves the open issues not kept; done ones stay", async () => {
  const { store, socket } = await online();
  const cur = store.createCycle(PROJECT, { name: "Now" });
  const next = store.createCycle(PROJECT, { name: "Next" });
  for (const id of [A, B, C]) store.updateIssue(id, { cycleId: cur.id });
  store.updateIssue(A, { stateId: DONE });
  assert.deepEqual(store.issuesInCycle(cur.id).map((i) => i.id).sort(), [A, B, C].sort());
  const before = socket().frames("tx").length;
  store.completeCycle(cur.id, next.id, [C]);
  const tx = socket().frames("tx")[before]!;
  assert.deepEqual(
    tx.ops.map((o: Op) => [o.m, o.id, "set" in o ? Object.keys(o.set) : []]),
    [["Cycle", cur.id, ["completedAt"]], ["Issue", B, ["cycleId"]]],
  );
  assert.deepEqual(store.issuesInCycle(next.id).map((i) => i.id), [B]);
  assert.ok(store.cycles.get(cur.id)!.completedAt, "completed at once, locally");
  store.dispose();
});

test("deleting a cycle takes its issues out first, then the cycle", async () => {
  const { store, socket } = await online();
  const c = store.createCycle(PROJECT, { name: "Gone" });
  store.updateIssue(A, { cycleId: c.id });
  const before = socket().frames("tx").length;
  store.deleteCycle(c.id);
  assert.deepEqual(socket().frames("tx")[before]!.ops.map((o: Op) => `${o.op}:${o.m}`), ["update:Issue", "delete:Cycle"]);
  assert.equal(store.issues.get(A)!.cycleId, null);
  assert.equal(store.cycles.get(c.id), undefined);
  store.dispose();
});

test("a cycle of more issues than a transaction holds: the completion heads the first one, the delete ends the last (RSVA-240)", () => {
  const ids = Array.from({ length: 900 }, (_, i) => `i${i}`);
  const done = txChunks(completeCycleOps("c", ids, "next"), 400);
  assert.deepEqual(done.map((tx) => tx.length), [400, 400, 101]);
  assert.deepEqual([done[0]![0]!.m, done[0]![1]!.id, done[2]!.at(-1)!.id], ["Cycle", "i0", "i899"]);
  const gone = txChunks(deleteCycleOps("c", ids), 400);
  assert.deepEqual(gone.map((tx) => tx.length), [400, 400, 101]);
  assert.deepEqual(gone.at(-1)!.at(-1), { op: "delete", m: "Cycle", id: "c" });
});
