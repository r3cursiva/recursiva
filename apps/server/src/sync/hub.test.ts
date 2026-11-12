import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Action, DeltaFrame } from "@rsva/protocol";
import type { WebSocket } from "ws";
import { db, schema } from "../db.ts";
import "../test/helpers.ts";
import { broadcast, catchUp, prime, sendToUser, subscribe } from "./hub.ts";

const batch = (from: number, n = 1): Action[] => Array.from({ length: n }, (_, i) => ({ id: from + i, m: "Issue", mid: randomUUID(), a: "U", d: { n: from + i } }));

/** Commits actions to the log the way a writer does (here or in another process). */
async function commit(workspaceId: string, actions: Action[]): Promise<Action[]> {
  await db.insert(schema.syncAction).values(actions.map((a) => ({ workspaceId, id: a.id, model: a.m, modelId: a.mid, action: a.a, data: a.d ?? null })));
  return actions;
}

/** A subscriber that records the log numbers it receives and when. */
function listen(workspaceId: string) {
  const ids: number[] = [];
  const ws = { send: (frame: string) => ids.push(...(JSON.parse(frame) as DeltaFrame).a.map((a) => a.id)) } as unknown as WebSocket;
  subscribe(workspaceId, { ws, userId: "u", buffer: null });
  return ids;
}

test("a gap left by another process is filled from the log at once, not after a timeout", async (ctx) => {
  const w = randomUUID();
  const ids = listen(w);
  await prime(w, async () => 0);
  await broadcast(w, await commit(w, batch(1)));
  await commit(w, batch(2, 3)); // another server or the CLI import took 2..4
  const mine = await commit(w, batch(5));
  const t = performance.now();
  await broadcast(w, mine);
  const ms = performance.now() - t;
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  // The old in-memory reorder waited for a 1 s stall timer here.
  assert.ok(ms < 200, `delivered in ${ms} ms`);
  ctx.diagnostic(`gap of 3 filled and delivered in ${ms.toFixed(1)} ms`);
});

test("batches that overtake each other in this process go out in order, each number once", async () => {
  const w = randomUUID();
  const ids = listen(w);
  await prime(w, async () => 0);
  const [b12, b3, b4, b5] = [await commit(w, batch(1, 2)), await commit(w, batch(3)), await commit(w, batch(4)), await commit(w, batch(5))];
  await Promise.all([broadcast(w, b12), broadcast(w, b5), broadcast(w, b4), broadcast(w, b3)]);
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
});

test("after priming, the first batch after a restart does not jump the queue", async () => {
  const w = randomUUID();
  const ids = listen(w);
  await prime(w, async () => 10);
  const [b11, b12] = [await commit(w, batch(11)), await commit(w, batch(12))];
  await broadcast(w, b12);
  await broadcast(w, b11);
  assert.deepEqual(ids, [11, 12]);
});

test("catchUp pushes another process's writes without a local write", async () => {
  const w = randomUUID();
  const ids = listen(w);
  await prime(w, async () => 0);
  await commit(w, batch(1, 2));
  await catchUp(w, 2);
  await catchUp(w, 2);
  assert.deepEqual(ids, [1, 2]);
});

test("a socket that stopped reading is dropped, not fed: the server's memory is not its buffer", () => {
  const w = randomUUID();
  let ended = 0;
  let sent = 0;
  const ws = { bufferedAmount: 2 ** 30, send: () => sent++, terminate: () => ended++ } as unknown as WebSocket;
  subscribe(w, { ws, userId: "u", buffer: null });
  sendToUser(w, "u", "{}");
  assert.deepEqual([sent, ended], [0, 1]);
});
