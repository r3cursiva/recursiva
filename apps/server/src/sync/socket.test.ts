import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { after, before, test } from "node:test";
import { CLOSE_TRY_AGAIN, CLOSE_UNAUTHORIZED, type Op } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import { createSession } from "../auth/sessions.ts";
import { sha256 } from "../auth/secret.ts";
import { createToken } from "../auth/tokens.ts";
import { db, schema } from "../db.ts";
import { addMember, asUser, Client, delay, importFixture, issueWithRefs, lastSyncId, ORIGIN, startServer, type Fixture } from "../test/helpers.ts";
import { reads, takeWrite } from "./limits.ts";
import { handleSocket } from "./socket.ts";
import { applyTx } from "./write.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
let refs: Awaited<ReturnType<typeof issueWithRefs>>;
const clients: Client[] = [];
before(async () => {
  [server, ws] = await Promise.all([startServer(), importFixture()]);
  refs = await issueWithRefs(ws.workspaceId);
});
after(async () => {
  for (const c of clients) c.close();
  await server.close();
});

async function open(): Promise<Client> {
  const c = await Client.open(server.url, await asUser(ws.ownerId));
  clients.push(c);
  await c.next((f) => f.t === "hello", 3000, true);
  return c;
}
const rename = (title: string): Op[] => [{ op: "update", m: "Issue", id: refs.issue.id, set: { title } }];
const write = (title: string) => applyTx(ws.workspaceId, ws.agentId, randomUUID(), rename(title));

test("hello names the person the socket is signed in as: a tab can tell its browser now holds someone else's sign-in", async () => {
  const other = await addMember(ws.workspaceId, "member");
  const [a, b] = [await open(), await Client.open(server.url, await asUser(other.id))];
  clients.push(b);
  const person = (c: Client) => c.next((f) => f.t === "hello", 3000, true).then((f) => (f.t === "hello" ? f.u : null));
  assert.equal(await person(a), ws.ownerId);
  assert.equal(await person(b), other.id);
});

test("sub with an old s gets exactly the missed actions, then live ones, without duplicates", async () => {
  const s0 = await lastSyncId(ws.workspaceId);
  for (let i = 0; i < 5; i++) await write(`missed ${i}`);
  const c = await open();
  // Live writes race with the catch-up read: none may be lost or repeated.
  const live = Array.from({ length: 10 }, (_, i) => write(`live ${i}`));
  c.send({ t: "sub", ws: ws.slug, s: s0 });
  await Promise.all(live);
  const last = await lastSyncId(ws.workspaceId);
  await c.next(() => c.actionIds().at(-1) === last, 3000, true);
  assert.deepEqual(c.actionIds(), Array.from({ length: last - s0 }, (_, i) => s0 + 1 + i));
});

test("a subscribe ends with `caught-up`, after the catch-up", async () => {
  const a = await open();
  const s = await lastSyncId(ws.workspaceId);
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), rename("for the catch-up"));
  a.send({ t: "sub", ws: ws.slug, s });
  await a.next((f) => f.t === "caught-up", 3000, true);
  assert.deepEqual(a.frames.filter((f) => f.t === "d" || f.t === "caught-up").map((f) => f.t), ["d", "caught-up"]);
});

test("a tx right after sub is accepted, and its delta reaches other subscribers", async () => {
  const [a, b] = await Promise.all([open(), open()]);
  const s = await lastSyncId(ws.workspaceId);
  b.send({ t: "sub", ws: ws.slug, s });
  await delay(50);
  const id = randomUUID();
  // No wait between the frames: they are handled in order on the connection.
  a.send({ t: "sub", ws: ws.slug, s });
  a.send({ t: "tx", id, ops: rename("right after sub") });
  const ack = await a.next((f) => f.t === "ack" || f.t === "rej", 3000, true);
  assert.deepEqual(ack, { t: "ack", id, s: s + 1 });
  await b.next((f) => f.t === "d" && f.a.some((x) => x.id === s + 1), 3000, true);
  // Replaying the same tx id is acknowledged with the same number and no new delta.
  a.send({ t: "tx", id, ops: rename("right after sub") });
  await a.next((f) => f.t === "ack" && f.id === id && a.frames.filter((x) => x.t === "ack").length === 2, 3000, true);
  await delay(50);
  assert.deepEqual(b.actionIds(), [s + 1]);
});

test("invalid transactions are rejected, the connection stays usable", async () => {
  const c = await open();
  c.send({ t: "tx", id: randomUUID(), ops: rename("before sub") });
  assert.equal(((await c.next((f) => f.t === "rej", 3000, true)) as { code: string }).code, "no_sub");
  c.send({ t: "sub", ws: ws.slug, s: await lastSyncId(ws.workspaceId) });
  const cases: [unknown, string][] = [
    [[{ op: "update", m: "Issue", id: refs.issue.id, set: { title: "" } }], "invalid"],
    [[{ op: "delete", m: "Issue", id: refs.issue.id }], "invalid"],
    [[{ op: "update", m: "Issue", id: refs.issue.id, set: { stateId: refs.otherStates[0]!.id } }], "bad_ref"],
  ];
  for (const [ops, code] of cases) {
    const id = randomUUID();
    c.send({ t: "tx", id, ops });
    const r = await c.next((f) => f.t === "rej" && f.id === id);
    assert.equal((r as { code: string }).code, code);
  }
  const bad = "not-a-uuid";
  c.send({ t: "tx", id: bad, ops: rename("x") });
  assert.equal(((await c.next((f) => f.t === "rej" && f.id === bad)) as { code: string }).code, "invalid");
  const ok = randomUUID();
  c.send({ t: "tx", id: ok, ops: rename("still works") });
  await c.next((f) => f.t === "ack" && f.id === ok);
});

test("a malformed frame closes the connection with 1003; a client ahead of the log is told to resync", async () => {
  const c = await open();
  const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
  c.send({ t: "sub", ws: ws.slug });
  assert.equal(await closed, 1003);

  const d = await open();
  d.send({ t: "sub", ws: ws.slug, s: (await lastSyncId(ws.workspaceId)) + 100 });
  await d.next((f) => f.t === "resync", 3000, true);
});

/** A socket of a new member: budgets are per person, so each test that spends one starts full. */
async function member(): Promise<Client> {
  const m = await addMember(ws.workspaceId, "member");
  const c = await Client.open(server.url, await asUser(m.id));
  clients.push(c);
  return c.subscribe(ws);
}
const rejection = async (c: Client, ops: unknown) => {
  const id = randomUUID();
  c.send({ t: "tx", id, ops });
  return (await c.next((f) => (f.t === "rej" || f.t === "ack") && f.id === id)) as { t: string; code?: string; msg?: string; wait?: number };
};

test("a browser session is held to the write budget too: ops and bytes a minute, refused before anything else", async (t) => {
  // The budget refills all the time, and the seventeenth frame passes it by under a second's refill: stop the clock it reads,
  // or on a busy machine that frame goes through.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // Ops: 400 a transaction (the client's chunk), invalid so nothing is written; the eighth passes 3,000.
  const a = await member();
  const junk = Array.from({ length: 400 }, () => ({ m: "Issue" }));
  for (let i = 0; i < 7; i++) assert.equal((await rejection(a, junk)).code, "invalid");
  const r = await rejection(a, junk);
  assert.equal(r.code, "rate_limited");
  assert.ok(r.wait! >= 1000, "it says how long to wait");
  // Bytes: frames near the 1 MiB limit; the seventeenth passes 16 MiB.
  const b = await member();
  const big = [{ op: "update", m: "Issue", id: refs.issue.id, set: { title: "x".repeat(1_000_000) } }];
  for (let i = 0; i < 16; i++) assert.equal((await rejection(b, big)).code, "invalid");
  assert.equal((await rejection(b, big)).code, "rate_limited");
  // Another person's budget is their own.
  assert.equal((await rejection(await member(), rename("someone else"))).t, "ack");
});

test("views, inbox changes and marks are charged to the person's budgets: a session floods none of them", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const m = await addMember(ws.workspaceId, "member");
  const c = await Client.open(server.url, await asUser(m.id));
  clients.push(c);
  await c.subscribe(ws);
  await c.next((f) => f.t === "caught-up", 3000, true);
  // An answer within the budget comes as before.
  c.send({ t: "views" });
  await c.next((f) => f.t === "views");
  const refused = async (frame: Record<string, unknown>, id: string) => {
    c.send(frame);
    const r = (await c.next((f) => f.t === "rej" && f.id === id)) as { code: string; wait?: number };
    assert.equal(r.code, "rate_limited", `${id}: ${JSON.stringify(r)}`);
    assert.ok(r.wait! >= 1000, "it says how long to wait");
  };
  // The reader's budget spent (by catch-ups, history pages, ...): the queries of views and inbox changes wait for it.
  reads.take(m.id, reads.available(m.id));
  await refused({ t: "views" }, "views");
  await refused({ t: "views", at: "1970-01-01T00:00:00Z" }, "views");
  await refused({ t: "inbox", at: "1970-01-01T00:00:00Z" }, "inbox");
  // Marks are writes: up to 500 rows each, held to the ops a minute that transactions are.
  assert.ok(takeWrite(m.id, 3000, 0));
  await refused({ t: "mark", m: [{ issueId: refs.issue.id, readId: 1, archivedId: 0, snoozedId: 0, snoozedUntil: null }] }, "mark");
});

test("a reply to a socket that stopped reading closes it, as a delta does: the server's memory is not its buffer", () => {
  let sent = 0;
  let ended = 0;
  const reader = { bufferedAmount: 2 ** 30, readyState: 1, OPEN: 1, CLOSING: 2, send: () => sent++, terminate: () => ended++, on: () => {}, ping: () => {} };
  // The first reply is hello, sent as the socket opens.
  handleSocket(reader as unknown as WebSocket, { userId: ws.ownerId, via: "session", credentialId: randomUUID() }, async () => null);
  assert.deepEqual([sent, ended], [0, 1]);
});

test("a database error reaches the client as a bare 'internal', without the SQL", async () => {
  const c = await member();
  // A comment body is stored as written, and Postgres text takes no NUL (titles lose it to cleanName, PLNR-39).
  const r = await rejection(c, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: refs.issue.id, body: "nul \u0000 byte" } }]);
  assert.deepEqual([r.code, r.msg], ["internal", "internal error"]);
  assert.equal((await rejection(c, rename("after the error"))).t, "ack", "the connection stays usable");
});

test("a catch-up past the byte cap is a resync, read without loading the actions", async () => {
  const s0 = await lastSyncId(ws.workspaceId);
  const body = "y".repeat(60_000);
  // 72 comments of 60 KB: 4.3 MB of log, over the 4 MiB cap.
  for (let i = 0; i < 6; i++) {
    await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), Array.from({ length: 12 }, () => ({ op: "create", m: "Comment", id: randomUUID(), set: { issueId: refs.issue.id, body } }) as Op));
  }
  const c = await open();
  c.send({ t: "sub", ws: ws.slug, s: s0 });
  await c.next((f) => f.t === "resync", 3000, true);
  assert.equal(c.actionIds().length, 0);
  // Nearer the tail it fits.
  const d = await open();
  d.send({ t: "sub", ws: ws.slug, s: (await lastSyncId(ws.workspaceId)) - 12 });
  await d.next((f) => f.t === "d", 3000, true);
  assert.equal(d.actionIds().length, 12);
});

test("subscribes are charged to the reader's budget before the log is sized; a flood is closed to try again later", async () => {
  // From 0 the catch-up is past the caps (the comments above), so each subscribe keeps its whole 4 MiB reservation.
  const m = await addMember(ws.workspaceId, "member");
  const c = await Client.open(server.url, await asUser(m.id));
  clients.push(c);
  const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
  for (let i = 0; i < 16; i++) {
    c.send({ t: "sub", ws: ws.slug, s: 0 });
    await c.next((f) => f.t === "resync", 3000, true);
  }
  c.send({ t: "sub", ws: ws.slug, s: 0 });
  assert.equal(await closed, CLOSE_TRY_AGAIN);
  // A small catch-up gives back what it did not use: another person subscribes as often as they like.
  const d = await member();
  const tail = await lastSyncId(ws.workspaceId);
  for (let i = 0; i < 20; i++) d.send({ t: "sub", ws: ws.slug, s: tail });
  assert.equal((await rejection(d, rename("still open"))).t, "ack");
});

test("a socket closes when its session or token reaches its expiry, not at the next recheck", async () => {
  const m = await addMember(ws.workspaceId, "member");
  const { token } = await createSession(m.id, "cli", "test");
  const soon = () => new Date(Date.now() + 1200).toISOString();
  await db.update(schema.session).set({ expiresAt: soon() }).where(eq(schema.session.id, sha256(token)));
  const { secret } = await createToken({ workspaceId: ws.workspaceId, userId: m.id, name: "short", scope: "write", createdById: null, expiresAt: new Date(Date.now() + 1200) });
  const sockets = [await Client.open(server.url, { cookie: `rsva_sid=${token}`, origin: ORIGIN }), await Client.open(server.url, { authorization: `Bearer ${secret}` })];
  const closed = sockets.map((c) => new Promise<number>((r) => c.ws.once("close", (code) => r(code))));
  for (const c of sockets) {
    clients.push(c);
    await c.subscribe(ws);
  }
  const started = Date.now();
  assert.deepEqual(await Promise.all(closed), [CLOSE_UNAUTHORIZED, CLOSE_UNAUTHORIZED]);
  assert.ok(Date.now() - started < 3000, "within moments of the expiry");
});

/** Upgrades a raw socket to /ws and hands it back: frames written to it reach the server exactly as given. */
async function rawSocket(headers = ""): Promise<net.Socket> {
  const { hostname, port } = new URL(server.url);
  const s = net.connect(Number(port), hostname);
  s.write(`GET /ws HTTP/1.1\r\nHost: ${hostname}\r\nOrigin: ${ORIGIN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`);
  await new Promise<void>((resolve, reject) => {
    s.once("data", (d) => (String(d).startsWith("HTTP/1.1 101") ? resolve() : reject(new Error(String(d)))));
  });
  return s;
}

/** The server still answers: an unhandled socket error would have ended the process, and this file with it. */
async function serverAlive(): Promise<void> {
  await delay(50);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
}

test("a frame over the size limit closes that socket and the server stays up", async () => {
  const c = await open();
  const closed = new Promise<number>((resolve) => c.ws.once("close", resolve));
  c.ws.on("error", () => {});
  c.ws.send("x".repeat((1 << 20) + 1));
  assert.equal(await closed, 1009);
  await serverAlive();
});

/** Sends a frame with reserved bits and an opcode that does not exist, then checks the server is up. */
async function malformedFrame(headers?: string) {
  const s = await rawSocket(headers);
  s.on("error", () => {});
  s.write(Buffer.from([0xff, 0x80, 0, 0, 0, 0]));
  await serverAlive();
  s.destroy();
}

test("a malformed frame from a signed-in socket closes it and the server stays up", async () => {
  const { cookie } = await asUser(ws.ownerId);
  await malformedFrame(`Cookie: ${cookie}\r\n`);
});

test("a malformed frame on a socket that was refused sign-in cannot take the server down", async () => {
  await malformedFrame();
});
