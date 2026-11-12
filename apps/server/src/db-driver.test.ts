// What patches/postgres@3.4.9.patch is for: a connection reset in the middle of a transaction. Through a small proxy, as
// only a real RST reaches the driver's socket error path; pg_terminate_backend (sync/write.test.ts) closes cleanly.
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import { after, test } from "node:test";
import postgres from "postgres";
import { transient } from "./sync/retry.ts";

const target = new URL(process.env.DATABASE_URL!);
const sockets = new Set<net.Socket>();
let cutTypes = false;
let onClosed = () => {};
const proxy = net.createServer((c) => {
  const up = net.connect(Number(target.port), target.hostname);
  sockets.add(c);
  c.on("data", (d) => {
    if (cutTypes && d.includes("pg_catalog.pg_type")) {
      cutTypes = false;
      return c.resetAndDestroy();
    }
    up.write(d);
  });
  up.pipe(c);
  c.on("error", () => {});
  up.on("error", () => {});
  c.on("close", () => (sockets.delete(c), up.destroy()));
  up.on("close", () => c.destroy());
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
// One connection: the query after the reset has to use the very one that was reset.
const sql = postgres({ host: "127.0.0.1", port: (proxy.address() as AddressInfo).port, user: target.username, pass: target.password, database: target.pathname.slice(1), max: 1, onnotice: () => {}, onclose: () => onClosed() });
after(async () => {
  await sql.end({ timeout: 1 });
  proxy.close();
});

const settled = async <T>(p: Promise<T>, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`${what} never settled`)), 5000)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

test("a reset connection fails its transaction and leaves the pool answering the right queries", async () => {
  await sql`select 1`;
  const reset = sql.begin(async (t) => {
    await t`select 1`;
    setTimeout(() => sockets.forEach((s) => s.resetAndDestroy()), 30);
    await t`select pg_sleep(0.5)`;
  });
  await assert.rejects(settled(reset, "the transaction"), transient, "an error the write pipeline runs again");
  const answer = await settled(
    sql.begin(async (t) => [await t`select 2 as two`, await t`select 3 as three`]),
    "the next transaction",
  );
  assert.deepEqual(answer.map((r) => ({ ...r[0] })), [{ two: 2 }, { three: 3 }]);
  assert.deepEqual([...(await settled(sql`select 4 as four`, "a plain query"))].map((r) => ({ ...r })), [{ four: 4 }]);
});

test("a reset during the driver's own query for types fails one query, not the process", async () => {
  // The driver's own word, not a pause: a busy loop can run a timer before the socket's error, and the query then goes to
  // the old connection and fails there, with the types query never sent.
  const closed = new Promise<void>((done) => (onClosed = done));
  sockets.forEach((s) => s.resetAndDestroy());
  await settled(closed, "the reset connection");
  cutTypes = true;
  await assert.rejects(settled(sql`select 5`, "the first query"), transient);
  assert.equal(cutTypes, false, "the reset came during the query for types");
  assert.deepEqual([...(await settled(sql`select 6 as six`, "the next query"))].map((r) => ({ ...r })), [{ six: 6 }]);
});
