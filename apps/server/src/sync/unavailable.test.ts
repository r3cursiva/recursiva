// A database that stays down past the write pipeline's retries (retry.ts): what the caller is told, so nothing is lost.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CLOSE_TRY_AGAIN } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { asUser, Client, delay, ORIGIN, serverWithIssue, type ServerWithIssue } from "../test/helpers.ts";

let s: ServerWithIssue;
before(async () => {
  s = await serverWithIssue();
});
after(() => s.server.close());

/** How drizzle reports a deadlock: its own error, the driver's in `cause`. */
const deadlock = () => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }) });

const subscribed = async () => {
  const c = await Client.open(s.server.url, await asUser(s.ws.ownerId));
  await c.subscribe(s.ws);
  await delay(100); // the subscribe is read first
  return c;
};
const priority = (priority: number) => ({ op: "update", m: "Issue", id: s.refs.issue.id, set: { priority } });
/** The close code; a socket that stays open fails the test instead of hanging it. */
const closing = (c: Client) =>
  Promise.race([new Promise<number>((resolve) => c.ws.once("close", resolve)), delay(5000).then(() => assert.fail("the socket stayed open"))]);

test("the agent API answers 503 with retry-after, not 500", async (t) => {
  t.mock.method(db, "transaction", () => Promise.reject(deadlock()));
  const key = `${s.refs.project.key}-${s.refs.issue.number}`;
  const r = await s.agent(`${s.server.url}/api/v1/workspaces/${s.ws.slug}/issues/${key}`, { method: "PATCH", body: JSON.stringify({ priority: "high" }), headers: { "content-type": "application/json", origin: ORIGIN } });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "1");
  assert.equal(((await r.json()) as { error: string }).error, "unavailable");
});

test("the socket closes to have the write sent again, and does not reject it", async (t) => {
  const c = await subscribed();
  t.mock.method(db, "transaction", () => Promise.reject(deadlock()));
  const closed = closing(c);
  c.send({ t: "tx", id: randomUUID(), ops: [priority(3)] });
  assert.equal(await closed, CLOSE_TRY_AGAIN);
  assert.deepEqual(c.frames.filter((f) => f.t === "rej"), []);
});

test("a frame queued behind that close is not applied: the client sends both again, in order", async (t) => {
  const c = await subscribed();
  const real = db.transaction.bind(db);
  let runs = 0;
  t.mock.method(db, "transaction", (...args: Parameters<typeof db.transaction>) => (++runs <= 3 ? Promise.reject(deadlock()) : real(...args)));
  const closed = closing(c);
  const newer = randomUUID();
  c.send({ t: "tx", id: randomUUID(), ops: [priority(1)] });
  c.send({ t: "tx", id: newer, ops: [priority(2)] });
  assert.equal(await closed, CLOSE_TRY_AGAIN);
  await delay(100);
  assert.deepEqual(await db.select().from(schema.appliedTx).where(eq(schema.appliedTx.txId, newer)), []);
});
