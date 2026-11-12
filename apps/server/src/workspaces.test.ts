import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CLOSE_FORBIDDEN, newProjectOps, type InviteResult, type InviteView, type PendingInvite } from "@rsva/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { Mail } from "./auth/mail.ts";
import { db, schema } from "./db.ts";
import { snapshot } from "./sync/bootstrap.ts";
import { addMember as join } from "./sync/members.ts";
import { applyServerChange, applyTx } from "./sync/write.ts";
import { forgetSessions, sweepSessions } from "./auth/sessions.ts";
import { addMember, asToken, asUser, Client, delay, fetchAs, importFixture, mailbox, ORIGIN, rejects, slug, startServer, type Fixture } from "./test/helpers.ts";

const { member, user, workflowState, project, syncAction } = schema;

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
const { mails, mailer, mailTo } = mailbox();
before(async () => {
  [server, ws] = await Promise.all([startServer({ mailer }), importFixture()]);
});
after(() => server.close());

const json = { "content-type": "application/json" };
const post = async (headers: Record<string, string>, path: string, body?: unknown) =>
  fetchAs(headers)(`${server.url}${path}`, { method: "POST", headers: json, body: JSON.stringify(body ?? {}) });

const linkSecret = (m: Mail) => /\/join\/([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
const roleIn = async (workspaceId: string, userId: string) =>
  (await db.select({ role: member.role }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, userId))))[0]?.role ?? null;

async function invite(email: string, role = "member", as = ws.ownerId): Promise<string> {
  const r = await post(await asUser(as), `/api/v1/workspaces/${ws.slug}/invites`, { emails: [email], role });
  assert.equal(r.status, 201);
  return linkSecret(await mailTo(email.toLowerCase()));
}

test("an invited address without an account signs in with a code, gets an account and joins", async () => {
  const email = `New.Person-${randomUUID().slice(0, 6)}@example.test`;
  const lower = email.toLowerCase();
  const secret = await invite(email);

  // The link shows the invite to anyone holding it; a made-up one says nothing.
  const view = (await (await fetch(`${server.url}/api/v1/invites/${secret}`)).json()) as InviteView;
  assert.equal(view.email, lower);
  assert.equal(view.workspace.slug, ws.slug);
  assert.equal(view.role, "member");
  assert.equal((await fetch(`${server.url}/api/v1/invites/nope`)).status, 404);

  // The code goes out although the address has no account yet; the account comes with the first sign-in.
  assert.equal((await post({ origin: ORIGIN }, "/auth/code", { email })).status, 204);
  const code = /(\d{6})/.exec((await mailTo(lower)).text)![1]!;
  const signed = await post({ origin: ORIGIN }, "/auth/verify", { email, code });
  assert.equal(signed.status, 200);
  const me = ((await signed.json()) as { user: { id: string; name: string } }).user;
  assert.equal(me.name.split(" ")[0], "New");
  const cookie = signed.headers.getSetCookie().find((c) => c.startsWith("rsva_sid="))!.split(";")[0]!;
  const asNew = { cookie, origin: ORIGIN };

  // Before joining, the person sees the invite in their own list.
  const mine = (await (await fetchAs(asNew)(`${server.url}/api/v1/me/invites`)).json()) as { invites: InviteView[] };
  assert.deepEqual(mine.invites.map((i) => i.workspace.slug), [ws.slug]);

  const joined = await post(asNew, `/api/v1/invites/${secret}/accept`);
  assert.equal(joined.status, 200);
  assert.deepEqual(await joined.json(), { slug: ws.slug });
  assert.equal(await roleIn(ws.workspaceId, me.id), "member");
  // A used link is dead.
  assert.equal((await fetch(`${server.url}/api/v1/invites/${secret}`)).status, 404);
  assert.equal((await post(asNew, `/api/v1/invites/${secret}/accept`)).status, 404);

  // The snapshot lists the new member with their role.
  for await (const l of snapshot(ws.slug, undefined)) {
    if (l.t !== "b" || l.m !== "User") continue;
    const id = l.c.indexOf("id");
    const role = l.c.indexOf("role");
    assert.equal(l.r.find((r) => r[id] === me.id)?.[role], "member");
  }
});

test("only admins invite, from a browser; the link works only for its address", async () => {
  const plain = await addMember(ws.workspaceId, "member");
  const admin = await addMember(ws.workspaceId, "admin");
  assert.equal((await post(await asUser(plain.id), `/api/v1/workspaces/${ws.slug}/invites`, { emails: ["x@example.test"], role: "member" })).status, 403);
  assert.equal((await post(await asToken(ws.workspaceId, ws.ownerId), `/api/v1/workspaces/${ws.slug}/invites`, { emails: ["x@example.test"], role: "member" })).status, 403);
  assert.equal((await post(await asUser(admin.id), `/api/v1/workspaces/${ws.slug}/invites`, { emails: ["x@example.test"], role: "owner" })).status, 400);

  // Members already in the workspace are left out, not invited.
  const r = await post(await asUser(admin.id), `/api/v1/workspaces/${ws.slug}/invites`, { emails: [plain.email, "Someone@Example.test"], role: "admin" });
  const res = (await r.json()) as InviteResult;
  assert.deepEqual(res.members, [plain.email]);
  assert.deepEqual(res.invited.map((i) => [i.email, i.role]), [["someone@example.test", "admin"]]);
  const secret = linkSecret(await mailTo("someone@example.test"));

  // Another account cannot use it.
  const accepted = await post(await asUser(plain.id), `/api/v1/invites/${secret}/accept`);
  assert.equal(accepted.status, 403);
  assert.equal(((await accepted.json()) as { error: string }).error, "wrong_account");
});

test("an invite stops working when its sender is no longer an admin", async () => {
  const admin = await addMember(ws.workspaceId, "admin");
  const email = `late-${randomUUID().slice(0, 6)}@example.test`;
  const secret = await invite(email, "admin", admin.id);
  assert.equal((await fetch(`${server.url}/api/v1/invites/${secret}`)).status, 200);
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "User", id: admin.id, set: { role: "member" } }]);
  assert.equal((await fetch(`${server.url}/api/v1/invites/${secret}`)).status, 404);
  assert.equal((await post({ origin: ORIGIN }, "/auth/code", { email })).status, 204);
  await delay(100);
  assert.equal(mails.some((m) => m.to === email), false, "the address may not sign in on a dead invite");
});

test("an expired link is dead for the invited person but stays in the admins' list to send again", async () => {
  const email = `old-${randomUUID().slice(0, 6)}@example.test`;
  const secret = await invite(email);
  await db.update(schema.invite).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.invite.email, email));
  assert.equal((await fetch(`${server.url}/api/v1/invites/${secret}`)).status, 404);
  const list = (await (await fetchAs(await asUser(ws.ownerId))(`${server.url}/api/v1/workspaces/${ws.slug}/invites`)).json()) as { invites: PendingInvite[] };
  assert.ok(list.invites.some((i) => i.email === email));
});

test("resending replaces the link, revoking kills it, declining takes it off the person's list", async () => {
  const email = `again-${randomUUID().slice(0, 6)}@example.test`;
  const first = await invite(email);
  const owner = await asUser(ws.ownerId);
  const list = async () => ((await (await fetchAs(owner)(`${server.url}/api/v1/workspaces/${ws.slug}/invites`)).json()) as { invites: PendingInvite[] }).invites;
  const id = (await list()).find((i) => i.email === email)!.id;

  assert.equal((await post(owner, `/api/v1/workspaces/${ws.slug}/invites/${id}/resend`)).status, 200);
  const second = linkSecret(await mailTo(email));
  assert.equal((await fetch(`${server.url}/api/v1/invites/${first}`)).status, 404);
  assert.equal((await fetch(`${server.url}/api/v1/invites/${second}`)).status, 200);

  // A second invite to the same address is the same invite.
  await invite(email, "admin");
  assert.equal((await list()).filter((i) => i.email === email).length, 1);

  assert.equal((await fetchAs(owner)(`${server.url}/api/v1/workspaces/${ws.slug}/invites/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await list()).some((i) => i.email === email), false);

  // Revoked, the address may not sign in any more: no code goes out.
  assert.equal((await post({ origin: ORIGIN }, "/auth/code", { email })).status, 204);
  await delay(100);
  assert.equal(mails.some((m) => m.to === email), false);
});

test("roles: admins change and remove members; nobody changes the owner or their own role", async () => {
  const admin = await addMember(ws.workspaceId, "admin");
  const plain = await addMember(ws.workspaceId, "member");
  const other = await addMember(ws.workspaceId, "member");
  const as = (who: string, ops: Parameters<typeof applyTx>[3]) => applyTx(ws.workspaceId, who, randomUUID(), ops);

  const promoted = await as(admin.id, [{ op: "update", m: "User", id: plain.id, set: { role: "admin" } }]);
  assert.deepEqual(promoted.actions.map((a) => [a.m, a.a, a.d]), [["User", "U", { role: "admin" }]]);
  await rejects(as(other.id, [{ op: "update", m: "User", id: admin.id, set: { role: "member" } }]), "forbidden");
  await rejects(as(admin.id, [{ op: "update", m: "User", id: ws.ownerId, set: { role: "member" } }]), "forbidden");
  await rejects(as(admin.id, [{ op: "update", m: "User", id: admin.id, set: { role: "member" } }]), "forbidden");
  await rejects(as(admin.id, [{ op: "update", m: "User", id: randomUUID(), set: { role: "member" } }]), "not_found");
  await rejects(as(admin.id, [{ op: "update", m: "User", id: plain.id, set: { role: "owner" as never } }]), "invalid");
  // An agent stays at most a member, as the import keeps it: an admin agent could change the rules agents work under.
  await rejects(as(admin.id, [{ op: "update", m: "User", id: ws.agentId, set: { role: "admin" } }]), "forbidden", /agent/);
  assert.equal(await roleIn(ws.workspaceId, ws.agentId), "member");

  // A removed member's open socket closes at once; the others get role null and keep the name.
  const token = await asToken(ws.workspaceId, other.id);
  const theirs = await Client.open(server.url, await asUser(other.id));
  theirs.send({ t: "sub", ws: ws.slug, s: 0 });
  await theirs.next((f) => f.t === "d" || f.t === "resync", 3000).catch(() => null);
  const closed = new Promise<number>((r) => theirs.ws.once("close", (code) => r(code)));
  const removed = await as(admin.id, [{ op: "delete", m: "User", id: other.id }]);
  assert.deepEqual(removed.actions[0]!.d, { role: null });
  assert.equal(await closed, CLOSE_FORBIDDEN);
  assert.equal(await roleIn(ws.workspaceId, other.id), null);
  // No workspace and no invite left: no session either, neither the old one nor a new one.
  assert.equal((await fetchAs(await asUser(other.id))(`${server.url}/sync/bootstrap?ws=${ws.slug}`)).status, 401);
  assert.equal((await db.select().from(schema.session).where(eq(schema.session.userId, other.id))).length, 0);
  // Their tokens end with the membership: inviting them back does not revive them.
  const live = await db.select().from(schema.apiToken).where(and(eq(schema.apiToken.userId, other.id), isNull(schema.apiToken.revokedAt)));
  assert.equal(live.length, 0);
  assert.equal((await fetch(`${server.url}/api/v1/workspaces/${ws.slug}/issues`, { headers: token })).status, 401);
});

test("a removed member's address leaves the workspace's log; the name stays (RSVA-609)", async () => {
  const email = `gone-${randomUUID().slice(0, 8)}@example.test`;
  const [u] = await db.insert(user).values({ email, name: "Gone Person", kind: "human" }).returning({ id: user.id });
  await applyServerChange(ws.workspaceId, u!.id, async (tx) => [(await join(tx, ws.workspaceId, u!.id, "member"))!]);
  const logged = async () => JSON.stringify(await db.select({ d: syncAction.data, p: syncAction.prev }).from(syncAction).where(and(eq(syncAction.workspaceId, ws.workspaceId), eq(syncAction.modelId, u!.id))));
  assert.ok((await logged()).includes(email), "a member's address is in the log, as in the snapshot");
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "delete", m: "User", id: u!.id }]);
  assert.ok(!(await logged()).includes(email), "a catch-up hands no member the address of someone who left");
  assert.ok((await logged()).includes("Gone Person"));
});

test("leaving: a member leaves through the API, the owner cannot", async () => {
  const leaver = await addMember(ws.workspaceId, "member");
  assert.equal((await post(await asUser(leaver.id), `/api/v1/workspaces/${ws.slug}/leave`)).status, 204);
  assert.equal(await roleIn(ws.workspaceId, leaver.id), null);
  const owner = await post(await asUser(ws.ownerId), `/api/v1/workspaces/${ws.slug}/leave`);
  assert.equal(owner.status, 403);
  assert.equal(await roleIn(ws.workspaceId, ws.ownerId), "owner");
});

/** Lists the fixture's owner in RSVA_WORKSPACE_CREATORS for one test. */
async function asCreator(f: () => Promise<void>): Promise<void> {
  const before = process.env.RSVA_WORKSPACE_CREATORS;
  process.env.RSVA_WORKSPACE_CREATORS = `elsewhere@example.test,OWNER@${ws.slug}.test`;
  try {
    await f();
  } finally {
    if (before === undefined) delete process.env.RSVA_WORKSPACE_CREATORS;
    else process.env.RSVA_WORKSPACE_CREATORS = before;
  }
}

test("only the people RSVA_WORKSPACE_CREATORS lists create workspaces; unset, nobody", async () => {
  const body = { name: "Mine", slug: slug("mine"), color: null, projects: [] };
  const member = await asUser((await addMember(ws.workspaceId, "member")).id);
  const owner = await asUser(ws.ownerId);
  delete process.env.RSVA_WORKSPACE_CREATORS;
  for (const who of [owner, member]) {
    const r = await post(who, "/api/v1/workspaces", body);
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { message: string }).message, /limited/);
    assert.equal((await fetchAs(who)(`${server.url}/api/v1/workspace-slugs/${body.slug}`)).status, 403);
  }
  await asCreator(async () => {
    assert.equal((await post(member, "/api/v1/workspaces", body)).status, 403);
    assert.equal((await post(owner, "/api/v1/workspaces", body)).status, 201);
  });
});

test("a new workspace: the address is checked, the creator owns it, projects get the default workflow", () => asCreator(async () => {
  const owner = await asUser(ws.ownerId);
  const check = async (s: string) => (await (await fetchAs(owner)(`${server.url}/api/v1/workspace-slugs/${s}`)).json()) as { available: boolean };
  assert.equal((await check(ws.slug)).available, false);
  assert.equal((await check("join")).available, false);
  // /notify/unsubscribe is the server's page (RSVA-619): a workspace at that address would sit under it.
  assert.equal((await check("notify")).available, false);
  assert.equal((await check("Bad Slug")).available, false);
  // A browser reads these as a host in "//3405803781/x".
  for (const host of ["3405803781", "0x7f000001", "123"]) assert.equal((await check(host)).available, false, host);
  assert.equal((await check(slug("0x"))).available, true);
  const fresh = slug("new");
  assert.equal((await check(fresh)).available, true);

  const body = { name: "Fresh", slug: fresh, color: "teal", projects: [{ name: "Engineering", key: "ENG" }, { name: "Design", key: "DES" }] };
  assert.equal((await post(owner, "/api/v1/workspaces", { ...body, projects: [body.projects[0], body.projects[0]] })).status, 400);
  assert.equal((await post(await asToken(ws.workspaceId, ws.ownerId), "/api/v1/workspaces", body)).status, 403);
  // Asked for before it exists, the slug is remembered as missing (auth/access.ts): creating it forgets that at once.
  assert.equal((await fetchAs(owner)(`${server.url}/sync/bootstrap?ws=${fresh}`)).status, 404);
  const r = await post(owner, "/api/v1/workspaces", body);
  assert.equal(r.status, 201);
  assert.equal((await post(owner, "/api/v1/workspaces", body)).status, 409);

  const [w] = await db.select().from(schema.workspace).where(eq(schema.workspace.slug, fresh));
  assert.equal(w!.color, "teal");
  assert.equal(await roleIn(w!.id, ws.ownerId), "owner");
  const projects = await db.select().from(project).where(eq(project.workspaceId, w!.id));
  assert.deepEqual(projects.map((p) => p.key).sort(), ["DES", "ENG"]);
  const states = await db.select().from(workflowState).where(eq(workflowState.projectId, projects[0]!.id));
  assert.deepEqual(states.filter((s) => s.isDefault).map((s) => s.name), ["Backlog"]);
  assert.equal(states.length, 5);
  assert.equal((await fetchAs(owner)(`${server.url}/sync/bootstrap?ws=${fresh}`)).status, 200);
  assert.equal((await post(owner, "/api/v1/workspaces", { ...body, slug: "3405803781" })).status, 409);

  // A project made later, through the write pipeline (New project, the agent API), gets the very same workflow: one source
  // of the default states (RSVA-428).
  const later = randomUUID();
  await applyTx(w!.id, ws.ownerId, randomUUID(), newProjectOps(later, { name: "Later", key: "LAT" }, randomUUID), true);
  const shape = async (projectId: string) =>
    (await db.select().from(workflowState).where(eq(workflowState.projectId, projectId)).orderBy(workflowState.position)).map((s) => ({ name: s.name, group: s.group, position: s.position, isDefault: s.isDefault, onlyPeople: s.onlyPeople, color: s.color }));
  assert.deepEqual(await shape(later), await shape(projects[0]!.id));
  const [made] = await db.select().from(project).where(eq(project.id, later));
  assert.equal(made!.color, projects[0]!.color);
}));

test("someone without a workspace keeps a session only while invited, and signs in only while invited", async () => {
  const [u] = await db.insert(user).values({ email: `solo-${randomUUID().slice(0, 6)}@example.test`, name: "Solo" }).returning();
  assert.equal((await post({ origin: ORIGIN }, "/auth/code", { email: u!.email })).status, 204);
  await delay(100);
  assert.equal(mails.some((m) => m.to === u!.email), false, "no workspace and no invite: no code");
  assert.equal((await fetchAs(await asUser(u!.id))(`${server.url}/auth/me`)).status, 401, "nor a session");
  await invite(u!.email);
  assert.equal((await post({ origin: ORIGIN }, "/auth/code", { email: u!.email })).status, 204);
  assert.match((await mailTo(u!.email)).subject, /recursiva code/);
  const me = await asUser(u!.id);
  assert.equal((await fetchAs(me)(`${server.url}/auth/me`)).status, 200);
  const [mine] = await (await fetchAs(me)(`${server.url}/api/v1/me/invites`)).json().then((r) => (r as { invites: InviteView[] }).invites);

  // Declining the last invite ends the session at once (the cached one too).
  assert.equal((await post(me, `/api/v1/me/invites/${mine!.id}/decline`)).status, 204);
  assert.equal((await fetchAs(me)(`${server.url}/auth/me`)).status, 401);
  assert.equal((await db.select().from(schema.session).where(eq(schema.session.userId, u!.id))).length, 0);
});

test("a session ends when its person's last membership or invite does: removed, left, revoked, expired", async () => {
  const other = await importFixture();
  const solo = await addMember(ws.workspaceId, "member");
  const s = await asUser(solo.id);
  const status = async (h: Record<string, string>) => (await fetchAs(h)(`${server.url}/auth/me`)).status;
  assert.equal(await status(s), 200);

  // Left the only workspace while invited elsewhere: still signed in, and the invite page works.
  const inviteBack = await post(await asUser(other.ownerId), `/api/v1/workspaces/${other.slug}/invites`, { emails: [solo.email], role: "member" });
  const [pendingInvite] = ((await inviteBack.json()) as InviteResult).invited;
  await mailTo(solo.email);
  assert.equal((await post(s, `/api/v1/workspaces/${ws.slug}/leave`)).status, 204);
  assert.equal(await status(s), 200);
  assert.equal((await fetchAs(s)(`${server.url}/api/v1/me/invites`)).status, 200);
  // Making a workspace does not bring them back: they are not a creator.
  assert.equal((await post(s, "/api/v1/workspaces", { name: "Back door", slug: slug("bd"), color: null, projects: [] })).status, 403);

  // The admin revokes it: the session ends at once, every one of that person's.
  const second = await asUser(solo.id);
  assert.equal((await fetch(`${server.url}/api/v1/workspaces/${other.slug}/invites/${pendingInvite!.id}`, { method: "DELETE", headers: await asUser(other.ownerId) })).status, 204);
  assert.equal(await status(s), 401);
  assert.equal(await status(second), 401);
  assert.equal((await db.select().from(schema.session).where(eq(schema.session.userId, solo.id))).length, 0);

  // An invite that runs out ends it on the next check (cached for a minute; dropped here).
  const late = await addMember(other.workspaceId, "member");
  const lateSession = await asUser(late.id);
  await db.insert(schema.invite).values({ workspaceId: ws.workspaceId, email: late.email, role: "member", hash: randomUUID(), invitedById: ws.ownerId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await db.delete(member).where(eq(member.userId, late.id));
  forgetSessions();
  assert.equal(await status(lateSession), 200, "invited: still signed in");
  await db.update(schema.invite).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.invite.email, late.email));
  assert.equal(await status(lateSession), 200, "cached for up to a minute");
  forgetSessions();
  assert.equal(await status(lateSession), 401);

  // The hourly sweep deletes sessions of people who lost every reason while away.
  const away = await addMember(other.workspaceId, "member");
  await asUser(away.id);
  await db.delete(member).where(eq(member.userId, away.id));
  const swept = await sweepSessions();
  assert.ok(swept.length >= 1);
  assert.equal((await db.select().from(schema.session).where(eq(schema.session.userId, away.id))).length, 0);
});
