import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AccountMe, DeltaFrame } from "@rsva/protocol";
import { PICTURE_MAX } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, schema } from "../db.ts";
import { OWN_ROW_CHANGES } from "./account.ts";
import { avif, jpeg, png, u24le, webp } from "../test/images.ts";
import { addMember, asToken, asUser, Client, fetchAs, importFixture, lastSyncId, limited, startServer, type Fixture } from "../test/helpers.ts";

const { syncAction, user } = schema;

let server: Awaited<ReturnType<typeof startServer>>;
let a: Fixture;
let b: Fixture;
before(async () => {
  [server, a, b] = await Promise.all([startServer(), importFixture(), importFixture()]);
});
after(() => server.close());

const patch = async (headers: Record<string, string>, body: unknown) =>
  fetchAs(headers)(`${server.url}/auth/me`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const me = async (headers: Record<string, string>) => (await (await fetchAs(headers)(`${server.url}/auth/me`)).json()) as AccountMe;

/** A person who is a member of both workspaces. */
async function inBoth(): Promise<{ id: string; headers: Record<string, string> }> {
  const p = await addMember(a.workspaceId, "member");
  await db.insert(schema.member).values({ workspaceId: b.workspaceId, userId: p.id, role: "member" });
  return { id: p.id, headers: await asUser(p.id) };
}

test("settings start at the defaults and change one at a time", async () => {
  const p = await inBoth();
  assert.deepEqual((await me(p.headers)).settings, { timeZone: null, weekStart: 1, theme: null, ui: null, myWork: null });

  let r = await patch(p.headers, { timeZone: "Europe/Sofia" });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as Pick<AccountMe, "settings">).settings, { timeZone: "Europe/Sofia", weekStart: 1, theme: null, ui: null, myWork: null });
  r = await patch(p.headers, { weekStart: 0 });
  assert.deepEqual(((await r.json()) as Pick<AccountMe, "settings">).settings, { timeZone: "Europe/Sofia", weekStart: 0, theme: null, ui: null, myWork: null });
  assert.deepEqual((await me(p.headers)).settings, { timeZone: "Europe/Sofia", weekStart: 0, theme: null, ui: null, myWork: null });
  const theme = { mode: "dark", light: "latte", dark: "mocha" };
  r = await patch(p.headers, { theme });
  assert.deepEqual(((await r.json()) as Pick<AccountMe, "settings">).settings, { timeZone: "Europe/Sofia", weekStart: 0, theme, ui: null, myWork: null });
  r = await patch(p.headers, { ui: { panes: "flat", density: "comfortable", start: "inbox", project: "issues", quiet: 7 } });
  assert.deepEqual(((await r.json()) as Pick<AccountMe, "settings">).settings, { timeZone: "Europe/Sofia", weekStart: 0, theme, ui: { panes: "flat", density: "comfortable", start: "inbox", project: "issues", quiet: 7 }, myWork: null });
});

test("My work's folded groups: whole, read back in the groups' order and once, null back to the defaults", async () => {
  const m = await addMember(a.workspaceId, "member");
  const p = { headers: await asUser(m.id) };
  let r = await patch(p.headers, { myWork: ["done", "wait", "done"] });
  assert.equal(r.status, 200);
  assert.deepEqual((await me(p.headers)).settings.myWork, ["wait", "done"]);
  r = await patch(p.headers, { myWork: [] });
  assert.deepEqual((await me(p.headers)).settings.myWork, []);
  for (const body of [{ myWork: ["brief"] }, { myWork: [{ id: "wait", kind: "wait", folded: true }] }, { myWork: ["wait", "doing", "agents", "next", "later", "done", "wait"] }])
    assert.equal((await patch(p.headers, body)).status, 400, JSON.stringify(body).slice(0, 80));
  r = await patch(p.headers, { myWork: null });
  assert.equal((await me(p.headers)).settings.myWork, null);
});

test("an interface choice saved before a setting existed keeps the others, the new one at its default", async () => {
  const p = await inBoth();
  await db.insert(schema.accountSettings).values({ userId: p.id, ui: { panes: "flat" } });
  assert.deepEqual((await me(p.headers)).settings.ui, { panes: "flat", density: "compact", start: "project", project: "home", quiet: 14 });
});

test("a time zone is kept as Intl spells it", async () => {
  const p = await inBoth();
  const r = await patch(p.headers, { timeZone: "europe/sofia" });
  assert.equal(((await r.json()) as Pick<AccountMe, "settings">).settings.timeZone, "Europe/Sofia");
});

test("a bad value, an unknown field or a token is refused", async () => {
  const p = await inBoth();
  for (const body of [{ timeZone: "Mars/Olympus" }, { weekStart: 3 }, { name: "  " }, { email: "x@example.test" }, { timeZone: null }, { theme: { mode: "dark", light: "graphite", dark: "mocha" } }, { theme: { mode: "dim", light: "ledger", dark: "mocha" } }, { theme: { mode: "dark", light: "ledger" } }, { ui: { panes: "roomy", density: "compact" } }, { ui: { panes: "flat", density: "compact", start: "project", project: "home", quiet: 10 } }, { ui: { panes: "flat", density: "compact", gap: 2 } }, { ui: { panes: "flat" } }, { ui: { panes: "flat", density: "compact", start: "home", project: "home" } }, { ui: { panes: "flat", density: "compact", start: "inbox", project: "cycles" } }, { avatar: "c1:1,2,3" }, { avatar: "<svg/>" }, { avatar: 5 }]) {
    assert.equal((await patch(p.headers, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await patch(await asToken(a.workspaceId, p.id), { weekStart: 0 })).status, 403);
  assert.equal((await patch({}, { weekStart: 0 })).status, 401);
  assert.deepEqual((await me(p.headers)).settings, { timeZone: null, weekStart: 1, theme: null, ui: null, myWork: null });
});

test("a new name reaches every workspace of the person in one action each, live", async () => {
  const p = await inBoth();
  const [ca, cb] = await Promise.all([(await Client.open(server.url, await asUser(a.ownerId))).subscribe(a), (await Client.open(server.url, await asUser(b.ownerId))).subscribe(b)]);
  const renamed = (f: { t: string }) => f.t === "d" && (f as DeltaFrame).a.some((x) => x.m === "User" && x.mid === p.id && x.d?.name === "Ада Лавлейс");
  const seen = [ca.next(renamed), cb.next(renamed)];

  const r = await patch(p.headers, { name: "  Ада   Лавлейс " });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as Pick<AccountMe, "user">).user.name, "Ада Лавлейс");
  await Promise.all(seen);
  const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, p.id));
  assert.equal(u!.name, "Ада Лавлейс");

  // The same name again writes nothing.
  const before = [await lastSyncId(a.workspaceId), await lastSyncId(b.workspaceId)];
  assert.equal((await patch(p.headers, { name: "Ада Лавлейс" })).status, 200);
  assert.deepEqual([await lastSyncId(a.workspaceId), await lastSyncId(b.workspaceId)], before);
  const logged = await db.select({ ws: syncAction.workspaceId }).from(syncAction).where(and(eq(syncAction.model, "User"), eq(syncAction.modelId, p.id)));
  assert.deepEqual(logged.map((x) => x.ws).sort(), [a.workspaceId, b.workspaceId].sort());
  ca.close();
  cb.close();
});

test("a creature for the avatar reaches every workspace of the person, and null goes back to the name's own", async () => {
  const p = await inBoth();
  const [ca, cb] = await Promise.all([(await Client.open(server.url, await asUser(a.ownerId))).subscribe(a), (await Client.open(server.url, await asUser(b.ownerId))).subscribe(b)]);
  const creature = "c1:5,40,60,-12,82,2,40,30,50,1";
  const drawn = (to: string | null) => (f: { t: string }) => f.t === "d" && (f as DeltaFrame).a.some((x) => x.m === "User" && x.mid === p.id && x.d?.avatar === to);
  const seen = [ca.next(drawn(creature)), cb.next(drawn(creature))];
  assert.equal((await patch(p.headers, { avatar: creature })).status, 200);
  await Promise.all(seen);
  const avatarOf = async () => (await db.select({ avatar: user.avatar }).from(user).where(eq(user.id, p.id)))[0]!.avatar;
  assert.equal(await avatarOf(), creature);

  const back = ca.next(drawn(null));
  assert.equal((await patch(p.headers, { avatar: null })).status, 200);
  await back;
  assert.equal(await avatarOf(), null);
  ca.close();
  cb.close();
});

// ── The picture (PLNR-244, picture.ts) ──

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const put = (headers: Record<string, string>, body: Buffer, type = "image/png") =>
  fetchAs(headers)(`${server.url}/auth/me/picture`, { method: "PUT", headers: { "content-type": type }, body });
const remove = (headers: Record<string, string>) => fetchAs(headers)(`${server.url}/auth/me/picture`, { method: "DELETE" });
const get = (headers: Record<string, string>, hash: string, init: RequestInit = {}) => fetchAs(headers)(`${server.url}/pictures/${hash}`, init);
const pictureOf = async (id: string) => (await db.select({ picture: schema.user.picture }).from(schema.user).where(eq(schema.user.id, id)))[0]!.picture;

test("a picture reaches every workspace of the person in one action each, live, and is served to their colleagues", async () => {
  const p = await inBoth();
  const [ca, cb] = await Promise.all([(await Client.open(server.url, await asUser(a.ownerId))).subscribe(a), (await Client.open(server.url, await asUser(b.ownerId))).subscribe(b)]);
  const bytes = png(256, 256);
  const hash = sha(bytes);
  const changed = (f: { t: string }) => f.t === "d" && (f as DeltaFrame).a.some((x) => x.m === "User" && x.mid === p.id && x.d?.picture === hash);
  const seen = [ca.next(changed), cb.next(changed)];

  const r = await put(p.headers, bytes);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { picture: hash });
  await Promise.all(seen);
  assert.equal(await pictureOf(p.id), hash);

  for (const viewer of [p.headers, await asUser(a.ownerId), await asUser(b.ownerId), await asToken(a.workspaceId, a.ownerId, "read")]) {
    const g = await get(viewer, hash);
    assert.equal(g.status, 200);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), bytes);
    assert.equal(g.headers.get("content-type"), "image/png");
    assert.equal(g.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.match(g.headers.get("content-security-policy") ?? "", /^sandbox;/);
    assert.equal((await get(viewer, hash, { headers: { "if-none-match": `"${hash}"` } })).status, 304);
  }

  // The same picture again writes nothing.
  const before = [await lastSyncId(a.workspaceId), await lastSyncId(b.workspaceId)];
  assert.equal((await put(p.headers, bytes)).status, 200);
  assert.deepEqual([await lastSyncId(a.workspaceId), await lastSyncId(b.workspaceId)], before);

  // A workspace's snapshot carries it.
  const snapshot = await (await fetchAs(await asUser(a.ownerId))(`${server.url}/sync/bootstrap?ws=${a.slug}`)).text();
  const users = snapshot.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; m?: string; c?: string[]; r?: unknown[][] }).find((l) => l.m === "User")!;
  assert.equal(users.r!.find((row) => row[0] === p.id)![users.c!.indexOf("picture")], hash);
  ca.close();
  cb.close();
});

test("nobody outside the person's workspaces reads the picture, nor a token of another workspace", async () => {
  const p = await addMember(a.workspaceId, "member");
  const bytes = png(64, 64, "only in a");
  assert.equal((await put(await asUser(p.id), bytes)).status, 200);
  const hash = sha(bytes);
  assert.equal((await get(await asUser(b.ownerId), hash)).status, 404);
  assert.equal((await get({}, hash)).status, 404);
  // The owner of b is in a too, but b's token opens b only.
  await db.insert(schema.member).values({ workspaceId: a.workspaceId, userId: b.ownerId, role: "member" }).onConflictDoNothing();
  assert.equal((await get(await asUser(b.ownerId), hash)).status, 200);
  assert.equal((await get(await asToken(b.workspaceId, b.ownerId), hash)).status, 404);
  assert.equal((await get(await asUser(a.ownerId), "0".repeat(64))).status, 404);
});

test("taking the picture away puts the creature back everywhere and the old address answers 404", async () => {
  const p = await inBoth();
  const bytes = jpeg(256, 256);
  assert.equal((await put(p.headers, bytes, "image/jpeg")).status, 200);
  const hash = sha(bytes);
  assert.equal((await get(p.headers, hash)).headers.get("content-type"), "image/jpeg");

  // A new picture replaces the old one's bytes.
  const next = png(256, 256, "another");
  assert.equal((await put(p.headers, next)).status, 200);
  assert.equal((await get(p.headers, hash)).status, 404);

  const ca = await (await Client.open(server.url, await asUser(a.ownerId))).subscribe(a);
  const gone = ca.next((f) => f.t === "d" && (f as DeltaFrame).a.some((x) => x.m === "User" && x.mid === p.id && x.d?.picture === null));
  const r = await remove(p.headers);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { picture: null });
  await gone;
  assert.equal(await pictureOf(p.id), null);
  assert.equal((await get(p.headers, sha(next))).status, 404);
  ca.close();
});

test("only a PNG, JPEG or WebP of at most 1024 pixels a side and PICTURE_MAX bytes, from a signed-in person", async () => {
  const p = await inBoth();
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  assert.equal((await put(p.headers, svg, "image/svg+xml")).status, 400);
  // A PNG's name on HTML.
  assert.equal((await put(p.headers, Buffer.from("<!doctype html><p>hi"), "image/png")).status, 400);
  // A GIF is an image, but no canvas makes one.
  assert.equal((await put(p.headers, Buffer.from("GIF89a\x01\x00\x01\x00"), "image/gif")).status, 400);
  assert.equal((await put(p.headers, avif([64, 64]), "image/avif")).status, 400);
  assert.equal((await put(p.headers, png(1025, 64))).status, 400);
  assert.equal((await put(p.headers, webp("VP8X", Buffer.concat([Buffer.alloc(4), u24le(16382), u24le(16382)])), "image/webp")).status, 400);
  assert.equal((await put(p.headers, png(256, 256, "x".repeat(PICTURE_MAX)))).status, 413);
  assert.equal((await put(p.headers, png(256, 256), "application/json")).status, 400);
  assert.equal((await put(await asToken(a.workspaceId, p.id), png(256, 256))).status, 403);
  assert.equal((await put({ origin: "http://127.0.0.1" }, png(256, 256))).status, 401);
  assert.equal((await remove(await asToken(a.workspaceId, p.id))).status, 403);
  assert.equal(await pictureOf(p.id), null);
});

test("past OWN_ROW_CHANGES changes a minute of name, creature and picture, 429 and nothing written; the settings still save", async () => {
  const p = await inBoth();
  const actions = async () => (await db.select({ id: syncAction.id }).from(syncAction).where(and(eq(syncAction.model, "User"), eq(syncAction.modelId, p.id)))).length;
  // A name and a creature in one patch are one change, the same name again none.
  assert.equal((await patch(p.headers, { name: "Name 0", avatar: "c1:5,40,60,-12,82,2,40,30,50,1" })).status, 200);
  assert.equal((await patch(p.headers, { name: "Name 0" })).status, 200);
  for (let i = 1; i < OWN_ROW_CHANGES; i++) assert.equal((await patch(p.headers, { name: `Name ${i % 2}` })).status, 200, `change ${i + 1}`);
  const written = await actions();
  assert.equal(written, OWN_ROW_CHANGES * 2);
  const before = [await lastSyncId(a.workspaceId), await lastSyncId(b.workspaceId)];

  await limited(await patch(p.headers, { name: "One too many", weekStart: 0 }));
  for (const r of [await patch(p.headers, { avatar: null }), await put(p.headers, png(64, 64)), await remove(p.headers)]) assert.equal(r.status, 429);
  assert.deepEqual([await lastSyncId(a.workspaceId), await lastSyncId(b.workspaceId)], before);
  assert.equal(await actions(), written);
  const [u] = await db.select({ name: user.name, picture: user.picture }).from(user).where(eq(user.id, p.id));
  assert.deepEqual(u, { name: `Name ${(OWN_ROW_CHANGES - 1) % 2}`, picture: null });
  // The refused patch wrote none of its settings; settings alone are not limited.
  assert.equal((await me(p.headers)).settings.weekStart, 1);
  assert.equal((await patch(p.headers, { weekStart: 0 })).status, 200);
  // Another person has their own budget.
  assert.equal((await patch(await asUser(a.ownerId), { name: "Owner" })).status, 200);
});
