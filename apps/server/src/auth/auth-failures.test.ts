// Wrong credentials cost the database a read each; an address that keeps sending them is refused before the read
// (actor.ts, authenticateFrom), over HTTP and WebSocket alike. Its own file: the limit is per process and the flood would
// hold back the other tests.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { asToken, asUser, Client, importFixture, startServer, type Fixture } from "../test/helpers.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
before(async () => {
  [server, ws] = await Promise.all([startServer(), importFixture()]);
});
after(() => server.close());

/** The status a refused WebSocket upgrade answered with; 101 when it opened. */
const upgrade = (headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const s = new WebSocket(`${server.url.replace(/^http/, "ws")}/ws`, { headers });
    s.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    s.once("open", () => (s.close(), resolve(101)));
    s.once("error", reject);
  });

test("a flood of wrong credentials from one address is refused with 429, over HTTP and WebSocket; only its kind of credential is", async () => {
  const url = `${server.url}/sync/workspaces`;
  // No credential (the sign-in screen's state) is a plain 401, counted against nobody; nor are cookies of no session.
  for (let i = 0; i < 310; i += 62) await Promise.all(Array.from({ length: 62 }, () => fetch(url, { headers: { cookie: "theme=dark" } })));
  assert.equal((await fetch(url)).status, 401);
  const wrong = (n: number) => fetch(url, { headers: { authorization: `Bearer rsva_${n.toString().padStart(43, "0")}` } });
  // The same wrong secret again hits the cache of misses, not the database, and still counts.
  assert.equal((await wrong(1)).status, 401);
  assert.equal((await wrong(1)).status, 401);
  for (let i = 0; i < 300; i += 50) await Promise.all(Array.from({ length: 50 }, (_, j) => wrong(i + j)));
  const over = await wrong(999);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  // For the window no token from the address is looked up, a right one either: the price of stopping the flood.
  assert.equal((await fetch(url, { headers: await asToken(ws.workspaceId, ws.ownerId) })).status, 429);
  // The WebSocket is behind the same count: refused before the upgrade.
  assert.equal(await upgrade({ authorization: "Bearer rsva_" + "9".repeat(43) }), 429);
  // A cookie or a terminal's session is another kind: agents with revoked tokens do not lock the owner's browser out.
  const cookie = await asUser(ws.ownerId);
  assert.equal((await fetch(url, { headers: cookie })).status, 200);
  const c = await Client.open(server.url, cookie);
  c.ws.close();
});
