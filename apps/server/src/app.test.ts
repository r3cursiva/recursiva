import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { IssueHistory, WorkspaceListItem } from "@rsva/protocol";
import { SERVER_PATHS } from "@rsva/schema/models";
import { buildApp } from "./app.ts";
import { addMember, asUser, fetchAs, importFixture, issueWithRefs, limited, startServer, type Fixture } from "./test/helpers.ts";
import { snapshotCacheStats } from "./sync/snapshot-cache.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
let owner: typeof fetch;
before(async () => {
  [server, ws] = await Promise.all([startServer(), importFixture()]);
  owner = fetchAs(await asUser(ws.ownerId));
});
after(() => server.close());

test("GET /sync/history: 404 for a malformed or unknown id; the description comes with the history", async () => {
  assert.equal((await owner(`${server.url}/sync/history/not-a-uuid`)).status, 404);
  assert.equal((await owner(`${server.url}/sync/history/${randomUUID()}`)).status, 404);
  const { issue } = await issueWithRefs(ws.workspaceId);
  const r = await owner(`${server.url}/sync/history/${issue.id}`);
  assert.equal(r.status, 200);
  const h = (await r.json()) as IssueHistory;
  assert.equal(h.doc?.id, issue.id);
  assert.equal(h.doc?.doc?.type, "doc");
});

test("POST /sync/feeds: over 1 KB it comes compressed as asked, with q=0 honoured (the one compression hook, PLNR-409)", async () => {
  const get = (accept: string) => owner(`${server.url}/sync/feeds?ws=${ws.slug}`, { method: "POST", headers: { "accept-encoding": accept, "content-type": "application/json" }, body: "{}" });
  const plain = await (await get("identity")).text();
  assert.ok(plain.length > 1024, `${plain.length} B is too small to prove compression`);
  const br = await get("br, gzip");
  assert.equal(br.headers.get("content-encoding"), "br");
  assert.equal(br.headers.get("vary"), "accept-encoding");
  assert.equal(await br.text(), plain);
  assert.equal((await get("br;q=0, gzip")).headers.get("content-encoding"), "gzip");
  assert.equal((await get("br;q=0")).headers.get("content-encoding"), null);
});

test("GET /sync/bootstrap: 404 for an unknown workspace, NDJSON from meta to end, the viewer in headers", async () => {
  assert.equal((await owner(`${server.url}/sync/bootstrap?ws=no-such-workspace`)).status, 404);
  const r = await owner(`${server.url}/sync/bootstrap?ws=${ws.slug}&project=CORE`, { headers: { "accept-encoding": "br" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-encoding"), "br");
  assert.equal(r.headers.get("x-rsva-me"), ws.ownerId);
  assert.equal(r.headers.get("x-rsva-role"), "owner");
  // Their own settings too (PLNR-210): the defaults, and no zone header while they have none.
  assert.equal(r.headers.get("x-rsva-week-start"), "1");
  assert.equal(r.headers.get("x-rsva-time-zone"), null);
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as { t: string });
  assert.equal(lines[0]!.t, "meta");
  assert.equal(lines.at(-1)!.t, "end");
});

test("GET /sync/bootstrap without brotli is the cached snapshot too, the same NDJSON, not a new read of the workspace", async () => {
  const bootstrap = (accept: string) => owner(`${server.url}/sync/bootstrap?ws=${ws.slug}&project=CORE`, { headers: { "accept-encoding": accept } });
  // fetch decodes the body as its content-encoding says.
  const br = await bootstrap("br");
  assert.equal(br.headers.get("content-encoding"), "br");
  const text = await br.text();
  const { builds, hits } = snapshotCacheStats;
  for (const accept of ["identity", "gzip"]) {
    const r = await bootstrap(accept);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-encoding"), accept === "gzip" ? "gzip" : null);
    assert.equal(await r.text(), text);
  }
  assert.deepEqual([snapshotCacheStats.builds, snapshotCacheStats.hits], [builds, hits + 2]);
});

test("GET /sync/bootstrap is held to a budget per person: past a minute's worth, 429 with retry-after", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const m = await addMember(ws.workspaceId, "member");
  const member = fetchAs(await asUser(m.id));
  const bootstrap = () => member(`${server.url}/sync/bootstrap?ws=${ws.slug}`, { headers: { "accept-encoding": "br" } });
  for (let i = 0; i < 60; i++) {
    const r = await bootstrap();
    assert.equal(r.status, 200, `request ${i + 1}`);
    await r.arrayBuffer();
  }
  await limited(await bootstrap());
  // Someone else's budget is their own.
  assert.equal((await owner(`${server.url}/sync/bootstrap?ws=${ws.slug}`, { headers: { "accept-encoding": "br" } })).status, 200);
});

test("GET /sync/workspaces: the viewer's workspaces with their role and member count", async () => {
  const list = (await (await owner(`${server.url}/sync/workspaces`)).json()) as WorkspaceListItem[];
  const mine = list.find((w) => w.slug === ws.slug);
  assert.ok(mine);
  assert.equal(mine.role, "owner");
  assert.ok(mine.members > 0);
});

test("close() returns while a WebSocket client is connected", async () => {
  const { WebSocket } = await import("ws");
  const app = buildApp({ logLevel: "silent", mailer: async () => {} });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as import("node:net").AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: await asUser(ws.ownerId) });
  await new Promise((r) => socket.once("open", r));
  const closed = await Promise.race([app.close().then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  assert.equal(closed, true, "app.close() hung with an open socket");
});

test("every route the server registers starts with a SERVER_PATHS segment, or the Service Worker serves the shell for it (RSVA-619)", async () => {
  // Fastify announces each new instance on this channel inside its constructor: the hook is in before buildApp adds a route.
  const urls: string[] = [];
  const onInit = (msg: unknown) => (msg as { fastify: FastifyInstance }).fastify.addHook("onRoute", (r) => void urls.push(r.url));
  subscribe("fastify.initialization", onInit);
  let app: FastifyInstance;
  try {
    app = buildApp({ logLevel: "silent", mailer: async () => {} });
  } finally {
    unsubscribe("fastify.initialization", onInit);
  }
  // Routes of plugins (the notify ones among them) are added when the instance loads them.
  await app.ready();
  await app.close();
  assert.ok(urls.length > 50, `${urls.length} routes seen: the hook missed some`);
  // "/*" is the shell itself.
  const outside = [...new Set(urls.filter((u) => u !== "/*").map((u) => u.split("/")[1]!))].filter((seg) => !(SERVER_PATHS as readonly string[]).includes(seg));
  assert.deepEqual(outside, [], "add these first segments to SERVER_PATHS (packages/schema/src/models.ts): the Service Worker answers a navigation to them with the app shell");
});
