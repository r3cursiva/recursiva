import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { PROJECT_ORDER_MAX, type ViewFields, type ViewsFrame } from "@rsva/protocol";
import type { Grant } from "@rsva/policy";
import { eq } from "drizzle-orm";
import { createToken } from "../auth/tokens.ts";
import { db, schema } from "../db.ts";
import { addMember, asUser, Client, importFixture, startServer, type Fixture } from "../test/helpers.ts";
import { findView, readViews, viewsSince, ViewError, VIEWS_MAX, writeView } from "./views.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
let other: Fixture;
let mate: { id: string };
let admin: { id: string };
const clients: Client[] = [];
before(async () => {
  [server, ws, other] = await Promise.all([startServer(), importFixture(), importFixture()]);
  [mate, admin] = await Promise.all([addMember(ws.workspaceId, "member"), addMember(ws.workspaceId, "admin")]);
});
after(async () => {
  for (const c of clients) c.close();
  await server.close();
});

const fields = (over: Partial<ViewFields> = {}): ViewFields => ({
  name: "Needs review",
  icon: "eye",
  query: 'project:PLNR state:"In Review"',
  display: { groupBy: "state" },
  layout: "list",
  shared: false,
  tab: true,
  position: 1,
  ...over,
});
const save = (me: string, role: "member" | "admin" | "owner", id: string, set: Partial<ViewFields>) => writeView(ws.workspaceId, me, role, { op: "save", id, set });
const ids = (f: ViewsFrame | null) => f?.v.map((v) => v.id) ?? [];

test("a private view is its owner's alone; a shared one everyone sees and only its owner or an admin changes", async () => {
  const mine = randomUUID();
  const shared = randomUUID();
  await save(ws.ownerId, "owner", mine, fields());
  await save(ws.ownerId, "owner", shared, fields({ name: "  Team​ view ", shared: true, tab: false }));
  assert.ok(ids(await readViews(ws.workspaceId, ws.ownerId)).includes(mine));
  const seen = await readViews(ws.workspaceId, mate.id);
  assert.ok(!ids(seen).includes(mine));
  assert.equal(seen.v.find((v) => v.id === shared)?.name, "Team view");

  await assert.rejects(save(mate.id, "member", shared, { name: "Mine now" }), ViewError);
  await assert.rejects(save(mate.id, "member", mine, { name: "Peek" }), /no such view/);
  await save(admin.id, "admin", shared, { name: "Renamed by an admin" });
  await assert.rejects(save(admin.id, "admin", shared, { shared: false }), /only its owner/);
});

test("a person keeps at most VIEWS_MAX live views in a workspace: a deleted one makes room, coming back takes it", async () => {
  const p = await addMember(ws.workspaceId, "member");
  const view = (i: number) => ({ workspaceId: ws.workspaceId, ownerId: p.id, name: `v${i}`, icon: "star", display: {} });
  await db.insert(schema.savedView).values(Array.from({ length: VIEWS_MAX - 1 }, (_, i) => view(i)));
  const last = randomUUID();
  await save(p.id, "member", last, fields());
  await assert.rejects(save(p.id, "member", randomUUID(), fields()), new RegExp(`at most ${VIEWS_MAX} saved views`));
  await writeView(ws.workspaceId, p.id, "member", { op: "delete", id: last });
  await save(p.id, "member", randomUUID(), fields());
  // Saving a deleted view brings it back (undo): a live view again, so it needs the room too.
  await assert.rejects(save(p.id, "member", last, {}), new RegExp(`at most ${VIEWS_MAX} saved views`));
  // Another person's views are theirs to count.
  await save(mate.id, "member", randomUUID(), fields());
});

test("validation: names, icons, layouts, positions, views of other workspaces", async () => {
  await assert.rejects(save(ws.ownerId, "owner", randomUUID(), fields({ name: " ​ " })), /a view needs a name/);
  await assert.rejects(save(ws.ownerId, "owner", randomUUID(), fields({ icon: "skull" as never })), ViewError);
  await assert.rejects(save(ws.ownerId, "owner", randomUUID(), fields({ layout: "calendar" as never })), ViewError);
  await assert.rejects(save(ws.ownerId, "owner", randomUUID(), { name: "half" }), ViewError);
  await assert.rejects(save(ws.ownerId, "owner", randomUUID(), fields({ position: Number.NaN })), ViewError);
  const theirs = randomUUID();
  await writeView(other.workspaceId, other.ownerId, "owner", { op: "save", id: theirs, set: fields({ shared: true }) });
  await assert.rejects(save(ws.ownerId, "owner", theirs, { name: "x" }), /no such view/);
});

test("a project's home is a view with the layout home: more room for its widgets, never a tab, not in `view=` (ADR 0053)", async () => {
  const widgets = Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, kind: "list", query: `label:bug -group:completed -group:cancelled order:priority ${i}`, width: 6, rows: 5 }));
  const home = randomUUID();
  await save(ws.ownerId, "owner", home, fields({ name: "Home", query: "project:PLNR", layout: "home", tab: false, shared: true, display: { widgets } }));
  assert.ok(JSON.stringify({ widgets }).length > 2048, "longer than a view's display may be");
  assert.equal((await readViews(ws.workspaceId, mate.id)).v.find((v) => v.id === home)?.layout, "home");
  await assert.rejects(save(ws.ownerId, "owner", home, { tab: true }), /not a tab/);
  await assert.rejects(save(ws.ownerId, "owner", home, { layout: "list" }), /longer than 2048/);
  await assert.rejects(save(ws.ownerId, "owner", randomUUID(), fields({ display: { widgets } })), /longer than 2048/);
  const found = await findView(ws.workspaceId, ws.ownerId, home);
  assert.ok("error" in found);
});

test("the workspace's default home (RSVA-577), a home with no project in its query, is an admin's; a home is never private", async () => {
  const home = (set: Partial<ViewFields>) => fields({ name: "Home", query: "", layout: "home", tab: false, display: { widgets: [] }, shared: true, ...set });
  await assert.rejects(save(mate.id, "member", randomUUID(), home({})), /only an admin/);
  await assert.rejects(save(mate.id, "member", randomUUID(), home({ shared: false, query: "project:PLNR" })), /cannot be private/);
  // A project's home is still any member's to make, and does not become the default by losing its project.
  const project = randomUUID();
  await save(mate.id, "member", project, home({ query: "project:PLNR" }));
  await assert.rejects(save(mate.id, "member", project, { query: " " }), /only an admin/);
  await assert.rejects(save(mate.id, "member", project, { shared: false }), /cannot be private/);
  const shared = randomUUID();
  await save(ws.ownerId, "owner", shared, home({}));
  assert.equal((await readViews(ws.workspaceId, mate.id)).v.find((v) => v.id === shared)?.query, "");
  await assert.rejects(save(mate.id, "member", shared, { display: { widgets: [] } }), /only its owner or an admin/);
});

test("since a cursor: changes, deletions and views made private come as gone; pins are per person", async () => {
  const id = randomUUID();
  await save(ws.ownerId, "owner", id, fields({ shared: true }));
  const { at } = await readViews(ws.workspaceId, mate.id);
  assert.equal(await viewsSince(ws.workspaceId, mate.id, at!), null);

  await writeView(ws.workspaceId, mate.id, "member", { op: "pin", id, pinned: true });
  const pinned = await viewsSince(ws.workspaceId, mate.id, at!);
  assert.deepEqual(pinned?.p, [[id, true]]);
  assert.deepEqual((await viewsSince(ws.workspaceId, ws.ownerId, at!))?.p ?? [], []);

  await save(ws.ownerId, "owner", id, { shared: false });
  assert.deepEqual((await viewsSince(ws.workspaceId, mate.id, at!))?.gone, [id]);
  assert.ok(ids(await viewsSince(ws.workspaceId, ws.ownerId, at!)).includes(id));

  await writeView(ws.workspaceId, ws.ownerId, "owner", { op: "delete", id });
  const later = await viewsSince(ws.workspaceId, ws.ownerId, at!);
  assert.ok(later?.gone.includes(id));
  assert.ok(!ids(await readViews(ws.workspaceId, ws.ownerId)).includes(id));
  await assert.rejects(writeView(ws.workspaceId, mate.id, "member", { op: "pin", id, pinned: true }), /no such view/);
  // Undo: its owner saves it again; nobody else can.
  await assert.rejects(save(mate.id, "member", id, { name: "Back" }), /no such view/);
  await save(ws.ownerId, "owner", id, { shared: true });
  assert.ok(ids(await readViews(ws.workspaceId, mate.id)).includes(id));
});

test("over the socket: a shared change reaches every member, a private one only its owner", async () => {
  const [owner, member] = await Promise.all([
    Client.open(server.url, await asUser(ws.ownerId)).then((c) => c.subscribe(ws)),
    Client.open(server.url, await asUser(mate.id)).then((c) => c.subscribe(ws)),
  ]);
  clients.push(owner, member);
  member.send({ t: "views" });
  const first = (await member.next((f) => f.t === "views" && !!f.full)) as ViewsFrame;
  assert.ok(first.at);

  const id = randomUUID();
  owner.send({ t: "view", w: { op: "save", id, set: fields({ name: "Live", shared: true }) } });
  const got = (await member.next((f) => f.t === "views" && f.v.some((v) => v.id === id))) as ViewsFrame;
  assert.equal(got.v[0]!.name, "Live");

  owner.send({ t: "view", w: { op: "save", id, set: { shared: false } } });
  await member.next((f) => f.t === "views" && f.gone.includes(id));

  member.send({ t: "view", w: { op: "save", id, set: { name: "Nope" } } });
  const rej = await member.next((f) => f.t === "rej" && f.id === "view");
  assert.equal(rej.t === "rej" && rej.code, "invalid");
});

test("a custom token changes saved views only when given Views: write (PLNR-271)", async () => {
  const custom = (grants: string[]) => createToken({ workspaceId: ws.workspaceId, userId: ws.ownerId, name: "t", scope: "custom", grants: grants as Grant[], createdById: ws.ownerId });
  const without = await Client.open(server.url, { authorization: `Bearer ${(await custom(["issues.write"])).secret}` }).then((c) => c.subscribe(ws));
  const given = await Client.open(server.url, { authorization: `Bearer ${(await custom(["views.write"])).secret}` }).then((c) => c.subscribe(ws));
  clients.push(without, given);
  without.send({ t: "view", w: { op: "save", id: randomUUID(), set: fields({ name: "Shared by a token", shared: true }) } });
  const rej = await without.next((f) => f.t === "rej" && f.id === "view");
  assert.deepEqual(rej.t === "rej" && [rej.code, rej.msg], ["forbidden", "the token lacks Views: write"]);
  const id = randomUUID();
  given.send({ t: "view", w: { op: "save", id, set: fields({ name: "Given" }) } });
  await given.next((f) => f.t === "views" && f.v.some((v) => v.id === id));
});

test("the order of projects is its person's alone, per workspace, whole, and reaches their other windows", async () => {
  const a = randomUUID();
  const b = randomUUID();
  const { at } = await readViews(ws.workspaceId, mate.id);
  assert.deepEqual((await readViews(other.workspaceId, other.ownerId)).o, [], "no order yet");
  assert.equal(await viewsSince(ws.workspaceId, mate.id, at!), null);

  await writeView(ws.workspaceId, mate.id, "member", { op: "order", ids: [a, b] });
  await writeView(ws.workspaceId, mate.id, "member", { op: "order", ids: [b, a] });
  assert.deepEqual((await readViews(ws.workspaceId, mate.id)).o, [b, a], "the last one, in place of the first");
  assert.deepEqual((await viewsSince(ws.workspaceId, mate.id, at!))?.o, [b, a]);
  const full = await readViews(ws.workspaceId, mate.id);
  assert.equal(await viewsSince(ws.workspaceId, mate.id, full.at!), null, "the cursor covers it");
  assert.deepEqual((await readViews(ws.workspaceId, admin.id)).o, [], "someone else's order stays theirs");

  await assert.rejects(writeView(ws.workspaceId, mate.id, "member", { op: "order", ids: ["not-an-id"] }), ViewError);
  await assert.rejects(writeView(ws.workspaceId, mate.id, "member", { op: "order", ids: Array.from({ length: PROJECT_ORDER_MAX + 1 }, randomUUID) }), ViewError);

  const [one, two, stranger] = await Promise.all([
    Client.open(server.url, await asUser(mate.id)).then((c) => c.subscribe(ws)),
    Client.open(server.url, await asUser(mate.id)).then((c) => c.subscribe(ws)),
    Client.open(server.url, await asUser(admin.id)).then((c) => c.subscribe(ws)),
  ]);
  clients.push(one, two, stranger);
  one.send({ t: "view", w: { op: "order", ids: [a] } });
  const seen = await Promise.all([one, two].map((c) => c.next((f) => f.t === "views" && !!f.o)));
  for (const f of seen) assert.deepEqual((f as ViewsFrame).o, [a]);
  stranger.send({ t: "views" });
  assert.deepEqual(((await stranger.next((f) => f.t === "views" && !!f.full)) as ViewsFrame).o, [], "only their own sockets");
});

test("pins and hidden projects: whole lists of their person, each echoed alone; a client before them still pins a view (PLNR-292)", async () => {
  const view = randomUUID();
  await save(ws.ownerId, "owner", view, fields({ shared: true }));
  const issue = `issue:${randomUUID()}` as const;
  const project = randomUUID();
  const { at } = await readViews(ws.workspaceId, admin.id);

  const echo = await writeView(ws.workspaceId, admin.id, "admin", { op: "pins", refs: [issue, `view:${view}`] });
  assert.ok("own" in echo);
  assert.deepEqual([echo.own.s, echo.own.o, echo.own.h], [[issue, `view:${view}`], undefined, undefined], "the echo carries only the list it wrote");
  await writeView(ws.workspaceId, admin.id, "admin", { op: "hidden", ids: [project] });
  const full = await readViews(ws.workspaceId, admin.id);
  assert.deepEqual([full.s, full.h, full.p], [[issue, `view:${view}`], [project], [[view, true]]], "p repeats the pinned views for an older client");
  assert.deepEqual((await viewsSince(ws.workspaceId, admin.id, at!))?.s, [issue, `view:${view}`]);
  assert.deepEqual((await readViews(ws.workspaceId, ws.ownerId)).s, [], "someone else's pins stay theirs");

  // An older client's pin moves its view to the end of the list or out of it.
  await writeView(ws.workspaceId, admin.id, "admin", { op: "pin", id: view, pinned: false });
  await writeView(ws.workspaceId, admin.id, "admin", { op: "pin", id: view, pinned: true });
  assert.deepEqual((await readViews(ws.workspaceId, admin.id)).s, [issue, `view:${view}`]);
  await writeView(ws.workspaceId, ws.ownerId, "owner", { op: "pin", id: view, pinned: true });
  assert.deepEqual((await readViews(ws.workspaceId, ws.ownerId)).s, [`view:${view}`], "a first pin makes the row");

  for (const refs of [["project:" + randomUUID()], [issue, issue], [`issue:not-an-id`]])
    await assert.rejects(writeView(ws.workspaceId, admin.id, "admin", { op: "pins", refs }), ViewError);
  await assert.rejects(writeView(ws.workspaceId, admin.id, "admin", { op: "hidden", ids: [project, project] }), ViewError);
});

test("groups of projects: their person's, whole, echoed alone; a project in one group at most (RSVA-566)", async () => {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  const group = { id: randomUUID(), name: "  Clients ", ids: [a, b], folded: true as const };
  assert.deepEqual((await readViews(ws.workspaceId, mate.id)).g, { groups: [], keep: [], quiet: [] }, "none until they make one");

  const groups = { groups: [group], keep: [c], quiet: [[a, "2026-11-01T10:00:00.000Z"]] as [string, string][] };
  const echo = await writeView(ws.workspaceId, mate.id, "member", { op: "groups", groups });
  assert.ok("own" in echo);
  assert.deepEqual([echo.own.g?.groups[0]?.name, echo.own.o, echo.own.h], ["Clients", undefined, undefined], "the name trimmed; only this list echoed");
  assert.deepEqual((await readViews(ws.workspaceId, mate.id)).g, { ...groups, groups: [{ ...group, name: "Clients" }] });
  assert.deepEqual((await readViews(ws.workspaceId, admin.id)).g?.groups, [], "someone else's groups stay theirs");

  const refused = [
    { ...groups, groups: [group, { id: randomUUID(), name: "Two", ids: [a] }] },
    { ...groups, groups: [group, group] },
    { ...groups, groups: [{ ...group, name: "   " }] },
    { ...groups, quiet: [[a, "yesterday"]] },
    { groups: [group], keep: [] },
  ];
  for (const g of refused) await assert.rejects(writeView(ws.workspaceId, mate.id, "member", { op: "groups", groups: g }), ViewError, JSON.stringify(g));

  // A field from an older shape stays in the row but never goes out: the client writes back what it was given.
  await db.update(schema.projectOrder).set({ groups: { ...groups, quietDays: 14 } }).where(eq(schema.projectOrder.userId, mate.id));
  assert.deepEqual(Object.keys((await readViews(ws.workspaceId, mate.id)).g!).sort(), ["groups", "keep", "quiet"]);
});
